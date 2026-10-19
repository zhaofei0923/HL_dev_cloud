const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MATCHMAKER_LIFETIME_PLAN, assertMatchmakerLifetimeProduct,
  normalizeMembershipPlan, createPendingPaymentOrder, isReusablePaymentOrder, paymentConfirmationMatches
} = require('../cloudfunctions/hlApi/membership-payment-policy');
const { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder, assertPurchaseContract }
  = require('../cloudfunctions/hlApi/purchase-contract-policy');
const { createVipMembershipService, DEFAULT_MEMBERSHIP_PLANS }
  = require('../cloudfunctions/hlApi/vip-membership-service');

const timestamp = '2026-10-19T10:00:00.000Z';
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');
function order(overrides = {}) {
  return { ...MATCHMAKER_LIFETIME_PLAN, id: 81, userId: 9, outTradeNo: 'HL_MATCHMAKER_81',
    fulfillmentContract: DIRECT_PURCHASE_CONTRACT, ...overrides };
}
function runtime(options = {}) {
  const transaction = { collection(name) {
    assert.equal(name, 'hl_users');
    return { doc(id) {
      assert.equal(id, 'user_9');
      return { async get() { return { data: { _id: 'user_9', id: 9, status: options.status ?? 1,
        ...(options.merged ? { mergedIntoUserId: 10 } : {}) } }; } };
    } };
  } };
  const writes = [];
  const service = createVipMembershipService({ db: {}, getAll: async () => [], getOne: async () => null,
    getById: async (name, id) => name === 'hl_users' && id === 9 ? { _id: 'user_9', id: 9, status: 1 } : null,
    now: () => timestamp, ...(options.dependencies || {}) });
  return { service, transaction, writes };
}

test('principal lifetime product is immutable, exact priced, unlimited and separate from VIP catalog', () => {
  assert.equal(Object.isFrozen(MATCHMAKER_LIFETIME_PLAN), true);
  assert.equal(MATCHMAKER_LIFETIME_PLAN.amountFen, 698000);
  assert.equal(MATCHMAKER_LIFETIME_PLAN.durationDays, 0);
  assert.equal(MATCHMAKER_LIFETIME_PLAN.lifetime, true);
  assert.equal(MATCHMAKER_LIFETIME_PLAN.serviceCount, 0);
  assert.equal(DEFAULT_MEMBERSHIP_PLANS.length, 6);
  assert.ok(DEFAULT_MEMBERSHIP_PLANS.every(plan => plan.productType !== 'matchmaker'));
  assert.equal(assertMatchmakerLifetimeProduct(MATCHMAKER_LIFETIME_PLAN), true);
  const plan = normalizeMembershipPlan(MATCHMAKER_LIFETIME_PLAN, { requireActive: true });
  assert.equal(plan.priceText, '¥6980.00');
  assert.equal(plan.lifetime, true);
  assert.equal(Object.hasOwn(plan, 'membershipTier'), false);
});

test('principal plan refuses altered price, product, duration, lifetime, service count and reserved code reuse', () => {
  for (const [field, values] of Object.entries({ amountFen: [1, 6980, 698001, '698000'],
    durationDays: [1, 3650, '0', null], lifetime: [false, undefined, 1, 'true'],
    serviceCount: [1, undefined, '0'], productType: ['vip', 'matchmaking', undefined],
    planCode: ['vip_year', 'matchmaker_month', 'MATCHMAKER_LIFETIME'] })) {
    for (const value of values) {
      const row = { ...MATCHMAKER_LIFETIME_PLAN, [field]: value };
      assert.throws(() => assertMatchmakerLifetimeProduct(row), error => error.code === 40001, `${field}:${value}`);
      assert.throws(() => normalizeMembershipPlan(row, { requireActive: true }), /主理人|套餐/, `${field}:${value}`);
    }
  }
  assert.throws(() => normalizeMembershipPlan({ ...MATCHMAKER_LIFETIME_PLAN, active: false }, { requireActive: true }), /未启用/);
  assert.throws(() => normalizeMembershipPlan({ ...MATCHMAKER_LIFETIME_PLAN, productType: 'vip', planCode: 'vip_lifetime' }), /有效期/);
});

test('new principal checkout is user-owned and persists zero duration without granting VIP or matchmaking', () => {
  const plan = { ...MATCHMAKER_LIFETIME_PLAN };
  const snapshot = structuredClone(plan);
  const pending = createPendingPaymentOrder({ id: 81, outTradeNo: 'HL_MATCHMAKER_81', userId: 9,
    memberRecordId: 0, payerOpenid: 'openid-9', fulfillmentContract: DIRECT_PURCHASE_CONTRACT, plan, now: timestamp });
  assert.equal(pending.productType, 'matchmaker');
  assert.equal(pending.amountFen, 698000);
  assert.equal(pending.durationDays, 0);
  assert.equal(pending.lifetime, true);
  assert.equal(pending.serviceCount, 0);
  assert.equal(pending.memberRecordId, 0);
  assert.equal(pending.fulfillmentStatus, '');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.paidAt, null);
  assert.equal(Object.hasOwn(pending, 'membershipTier'), false);
  assert.deepEqual(plan, snapshot);
  for (const marker of [undefined, '', 'admin_approval_v1']) {
    assert.throws(() => createPendingPaymentOrder({ id: 81, outTradeNo: 'HL_MATCHMAKER_81', userId: 9,
      memberRecordId: 12, payerOpenid: 'openid-9', fulfillmentContract: marker, plan, now: timestamp }),
    error => error.code === 40907);
  }
});

test('principal orders cannot use historical assignment contract or unknown direct product', () => {
  assert.equal(isDirectPurchaseOrder(order()), true);
  assert.equal(assertPurchaseContract(order()), true);
  assert.throws(() => assertPurchaseContract(order({ fulfillmentContract: undefined })), error => error.code === 40907);
  assert.equal(isDirectPurchaseOrder({ ...order(), productType: 'admin' }), false);
  assert.throws(() => assertPurchaseContract({ ...order(), productType: 'admin' }), error => error.code === 40907);
  assert.equal(assertPurchaseContract({ productType: 'vip' }), false, 'historical VIP contract is retained');
});

test('principal checkout rejects invalid user or order identity before payment creation', () => {
  const args = { id: 81, outTradeNo: 'HL_MATCHMAKER_81', userId: 9, memberRecordId: 0,
    payerOpenid: 'openid-9', fulfillmentContract: DIRECT_PURCHASE_CONTRACT,
    plan: MATCHMAKER_LIFETIME_PLAN, now: timestamp };
  for (const overrides of [{ id: 0 }, { id: 1.5 }, { userId: 0 }, { userId: 1.5 },
    { outTradeNo: 'invalid / order' }, { payerOpenid: '' }]) {
    assert.throws(() => createPendingPaymentOrder({ ...args, ...overrides }), error => error.code === 40001);
  }
});

test('confirmation refuses tampered principal order even when provider echoes the altered price', () => {
  const pending = order({ payerOpenid: 'openid-9' });
  const confirmation = { outTradeNo: pending.outTradeNo, payerOpenid: 'openid-9', amountFen: 698000,
    merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency, tradeState: 'SUCCESS' };
  assert.equal(paymentConfirmationMatches(pending, confirmation), true);
  assert.equal(paymentConfirmationMatches({ ...pending, amountFen: 1 }, { ...confirmation, amountFen: 1 }), false);
  assert.equal(paymentConfirmationMatches({ ...pending, lifetime: false }, confirmation), false);
  assert.equal(paymentConfirmationMatches({ ...pending, fulfillmentContract: undefined }, confirmation), false);
});

test('principal unpaid order reuse requires the immutable lifetime product and direct contract', () => {
  const pending = order({ status: 'pending' });
  assert.equal(isReusablePaymentOrder(pending, MATCHMAKER_LIFETIME_PLAN), true);
  assert.equal(isReusablePaymentOrder({ ...pending, status: 'confirming' }, MATCHMAKER_LIFETIME_PLAN), true);
  for (const overrides of [{ amountFen: 1 }, { lifetime: false }, { productType: 'vip' },
    { durationDays: 365 }, { serviceCount: 1 }, { fulfillmentContract: undefined }, { status: 'paid' }]) {
    assert.equal(isReusablePaymentOrder({ ...pending, ...overrides }, MATCHMAKER_LIFETIME_PLAN), false);
  }
  assert.equal(isReusablePaymentOrder(pending, { ...MATCHMAKER_LIFETIME_PLAN, lifetime: false }), false);
});

test('principal fulfillment and refund delegate the same transaction and exact trusted order to role service', async () => {
  const calls = [];
  const r = runtime({ dependencies: {
    fulfillMatchmaker: async (...args) => { calls.push(['fulfill', ...args]); return { active: true, lifetime: true, expireAt: null }; },
    refundMatchmaker: async (...args) => { calls.push(['refund', ...args]); return { revoked: true }; }
  } });
  const trusted = order();
  const snapshot = structuredClone(trusted);
  assert.deepEqual(await r.service.fulfillOrder(r.transaction, trusted, timestamp), { active: true, lifetime: true, expireAt: null });
  assert.deepEqual(await r.service.refundOrder(r.transaction, trusted, timestamp), { revoked: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call[1], r.transaction);
    assert.equal(call[2], trusted);
    assert.equal(call[3], timestamp);
  }
  assert.deepEqual(trusted, snapshot);
});

test('principal fulfillment and refund fail closed without installed role hooks', async () => {
  const r = runtime();
  await assert.rejects(r.service.fulfillOrder(r.transaction, order(), timestamp), error => error.status === 503 && error.code === 50301);
  await assert.rejects(r.service.refundOrder(r.transaction, order(), timestamp), error => error.status === 503 && error.code === 50301);
});

test('tampered principal payment snapshot never reaches fulfillment or refund hook', async () => {
  let calls = 0;
  const r = runtime({ dependencies: { fulfillMatchmaker: async () => { calls += 1; },
    refundMatchmaker: async () => { calls += 1; } } });
  for (const overrides of [{ amountFen: 1 }, { amountFen: '698000' }, { lifetime: false }, { lifetime: undefined },
    { planCode: 'matchmaker_other' }, { durationDays: 365 }, { serviceCount: 1 },
    { productType: 'vip', durationDays: 365 }, { productType: 'matchmaking', durationDays: 30, serviceCount: 2 },
    { fulfillmentContract: undefined }, { userId: 0 }, { userId: 1.5 }, { outTradeNo: 'invalid / order' }]) {
    await assert.rejects(r.service.fulfillOrder(r.transaction, order(overrides), timestamp), /无效/);
    await assert.rejects(r.service.refundOrder(r.transaction, order(overrides), timestamp), /无效/);
  }
  assert.equal(calls, 0);
});

test('disabled or merged principal account cannot gain role from payment fulfillment', async () => {
  for (const flags of [{ status: 0 }, { merged: true }]) {
    let calls = 0;
    const r = runtime({ ...flags, dependencies: { fulfillMatchmaker: async () => { calls += 1; } } });
    await assert.rejects(r.service.fulfillOrder(r.transaction, order(), timestamp), error => error.code === 40304);
    assert.equal(calls, 0);
  }
});
