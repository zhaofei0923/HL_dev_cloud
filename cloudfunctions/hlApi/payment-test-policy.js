'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_PLAN = Object.freeze({
  planCode: 'hl_payment_probe',
  title: '微信支付测试',
  description: '0.01元真实付款，支付核验成功后获得1天会员权益。',
  badge: '测试',
  amountFen: 1,
  priceText: '¥0.01',
  durationDays: 1,
  active: true,
  sortOrder: 0
});
const WEEK_TEST_PLAN = Object.freeze({
  planCode: 'vip_week', title: 'VIP周卡', productType: 'vip', membershipTier: 'vip',
  description: '沙箱验证VIP周卡，价格61.60元，服务端确认后获得7天VIP权益。',
  badge: '沙箱测试', amountFen: 6160, priceText: '¥61.60', durationDays: 7,
  serviceCount: 0, active: true, sortOrder: 0
});

function enabled(value) {
  return (value === true || (typeof value === 'string' && value.toLowerCase() === 'true'));
}

function positiveId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function explicitTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || (match[8] !== 'Z' && (Number(match[9]) > 23 || Number(match[10]) > 59))) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

function currentTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : NaN;
  return explicitTime(value);
}

// A run is an operator-owned sandbox batch, never a client-supplied option.
// Invalid configured values must not select the legacy one-time entry.
function paymentTestRunId(env = {}) {
  const vars = env && typeof env === 'object' ? env : {};
  const runId = vars.PAYMENT_TEST_RUN_ID;
  if (runId === undefined) return '';
  return typeof runId === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(runId) ? runId : null;
}

// Locating a document does not grant access; callers still use paymentTestAccess.
function paymentTestDocumentId(env = {}, userId) {
  const user = positiveId(userId);
  const runId = paymentTestRunId(env);
  if (user === null || runId === null) {
    const error = new Error('支付测试批次配置无效');
    error.code = 40001;
    throw error;
  }
  return `payment_probe_user_${user}${runId ? `_run_${runId}` : ''}`;
}

// Return only a boolean; never publish the test allowlist or its deadline.
function paymentTestAccess(env = {}, userId, now = Date.now()) {
  const vars = env && typeof env === 'object' ? env : {};
  const plan = paymentTestPlan(vars);
  if (!plan) return false;
  const runId = paymentTestRunId(vars);
  if (runId === null) return false;
  if (plan.planCode === WEEK_TEST_PLAN.planCode && (!runId || vars.VPAY_ENV !== '1'
    || (vars.PAYMENT_INTEGRATION_READY !== 'false' && vars.PAYMENT_INTEGRATION_READY !== false)
    || (vars.MATCHMAKING_PAYMENT_READY !== 'false' && vars.MATCHMAKING_PAYMENT_READY !== false))) return false;
  // The runtime's paymentProviderConfig already fixes the virtual channel.
  if (runId && (vars.VPAY_ENV !== '1'
    || (vars.PAYMENT_INTEGRATION_READY !== 'false' && vars.PAYMENT_INTEGRATION_READY !== false))) return false;
  if (enabled(vars.PAYMENT_INTEGRATION_READY) || !enabled(vars.PAYMENT_TEST_ENABLED)) return false;
  // Environment values must be canonical decimal text, as supplied by SCF.
  const allowed = typeof vars.PAYMENT_TEST_USER_ID === 'string' ? positiveId(vars.PAYMENT_TEST_USER_ID) : null;
  const requester = positiveId(userId);
  if (allowed === null || requester === null || allowed !== requester) return false;
  const expiresAt = explicitTime(vars.PAYMENT_TEST_EXPIRES_AT);
  const reference = currentTime(now);
  const remaining = expiresAt - reference;
  return Number.isFinite(expiresAt) && Number.isFinite(reference) && remaining > 0 && remaining <= DAY_MS;
}

// Only an active operator-owned sandbox run may exclude query compensation.
function paymentTestPushOnly(env = {}, order = {}, now = Date.now()) {
  const vars = env && typeof env === 'object' ? env : {};
  if (vars.PAYMENT_TEST_PUSH_ONLY !== 'true' || !paymentTestRunId(vars)
    || !order || typeof order !== 'object' || order.paymentProvider !== 'virtual'
    || order.virtualPaymentEnv !== 1 || !paymentTestAccess(vars, order.userId, now)) return false;
  if (paymentTestPlan(vars)?.planCode === WEEK_TEST_PLAN.planCode) {
    try { assertCurrentTestCheckout(order, vars); } catch { return false; }
  }
  return order._id === paymentTestDocumentId(vars, order.userId);
}

function paymentTestPlan(env = {}) {
  const vars = env && typeof env === 'object' ? env : {};
  if (vars.PAYMENT_TEST_PLAN_CODE === undefined) return { ...TEST_PLAN };
  return vars.PAYMENT_TEST_PLAN_CODE === WEEK_TEST_PLAN.planCode ? { ...WEEK_TEST_PLAN } : null;
}

// Historical settlement validates its own immutable contract, not whichever
// product an operator selects for a later window. Legacy probe orders retain
// their exact original promise; ordinary VIP-week orders are not test orders.
function assertTestCheckout(order = {}) {
  const row = order && typeof order === 'object' ? order : {};
  const plan = row.planCode === TEST_PLAN.planCode ? TEST_PLAN : WEEK_TEST_PLAN;
  const weekly = plan === WEEK_TEST_PLAN;
  const run = typeof row.paymentTestRunId === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(row.paymentTestRunId);
  if (row.planCode !== plan.planCode || row.planTitle !== plan.title
    || row.amountFen !== plan.amountFen || row.durationDays !== plan.durationDays
    || (weekly && (row.productType !== 'vip' || row.membershipTier !== 'vip'
      || (row.serviceCount !== undefined && row.serviceCount !== 0) || row.paymentProvider !== 'virtual' || row.virtualPaymentEnv !== 1
      || positiveId(row.userId) === null || row.paymentTestPlanCode !== WEEK_TEST_PLAN.planCode || !run))) {
    const error = new Error('测试支付订单无效');
    error.code = 40001;
    throw error;
  }
  return true;
}

// New cashiers must additionally belong to this account, selected product and
// exact current batch. This assertion never authorizes a payment by itself;
// runtime callers also recheck paymentTestAccess at every mutation boundary.
function assertCurrentTestCheckout(order = {}, env = {}) {
  assertTestCheckout(order);
  const vars = env && typeof env === 'object' ? env : {};
  const plan = paymentTestPlan(vars);
  const user = positiveId(vars.PAYMENT_TEST_USER_ID);
  if (!plan || user === null || positiveId(order.userId) !== user
    || order._id !== paymentTestDocumentId(vars, user)
    || order.planCode !== plan.planCode || order.planTitle !== plan.title
    || order.amountFen !== plan.amountFen || order.durationDays !== plan.durationDays
    || (plan.planCode === WEEK_TEST_PLAN.planCode && order.paymentTestRunId !== paymentTestRunId(vars))) {
    const error = new Error('测试支付订单与当前批次不匹配');
    error.code = 40001;
    throw error;
  }
  return true;
}

module.exports = { paymentTestAccess, paymentTestRunId, paymentTestDocumentId, paymentTestPushOnly,
  paymentTestPlan, assertTestCheckout, assertCurrentTestCheckout };
