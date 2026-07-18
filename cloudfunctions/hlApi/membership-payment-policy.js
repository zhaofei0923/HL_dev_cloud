'use strict';

const ACTIVE_MEMBER_TYPES = new Set(['paid', 'vip']);
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const active = row.active === true || row.active === 1 || row.active === '1' || row.active === 'true';

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(planCode)) throw validationError('套餐编码无效');
  if (!title || title.length > 40) throw validationError('套餐名称无效');
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 100000000) {
    throw validationError('套餐金额无效');
  }
  if (!Number.isSafeInteger(durationDays) || durationDays <= 0 || durationDays > 3650) {
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
    active,
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : 0
  };
}

function paymentIntegrationConfig(env = {}) {
  const ready = String(env.PAYMENT_INTEGRATION_READY || '').toLowerCase() === 'true';
  const functionName = String(env.PAYMENT_FUNCTION_NAME || '').trim();
  const createPath = String(env.PAYMENT_CREATE_PATH || '').trim();
  const callbackToken = String(env.PAYMENT_CALLBACK_TOKEN || '').trim();
  const available = ready && !!functionName && createPath.startsWith('/') && callbackToken.length >= 32;
  return {
    available,
    reason: available ? '' : (ready ? 'integration_incomplete' : 'merchant_not_configured'),
    functionName: available ? functionName : '',
    createPath: available ? createPath : ''
  };
}

function createPendingPaymentOrder({
  id,
  outTradeNo,
  userId,
  memberRecordId,
  payerOpenid,
  plan,
  now = new Date().toISOString()
} = {}) {
  const trustedPlan = normalizeMembershipPlan(plan, { requireActive: true });
  const orderNo = String(outTradeNo || '').trim();
  const openid = String(payerOpenid || '').trim();
  if (!orderNo || !Number(userId) || !Number(memberRecordId) || !openid) {
    throw validationError('支付订单参数无效');
  }
  return {
    id: Number(id),
    outTradeNo: orderNo,
    userId: Number(userId),
    memberRecordId: Number(memberRecordId),
    payerOpenid: openid,
    planCode: trustedPlan.planCode,
    planTitle: trustedPlan.title,
    amountFen: trustedPlan.amountFen,
    durationDays: trustedPlan.durationDays,
    status: 'pending',
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

function isReusablePaymentOrder(order = {}, plan = {}, now = new Date().toISOString(), windowMs = 10 * 60 * 1000) {
  if (!['pending', 'confirming'].includes(String(order.status || ''))) return false;
  if (String(order.planCode || '') !== String(plan.planCode || '')) return false;
  if (Number(order.amountFen) !== Number(plan.amountFen)) return false;
  if (Number(order.durationDays) !== Number(plan.durationDays)) return false;
  const createdAt = validTime(order.createdAt);
  const referenceTime = validTime(now);
  const age = referenceTime - createdAt;
  return createdAt > 0 && referenceTime > 0 && age >= 0 && age <= windowMs;
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

function paymentConfirmationMatches(order = {}, confirmation = {}) {
  return String(order.outTradeNo || '') === String(confirmation.outTradeNo || '')
    && String(order.payerOpenid || '') === String(confirmation.payerOpenid || '')
    && Number(order.amountFen) === Number(confirmation.amountFen)
    && String(confirmation.tradeState || '').toUpperCase() === 'SUCCESS';
}

module.exports = {
  buildMembershipFulfillment,
  createPendingPaymentOrder,
  isReusablePaymentOrder,
  normalizeMembershipPlan,
  paymentConfirmationMatches,
  paymentIntegrationConfig
};
