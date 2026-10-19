import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { probeToken, detailArguments } from './verify-native-admin-readonly.mjs';
import { TARGET } from './prepare-admin-entry-rebuild.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const OUT = join(ROOT, 'output/native-admin-performance-20261019');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'arguments';

// Read-only calls only. Tokens and business contents remain in process memory.
async function main() {
  const [label, expectedHash] = process.argv.slice(2);
  check(['before', 'after'].includes(label) && /^[a-f0-9]{64}$/.test(expectedHash || ''), 'ARGUMENTS_INVALID');
  mkdirSync(OUT, { recursive: true });
  const client = new PaymentMcpClient(resolve(dirname(SDK), 'cli.cjs'), { ...TARGET, cwd: ROOT });
  try {
    await client.ready;
    const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
    const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
    stage = 'live-gate';
    const before = await manager.functions.getFunctionDetail(TARGET.functionName), protectedBefore = protectedDigests(before);
    const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
    check(before.Status === 'Active' && address.CodeSha256 === expectedHash, 'LIVE_CODE_CHANGED');
    const env = Object.fromEntries(before.Environment.Variables.map(row => [row.Key, row.Value]));
    check(env.JWT_SECRET?.length >= 32 && String(env.MINIPROGRAM_ADMIN_USER_IDS).split(',').map(s => s.trim()).includes('1'), 'PROBE_ACCOUNT_NOT_AUTHORIZED');
    const users = await client.call('readNoSqlDatabaseContent', { collectionName: 'hl_users', query: { status: 1 },
      projection: { id: 1, status: 1, authVersion: 1, mergedIntoUserId: 1 }, limit: 100 });
    check(Array.isArray(users.data) && users.data.length < 100, 'USER_QUERY_INCOMPLETE');
    const admins = users.data.filter(user => user.id === 1 && !user.mergedIntoUserId);
    check(admins.length === 1, 'PROBE_ACCOUNT_NOT_UNIQUE');
    const account = admins[0];
    const ordinary = users.data.find(user => user.id > 1 && !user.mergedIntoUserId
      && !String(env.MINIPROGRAM_ADMIN_USER_IDS).split(',').map(Number).includes(user.id));
    const samples = [], lists = new Map();
    async function invoke(action, args = {}, round = 0, tokenOverride, expected = 0) {
      stage = action;
      const token = tokenOverride === undefined ? probeToken(env.JWT_SECRET, 1, Number(account.authVersion || 1)) : tokenOverride;
      const start = performance.now();
      const result = await manager.functions.invokeFunction(TARGET.functionName, {
        path: action === 'entry' ? '/user/admin-entry' : '/user/admin/operations', method: action === 'entry' ? 'GET' : 'POST', token,
        data: action === 'entry' ? {} : { action, args }
      });
      const roundTripMs = Math.round(performance.now() - start), body = JSON.parse(result.RetMsg);
      check(body.code === expected, 'READONLY_RESPONSE_FAILED');
      const sample = { action, round, roundTripMs, code: body.code };
      for (const key of ['Duration', 'BillDuration', 'MemUsage']) if (Number.isFinite(Number(result[key]))) sample[key] = Number(result[key]);
      if (action.endsWith('.list') && expected === 0) {
        check(Array.isArray(body.data?.list) && Number.isSafeInteger(body.data.total), 'LIST_INVALID');
        sample.total = body.data.total; sample.returnedRows = body.data.list.length;
        sample.responseSha256 = sha(JSON.stringify(body.data));
        lists.set(action.split('.')[0], body.data.list);
      }
      if (action === 'overview' && expected === 0) check(body.data?.members && body.data?.matchmakers && body.data?.revenue, 'OVERVIEW_INVALID');
      samples.push(sample);
      console.log(JSON.stringify(sample));
      return body.data;
    }
    for (let round = 0; round < 3; round++) {
      await invoke('entry', {}, round);
      await invoke('overview', { periodDays: 30 }, round);
      for (const resource of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
        await invoke(resource + '.list', { page: 1, pageSize: 10 }, round);
        const row = lists.get(resource).find(item => detailArguments(resource, item));
        if (row) await invoke(resource + '.detail', detailArguments(resource, row), round);
      }
    }
    await invoke('overview', {}, -1, '', 40100);
    if (ordinary) await invoke('overview', {}, -1, probeToken(env.JWT_SECRET, ordinary.id, Number(ordinary.authVersion || 1)), 40360);
    stage = 'final-gate';
    const after = await manager.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(protectedBefore, protectedDigests(after));
    const finalAddress = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
    check(before.ModTime === after.ModTime && after.Status === 'Active' && finalAddress.CodeSha256 === expectedHash, 'CLOUD_CHANGED_DURING_MEASUREMENT');
    const medians = Object.fromEntries([...new Set(samples.filter(s => s.round >= 0).map(s => s.action))].map(action => {
      const values = samples.filter(s => s.action === action && s.round >= 0).map(s => s.roundTripMs).sort((a, b) => a - b);
      return [action, values[Math.floor(values.length / 2)]];
    }));
    const report = { status: 'passed', label, measuredAt: new Date().toISOString(), target: TARGET, codeSha256: expectedHash,
      method: 'three_sequential_rounds_via_official_manager_invoke; includes_management_network_latency; not_phone_timing',
      tokenMethod: 'in_memory_60_second_server_signed_probe', realWechatLoginVerified: false,
      samples, medianRoundTripMs: medians, protectedDigests: protectedBefore, configurationUnchanged: true,
      businessMutations: 0, materialReads: 0, paymentCalls: 0, credentialsPersisted: false };
    writeFileSync(join(OUT, label + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, label, medianRoundTripMs: medians, calls: samples.length }));
  } finally { client.close(); }
}
main().catch(error => { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'READONLY_MEASUREMENT_FAILED',
  transportCode: typeof error.code === 'string' && /^[A-Z0-9_.-]{1,80}$/i.test(error.code) ? error.code : undefined,
  timedOut: /timeout|timed out|ETIMEDOUT/i.test(String(error.message)), rawErrorWithheld: true })); process.exitCode = 1; });
