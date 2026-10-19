'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentTestAccess, paymentTestRunId, paymentTestDocumentId, paymentTestPushOnly, paymentTestPlan,
  assertTestCheckout, assertCurrentTestCheckout } = require('../cloudfunctions/hlApi/payment-test-policy');
const { createPendingPaymentOrder } = require('../cloudfunctions/hlApi/membership-payment-policy');

const NOW = '2026-10-09T10:00:00+08:00';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

function environment(patch = {}) {
  return {
    PAYMENT_INTEGRATION_READY: 'false',
    PAYMENT_TEST_ENABLED: 'true',
    PAYMENT_TEST_USER_ID: '9',
    PAYMENT_TEST_EXPIRES_AT: '2026-10-09T18:00:00+08:00',
    ...patch
  };
}

function checkout(patch = {}) {
  return { planCode: 'hl_payment_probe', planTitle: '微信支付测试', amountFen: 1, durationDays: 1, ...patch };
}

test('only the designated account can access the controlled payment probe', () => {
  assert.equal(paymentTestAccess(environment(), 9, NOW), true);
  assert.equal(paymentTestAccess(environment(), '9', NOW), true);
  assert.equal(paymentTestAccess(environment(), 10, NOW), false);
  assert.equal(paymentTestAccess(environment(), undefined, NOW), false);
  assert.equal(paymentTestAccess({}, 9, NOW), false);
  assert.equal(paymentTestAccess(null, 9, NOW), false);
});

test('operator-owned run keys select a separate document and invalid keys never fall back to the legacy probe', () => {
  assert.equal(paymentTestRunId(environment()), '');
  assert.equal(paymentTestDocumentId(environment(), 9), 'payment_probe_user_9');
  for (const runId of ['a', 'push_20261011_2127', 'sandbox-check', 'a'.repeat(32)]) {
    const env = environment({ PAYMENT_TEST_RUN_ID: runId });
    assert.equal(paymentTestRunId(env), runId);
    assert.equal(paymentTestDocumentId(env, '9'), `payment_probe_user_9_run_${runId}`);
  }
  for (const runId of ['', ' push', 'push ', 'push\n', 'Push', '1push', '../push', 'push/run',
    'a'.repeat(33), 1, true, null, {}, []]) {
    const env = environment({ PAYMENT_TEST_RUN_ID: runId });
    assert.equal(paymentTestRunId(env), null);
    assert.equal(paymentTestAccess(env, 9, NOW), false);
    assert.throws(() => paymentTestDocumentId(env, 9), error => error.code === 40001);
  }
  for (const userId of [0, '09', -1, NaN, undefined]) {
    assert.throws(() => paymentTestDocumentId(environment(), userId), error => error.code === 40001);
  }
});

test('repeat runs require explicit sandbox mode and retain account and short-window restrictions', () => {
  const runEnv = environment({ PAYMENT_TEST_RUN_ID: 'push_20261011_2127', VPAY_ENV: '1' });
  assert.equal(paymentTestAccess(runEnv, 9, NOW), true);
  assert.equal(paymentTestAccess({ ...runEnv, PAYMENT_INTEGRATION_READY: false }, 9, NOW), true);
  for (const patch of [
    { VPAY_ENV: '0' }, { VPAY_ENV: 1 }, { VPAY_ENV: ' 1' }, { VPAY_ENV: undefined },
    { PAYMENT_INTEGRATION_READY: 'true' }, { PAYMENT_INTEGRATION_READY: undefined }, { PAYMENT_INTEGRATION_READY: '' },
    { PAYMENT_TEST_ENABLED: 'false' }, { PAYMENT_TEST_USER_ID: '10' },
    { PAYMENT_TEST_EXPIRES_AT: NOW },
    { PAYMENT_TEST_EXPIRES_AT: new Date(NOW_MS + DAY_MS + 1).toISOString() }
  ]) assert.equal(paymentTestAccess({ ...runEnv, ...patch }, 9, NOW), false);
  assert.equal(paymentTestAccess(runEnv, 10, NOW), false);
});

test('push-only isolation applies only to the exact current active sandbox-run document', () => {
  const env = environment({ PAYMENT_TEST_RUN_ID: 'push_20261011_2127', PAYMENT_TEST_PUSH_ONLY: 'true',
    VPAY_ENV: '1' });
  const order = { _id: paymentTestDocumentId(env, 9), userId: 9, paymentProvider: 'virtual', virtualPaymentEnv: 1 };
  assert.equal(paymentTestPushOnly(env, order, NOW), true);
  for (const patch of [{ PAYMENT_TEST_PUSH_ONLY: 'false' }, { PAYMENT_TEST_PUSH_ONLY: undefined },
    { PAYMENT_TEST_RUN_ID: undefined }, { PAYMENT_TEST_RUN_ID: 'another_run' }, { PAYMENT_TEST_RUN_ID: '../run' },
    { VPAY_ENV: '0' }, { PAYMENT_INTEGRATION_READY: 'true' }, { PAYMENT_TEST_ENABLED: 'false' },
    { PAYMENT_TEST_EXPIRES_AT: NOW }]) {
    assert.equal(paymentTestPushOnly({ ...env, ...patch }, order, NOW), false);
  }
  for (const patch of [{ _id: 'payment_probe_user_9' }, { userId: 10 },
    { paymentProvider: 'jsapi' }, { virtualPaymentEnv: 0 }]) {
    assert.equal(paymentTestPushOnly(env, { ...order, ...patch }, NOW), false);
  }
});

test('ordinary payment readiness always disables the test plan regardless of its allowlist', () => {
  for (const value of ['true', 'TRUE', true]) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_INTEGRATION_READY: value }), 9, NOW), false);
  }
  for (const value of ['', 'false', false, 1, '1', ' true ', undefined]) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_ENABLED: value }), 9, NOW), false);
  }
  assert.equal(paymentTestAccess(environment({ PAYMENT_INTEGRATION_READY: undefined }), 9, NOW), true);
});

test('the allowlisted environment ID must be a canonical safe positive integer string', () => {
  for (const value of ['', '0', '-9', '+9', '09', '9.0', '9e0', '9 ', ' 9', '9\n',
    '9,10', '9|10', '9007199254740992', 9, true, undefined, null]) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_USER_ID: value }), 9, NOW), false);
  }
  for (const value of [0, -9, 9.1, NaN, Infinity, '09', '9.0', ' 9', '9\n', true]) {
    assert.equal(paymentTestAccess(environment(), value, NOW), false);
  }
});

test('expiry boundaries include exactly 24 hours and exclude elapsed or overly long windows', () => {
  for (const delta of [1, DAY_MS]) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: new Date(NOW_MS + delta).toISOString() }), 9, NOW_MS), true);
  }
  for (const delta of [-1, 0, DAY_MS + 1]) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: new Date(NOW_MS + delta).toISOString() }), 9, NOW_MS), false);
  }
  assert.equal(paymentTestAccess(environment(), 9, new Date(NOW)), true);
});

test('deadlines require an explicit timezone, valid calendar date and valid clock components', () => {
  for (const value of ['', '2026-10-09', '2026-10-09T18:00:00', '2026-10-09 18:00:00',
    '2026-10-09T18:00:00+0800', '2026-10-09T24:00:00+08:00',
    '2026-10-09T18:60:00+08:00', '2026-10-09T18:00:60+08:00',
    '2026-10-09T18:00:00+24:00', '2026-10-09T18:00:00+08:60',
    '2026-13-09T18:00:00+08:00', '2026-10-00T18:00:00+08:00',
    '2026-10-09T18:00:00+08:00\n', 'not-a-date']) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: value }), 9, NOW), false);
  }
  for (const [deadline, reference] of [
    ['2026-02-29T01:00:00Z', '2026-02-28T12:00:00Z'],
    ['2026-02-30T01:00:00Z', '2026-03-01T12:00:00Z'],
    ['2026-04-31T01:00:00Z', '2026-04-30T12:00:00Z']
  ]) assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: deadline }), 9, reference), false);
  assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: '2028-02-29T01:00:00Z' }), 9, '2028-02-28T12:00:00Z'), true);
});

test('timezone offsets are compared as instants and invalid current times fail closed', () => {
  for (const expiry of ['2026-10-09T10:00:00Z', '2026-10-09T18:00:00+08:00', '2026-10-09T05:00:00-05:00']) {
    assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_EXPIRES_AT: expiry }), 9, NOW), true);
  }
  for (const reference of ['invalid', '2026-10-09T10:00:00', NaN, Infinity, new Date(NaN), null]) {
    assert.equal(paymentTestAccess(environment(), 9, reference), false);
  }
});

test('test plans are fresh fixed snapshots with explicit real-payment and fulfillment copy', () => {
  const first = paymentTestPlan();
  assert.equal(first.planCode, 'hl_payment_probe');
  assert.equal(first.title, '微信支付测试');
  assert.equal(first.amountFen, 1);
  assert.equal(first.durationDays, 1);
  assert.equal(first.priceText, '¥0.01');
  assert.match(first.description, /0\.01元真实付款/);
  assert.match(first.description, /1天会员权益/);
  first.amountFen = 29900;
  first.durationDays = 90;
  assert.equal(paymentTestPlan().amountFen, 1);
  assert.equal(paymentTestPlan().durationDays, 1);
  assert.notEqual(paymentTestPlan(), paymentTestPlan());
  assert.doesNotMatch(JSON.stringify(paymentTestPlan()), /USER_ID|EXPIRES_AT|TOKEN|allowlist|expiresAt/);
  assert.equal(typeof paymentTestAccess(environment(), 9, NOW), 'boolean');
});

test('test checkout validation accepts the actual business-order snapshot shape', () => {
  const order = createPendingPaymentOrder({ id: 1, outTradeNo: 'HLMTEST00000001', userId: 9,
    memberRecordId: 12, payerOpenid: 'fixture-openid', plan: paymentTestPlan(), now: NOW });
  assert.equal(assertTestCheckout(order), true);
});

test('modified amounts, durations, plan identities and titles cannot pass test checkout', () => {
  for (const patch of [{ amountFen: 0 }, { amountFen: 100 }, { amountFen: '1' }, { amountFen: NaN },
    { durationDays: 0 }, { durationDays: 90 }, { durationDays: '1' },
    { planCode: 'paid_30d' }, { planCode: 'HL_PAYMENT_PROBE' }, { planCode: '' },
    { planTitle: '三个月会员' }, { planTitle: '' }]) {
    assert.throws(() => assertTestCheckout(checkout(patch)), error => {
      assert.equal(error.message, '测试支付订单无效');
      assert.equal(error.code, 40001);
      return true;
    });
  }
  for (const value of [undefined, null, {}, 'not-an-order']) assert.throws(() => assertTestCheckout(value));
});

test('failure diagnostics never include supplied order content or secret environment values', () => {
  const sentinel = 'private-variable-or-order-sentinel';
  assert.throws(() => assertTestCheckout(checkout({ planCode: sentinel, amountFen: sentinel, callbackToken: sentinel })), error => {
    assert.ok(!String(error.stack).includes(sentinel));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(paymentTestAccess(environment({ PAYMENT_TEST_USER_ID: sentinel, PAYMENT_CALLBACK_TOKEN: sentinel }), 9, NOW), false);
});

function weeklyEnvironment(patch = {}) {
  return environment({ PAYMENT_TEST_PLAN_CODE: 'vip_week', PAYMENT_TEST_RUN_ID: 'week_20261013',
    VPAY_ENV: '1', MATCHMAKING_PAYMENT_READY: 'false', ...patch });
}
function weeklyCheckout(patch = {}) {
  return { _id: paymentTestDocumentId(weeklyEnvironment(), 9), userId: 9,
    planCode: 'vip_week', planTitle: 'VIP周卡', amountFen: 6160, durationDays: 7,
    productType: 'vip', membershipTier: 'vip', paymentProvider: 'virtual', virtualPaymentEnv: 1,
    paymentTestPlanCode: 'vip_week', paymentTestRunId: 'week_20261013', ...patch };
}

test('weekly selector is operator-only, exact, fixed-price, and invalid values never select the old probe', () => {
  const plan = paymentTestPlan(weeklyEnvironment());
  assert.deepEqual([plan.planCode, plan.title, plan.amountFen, plan.durationDays, plan.productType, plan.membershipTier],
    ['vip_week', 'VIP周卡', 6160, 7, 'vip', 'vip']);
  plan.amountFen = 1;
  assert.equal(paymentTestPlan(weeklyEnvironment()).amountFen, 6160);
  for (const value of ['', null, true, 1, 'hl_payment_probe', 'vip_month', 'VIP_WEEK', ' vip_week', 'vip_week\n', {}, []]) {
    const env = weeklyEnvironment({ PAYMENT_TEST_PLAN_CODE: value });
    assert.equal(paymentTestPlan(env), null);
    assert.equal(paymentTestAccess(env, 9, NOW), false);
  }
  assert.equal(paymentTestPlan(environment()).planCode, 'hl_payment_probe');
});

test('weekly access requires one current account, a nonempty run, sandbox, both formal gates closed and a short future deadline', () => {
  assert.equal(paymentTestAccess(weeklyEnvironment(), 9, NOW), true);
  assert.equal(paymentTestAccess(weeklyEnvironment(), 10, NOW), false);
  for (const patch of [{ PAYMENT_TEST_RUN_ID: undefined }, { PAYMENT_TEST_RUN_ID: '' }, { PAYMENT_TEST_RUN_ID: '../run' },
    { VPAY_ENV: '0' }, { VPAY_ENV: 1 }, { VPAY_ENV: undefined },
    { PAYMENT_INTEGRATION_READY: undefined }, { PAYMENT_INTEGRATION_READY: 'true' },
    { MATCHMAKING_PAYMENT_READY: undefined }, { MATCHMAKING_PAYMENT_READY: 'true' }, { MATCHMAKING_PAYMENT_READY: '' },
    { PAYMENT_TEST_USER_ID: '10' }, { PAYMENT_TEST_EXPIRES_AT: NOW },
    { PAYMENT_TEST_EXPIRES_AT: new Date(NOW_MS + DAY_MS + 1).toISOString() }]) {
    assert.equal(paymentTestAccess(weeklyEnvironment(patch), 9, NOW), false);
  }
});

test('weekly current checkout binds the exact protected batch while historical validation remains independent of current selection', () => {
  const order = weeklyCheckout();
  assert.equal(assertCurrentTestCheckout(order, weeklyEnvironment()), true);
  assert.equal(assertTestCheckout(order), true);
  assert.equal(assertTestCheckout(checkout()), true, 'old one-fen promise stays valid');
  assert.throws(() => assertCurrentTestCheckout(checkout({ _id: order._id, userId: 9 }), weeklyEnvironment()));
  for (const patch of [{ _id: 'payment_order_99' }, { userId: 10 }, { amountFen: 1 }, { amountFen: '6160' },
    { durationDays: 1 }, { durationDays: '7' }, { planCode: 'vip_month' }, { planTitle: '微信支付测试' },
    { productType: 'matchmaking' }, { membershipTier: undefined }, { serviceCount: 1 }, { serviceCount: '0' },
    { paymentProvider: 'jsapi' }, { virtualPaymentEnv: 0 }, { paymentTestPlanCode: undefined },
    { paymentTestRunId: undefined }, { paymentTestRunId: 'another_run' }]) {
    assert.throws(() => assertCurrentTestCheckout(weeklyCheckout(patch), weeklyEnvironment()));
  }
  assert.throws(() => assertCurrentTestCheckout(order, weeklyEnvironment({ PAYMENT_TEST_RUN_ID: 'another_run' })));
  assert.throws(() => assertTestCheckout(weeklyCheckout({ paymentTestPlanCode: undefined, paymentTestRunId: undefined })),
    'ordinary full-price VIP orders cannot impersonate a test contract');
});

test('weekly push-only polling cannot hide another product or batch and ceases on expiry', () => {
  const env = weeklyEnvironment({ PAYMENT_TEST_PUSH_ONLY: 'true' });
  assert.equal(paymentTestPushOnly(env, weeklyCheckout(), NOW), true);
  assert.equal(paymentTestPushOnly(env, weeklyCheckout({ amountFen: 1 }), NOW), false);
  assert.equal(paymentTestPushOnly(env, weeklyCheckout({ paymentTestRunId: 'another_run' }), NOW), false);
  assert.equal(paymentTestPushOnly(env, checkout({ _id: weeklyCheckout()._id, userId: 9,
    paymentProvider: 'virtual', virtualPaymentEnv: 1 }), NOW), false);
  assert.equal(paymentTestPushOnly({ ...env, PAYMENT_TEST_EXPIRES_AT: NOW }, weeklyCheckout(), NOW), false);
});
