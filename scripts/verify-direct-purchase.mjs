import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { probeToken } from './verify-native-admin-readonly.mjs';
import { TARGET } from './prepare-admin-entry-rebuild.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'output/direct-purchase-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
let stage = 'arguments';
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
    check(env.SEED_DATA !== 'true', 'SEED_MUST_BE_DISABLED');
    check(env.PAYMENT_INTEGRATION_READY === 'false' && env.MATCHMAKING_PAYMENT_READY === 'false', 'PAYMENT_GATES_CHANGED');
    const users = await client.call('readNoSqlDatabaseContent', { collectionName: 'hl_users', query: { id: 1, status: 1 },
      projection: { id: 1, status: 1, authVersion: 1, mergedIntoUserId: 1 }, limit: 2 });
    check(Array.isArray(users.data) && users.data.length === 1 && !users.data[0].mergedIntoUserId, 'PROBE_ACCOUNT_NOT_UNIQUE');
    const account = users.data[0], calls = [];
    async function invoke(path, method, data = {}) {
      stage = path;
      const result = await manager.functions.invokeFunction(TARGET.functionName, { path, method, data,
        token: probeToken(env.JWT_SECRET, account.id, Number(account.authVersion || 1)) });
      const body = JSON.parse(result.RetMsg);
      check(body.code === 0, 'READONLY_RESPONSE_FAILED');
      calls.push({ path, method, action: data.action || null, code: body.code });
      return body.data;
    }
    const expected = [['matchmaking_double', '人工牵线2次', 298000, 30, 2], ['matchmaking_month_6', '人工牵线1个月', 698000, 30, 6]];
    const member = await invoke('/member/membership-plans', 'GET');
    check(Array.isArray(member.plans) && member.plans.length === 6, 'MEMBER_CATALOG_SIZE_INVALID');
    const memberPlans = member.plans.filter(row => row.productType === 'matchmaking').map(row => [row.planCode, row.title, row.amountFen, row.durationDays, row.serviceCount]);
    check(JSON.stringify(memberPlans) === JSON.stringify(expected), 'MEMBER_CATALOG_MISMATCH');
    if (label === 'after') check(member.plans.filter(row => row.productType === 'matchmaking')
      .every(row => row.description === ''), 'CUSTOM_DESCRIPTION_REQUIRES_REVIEW');
    check(member.matchmakingPayment?.available === false, 'PAYMENT_MUST_STAY_CLOSED');
    const admin = await invoke('/user/admin/operations', 'POST', { action: 'plans.list', args: { page: 1, pageSize: 50 } });
    check(Array.isArray(admin.list), 'ADMIN_CATALOG_INVALID');
    const adminPlans = admin.list.filter(row => expected.some(([code]) => code === row.planCode));
    check(adminPlans.length === 2, 'ADMIN_NEW_PLANS_MISSING');
    for (const [planCode, title, amountFen, durationDays, serviceCount] of expected) {
      const detail = await invoke('/user/admin/operations', 'POST', { action: 'plans.detail', args: { planCode } });
      check(detail.planCode === planCode && detail.title === title && detail.amountFen === amountFen
        && detail.durationDays === durationDays && detail.serviceCount === serviceCount && detail.retired === false, 'ADMIN_DETAIL_MISMATCH');
    }
    let serviceQueue;
    if (label === 'after') {
      check(member.matchmakingProgress && typeof member.matchmakingProgress.purchased === 'boolean'
        && Number.isSafeInteger(member.matchmakingProgress.remainingCount), 'SERVICE_PROGRESS_MISSING');
      const queue = await invoke('/user/admin/operations', 'POST', { action: 'services.list', args: { page: 1, pageSize: 10 } });
      check(Array.isArray(queue.list) && Number.isSafeInteger(queue.total), 'SERVICE_QUEUE_INVALID');
      const denied = await manager.functions.invokeFunction(TARGET.functionName, { path: '/user/admin/operations', method: 'POST',
        data: { action: 'services.list', args: { page: 1, pageSize: 10 } } });
      check(JSON.parse(denied.RetMsg).code === 40100, 'UNAUTHENTICATED_SERVICE_QUEUE_NOT_DENIED');
      serviceQueue = { total: queue.total, returnedRows: queue.list.length, unauthenticatedDenied: true };
    }
    stage = 'final-gate';
    const after = await manager.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(protectedBefore, protectedDigests(after));
    const finalAddress = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
    check(before.ModTime === after.ModTime && after.Status === 'Active' && finalAddress.CodeSha256 === expectedHash, 'CLOUD_CHANGED_DURING_PROBE');
    const report = { status: 'passed', label, verifiedAt: new Date().toISOString(), target: TARGET, codeSha256: expectedHash,
      memberPlans, adminDetailsMatched: true, serviceQueue, userProgressPresent: !!member.matchmakingProgress, calls, protectedDigests: protectedBefore,
      paymentIntegrationReady: false, matchmakingPaymentReady: false, virtualPaymentEnvironment: env.VPAY_ENV,
      configurationUnchanged: true, businessMutations: 0, paymentCalls: 0, credentialsPersisted: false,
      tokenMethod: 'in_memory_60_second_server_signed_probe', realWechatLoginVerified: false };
    writeFileSync(join(OUT, label + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report));
  } finally { client.close(); }
}
main().catch(error => { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'DIRECT_PURCHASE_READONLY_FAILED', rawErrorWithheld: true })); process.exitCode = 1; });
