'use strict';
const { assertPurchaseContract, isDirectPurchaseOrder } = require('./purchase-contract-policy');
const { MATCHMAKER_LIFETIME_PLAN, assertMatchmakerLifetimeProduct } = require('./matchmaker-activation-policy');

const ACTIVE_MEMBER_TYPES = new Set(['paid', 'vip']);
const DAY_MS = 24 * 60 * 60 * 1000;
const merchantConfig = require('./payment-merchant-config.json');

function paymentOrderIdentity(order = {}) {
  return Object.fromEntries(['merchantId', 'appId', 'currency'].map(field => [field,
    Object.prototype.hasOwnProperty.call(order, field) ? String(order[field]) : String(merchantConfig[field])
  ]));
}

function validationError(message) {
  const error = new Error(message);
  error.code = 40001;
  return error;
}

function normalizeMembershipPlan(row = {}, { requireActive = false } = {}) {
  const planCode = String(row.planCode || '').trim().toLowerCase();
  const title = String(row.title || '').trim();
  const amountFen = Number(row.amountFen);
  const durationDays = Number(row.durationDays);
  const productType = row.productType === undefined ? '' : String(row.productType);
  if (productType && !['vip', 'matchmaking', 'matchmaker'].includes(productType)) throw validationError('套餐商品类型无效');
  const matchmaker = productType === 'matchmaker';
  if (matchmaker || planCode === MATCHMAKER_LIFETIME_PLAN.planCode) assertMatchmakerLifetimeProduct(row);
  const serviceCount = Number(row.serviceCount);
  if (productType === 'matchmaking' && (!Number.isSafeInteger(serviceCount) || serviceCount <= 0 || serviceCount > 1000)) {
    throw validationError('牵线次数无效');
  }
  const active = row.active === true || row.active === 1 || row.active === '1' || row.active === 'true';

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(planCode)) throw validationError('套餐编码无效');
  if (!title || title.length > 40) throw validationError('套餐名称无效');
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 100000000) {
    throw validationError('套餐金额无效');
  }
  if (!matchmaker && (!Number.isSafeInteger(durationDays) || durationDays <= 0 || durationDays > 3650)) {
    throw validationError('套餐有效期无效');
  }
  if (requireActive && !active) throw validationError('套餐未启用');

  return {
    planCode,
    title,
    description: String(row.description || '').trim().slice(0, 120),
    badge: String(row.badge || '').trim().slice(0, 12),
    amountFen,
    priceText: `¥${(amountFen / 100).toFixed(2)}`,
    durationDays,
    ...(productType ? { productType, ...(matchmaker ? { lifetime: true, serviceCount: 0 }
      : productType === 'matchmaking' ? { serviceCount } : { membershipTier: 'vip' }) } : {}),
    active,
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : 0
  };
}

function paymentIntegrationConfig(env = {}) {
  const ready = String(env.PAYMENT_INTEGRATION_READY || '').toLowerCase() === 'true';
  const functionName = String(env.PAYMENT_FUNCTION_NAME || '').trim();
  const createPath = String(env.PAYMENT_CREATE_PATH || '').trim();
  const queryPath = String(env.PAYMENT_QUERY_PATH || '').trim();
  const callbackToken = String(env.PAYMENT_CALLBACK_TOKEN || '').trim();
  const configured = !!functionName && createPath.startsWith('/') && queryPath.startsWith('/')
    && callbackToken.length >= 32;
  const available = ready && configured;
  return {
    ...paymentOrderIdentity(),
    provider: 'jsapi',
    available,
    reason: available ? '' : (ready ? 'integration_incomplete' : 'merchant_not_configured'),
    functionName: configured ? functionName : '',
    createPath: available ? createPath : '',
    queryPath: configured ? queryPath : ''
  };
}

// VIP 与线上人工牵线的新购只开放小程序虚拟支付；配置缺项时关闭入口，
// 不回退旧 JSAPI 通道。不同商品的启用开关由调用方分别传入。
// 此处只读取公开配置形态，绝不向前端返回任何密钥。
function paymentProviderConfig(env = {}) {
  const offerId = String(env.VPAY_OFFER_ID || '').trim();
  const envMode = String(env.VPAY_ENV ?? '').trim();
  const validEnv = envMode === '0' || envMode === '1';
  const appKey = String((envMode === '1' ? env.VPAY_SANDBOX_APP_KEY
    : (envMode === '0' ? env.VPAY_APP_KEY : '')) || '').trim();
  const appSecret = String(env.WX_APP_SECRET || '').trim();
  const callbackToken = String(env.PAYMENT_CALLBACK_TOKEN || '').trim();
  const virtualConfigured = validEnv && /^\d{6,20}$/.test(offerId) && appKey.length >= 16 && appKey.length <= 128
    && appSecret.length >= 16 && appSecret.length <= 128 && callbackToken.length >= 32;
  const ready = String(env.PAYMENT_INTEGRATION_READY || '').toLowerCase() === 'true';
  const available = ready && virtualConfigured;
  return {
    ...paymentOrderIdentity(),
    provider: 'virtual',
    available,
    reason: available ? '' : (ready ? 'integration_incomplete' : 'merchant_not_configured'),
    functionName: '',
    createPath: '',
    queryPath: ''
  };
}

function createPendingPaymentOrder({
  id,
  outTradeNo,
  userId,
  memberRecordId,
  memberMatchmakerId,
  fulfillmentContract,
  payerOpenid,
  plan,
  now = new Date().toISOString()
} = {}) {
  const trustedPlan = normalizeMembershipPlan(plan, { requireActive: true });
  const orderNo = String(outTradeNo || '').trim();
  const openid = String(payerOpenid || '').trim();
  const contract = { fulfillmentContract, productType: trustedPlan.productType };
  assertPurchaseContract(contract);
  if (trustedPlan.productType === 'matchmaker' && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0
    || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
    || !/^[a-zA-Z0-9_-]{1,96}$/.test(orderNo))) throw validationError('支付订单参数无效');
  if (!orderNo || !Number(userId) || (!Number(memberRecordId) && trustedPlan.productType !== 'vip' && !isDirectPurchaseOrder(contract)) || !openid) {
    throw validationError('支付订单参数无效');
  }
  return {
    id: Number(id),
    outTradeNo: orderNo,
    userId: Number(userId),
    ...(fulfillmentContract ? { fulfillmentContract } : {}),
    memberRecordId: Number(memberRecordId),
    ...(Number.isSafeInteger(Number(memberMatchmakerId)) && Number(memberMatchmakerId) > 0
      ? { memberMatchmakerId: Number(memberMatchmakerId) } : {}),
    payerOpenid: openid,
    ...paymentOrderIdentity(),
    planCode: trustedPlan.planCode,
    planTitle: trustedPlan.title,
    amountFen: trustedPlan.amountFen,
    durationDays: trustedPlan.durationDays,
    ...(trustedPlan.productType ? { productType: trustedPlan.productType,
      ...(trustedPlan.productType === 'matchmaker' ? { lifetime: true, serviceCount: 0 }
        : trustedPlan.productType === 'matchmaking' ? { serviceCount: trustedPlan.serviceCount } : { membershipTier: 'vip' }) } : {}),
    status: 'pending',
    fulfillmentStatus: '',
    fulfillmentMessage: '',
    transactionId: '',
    paidAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function validTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isReusablePaymentOrder(order = {}, plan = {}) {
  if (order.productType === 'matchmaker' || plan.productType === 'matchmaker'
    || order.planCode === MATCHMAKER_LIFETIME_PLAN.planCode || plan.planCode === MATCHMAKER_LIFETIME_PLAN.planCode) {
    try {
      assertMatchmakerLifetimeProduct(order);
      assertMatchmakerLifetimeProduct(plan);
      assertPurchaseContract(order);
    } catch { return false; }
  }
  if (!['pending', 'confirming'].includes(String(order.status || ''))) return false;
  if (String(order.planCode || '') !== String(plan.planCode || '')) return false;
  if (Number(order.amountFen) !== Number(plan.amountFen)) return false;
  if (Number(order.durationDays) !== Number(plan.durationDays)) return false;
  // Only a trusted terminal result releases an unpaid order. An elapsed UI
  // window cannot prove that an earlier cashier or delayed payment has ended.
  return true;
}

function buildMembershipFulfillment({ member = {}, durationDays, now = new Date().toISOString() } = {}) {
  const days = Number(durationDays);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 3650) {
    throw validationError('套餐有效期无效');
  }
  const currentType = String(member.memberType || '').trim().toLowerCase();
  const rawExpiry = member.expireAt;
  const isLegacyLifetime = ACTIVE_MEMBER_TYPES.has(currentType)
    && (rawExpiry === null || rawExpiry === undefined || String(rawExpiry).trim() === '');
  if (isLegacyLifetime) {
    return {
      memberType: currentType,
      expireAt: null
    };
  }

  const nowTime = validTime(now) || Date.now();
  const currentExpiry = ACTIVE_MEMBER_TYPES.has(currentType) ? validTime(rawExpiry) : 0;
  const baseTime = currentExpiry > nowTime ? currentExpiry : nowTime;
  return {
    memberType: currentType === 'vip' ? 'vip' : 'paid',
    expireAt: new Date(baseTime + (days * DAY_MS)).toISOString()
  };
}

function paymentDetailsMatch(order = {}, confirmation = {}) {
  if (order.productType === 'matchmaker' || order.planCode === MATCHMAKER_LIFETIME_PLAN.planCode) {
    try { assertMatchmakerLifetimeProduct(order); assertPurchaseContract(order); }
    catch { return false; }
  }
  const identity = paymentOrderIdentity(order);
  const registered = paymentOrderIdentity();
  return Object.keys(registered).every(field => identity[field] === registered[field]
      && typeof confirmation[field] === 'string' && confirmation[field] === registered[field])
    && !!String(order.outTradeNo || '') && !!String(order.payerOpenid || '')
    && String(order.outTradeNo || '') === String(confirmation.outTradeNo || '')
    && String(order.payerOpenid || '') === String(confirmation.payerOpenid || '')
    && Number.isSafeInteger(Number(confirmation.amountFen)) && Number(confirmation.amountFen) > 0
    && Number(order.amountFen) === Number(confirmation.amountFen);
}

function paymentConfirmationMatches(order = {}, confirmation = {}) {
  return paymentDetailsMatch(order, confirmation)
    && String(confirmation.tradeState || '').toUpperCase() === 'SUCCESS';
}

module.exports = {
  MATCHMAKER_LIFETIME_PLAN,
  assertMatchmakerLifetimeProduct,
  buildMembershipFulfillment,
  createPendingPaymentOrder,
  isReusablePaymentOrder,
  normalizeMembershipPlan,
  paymentOrderIdentity,
  paymentDetailsMatch,
  paymentConfirmationMatches,
  paymentIntegrationConfig,
  paymentProviderConfig
};
