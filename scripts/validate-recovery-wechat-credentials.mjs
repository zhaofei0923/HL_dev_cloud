import https from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { createVirtualPaymentClient, buildVirtualConfirmation, mapVirtualOrderState } =
  require('../cloudfunctions/hlApi/virtual-payment-policy.js');
const { paymentOrderIdentity } = require('../cloudfunctions/hlApi/membership-payment-policy.js');
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const RUN_ID = 'week_20261013_mv68bzxs';
const DOCUMENT_ID = `payment_probe_user_1_run_${RUN_ID}`;
const EVIDENCE_DIRECTORY = new URL(`../.cloudbase/vip-week-sandbox-20261013/${RUN_ID}_user_1/`, import.meta.url);
const ERROR_BRAND = Symbol('safe-recovery-credential-error');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(stable(value)));
function fail(code) {
  throw Object.assign(new Error(code), { safeCode: code, [ERROR_BRAND]: true });
}
function check(condition, code) { if (!condition) fail(code); }
const fields = names => Object.fromEntries(names.map(name => [name, 1]));
const ORDER_FIELDS = ['_id', 'userId', 'outTradeNo', 'planCode', 'productType', 'membershipTier', 'amountFen', 'durationDays',
  'status', 'fulfillmentStatus', 'paymentReviewRequired', 'reviewReason', 'paymentProvider', 'merchantId', 'appId', 'currency',
  'payerOpenid', 'paymentTestPlanCode', 'paymentTestRunId', 'virtualPaymentEnv', 'virtualPaymentOfferId',
  'virtualPaymentAttempts', 'virtualPaidAttemptNo', 'virtualDeliveryStatus', 'virtualDeliveryOrderNo', 'transactionId', 'createdAt'];
const MAPPING_FIELDS = ['_id', 'orderDocumentId', 'businessOutTradeNo', 'env', 'offerId'];

async function loadLocalEvidence() {
  const serializedIntent = await readFile(new URL('intent.json', EVIDENCE_DIRECTORY));
  return { intent: JSON.parse(serializedIntent.toString('utf8')),
    state: JSON.parse(await readFile(new URL('state.json', EVIDENCE_DIRECTORY), 'utf8')),
    intentSha256: sha(serializedIntent) };
}

// No redirects, raw errors, response bodies or credential-bearing URLs escape.
async function boundedHttpsJson(target, options) {
  return new Promise((resolveRequest, reject) => {
    let settled = false, request;
    const finish = (fn, value) => {
      if (!settled) { settled = true; clearTimeout(deadline); fn(value); }
    };
    const rejected = () => finish(reject, new Error('READ_ONLY_TRANSPORT_FAILED'));
    const deadline = setTimeout(() => { request?.destroy(); rejected(); }, 10000);
    try {
      request = https.request(target, { method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) } }, response => {
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 1024 * 1024) { request.destroy(); rejected(); }
          else chunks.push(chunk);
        });
        response.on('error', rejected);
        response.on('end', () => {
          try { finish(resolveRequest, { status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { rejected(); }
        });
      });
      request.on('timeout', () => { request.destroy(); rejected(); });
      request.on('error', rejected);
      request.end(options.body);
    } catch { rejected(); }
  });
}

/** Wrap even an injected transport in the same two-route read-only allowlist. */
export function createRecoveryReadOnlyRequest(transport = boundedHttpsJson) {
  check(typeof transport === 'function', 'RECOVERY_REQUEST_DEPENDENCY_INVALID');
  return async (url, options = {}) => {
    try {
      const target = new URL(url);
      check(target.protocol === 'https:' && target.hostname === 'api.weixin.qq.com' && !target.port
        && !target.username && !target.password && !target.hash && options.method === 'POST'
        && ['/cgi-bin/stable_token', '/xpay/query_order'].includes(target.pathname)
        && typeof options.body === 'string' && Buffer.byteLength(options.body) <= 4096,
      'RECOVERY_PROVIDER_MUTATION_FORBIDDEN');
      return await transport(target.href, { method: 'POST', body: options.body });
    } catch (error) {
      if (error?.[ERROR_BRAND]) throw error;
      fail('RECOVERY_WECHAT_QUERY_FAILED');
    }
  };
}

/** Adapter for an existing authenticated official MCP client; reads only. */
export function recoveryReadFromMcp(client) {
  check(client && typeof client.call === 'function', 'RECOVERY_DATABASE_DEPENDENCY_INVALID');
  return async argumentsObject => {
    try {
      const result = await client.call('readNoSqlDatabaseContent', argumentsObject);
      check(result?.success === true && Array.isArray(result.data)
        && (result.collectionName === undefined || result.collectionName === argumentsObject.collectionName),
      'RECOVERY_DATABASE_READ_UNCONFIRMED');
      return result.data;
    } catch (error) {
      if (error?.[ERROR_BRAND]) throw error;
      fail('RECOVERY_DATABASE_READ_UNCONFIRMED');
    }
  };
}

/**
 * credentials: { WX_APP_SECRET, VPAY_SANDBOX_APP_KEY }.
 * dependencies.read({collectionName, query, projection, limit: 2}) -> rows[].
 * Optional request is a transport for tests; the route allowlist still applies.
 * Optional loadEvidence is a fixture loader for offline tests.
 * Resolves only safe booleans and fixed scope metadata; rejects with safeCode.
 * Never invokes a function, changes configuration, or writes records/files.
 */
export async function validateRecoveryWechatCredentials(credentials, { read, request, loadEvidence = loadLocalEvidence } = {}) {
  try {
    check(credentials && Object.keys(credentials).sort().join(',') === 'VPAY_SANDBOX_APP_KEY,WX_APP_SECRET'
      && Object.values(credentials).every(value => typeof value === 'string' && value.length >= 16 && value.length <= 128
        && value.trim() === value && !/[\r\n\x00]|REDACTED|MASKED|^\*+$/i.test(value)), 'RECOVERY_WECHAT_CREDENTIAL_INPUT_INVALID');
    check(typeof read === 'function' && typeof loadEvidence === 'function', 'RECOVERY_DATABASE_DEPENDENCY_INVALID');
    const { intent, state, intentSha256 } = await loadEvidence();
    check(intent?.envId === ENV_ID && intent.functionName === 'hlApi' && intent.userId === 1
      && intent.runId === RUN_ID && intent.documentId === DOCUMENT_ID && intent.planCode === 'vip_week'
      && intent.amountFen === 6160 && intent.durationDays === 7 && intent.sandbox === true
      && state?.status === 'closed_verified' && state.configurationVerified === true
      && state.otherEnvironmentValuesPreserved === true && /^[a-f0-9]{64}$/.test(intentSha256 || '')
      && state.intentSha256 === intentSha256, 'RECOVERY_CLOSED_EVIDENCE_INVALID');
    const readRows = async (collectionName, query, names) => {
      const rows = await read({ collectionName, query, projection: fields(names), limit: 2 });
      check(Array.isArray(rows) && rows.length === 1, 'RECOVERY_DATABASE_RECORD_NOT_UNIQUE');
      // Freeze a value snapshot even if a test/adapter later mutates its object.
      return JSON.parse(JSON.stringify(rows[0]));
    };
    const readOrder = () => readRows('hl_payment_orders', { _id: DOCUMENT_ID, userId: 1 }, ORDER_FIELDS);
    const order = await readOrder(), identity = paymentOrderIdentity();
    check(order._id === DOCUMENT_ID && order.userId === 1 && order.planCode === 'vip_week'
      && order.productType === 'vip' && order.membershipTier === 'vip' && order.amountFen === 6160 && order.durationDays === 7
      && order.paymentProvider === 'virtual' && order.virtualPaymentEnv === 1 && order.virtualPaymentOfferId === '1450674507'
      && order.paymentTestPlanCode === 'vip_week' && order.paymentTestRunId === RUN_ID
      && ['merchantId', 'appId', 'currency'].every(name => order[name] === identity[name])
      && /^[a-zA-Z0-9_-]{20,128}$/.test(order.payerOpenid || '')
      && typeof order.outTradeNo === 'string' && /^HLM\d{16,40}$/.test(order.outTradeNo)
      && Date.parse(order.createdAt) >= Date.parse(intent.createdAt) && Date.parse(order.createdAt) < Date.parse(intent.expiresAt),
    'RECOVERY_ORDER_SCOPE_MISMATCH');
    check(order.status === 'paid' && order.fulfillmentStatus === 'fulfilled' && !order.paymentReviewRequired && !order.reviewReason
      && order.virtualDeliveryStatus === 'confirmed' && /^[a-zA-Z0-9_-]{8,64}$/.test(order.transactionId || ''),
    'RECOVERY_ORDER_NOT_COMPLETED');
    const attempts = order.virtualPaymentAttempts;
    check(Array.isArray(attempts) && attempts.length >= 1 && attempts.length <= 10
      && new Set(attempts.map(attempt => attempt.outTradeNo)).size === attempts.length
      && attempts.every(attempt => /^HLA[a-f0-9]{24}$/.test(attempt.outTradeNo || '') && attempt.env === 1
        && attempt.offerId === '1450674507' && Date.parse(attempt.createdAt) >= Date.parse(intent.createdAt)
        && Date.parse(attempt.createdAt) < Date.parse(intent.expiresAt))
      && attempts.filter(attempt => attempt.outTradeNo === order.virtualPaidAttemptNo).length === 1
      && order.virtualDeliveryOrderNo === order.virtualPaidAttemptNo, 'RECOVERY_PAID_ATTEMPT_NOT_BOUND');
    const mappingQuery = { _id: `virtualPaymentAttempt_${order.virtualPaidAttemptNo}` };
    const readMapping = () => readRows('hl_counters', mappingQuery, MAPPING_FIELDS);
    const mapping = await readMapping();
    check(mapping._id === mappingQuery._id && mapping.orderDocumentId === DOCUMENT_ID
      && mapping.businessOutTradeNo === order.outTradeNo && mapping.env === 1 && mapping.offerId === '1450674507',
    'RECOVERY_ATTEMPT_MAPPING_MISMATCH');
    const api = createVirtualPaymentClient({ appId: identity.appId, request: createRecoveryReadOnlyRequest(request) });
    const provider = await api.queryOrder({ appSecret: credentials.WX_APP_SECRET, appKey: credentials.VPAY_SANDBOX_APP_KEY,
      openid: order.payerOpenid, env: 1, outTradeNo: order.virtualPaidAttemptNo });
    check(provider && mapVirtualOrderState(provider) === 'SUCCESS' && Number(provider.status) === 4,
      'RECOVERY_PROVIDER_ORDER_NOT_COMPLETED');
    let confirmation;
    try { confirmation = buildVirtualConfirmation({ ...order, outTradeNo: order.virtualPaidAttemptNo }, provider, 1, identity); }
    catch { fail('RECOVERY_PROVIDER_PAYMENT_MISMATCH'); }
    check(confirmation.outTradeNo === order.virtualPaidAttemptNo && confirmation.amountFen === 6160
      && confirmation.transactionId === order.transactionId, 'RECOVERY_PROVIDER_PAYMENT_MISMATCH');
    check(digest(await readOrder()) === digest(order) && digest(await readMapping()) === digest(mapping),
      'RECOVERY_READONLY_SNAPSHOT_CHANGED');
    return Object.freeze({ verified: true, readOnly: true, sandbox: true, amountFen: 6160,
      wechatAppSecretVerified: true, sandboxAppKeyVerified: true, providerCompleted: true,
      orderNumberMatched: true, transactionMatched: true, databaseSnapshotStable: true,
      configurationChangesRequested: false, databaseChangesRequested: false,
      cashierInvoked: false, fulfillmentInvoked: false, deliveryInvoked: false, refundOrCloseInvoked: false,
      sensitiveValuesReturned: false });
  } catch (error) {
    if (error?.[ERROR_BRAND]) throw error;
    fail('RECOVERY_WECHAT_CREDENTIAL_VALIDATION_FAILED');
  }
}
