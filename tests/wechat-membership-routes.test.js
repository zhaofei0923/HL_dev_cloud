'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../integrations/wechat-pay/hl-membership-routes');

const MERCHANT = { merchantId: '1118515135', appId: 'wx7e5c0f4d07d2f0f8', envId: 'cloud1-d2gza7q9c8d69c721',
  businessFunctionName: 'hlApi', currency: 'CNY' };
const TOKEN = 'route-test-only-not-a-real-callback-credential';
const OPENID = 'oFixtureMiniProgramPayer000001';
const ORDER_NO = 'HLM202610080000000101';
const PAYMENT = { appId: MERCHANT.appId, timeStamp: '1791420000', nonceStr: 'fixtureNonce123456',
  package: 'prepay_id=wx_fixture_prepayment', signType: 'RSA', paySign: Buffer.alloc(256, 1).toString('base64') };

function response() {
  return { statusCode: 200, body: undefined,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}

function fixture(options = {}) {
  const mounts = [], registrations = [], businessCalls = [], wechatCalls = [], initializations = [];
  // These are the exact Express operations used by install: capture middleware
  // registration and invoke its actual handlers, without reimplementing a router.
  const app = { use(...args) { mounts.push(args); } };
  const router = { post(path, handler) { registrations.push({ path, handler }); } };
  const express = { Router: () => router };
  const local = { outTradeNo: ORDER_NO, description: '会员服务一年', amountFen: 188000, payerOpenid: OPENID,
    merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY', status: 'confirming', userId: 1,
    order: { id: 101, outTradeNo: ORDER_NO, amountFen: 188000, status: 'confirming', userId: 1 } };
  const trade = { appid: MERCHANT.appId, mchid: MERCHANT.merchantId, out_trade_no: ORDER_NO,
    trade_type: 'JSAPI', trade_state: 'NOTPAY', payer: { openid: OPENID } };
  class PayService {
    async unifiedOrder(params, type) {
      wechatCalls.push({ method: 'create', params, type });
      if (options.throwProvider) throw new Error(`vendor private detail ${TOKEN}`);
      return { status: 200, data: PAYMENT };
    }
    async queryOrderByOutTradeNo(params) {
      wechatCalls.push({ method: 'query', params });
      return { status: 200, data: trade };
    }
  }
  class OrderService {}
  const cloud = {
    init(value) { initializations.push(value); },
    async callFunction(input) {
      businessCalls.push(input);
      return { result: { code: 0, data: local } };
    }
  };
  const bridge = install(app, { express, PayService, OrderService, cloud,
    payConfig: { mchId: MERCHANT.merchantId, appId: MERCHANT.appId }, merchant: MERCHANT,
    env: { PAYMENT_CALLBACK_TOKEN: TOKEN } });
  assert.deepEqual(mounts[0], ['/hl-membership', router]);
  assert.equal(mounts.length, 2);
  assert.deepEqual(registrations.map(value => value.path), ['/create', '/query', '/refund-query']);
  return { bridge, businessCalls, wechatCalls, initializations, OrderService,
    gate: mounts[1][0], route: path => registrations.find(value => value.path === path).handler };
}

function checkGate(gate, { path = '/', method = 'POST', body = {} } = {}) {
  const req = { path, method, body: structuredClone(body), headers: {} };
  const original = structuredClone(req.body);
  const res = response();
  let nextCalls = 0;
  gate(req, res, () => { nextCalls += 1; });
  assert.deepEqual(req.body, original, 'the generated adapter must still receive its original envelope');
  return { nextCalls, res };
}

function assertAllowed(gate, request) {
  const result = checkGate(gate, request);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.res.body, undefined);
}

function assertDenied(gate, request) {
  const result = checkGate(gate, request);
  assert.equal(result.nextCalls, 0);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.code, 40304);
}

test('root system payment callbacks support both actual template event envelopes', () => {
  const { gate } = fixture();
  for (const field of ['rawData', 'ParsedNotify']) {
    for (const event_type of ['TRANSACTION.SUCCESS', 'TRANSACTION.FAIL']) {
      assertAllowed(gate, { body: { [field]: { event_type } } });
      assertAllowed(gate, { path: '/wechatpay/order', body: { [field]: { event_type } } });
    }
  }
  assertAllowed(gate, { body: { rawData: { event_type: 'TRANSACTION.SUCCESS' },
    ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } } });
});

test('direct callback and legacy action/path envelopes remain compatible', () => {
  const { gate } = fixture();
  assertAllowed(gate, { path: '/wx-pay/unifiedOrderTrigger' });
  for (const body of [{ _action: 'unifiedOrderTrigger' }, { _action: '/wx-pay/unifiedOrderTrigger' },
    { path: '/wx-pay/unifiedOrderTrigger' },
    { _action: 'unifiedOrderTrigger', path: '/wx-pay/unifiedOrderTrigger' }]) {
    assertAllowed(gate, { body });
    assertAllowed(gate, { path: '/wechatpay/order', body });
  }
});

test('only dedicated refund callbacks with matching REFUND.SUCCESS envelopes are forwarded', () => {
  const { gate } = fixture();
  assertAllowed(gate, { path: '/wx-pay/refundTrigger', body: { event_type: 'REFUND.SUCCESS' } });
  assertDenied(gate, { path: '/wx-pay/refundTrigger', body: { event_type: 'TRANSACTION.SUCCESS', rawData: { event_type: 'REFUND.SUCCESS' } } });
  assertDenied(gate, { path: '/wx-pay/unifiedOrderTrigger', body: { event_type: 'REFUND.SUCCESS' } });
  for (const field of ['rawData', 'ParsedNotify']) {
    const event = { [field]: { event_type: 'REFUND.SUCCESS' } };
    assertAllowed(gate, { path: '/wx-pay/refundTrigger', body: event });
    for (const path of ['/', '/wechatpay/order']) {
      assertAllowed(gate, { path, body: event });
      assertAllowed(gate, { path, body: { ...event, _action: 'refundTrigger', path: '/wx-pay/refundTrigger' } });
    }
  }
  for (const body of [{}, { _action: 'refundTrigger' }, { path: '/wx-pay/refundTrigger' },
    { rawData: { event_type: 'REFUND.ABNORMAL' } }, { rawData: { event_type: 'REFUND.CLOSED' } },
    { _action: 'unifiedOrderTrigger', rawData: { event_type: 'REFUND.SUCCESS' } },
    { _action: 'refundTrigger', path: '/wx-pay/wxpay_refund', rawData: { event_type: 'REFUND.SUCCESS' } },
    { rawData: { event_type: 'REFUND.SUCCESS' }, ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } }]) {
    assertDenied(gate, { path: '/wx-pay/refundTrigger', body });
  }
  for (const method of ['GET', 'PUT', 'DELETE']) assertDenied(gate, { method, path: '/wx-pay/refundTrigger', body: { rawData: { event_type: 'REFUND.SUCCESS' } } });
  for (const path of ['/wx-pay/wxpay_refund', '/wx-pay/transferTrigger', '/other']) {
    assertDenied(gate, { path, body: { _action: 'refundTrigger', rawData: { event_type: 'REFUND.SUCCESS' } } });
  }
});

test('refund, transfer and unknown events cannot reach any payment callback entry', () => {
  const { gate } = fixture();
  for (const path of ['/', '/wechatpay/order', '/wx-pay/unifiedOrderTrigger']) {
    for (const field of ['rawData', 'ParsedNotify']) {
      for (const event_type of ['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED',
        'MCHTRANSFER.TRANSFER.SUCCESS', 'MCHTRANSFER.TRANSFER.FAIL', 'UNKNOWN', '', null, 1]) {
        assertDenied(gate, { path, body: { _action: 'unifiedOrderTrigger', [field]: { event_type } } });
      }
    }
    assertDenied(gate, { path, body: { rawData: { event_type: 'TRANSACTION.SUCCESS' },
      ParsedNotify: { event_type: 'REFUND.SUCCESS' } } });
    assertDenied(gate, { path, body: { rawData: { event_type: 'REFUND.SUCCESS' },
      ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } } });
  }
});

test('callback hints cannot conceal conflicting order, refund or transfer selectors', () => {
  const { gate } = fixture();
  for (const path of ['/', '/wechatpay/order', '/wx-pay/unifiedOrderTrigger']) {
    for (const action of ['wxpay_order', 'wxpay_close_order', 'wxpay_refund', 'refundTrigger',
      'wxpay_transfer', 'transferTrigger', 'prefix/wx-pay/unifiedOrderTrigger']) {
      assertDenied(gate, { path, body: { _action: action, path: '/wx-pay/unifiedOrderTrigger' } });
      assertDenied(gate, { path, body: { _action: 'unifiedOrderTrigger', path: `/wx-pay/${action}` } });
      assertDenied(gate, { path, body: { _action: action, rawData: { event_type: 'TRANSACTION.SUCCESS' } } });
    }
    for (const value of [1, {}, ['unifiedOrderTrigger']]) {
      assertDenied(gate, { path, body: { _action: value, path: '/wx-pay/unifiedOrderTrigger' } });
      assertDenied(gate, { path, body: { _action: 'unifiedOrderTrigger', path: value } });
    }
  }
});

test('generic template operations, unrelated paths and non-POST callbacks stay closed', () => {
  const { gate } = fixture();
  for (const path of ['/wx-pay/wxpay_order', '/wx-pay/wxpay_query_order_by_out_trade_no',
    '/wx-pay/wxpay_refund', '/wx-pay/refundTrigger', '/wx-pay/transferTrigger',
    '/unifiedOrderTrigger', '/other', '/hl-membership/unrecognized']) {
    assertDenied(gate, { path, body: { _action: 'unifiedOrderTrigger' } });
  }
  assertDenied(gate, {});
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    assertDenied(gate, { method, path: '/wx-pay/unifiedOrderTrigger' });
    assertDenied(gate, { method, body: { rawData: { event_type: 'TRANSACTION.SUCCESS' } } });
  }
});

test('membership payment and refund queries require a single nonempty platform openid header', async () => {
  for (const path of ['/create', '/query', '/refund-query']) {
    for (const headers of [{}, { 'x-wx-openid': '' }, { 'x-wx-openid': '   ' },
      { 'x-wx-openid': [OPENID] }, { 'x-wx-openid': 1 }]) {
      const r = fixture();
      const res = response();
      await r.route(path)({ headers: { 'x-wx-appid': MERCHANT.appId, ...headers },
        body: { outTradeNo: ORDER_NO, requesterOpenid: OPENID } }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 40101);
      assert.equal(r.businessCalls.length, 0);
      assert.equal(r.wechatCalls.length, 0);
    }
  }
});

test('membership payment and refund queries require the registered platform AppID before invoking the bridge', async () => {
  for (const path of ['/create', '/query', '/refund-query']) {
    for (const headers of [{}, { 'x-wx-appid': '' }, { 'x-wx-appid': '   ' },
      { 'x-wx-appid': 'wx0000000000000000' }, { 'x-wx-appid': [MERCHANT.appId] },
      { 'x-wx-appid': 1 }, { 'x-wx-appid': ` ${MERCHANT.appId} ` }]) {
      const r = fixture();
      const res = response();
      await r.route(path)({ headers: { 'x-wx-openid': OPENID, ...headers }, body: {
        outTradeNo: ORDER_NO, appId: MERCHANT.appId, appid: MERCHANT.appId } }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 40101);
      assert.equal(r.businessCalls.length, 0);
      assert.equal(r.wechatCalls.length, 0);
    }
  }
});

test('membership create trusts header identity and business order instead of client financial fields', async () => {
  const r = fixture();
  const res = response();
  await r.route('/create')({ headers: { 'x-wx-openid': ` ${OPENID} `, 'x-wx-appid': MERCHANT.appId }, body: {
    outTradeNo: ORDER_NO, requesterOpenid: 'attacker', payerOpenid: 'attacker', amountFen: 1,
    mchid: 'attacker', appid: 'attacker', notify_url: 'https://invalid.example' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, 0);
  assert.deepEqual(r.initializations, [{ env: MERCHANT.envId }]);
  assert.deepEqual(r.businessCalls[0], { name: 'hlApi', config: { env: MERCHANT.envId }, data: {
    path: '/internal/payment-orders/checkout', method: 'POST', data: {
      outTradeNo: ORDER_NO, requesterOpenid: OPENID, paymentProvider: 'jsapi', callbackToken: TOKEN } } });
  assert.deepEqual(r.wechatCalls, [{ method: 'create', type: 'jsapi', params: {
    appid: MERCHANT.appId, mchid: MERCHANT.merchantId, out_trade_no: ORDER_NO,
    description: '会员服务一年', amount: { total: 188000, currency: 'CNY' }, payer: { openid: OPENID } } }]);
  assert.deepEqual(Object.keys(res.body.data).sort(), ['nonceStr', 'package', 'paySign', 'signType', 'timeStamp']);
  assert.doesNotMatch(JSON.stringify(res.body), /attacker|openid|callbackToken|credential/);
});

test('membership query carries the current header identity and does not trust client paid status', async () => {
  const r = fixture();
  const res = response();
  await r.route('/query')({ headers: { 'x-wx-openid': OPENID, 'x-wx-appid': MERCHANT.appId }, body: {
    outTradeNo: ORDER_NO, requesterOpenid: 'attacker', status: 'paid', transactionId: 'forged' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.order.status, 'confirming');
  assert.equal(r.businessCalls[0].data.path, '/internal/payment-orders/query');
  assert.equal(r.businessCalls[0].data.data.requesterOpenid, OPENID);
  assert.deepEqual(r.wechatCalls, [{ method: 'query', params: { out_trade_no: ORDER_NO, mchid: MERCHANT.merchantId } }]);
  assert.equal(r.businessCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(res.body), /forged|attacker|openid|callbackToken|credential/);
});

test('membership route provider failures do not disclose SDK or callback credentials', async () => {
  const r = fixture({ throwProvider: true });
  const res = response();
  await r.route('/create')({ headers: { 'x-wx-openid': OPENID, 'x-wx-appid': MERCHANT.appId },
    body: { outTradeNo: ORDER_NO } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, -1);
  assert.doesNotMatch(JSON.stringify(res.body), /vendor|private|credential/);
});

test('installed callback hook independently queries WeChat before using an untrusted callback hint', async () => {
  const r = fixture();
  const result = await new r.OrderService().handlerUnifiedTrigger({ out_trade_no: ORDER_NO,
    trade_state: 'SUCCESS', transaction_id: 'forged', payer: { openid: 'attacker' } });
  assert.equal(result.order.status, 'confirming');
  assert.deepEqual(r.wechatCalls, [{ method: 'query', params: { out_trade_no: ORDER_NO, mchid: MERCHANT.merchantId } }]);
  assert.equal(r.businessCalls[0].data.data.requesterOpenid, OPENID);
  assert.equal(r.businessCalls.length, 1);
});

test('installed refund callback hook refuses unverified service support instead of trusting a successful payload', async () => {
  const r = fixture();
  await assert.rejects(new r.OrderService().handlerRefundTrigger({ out_trade_no: ORDER_NO,
    out_refund_no: 'HLR202610120000000101', status: 'SUCCESS', verified: true, providerVerified: true }), /退款查证服务暂不可用/);
  assert.equal(r.businessCalls.length, 0);
  assert.equal(r.wechatCalls.length, 0);
});
