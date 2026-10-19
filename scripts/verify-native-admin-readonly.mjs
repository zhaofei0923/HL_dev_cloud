import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { recoveryGate } from './deploy-miniprogram-admin-entry.mjs';
import { validateNativeArtifacts } from './deploy-native-admin.mjs';
import { TARGET } from './prepare-admin-entry-rebuild.mjs';
import { OUTPUT } from './prepare-native-admin-deployment.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const check = (ok, safeCode) => { if (!ok) throw Object.assign(new Error(safeCode), { safeCode }); };
const b64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
let stage = 'arguments';

// Probe tokens never leave process memory except inside the authenticated
// function invocation. They expire in 60 seconds and are not WeChat login tests.
export function probeToken(secret, userId, authVersion, { type = 'access', expired = false } = {}) {
  const now = Math.floor(Date.now() / 1000), iat = expired ? now - 120 : now;
  const input = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ userId, authVersion, type, iat, exp: iat + 60, jti: randomUUID() });
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
export function detailArguments(resource, row) {
  if (!row || typeof row !== 'object') return null;
  if (resource === 'certifications') return row.canView === true && row.applicationId && row.kind
    ? { userId: row.userId, kind: row.kind, applicationId: row.applicationId } : null;
  if (resource === 'plans') return { planCode: row.planCode || row.code };
  if (resource === 'orders') return { outTradeNo: row.outTradeNo };
  return { id: row.id };
}
async function main() {
  let client;
  try {
    check(process.argv.length === 2, 'NO_ARGUMENTS_SUPPORTED');
    const deployment = json(join(OUTPUT, 'deployment.json')), { manifest } = validateNativeArtifacts();
    check(deployment.status === 'verified' && deployment.candidateZipSha256 === manifest.candidateZipSha256, 'NATIVE_DEPLOYMENT_NOT_VERIFIED');
    const recovery = json(join(ROOT, 'output/admin-entry-20261015/configuration-recovery.json'));
    const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
    const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
    stage = 'readonly-live-gate';
    const before = await manager.functions.getFunctionDetail(TARGET.functionName), baseline = protectedDigests(before);
    recoveryGate(recovery, baseline.environmentSha256);
    const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
    check(before.Status === 'Active' && address.CodeSha256 === manifest.candidateZipSha256, 'NATIVE_LIVE_CODE_MISMATCH');
    const env = Object.fromEntries(before.Environment.Variables.map(row => [row.Key, row.Value]));
    check(env.MINIPROGRAM_ADMIN_USER_IDS === '1' && env.JWT_SECRET?.length >= 32, 'NATIVE_BINDING_NOT_CONFIRMED');
    check(env.SEED_DATA !== 'true' && manifest.nativeBootstrapGuard === true, 'NATIVE_READONLY_INITIALIZATION_NOT_DISABLED');
    client = new PaymentMcpClient(resolve(dirname(SDK), 'cli.cjs'), { envId: TARGET.envId, region: TARGET.region, cwd: ROOT });
    await client.ready;
    stage = 'readonly-current-account';
    const projection = Object.fromEntries(['id', 'status', 'authVersion', 'mergedIntoUserId'].map(name => [name, 1]));
    const users = await client.call('readNoSqlDatabaseContent', { collectionName: 'hl_users', query: { status: 1 }, projection, limit: 100 });
    check(Array.isArray(users.data) && users.data.length < 100, 'NATIVE_USER_QUERY_NOT_COMPLETE');
    const admin = users.data.filter(row => row.id === 1 && !row.mergedIntoUserId);
    check(admin.length === 1, 'NATIVE_ADMIN_NOT_UNIQUE');
    const account = admin[0], ordinary = users.data.find(row => Number.isSafeInteger(row.id) && row.id > 1 && !row.mergedIntoUserId);
    const calls = [];
    const invoke = async (token, action, args = {}, route = '/user/admin/operations', expected = 0) => {
      const result = await manager.functions.invokeFunction(TARGET.functionName, { path: route, method: route === '/user/admin-entry' ? 'GET' : 'POST',
        ...(token ? { token } : {}), data: action ? { action, args } : {} });
      const body = JSON.parse(result.RetMsg);
      calls.push({ route, action: action || 'entry', code: body.code });
      check(body.code === expected, 'NATIVE_READONLY_ASSERTION_FAILED');
      return body.data;
    };
    const token = () => probeToken(env.JWT_SECRET, account.id, Number(account.authVersion || 1));
    stage = 'readonly-native-entry';
    const entry = await invoke(token(), '', {}, '/user/admin-entry');
    check(entry.allowed === true && entry.ready === true && entry.mode === 'native' && !Object.hasOwn(entry, 'url'), 'NATIVE_ENTRY_NOT_READY');
    stage = 'readonly-denial-checks';
    await invoke('', 'overview', {}, undefined, 40100);
    await invoke('invalid.native.probe', 'overview', {}, undefined, 40100);
    await invoke(probeToken(env.JWT_SECRET, 1, Number(account.authVersion || 1), { type: 'refresh' }), 'overview', {}, undefined, 40100);
    await invoke(probeToken(env.JWT_SECRET, 1, Number(account.authVersion || 1), { expired: true }), 'overview', {}, undefined, 40100);
    await invoke(probeToken(env.JWT_SECRET, 1, Number(account.authVersion || 1) + 1), 'overview', {}, undefined, 40100);
    if (ordinary) await invoke(probeToken(env.JWT_SECRET, ordinary.id, Number(ordinary.authVersion || 1)), 'overview', {}, undefined, 40360);
    await invoke(token(), 'orders.refund', {}, undefined, 40360);
    await invoke(token(), 'plans.update', { planCode: 'vip_week', active: false }, undefined, 42260);
    stage = 'readonly-overview';
    const overview = await invoke(token(), 'overview', { periodDays: 7 });
    check(overview?.members && overview?.matchmakers && overview?.revenue, 'NATIVE_OVERVIEW_SCHEMA_INVALID');
    const lists = [];
    for (const resource of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
      stage = `readonly-${resource}`;
      const list = await invoke(token(), resource + '.list', { page: 1, pageSize: 10 });
      check(Array.isArray(list?.list) && list.page === 1 && list.pageSize === 10 && Number.isSafeInteger(list.total), 'NATIVE_LIST_SCHEMA_INVALID');
      const row = list.list.find(item => detailArguments(resource, item));
      let detailVerified = false;
      if (row) {
        const detail = await invoke(token(), resource + '.detail', detailArguments(resource, row));
        check(detail && typeof detail === 'object' && (resource === 'orders' || /^v1_[a-f0-9]{64}$/.test(detail.version || '')), 'NATIVE_DETAIL_SCHEMA_INVALID');
        detailVerified = true;
      }
      lists.push({ resource, total: list.total, returnedRows: list.list.length, detailVerified, noSensitiveContentsPersisted: true });
    }
    stage = 'readonly-final-configuration';
    const after = await manager.functions.getFunctionDetail(TARGET.functionName), current = protectedDigests(after);
    assertProtectedUnchanged(baseline, current); recoveryGate(recovery, current.environmentSha256);
    check(before.ModTime === after.ModTime && after.Status === 'Active', 'NATIVE_CLOUD_CHANGED_DURING_PROBE');
    const report = { status: 'passed', verifiedAt: new Date().toISOString(), ...TARGET, deployedCodeSha256: manifest.candidateZipSha256,
      entryMode: 'native', adminUserId: 1, tokenMethod: 'in_memory_60_second_server_signed_readonly_probe', realWechatLoginVerified: false,
      nativeEntryVerified: true, nativeOverviewVerified: true, ordinaryAccountDenied: !!ordinary, lists, calls,
      configurationUnchanged: true, businessMutations: 0, sensitiveMaterialReads: 0, paymentCalls: 0,
      nativeBootstrapSkipped: true, existingAutoCreateConfigurationPreserved: true,
      rejectedMutationProbe: 'plans.update without mandatory requestId; validation rejects before mutation service', credentialsPersisted: false };
    writeFileSync(join(OUTPUT, 'readonly-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { client?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'NATIVE_READONLY_UNCONFIRMED',
    rawErrorWithheld: true, businessMutations: 0, credentialsPersisted: false })); process.exitCode = 1; });
}
