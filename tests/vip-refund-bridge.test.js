'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMembershipBridge } = require('../integrations/wechat-pay/hl-membership-bridge');

const MERCHANT = { merchantId: '1118515135', appId: 'wx7e5c0f4d07d2f0f8', envId: 'isolated-vip-refund-fixture',
  businessFunctionName: 'hlApi', currency: 'CNY' };
const TOKEN = 'isolated-refund-bridge-fixture-not-a-real-callback-token';
const OPENID = 'oRefundFixturePayer000001';
const ORDER = 'HLM_REFUND_FIXTURE_001';
const REFUND_ORDER = 'HLR_REFUND_FIXTURE_001';
const TRANSACTION = '420000000000000000001234';
const REFUND_ID = '503000000000000000001234';
const AMOUNT = 698000;

function fixture(options = {}) {
  const calls = [], providerCalls = [], events = [];
  const rights = { remainingCount: 2, revokedCount: 0 };
  const local = { outTradeNo: ORDER, description: '人工牵线1个月', amountFen: AMOUNT, payerOpenid: OPENID,
    merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: MERCHANT.currency, userId: 1,
    status: 'paid', ...(options.local || {}) };
  const order = { id: 11, outTradeNo: ORDER, userId: 1, planCode: 'matchmaking_month', planTitle: '人工牵线1个月',
    productType: 'matchmaking', serviceCount: 2, amountFen: AMOUNT, durationDays: 30, status: local.status,
    fulfillmentStatus: 'fulfilled', transactionId: TRANSACTION, paidAt: '2026-10-12T00:00:00.000Z',
    createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
    payerOpenid: OPENID, callbackToken: TOKEN, privateKey: 'PRIVATE_KEY_MARKER', grants: ['INTERNAL_GRANT_MARKER'],
    ...(options.order || {}) };
  const refund = { status: 'SUCCESS', out_trade_no: ORDER, out_refund_no: REFUND_ORDER, refund_id: REFUND_ID,
    transaction_id: TRANSACTION, amount: { total: AMOUNT, refund: AMOUNT, currency: 'CNY' },
    ...(options.refund || {}) };
  const trade = { appid: MERCHANT.appId, mchid: MERCHANT.merchantId, out_trade_no: ORDER,
    trade_state: 'REFUND', trade_type: 'JSAPI', transaction_id: TRANSACTION,
    payer: { openid: OPENID }, amount: { total: AMOUNT, currency: 'CNY', payer_total: AMOUNT, payer_currency: 'CNY' },
    ...(options.trade || {}) };
  const settled = new Set();
  const callFunction = async input => {
    calls.push(structuredClone(input));
    const action = input.data.path.split('/').at(-1), data = input.data.data;
    events.push(`business:${action}`);
    assert.equal(input.name, 'hlApi'); assert.equal(input.config.env, MERCHANT.envId);
    assert.equal(data.callbackToken, TOKEN);
    if (action === 'query') {
      if (options.queryDenied) return { result: { code: 40304, data: null } };
      return { result: { code: 0, data: { ...local, order: { ...order } } } };
    }
    assert.equal(action, 'refund', 'refund verification must not call paid confirmation, checkout, or close');
    if (options.refundOutcome) return { result: { code: 0, data: { order: { ...order, ...options.refundOutcome } } } };
    if (!['paid', 'refunded'].includes(local.status) || order.transactionId !== data.transactionId || !data.transactionId) {
      return { result: { code: 40907, data: null } };
    }
    if (!settled.has(data.refundId)) {
      settled.add(data.refundId); rights.remainingCount = 0; rights.revokedCount += 1;
      local.status = order.status = 'refunded';
    }
    return { result: { code: 0, data: { order: { ...order }, callbackToken: TOKEN, sdkSignature: 'SIGNATURE_MARKER' } } };
  };
  const payService = {
    async unifiedOrder() { throw new Error('refund tests must never prepare a payment'); },
    async queryRefund(params) {
      providerCalls.push({ method: 'queryRefund', params: structuredClone(params) }); events.push('wechat:refund');
      if (options.refundThrow) throw new Error(`sdk credentials ${TOKEN} PRIVATE_KEY_MARKER`);
      return options.refundResponse || { status: 200, verified: true, data: structuredClone(refund) };
    },
    async queryOrderByOutTradeNo(params) {
      providerCalls.push({ method: 'queryOrderByOutTradeNo', params: structuredClone(params) }); events.push('wechat:trade');
      return options.tradeResponse || { status: 200, verified: true, data: structuredClone(trade) };
    }
  };
  if (options.missingRefundQuery) delete payService.queryRefund;
  const bridge = createMembershipBridge({ callFunction, payService, merchant: MERCHANT, callbackToken: TOKEN });
  return { bridge, calls, providerCalls, events, rights, local, order, refund, trade,
    query: (payer = OPENID, data = {}) => bridge.queryRefund({ outTradeNo: ORDER, outRefundNo: REFUND_ORDER, ...data }, payer),
    callback: (data = {}) => bridge.confirmVerifiedRefund({ out_trade_no: ORDER, out_refund_no: REFUND_ORDER, ...data }) };
}
const mutations = r => r.calls.filter(input => input.data.path.endsWith('/refund'));
async function rejectsWithoutMutation(runtime, operation = 'query') {
  await assert.rejects(runtime[operation](), error => !/PRIVATE_KEY_MARKER|callback-token|sdk credentials/.test(error.message));
  assert.equal(mutations(runtime).length, 0);
  assert.deepEqual(runtime.rights, { remainingCount: 2, revokedCount: 0 });
}

test('ordinary refund bridge rejects virtual matching orders without querying the ordinary refund merchant', async () => {
  for (const snapshot of [{ local: { paymentProvider: 'virtual' } }, { order: { paymentProvider: 'virtual' } }]) {
    const r = fixture(snapshot);
    await rejectsWithoutMutation(r);
    assert.equal(r.providerCalls.length, 0);
  }
});

test('historical matching JSAPI refund remains independent of new virtual product purchases', async () => {
  const r = fixture({ local: { paymentProvider: 'jsapi' }, order: { paymentProvider: 'jsapi' } });
  const result = await r.query();
  assert.equal(result.order.paymentProvider, 'jsapi');
  assert.equal(result.order.status, 'refunded');
  assert.equal(result.order.productType, 'matchmaking');
  assert.ok(r.calls.every(call => call.data.data.paymentProvider === 'jsapi'));
  assert.deepEqual(r.rights, { remainingCount: 0, revokedCount: 1 });
});

test('refund lookup checks authenticated ownership before contacting the provider', async () => {
  for (const payer of [undefined, '', 'manual_user', 'oDifferentRefundPayer']) {
    const r = fixture();
    await assert.rejects(r.bridge.queryRefund({ outTradeNo: ORDER, outRefundNo: REFUND_ORDER }, payer));
    assert.equal(r.providerCalls.length, 0);
    assert.equal(mutations(r).length, 0);
  }
  const denied = fixture({ queryDenied: true });
  await rejectsWithoutMutation(denied);
  assert.equal(denied.providerCalls.length, 0);
});

test('unsigned, failed, malformed, and unavailable refund responses cannot revoke any rights', async () => {
  const valid = fixture().refund;
  for (const response of [
    { status: 200, data: valid }, { status: 200, verified: false, data: valid },
    { status: '200', verified: true, data: valid }, { status: 500, verified: true, data: valid },
    { status: 200, verified: true, data: null }, { status: 200, verified: true, data: [] }
  ]) {
    const r = fixture({ refundResponse: response });
    await rejectsWithoutMutation(r);
    assert.equal(r.providerCalls.filter(call => call.method === 'queryOrderByOutTradeNo').length, 0);
  }
  await rejectsWithoutMutation(fixture({ refundThrow: true }));
  await rejectsWithoutMutation(fixture({ missingRefundQuery: true }));
});

test('callback payload is a locator only and cannot declare an unsigned provider response verified', async () => {
  const r = fixture({ refundResponse: { status: 200, verified: false, data: fixture().refund } });
  await assert.rejects(r.callback({ verified: true, status: 'SUCCESS', providerVerified: true,
    amount: { total: AMOUNT, refund: AMOUNT, currency: 'CNY' }, transaction_id: TRANSACTION }));
  assert.equal(mutations(r).length, 0);
  assert.equal(r.providerCalls[0].method, 'queryRefund');
  assert.equal(r.rights.remainingCount, 2);
});

test('refund processing states, different orders, and malformed refund identifiers are rejected before original-trade query', async () => {
  for (const patch of [
    { status: 'PROCESSING' }, { status: 'CLOSED' }, { status: 'ABNORMAL' }, { status: 'success' },
    { out_trade_no: 'HLM_OTHER_ORDER_002' }, { out_refund_no: 'HLR_OTHER_REFUND_002' },
    { refund_id: '' }, { refund_id: 503000 }, { refund_id: 'short' }, { refund_id: 'invalid refund id' }
  ]) {
    const r = fixture({ refund: patch });
    await rejectsWithoutMutation(r);
    assert.equal(r.providerCalls.filter(call => call.method === 'queryOrderByOutTradeNo').length, 0);
  }
});

test('original transaction must match order, merchant, app, JSAPI payer, amount, and saved paid transaction id', async () => {
  const trades = [
    { out_trade_no: 'HLM_OTHER_ORDER_002' }, { mchid: '9999999999' }, { appid: 'wx0000000000000000' },
    { trade_type: 'NATIVE' }, { trade_type: undefined }, { payer: { openid: 'oDifferentRefundPayer' } },
    { payer: null }, { amount: { total: AMOUNT, currency: 'USD' } }, { amount: { total: AMOUNT - 1, currency: 'CNY' } },
    { transaction_id: '420000000000000000009999' }, { trade_state: 'NOTPAY' }, { trade_state: 'USERPAYING' },
    { trade_state: 'CLOSED' }, { trade_state: 'PAYERROR' }
  ];
  for (const trade of trades) await rejectsWithoutMutation(fixture({ trade }));
  await rejectsWithoutMutation(fixture({ order: { transactionId: '420000000000000000009999' } }));
  await rejectsWithoutMutation(fixture({ tradeResponse: { status: 404, verified: true, data: { code: 'ORDER_NOT_EXIST' } } }));
});

test('refund must cover the exact original total in CNY; partial and conflicting evidence never reaches mutation', async () => {
  for (const amount of [
    { total: AMOUNT, refund: AMOUNT - 1, currency: 'CNY' },
    { total: AMOUNT - 1, refund: AMOUNT, currency: 'CNY' },
    { total: AMOUNT, refund: AMOUNT, currency: 'USD' },
    { total: AMOUNT, refund: `${AMOUNT}`, currency: 'CNY' },
    { total: AMOUNT, refund: AMOUNT }, null
  ]) await rejectsWithoutMutation(fixture({ refund: { amount } }));
  await rejectsWithoutMutation(fixture({ refund: { transaction_id: '420000000000000000009999' } }));
});

test('paid business state and nonempty transaction evidence are mandatory before submitting refund proof', async () => {
  for (const status of ['pending', 'confirming', 'closed', 'failed']) {
    const r = fixture({ local: { status }, order: { status, fulfillmentStatus: '' } });
    await rejectsWithoutMutation(r);
  }
  const absent = fixture({ refund: { transaction_id: undefined }, trade: { transaction_id: undefined }, order: { transactionId: undefined } });
  await rejectsWithoutMutation(absent);
});

test('inner business order identity must agree with its trusted outer payment snapshot', async () => {
  for (const order of [{ outTradeNo: 'HLM_OTHER_ORDER_002' }, { userId: 2 }, { amountFen: AMOUNT - 1 },
    { status: 'pending', fulfillmentStatus: '' }]) await rejectsWithoutMutation(fixture({ order }));
});

test('verified refund query posts one complete server proof and returns only the sanitized refunded business order', async () => {
  const r = fixture();
  const result = await r.query();
  assert.deepEqual(r.events, ['business:query', 'wechat:refund', 'wechat:trade', 'business:query', 'business:refund']);
  assert.equal(mutations(r).length, 1);
  assert.deepEqual(mutations(r)[0], { name: 'hlApi', config: { env: MERCHANT.envId }, data: {
    path: '/internal/payment-orders/refund', method: 'POST', data: {
      outTradeNo: ORDER, merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY', payerOpenid: OPENID,
      amountFen: AMOUNT, refundAmountFen: AMOUNT, transactionId: TRANSACTION, refundId: REFUND_ID,
      tradeState: 'REFUND', providerVerified: true, refundSource: 'verified_jsapi_query',
      paymentProvider: 'jsapi', callbackToken: TOKEN
    }
  } });
  assert.deepEqual(r.providerCalls, [
    { method: 'queryRefund', params: { out_refund_no: REFUND_ORDER } },
    { method: 'queryOrderByOutTradeNo', params: { out_trade_no: ORDER, mchid: MERCHANT.merchantId } }
  ]);
  assert.equal(result.order.status, 'refunded');
  assert.equal(result.order.productType, 'matchmaking');
  assert.equal(result.order.serviceCount, 2);
  assert.deepEqual(Object.keys(result), ['order']);
  assert.doesNotMatch(JSON.stringify(result), /callbackToken|payerOpenid|PRIVATE_KEY_MARKER|INTERNAL_GRANT_MARKER|SIGNATURE_MARKER|providerVerified/);
  assert.deepEqual(r.rights, { remainingCount: 0, revokedCount: 1 });
});

test('verified callbacks independently query provider proof and repeated delivery revokes rights exactly once', async () => {
  const r = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await r.callback({ amount: { refund: 1 }, payer: { openid: 'attacker' }, refund_id: 'injected-refund-id' });
    assert.equal(result.order.status, 'refunded');
    assert.doesNotMatch(JSON.stringify(result), /attacker|injected-refund|PRIVATE_KEY_MARKER|callbackToken|payerOpenid/);
  }
  assert.equal(r.providerCalls.filter(call => call.method === 'queryRefund').length, 2);
  assert.equal(mutations(r).length, 2, 'each callback submits one freshly verified idempotent proof');
  assert.equal(r.rights.revokedCount, 1);
});

test('bridge never acknowledges a mismatched or uncommitted business refund result', async () => {
  for (const refundOutcome of [
    { status: 'paid' }, { status: 'refunded', amountFen: AMOUNT - 1 },
    { status: 'refunded', userId: 2 }, { status: 'refunded', transactionId: '420000000000000000009999' }
  ]) {
    const r = fixture({ refundOutcome });
    await assert.rejects(r.query());
    assert.equal(mutations(r).length, 1);
    assert.equal(r.rights.remainingCount, 2);
  }
});
