'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingPaymentOrder } = require('../cloudfunctions/hlApi/membership-payment-policy');
const { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder, assertPurchaseContract } = require('../cloudfunctions/hlApi/purchase-contract-policy');
const plan = { planCode: 'matchmaking_double', title: '人工牵线2次', productType: 'matchmaking', amountFen: 298000,
  durationDays: 30, serviceCount: 2, active: true };
const input = { id: 1, outTradeNo: 'fixture_direct_001', userId: 1, memberRecordId: 0, payerOpenid: 'fixture-openid', plan };

test('new user-owned order can omit assignment while historical manual creation keeps its old contract', () => {
  assert.throws(() => createPendingPaymentOrder(input), /支付订单参数无效/);
  const order = createPendingPaymentOrder({ ...input, fulfillmentContract: DIRECT_PURCHASE_CONTRACT });
  assert.equal(order.memberRecordId, 0);
  assert.equal(order.fulfillmentContract, DIRECT_PURCHASE_CONTRACT);
  assert.equal(order.amountFen, 298000); assert.equal(order.serviceCount, 2); assert.equal(order.durationDays, 30);
  const historical = createPendingPaymentOrder({ ...input, memberRecordId: 2 });
  assert.equal(Object.hasOwn(historical, 'fulfillmentContract'), false);
});

test('unknown or malformed purchase contracts never gain independent rights semantics', () => {
  assert.equal(isDirectPurchaseOrder({ productType: 'matchmaking' }), false);
  for (const value of ['', null, 'future_contract', {}, true]) {
    assert.throws(() => createPendingPaymentOrder({ ...input, fulfillmentContract: value }), { code: 40907 });
    assert.throws(() => assertPurchaseContract({ fulfillmentContract: value, productType: 'matchmaking' }), { code: 40907 });
  }
  assert.throws(() => assertPurchaseContract({ fulfillmentContract: DIRECT_PURCHASE_CONTRACT, productType: 'legacy' }), { code: 40907 });
  assert.equal(assertPurchaseContract({ productType: 'matchmaking' }), false);
});
