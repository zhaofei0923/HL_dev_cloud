import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests } from './deploy-admin-entry-compatibility.mjs';
import { probeToken } from './verify-native-admin-readonly.mjs';
import { probeFormalPaymentKey } from './formal-payment-key-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'output/formal-payment-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const TARGET = { envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai', functionName: 'hlApi' };
const BASE_CODE = '24b108f4e9548d812eb95c4fcbd17da4bae044ebaad62a7c86640094d539a32b';
const CHANGED_KEYS = ['VPAY_APP_KEY', 'VPAY_ENV', 'PAYMENT_INTEGRATION_READY', 'MATCHMAKING_PAYMENT_READY', 'PAYMENT_TEST_ENABLED'];
const EXPECTED_PLANS = [['vip_week',6160,7,0],['vip_month',19800,30,0],['vip_quarter',39800,90,0],['vip_year',69800,365,0],
  ['matchmaking_double',298000,30,2],['matchmaking_month_6',698000,30,6]];
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const json = name => JSON.parse(readFileSync(resolve(OUT, name), 'utf8').replace(/^\uFEFF/, ''));
const save = (name, value, exclusive = false) => writeFileSync(resolve(OUT, name), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });

export function formalPatch(env, productionAppKey) {
  check(typeof productionAppKey === 'string' && /^[\x21-\x7e]{16,128}$/.test(productionAppKey), 'PRODUCTION_KEY_FORMAT');
  check(productionAppKey !== env.VPAY_SANDBOX_APP_KEY, 'SANDBOX_KEY_NOT_PRODUCTION_KEY');
  check(/^\d{6,20}$/.test(env.VPAY_OFFER_ID || '') && (env.WX_APP_SECRET || '').length >= 16
    && (env.PAYMENT_CALLBACK_TOKEN || '').length >= 32, 'BASE_PAYMENT_CONFIG_MISSING');
  check(env.PAYMENT_TEST_ENABLED === 'false' && env.VIP_MEMBERSHIP_CATALOG_READY === 'true', 'TEST_OR_CATALOG_STATE_CHANGED');
  return { VPAY_APP_KEY: productionAppKey, VPAY_ENV: '0', PAYMENT_INTEGRATION_READY: 'true',
    MATCHMAKING_PAYMENT_READY: 'true', PAYMENT_TEST_ENABLED: 'false' };
}
export function orderBlockers(orders, slots) {
  check(Array.isArray(orders) && orders.length < 1000 && Array.isArray(slots) && slots.length < 1000, 'READ_LIMIT_REACHED');
  const unresolved = orders.filter(row => ['pending','confirming'].includes(row.status) || row.paymentReviewRequired
    || row.fulfillmentStatus === 'requires_review' || row.status === 'paid' && row.fulfillmentStatus !== 'fulfilled'
    || row.status === 'paid' && row.paymentProvider === 'virtual' && row.virtualDeliveryStatus !== 'confirmed');
  const occupied = slots.filter(row => String(row._id || '').startsWith('paymentPendingUser_') && (row.orderDocumentId || row.blockedReviewDocumentId));
  return { orderCount: orders.length, sandboxOrderCount: orders.filter(row => row.virtualPaymentEnv === 1).length,
    unresolvedOrders: unresolved.length, occupiedSlots: occupied.length, safeToSwitch: !unresolved.length && !occupied.length };
}
export function assertEnvironmentReadback(before, after, patch) {
  const expected = { ...before, ...patch };
  check(digest(expected) === digest(after), 'ENVIRONMENT_READBACK_MISMATCH');
  check(Object.keys(patch).every(key => CHANGED_KEYS.includes(key)), 'PATCH_SCOPE_INVALID');
  return { environmentSha256: digest(after), otherEnvironmentSha256: digest(Object.fromEntries(Object.entries(after).filter(([key]) => !CHANGED_KEYS.includes(key)))) };
}
function values(detail) {
  protectedDigests(detail);
  check(detail.Status === 'Active', 'FUNCTION_NOT_ACTIVE');
  return Object.fromEntries(detail.Environment.Variables.map(item => [item.Key, item.Value]));
}
async function secretInput() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString('utf8'); check(input.length <= 1024, 'INPUT_TOO_LARGE'); }
  let record;
  try { record = JSON.parse(input); } catch { check(false, 'INPUT_FORMAT'); }
  check(record && Object.keys(record).length === 1 && Object.hasOwn(record, 'productionAppKey'), 'INPUT_FORMAT');
  return record.productionAppKey;
}
async function main(mode) {
  mkdirSync(OUT, { recursive: true });
  check(['--inspect','--apply-stdin','--verify'].includes(mode), 'MODE_INVALID');
  const productionKey = mode === '--apply-stdin' ? await secretInput() : undefined;
  const mcp = new PaymentMcpClient(resolve(SDK, '..', 'cli.cjs'), { ...TARGET, cwd: ROOT });
  let writeRequested = false, stage = 'connect';
  try {
    await mcp.ready;
    const listed = await mcp.request('tools/list', {});
    check(['queryFunctions','manageFunctions','readNoSqlDatabaseContent'].every(name => listed.tools.some(tool => tool.name === name)), 'MCP_SCHEMA_MISSING');
    const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
    const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
    async function snapshot() {
      const detail = await manager.functions.getFunctionDetail(TARGET.functionName), env = values(detail);
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      check(address.CodeSha256 === BASE_CODE, 'LIVE_CODE_CHANGED');
      return { detail, env, protected: protectedDigests(detail) };
    }
    async function read(collectionName, fields, query = {}, limit = 1000) {
      const result = await mcp.call('readNoSqlDatabaseContent', { collectionName, query,
        projection: Object.fromEntries(fields.map(key => [key, 1])), limit });
      check(result.success === true && Array.isArray(result.data) && result.data.length < limit, 'DATABASE_READ_INCOMPLETE');
      return result.data;
    }
    async function orderState() {
      const rows = await Promise.all([
        read('hl_payment_orders', ['_id','status','fulfillmentStatus','paymentReviewRequired','paymentProvider','virtualPaymentEnv','virtualDeliveryStatus']),
        read('hl_counters', ['_id','orderDocumentId','blockedReviewDocumentId'])
      ]);
      return orderBlockers(...rows);
    }
    async function overview(env, requireEnabled) {
      const users = await read('hl_users', ['id','status','authVersion','mergedIntoUserId'], { id: 1, status: 1 }, 2);
      check(users.length === 1 && !users[0].mergedIntoUserId, 'PROBE_USER_INVALID');
      const result = await manager.functions.invokeFunction(TARGET.functionName, { path: '/member/membership-plans', method: 'GET', data: {},
        token: probeToken(env.JWT_SECRET, 1, Number(users[0].authVersion || 1)) });
      const body = JSON.parse(result.RetMsg);
      check(body.code === 0, 'MEMBERSHIP_READ_FAILED');
      const data = body.data;
      check(Array.isArray(data.plans) && data.plans.length === 6 && EXPECTED_PLANS.every(([code, amount, days, count]) => data.plans.some(plan => plan.planCode === code
        && plan.amountFen === amount && plan.durationDays === days && Number(plan.serviceCount || 0) === count)), 'CATALOG_MISMATCH');
      if (requireEnabled) check(data.payment?.provider === 'virtual' && data.payment.available === true && !data.payment.testMode
        && data.matchmakingPayment?.provider === 'virtual' && data.matchmakingPayment.available === true && !data.matchmakingPayment.testMode, 'FORMAL_AVAILABILITY_FAILED');
      return { catalogMatched: true, vipAvailable: data.payment?.available === true, matchmakingAvailable: data.matchmakingPayment?.available === true,
        provider: data.payment?.provider, paymentCalls: 0 };
    }
    stage = 'preflight';
    const before = await snapshot();
    if (mode === '--verify') {
      const intent = json('enable-intent.json');
      check(digest(before.env) === intent.expectedEnvironmentSha256 && before.protected.configurationSha256 === intent.configurationSha256, 'APPLIED_STATE_MISMATCH');
      const checked = await overview(before.env, true);
      const report = { status: 'enabled', verifiedAt: new Date().toISOString(), target: TARGET, codeSha256: BASE_CODE,
        env: 0, vipEnabled: true, matchmakingEnabled: true, testEnabled: false, ...checked, keyProof: intent.keyProof, credentialsPersisted: false,
        realProductionPaymentVerified: false, configurationWrites: 1 };
      save('enabled.json', report); return report;
    }
    const baseline = json('inspection.json');
    check(before.protected.environmentSha256 === baseline.protectedDigests.environmentSha256
      && before.protected.configurationSha256 === baseline.protectedDigests.configurationSha256, 'PREFLIGHT_CONFIGURATION_CHANGED');
    check(before.env.VPAY_ENV === '1' && before.env.PAYMENT_INTEGRATION_READY === 'false'
      && before.env.MATCHMAKING_PAYMENT_READY === 'false' && before.env.PAYMENT_TEST_ENABLED === 'false', 'INITIAL_GATES_CHANGED');
    const [orders, catalog] = await Promise.all([orderState(), overview(before.env, false)]);
    check(orders.safeToSwitch, 'UNRESOLVED_PAYMENT_ORDERS');
    if (mode === '--inspect') {
      const report = { status: 'ready_for_production_key', checkedAt: new Date().toISOString(), target: TARGET, codeSha256: BASE_CODE,
        orders, catalog, missingProductionKey: !before.env.VPAY_APP_KEY, cloudWrites: 0, paymentCalls: 0, credentialsPersisted: false };
      save('preflight.json', report); return report;
    }
    const patch = formalPatch(before.env, productionKey), expected = { ...before.env, ...patch };
    check(!existsSync(resolve(OUT, 'enable-intent.json')), 'ENABLE_ALREADY_REQUESTED_VERIFY_FIRST');
    stage = 'production_key_probe';
    const probeUsers = await read('hl_users', ['id','status','openid','mergedIntoUserId'], { id: 1, status: 1 }, 2);
    check(probeUsers.length === 1 && !probeUsers[0].mergedIntoUserId, 'PROBE_USER_INVALID');
    const keyProof = await probeFormalPaymentKey({ appId: 'wx7e5c0f4d07d2f0f8', appSecret: before.env.WX_APP_SECRET,
      productionAppKey: productionKey, openid: probeUsers[0].openid });
    check(keyProof.signatureVerified === true && keyProof.env === 0 && keyProof.ordersCreated === 0, 'PRODUCTION_KEY_PROBE_UNCONFIRMED');
    stage = 'final_preflight';
    check((await orderState()).safeToSwitch, 'UNRESOLVED_PAYMENT_ORDERS');
    const current = await snapshot();
    check(digest(current.env) === digest(before.env) && current.detail.ModTime === before.detail.ModTime
      && current.protected.configurationSha256 === before.protected.configurationSha256, 'CONCURRENT_CONFIGURATION_CHANGE');
    save('enable-intent.json', { requestedAt: new Date().toISOString(), target: TARGET, codeSha256: BASE_CODE,
      changedKeys: CHANGED_KEYS, expectedEnvironmentSha256: digest(expected), configurationSha256: before.protected.configurationSha256,
      otherEnvironmentSha256: digest(Object.fromEntries(Object.entries(before.env).filter(([key]) => !CHANGED_KEYS.includes(key)))),
      keyProof, cloudConfigurationWrites: 1, paymentCalls: 0, credentialsPersisted: false }, true);
    stage = 'configuration_update'; writeRequested = true;
    // The complete environment stays in memory and travels only over official MCP stdio.
    // This also protects all existing keys if a provider uses replace semantics.
    await mcp.call('manageFunctions', { action: 'updateFunctionConfig', functionName: TARGET.functionName, envVariables: expected });
    stage = 'readback';
    let after;
    for (let attempt = 0; attempt < 15; attempt++) {
      const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
      check(!/Failed|Error/i.test(detail.Status), 'CONFIGURATION_UPDATE_FAILED');
      if (detail.Status === 'Active') {
        const env = values(detail);
        if (digest(env) === digest(expected)) { after = { detail, env, protected: protectedDigests(detail) }; break; }
      }
      await new Promise(done => setTimeout(done, 1000));
    }
    check(after, 'CONFIGURATION_PENDING_VERIFY_REQUIRED');
    assertEnvironmentReadback(before.env, after.env, patch);
    check(after.protected.configurationSha256 === before.protected.configurationSha256, 'OTHER_CONFIGURATION_CHANGED');
    stage = 'availability';
    const checked = await overview(after.env, true);
    const final = await snapshot();
    check(digest(final.env) === digest(expected) && final.protected.configurationSha256 === before.protected.configurationSha256, 'FINAL_STATE_CHANGED');
    const report = { status: 'enabled', verifiedAt: new Date().toISOString(), target: TARGET, codeSha256: BASE_CODE,
      env: 0, vipEnabled: true, matchmakingEnabled: true, testEnabled: false, ...checked,
      keyProof, configurationWrites: 1, unchangedOtherConfiguration: true, credentialsPersisted: false, realProductionPaymentVerified: false };
    save('enabled.json', report); return report;
  } catch (error) {
    const report = { status: 'incomplete', stage, code: error.safeCode || 'FORMAL_PAYMENT_OPERATION_FAILED',
      configurationUpdateRequested: writeRequested, automaticRetry: false, credentialsPersisted: false };
    if (stage === 'production_key_probe' && error.probeDiagnostics) {
      report.probeDiagnostics = {};
      for (const phase of ['initial', 'control']) {
        const diagnostic = error.probeDiagnostics[phase];
        if (diagnostic) report.probeDiagnostics[phase] = {
          httpStatus: Number.isInteger(diagnostic.httpStatus) ? diagnostic.httpStatus : null,
          providerCode: Number.isSafeInteger(diagnostic.providerCode) ? diagnostic.providerCode : null
        };
      }
      if (error.probeDiagnostics.controlTransportFailed === true) report.probeDiagnostics.controlTransportFailed = true;
    }
    save('latest-safe-result.json', report);
    return report;
  } finally { mcp.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(process.argv.length === 3 ? process.argv[2] : ''); console.log(JSON.stringify(result)); if(result.status === 'incomplete') process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ status: 'incomplete', code: error.safeCode || 'FORMAL_PAYMENT_OPERATION_FAILED', automaticRetry: false })); process.exitCode = 1; }
}
