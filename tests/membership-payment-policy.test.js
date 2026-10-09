const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMembershipFulfillment,
  createPendingPaymentOrder,
  isReusablePaymentOrder,
  normalizeMembershipPlan,
  paymentConfirmationMatches,
  paymentIntegrationConfig
} = require('../cloudfunctions/hlApi/membership-payment-policy');
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };

const now = '2026-07-18T00:00:00.000Z';

test('membership plan owns the trusted amount and duration', () => {
  const plan = normalizeMembershipPlan({
    planCode: 'paid_90d',
    title: '三个月会员',
    amountFen: 29900,
    durationDays: 90,
    active: true,
    sortOrder: 10
  });
  const order = createPendingPaymentOrder({
    id: 31,
    outTradeNo: 'HL202607180001',
    userId: 9,
    memberRecordId: 12,
    payerOpenid: 'openid-9',
    plan,
    now
  });

  assert.equal(order.amountFen, 29900);
  assert.equal(order.durationDays, 90);
  assert.equal(order.planCode, 'paid_90d');
  assert.equal(order.status, 'pending');
  for (const [field, value] of Object.entries(identity)) assert.equal(order[field], value);
  assert.equal(Object.hasOwn(order, 'clientAmountFen'), false);
});

test('invalid or inactive plans cannot create a checkout', () => {
  assert.throws(() => normalizeMembershipPlan({
    planCode: 'bad plan',
    title: '错误套餐',
    amountFen: 0,
    durationDays: -1,
    active: true
  }), /套餐/);
  assert.throws(() => normalizeMembershipPlan({
    planCode: 'paid_30d',
    title: '一个月会员',
    amountFen: 9900,
    durationDays: 30,
    active: false
  }, { requireActive: true }), /未启用/);
});

test('payment integration stays disabled until every external setting exists', () => {
  assert.deepEqual(paymentIntegrationConfig({}), {
    ...identity,
    available: false,
    reason: 'merchant_not_configured',
    functionName: '',
    createPath: '',
    queryPath: ''
  });
  assert.deepEqual(paymentIntegrationConfig({
    PAYMENT_INTEGRATION_READY: 'true',
    PAYMENT_FUNCTION_NAME: 'generated-payment-function',
    PAYMENT_CREATE_PATH: '/member-pay/create',
    PAYMENT_QUERY_PATH: '/member-pay/query',
    PAYMENT_CALLBACK_TOKEN: 'x'.repeat(32)
  }), {
    ...identity,
    available: true,
    reason: '',
    functionName: 'generated-payment-function',
    createPath: '/member-pay/create',
    queryPath: '/member-pay/query'
  });
  assert.equal(paymentIntegrationConfig({
    PAYMENT_INTEGRATION_READY: 'true',
    PAYMENT_FUNCTION_NAME: 'generated-payment-function',
    PAYMENT_CREATE_PATH: '/member-pay/create',
    PAYMENT_CALLBACK_TOKEN: 'too-short'
  }).available, false);
  assert.equal(paymentIntegrationConfig({
    PAYMENT_INTEGRATION_READY: 'true', PAYMENT_FUNCTION_NAME: 'generated-payment-function',
    PAYMENT_CREATE_PATH: '/member-pay/create', PAYMENT_CALLBACK_TOKEN: 'x'.repeat(32)
  }).available, false, 'a missing trusted query route must keep payments unavailable');
});

test('maintenance disables new checkouts but preserves the configured route for existing-order queries', () => {
  const env = {
    PAYMENT_INTEGRATION_READY: 'false', PAYMENT_FUNCTION_NAME: 'generated-payment-function',
    PAYMENT_CREATE_PATH: '/member-pay/create', PAYMENT_QUERY_PATH: '/member-pay/query',
    PAYMENT_CALLBACK_TOKEN: 'x'.repeat(32)
  };
  assert.deepEqual(paymentIntegrationConfig(env), {
    ...identity, available: false, reason: 'merchant_not_configured',
    functionName: 'generated-payment-function', createPath: '', queryPath: '/member-pay/query'
  });
  for (const field of ['PAYMENT_FUNCTION_NAME', 'PAYMENT_CREATE_PATH', 'PAYMENT_QUERY_PATH', 'PAYMENT_CALLBACK_TOKEN']) {
    const config = paymentIntegrationConfig({ ...env, [field]: '' });
    assert.equal(config.available, false);
    assert.equal(config.functionName, '');
    assert.equal(config.createPath, '');
    assert.equal(config.queryPath, '');
  }
});

test('renewal extends a future expiry and never shortens lifetime memberships', () => {
  const future = buildMembershipFulfillment({
    member: { memberType: 'paid', expireAt: '2026-08-01T00:00:00.000Z' },
    durationDays: 30,
    now
  });
  assert.equal(future.memberType, 'paid');
  assert.equal(future.expireAt, '2026-08-31T00:00:00.000Z');

  const expired = buildMembershipFulfillment({
    member: { memberType: 'free', expireAt: '2026-01-01T00:00:00.000Z' },
    durationDays: 30,
    now
  });
  assert.equal(expired.expireAt, '2026-08-17T00:00:00.000Z');

  const freeWithStaleFutureDate = buildMembershipFulfillment({
    member: { memberType: 'free', expireAt: '2026-12-01T00:00:00.000Z' },
    durationDays: 30,
    now
  });
  assert.equal(freeWithStaleFutureDate.expireAt, '2026-08-17T00:00:00.000Z');

  const lifetime = buildMembershipFulfillment({
    member: { memberType: 'vip', expireAt: null },
    durationDays: 30,
    now
  });
  assert.equal(lifetime.memberType, 'vip');
  assert.equal(lifetime.expireAt, null);
});

test('payment confirmation must match order, user identity, amount, and success state', () => {
  const order = {
    outTradeNo: 'HL202607180001',
    payerOpenid: 'openid-9',
    amountFen: 29900
  };
  assert.equal(paymentConfirmationMatches(order, {
    ...identity,
    outTradeNo: 'HL202607180001',
    payerOpenid: 'openid-9',
    amountFen: 29900,
    tradeState: 'SUCCESS'
  }), true);
  assert.equal(paymentConfirmationMatches(order, {
    ...identity,
    outTradeNo: 'HL202607180001',
    payerOpenid: 'openid-9',
    amountFen: 1,
    tradeState: 'SUCCESS'
  }), false);
  assert.equal(paymentConfirmationMatches(order, {
    ...identity,
    outTradeNo: 'HL202607180001',
    payerOpenid: 'openid-9',
    amountFen: 29900,
    tradeState: 'NOTPAY'
  }), false);
});

test('confirmation requires every registered identity field and rejects conflicting order snapshots', () => {
  const order = { outTradeNo: 'HL202607180001', payerOpenid: 'openid-9', amountFen: 29900 };
  const confirmation = { ...order, ...identity, tradeState: 'SUCCESS' };
  for (const field of Object.keys(identity)) {
    const missing = { ...confirmation }; delete missing[field];
    assert.equal(paymentConfirmationMatches(order, missing), false);
    for (const invalid of ['', null, 'different-value']) {
      assert.equal(paymentConfirmationMatches(order, { ...confirmation, [field]: invalid }), false);
      assert.equal(paymentConfirmationMatches({ ...order, [field]: invalid }, confirmation), false);
    }
  }
  assert.equal(paymentConfirmationMatches({ ...order, ...identity }, confirmation), true);
  assert.equal(paymentConfirmationMatches(order, confirmation), true, 'only legacy missing snapshot fields use registered identity');
});

test('recent matching pending orders can be reused without duplicating checkout records', () => {
  const plan = { planCode: 'paid_90d', amountFen: 29900, durationDays: 90 };
  const pending = {
    status: 'pending',
    planCode: 'paid_90d',
    amountFen: 29900,
    durationDays: 90,
    createdAt: '2026-07-18T00:05:00.000Z'
  };
  assert.equal(isReusablePaymentOrder(pending, plan, '2026-07-18T00:10:00.000Z'), true);
  assert.equal(isReusablePaymentOrder({ ...pending, status: 'paid' }, plan, '2026-07-18T00:10:00.000Z'), false);
  assert.equal(isReusablePaymentOrder({ ...pending, amountFen: 1 }, plan, '2026-07-18T00:10:00.000Z'), false);
  assert.equal(isReusablePaymentOrder(pending, plan, '2026-07-18T00:20:01.000Z'), false);
});
