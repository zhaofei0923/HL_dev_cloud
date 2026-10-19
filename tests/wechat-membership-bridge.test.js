'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMembershipBridge } = require('../integrations/wechat-pay/hl-membership-bridge');

const MERCHANT = { merchantId: '1118515135', appId: 'wx7e5c0f4d07d2f0f8', envId: 'cloud1-d2gza7q9c8d69c721',
  businessFunctionName: 'hlApi', currency: 'CNY' };
const TOKEN = 'bridge-test-private-credential-not-a-real-token';
const OPENID = 'oFixtureMiniProgramPayer000001';
const ORDER_NO = 'HLM202610080000000101';
const PAYMENT = { appId: MERCHANT.appId, timeStamp: '1791420000', nonceStr: 'fixtureNonce123456',
  package: 'prepay_id=wx_fixture_prepayment', signType: 'RSA', paySign: Buffer.alloc(256, 1).toString('base64') };

function fixture(options = {}) {
  const calls = [], wechatCalls = [], events = [];
  const local = { outTradeNo: ORDER_NO, description: '会员服务一年', amountFen: 188000, payerOpenid: OPENID,
    merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY', status: 'confirming', userId: 1,
    ...(options.local || {}) };
  const order = { id: 101, outTradeNo: ORDER_NO, amountFen: local.amountFen, status: local.status, userId: 1,
    planCode: 'year', planTitle: '会员服务一年', durationDays: 365, createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z', callbackToken: TOKEN, payerOpenid: OPENID,
    privateKey: 'PRIVATE_KEY_MARKER', ...(options.order || {}) };
  const trade = { appid: MERCHANT.appId, mchid: MERCHANT.merchantId, out_trade_no: ORDER_NO, trade_type: 'JSAPI',
    trade_state: 'SUCCESS', amount: { total: local.amountFen, currency: 'CNY', payer_total: local.amountFen, payer_currency: 'CNY' },
    payer: { openid: OPENID }, transaction_id: '420000000000000000000001', success_time: '2026-10-08T08:00:00+08:00',
    ...(options.trade || {}) };
  let fulfillments = 0;
  const callFunction = async input => {
    calls.push(structuredClone(input));
    const { path, data } = input.data;
    const action = path.split('/').at(-1);
    events.push(`business:${action}`);
    if (options.business) return options.business(input, { local, order });
    if (['checkout', 'query'].includes(action)) return { result: { code: 0, data: { ...local, order: { ...order } } } };
    if (action === 'confirm') {
      if (order.status !== 'paid') fulfillments += 1;
      order.status = 'paid'; local.status = 'paid'; order.transactionId = data.transactionId;
    }
    if (action === 'close' && order.status !== 'paid') { order.status = data.tradeState === 'CLOSED' ? 'closed' : 'failed'; local.status = order.status; }
    return { result: { code: 0, data: { order: { ...order }, callbackToken: TOKEN } } };
  };
  const payService = {
    async unifiedOrder(params, type) {
      wechatCalls.push({ method: 'unifiedOrder', params: structuredClone(params), type }); events.push('wechat:create');
      return options.create ? options.create(params, type) : { status: 200, data: { ...PAYMENT, privateKey: 'PRIVATE_KEY_MARKER' } };
    },
    async queryOrderByOutTradeNo(params) {
      wechatCalls.push({ method: 'queryOrderByOutTradeNo', params: structuredClone(params) }); events.push('wechat:query');
      return options.query ? options.query(params) : { status: 200, data: structuredClone(trade) };
    }
  };
  const bridge = createMembershipBridge({ callFunction, payService, merchant: { ...MERCHANT }, callbackToken: TOKEN });
  return { bridge, calls, wechatCalls, events, local, order, trade, fulfillments: () => fulfillments };
}

const mutationCalls = r => r.calls.filter(call => /\/(confirm|close)$/.test(call.data.path));

test('JSAPI bridge rejects explicit virtual snapshots before querying or preparing the ordinary merchant', async () => {
  for (const snapshot of [{ local: { paymentProvider: 'virtual' } }, { order: { paymentProvider: 'virtual' } },
    { local: { paymentProvider: 'unknown' } }]) {
    for (const operation of ['create', 'query']) {
      const r = fixture(snapshot);
      await assert.rejects(r.bridge[operation]({ outTradeNo: ORDER_NO, paymentProvider: 'jsapi' }, OPENID),
        error => error.code === 40907);
      assert.equal(r.wechatCalls.length, 0);
      assert.equal(mutationCalls(r).length, 0);
    }
  }
});

test('historical explicit JSAPI orders remain queryable and every internal proof keeps the original provider', async () => {
  const r = fixture({ local: { paymentProvider: 'jsapi' }, order: { paymentProvider: 'jsapi' } });
  const result = await r.bridge.query({ outTradeNo: ORDER_NO, paymentProvider: 'virtual' }, OPENID);
  assert.equal(result.order.status, 'paid');
  assert.equal(result.order.paymentProvider, 'jsapi');
  assert.equal(r.fulfillments(), 1);
  assert.ok(r.calls.every(call => call.data.data.paymentProvider === 'jsapi'));
  assert.equal(r.wechatCalls.filter(call => call.method === 'unifiedOrder').length, 0);
});

test('only a verified exact ORDER_NOT_EXIST query can recover the original unpaid local order', async () => {
  for (const status of ['pending', 'confirming']) {
    const r = fixture({ local: { status }, query: async () => ({ status: 404, verified: true,
      data: { code: 'ORDER_NOT_EXIST', message: 'provider-private-message' } }) });
    const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.equal(result.order.outTradeNo, ORDER_NO);
    assert.equal(result.order.status, status);
    assert.equal(result.providerOrderAbsent, true);
    assert.equal(result.tradeState, undefined);
    assert.equal(mutationCalls(r).length, 0);
    assert.equal(r.wechatCalls.filter(call => call.method === 'unifiedOrder').length, 0);
    assert.doesNotMatch(JSON.stringify(result), /provider-private-message|callbackToken|payerOpenid/);
  }
  for (const response of [
    { status: 404, data: { code: 'ORDER_NOT_EXIST' } },
    { status: 404, verified: false, data: { code: 'ORDER_NOT_EXIST' } },
    { status: 500, verified: true, data: { code: 'ORDER_NOT_EXIST' } },
    { status: 404, verified: true, data: { code: 'RESOURCE_NOT_EXISTS' } }
  ]) {
    const r = fixture({ query: async () => response });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), /微信订单查询失败/);
    assert.equal(mutationCalls(r).length, 0);
  }
});

test('provider absence cannot erase paid records or acknowledge a payment callback', async () => {
  for (const status of ['paid', 'closed', 'failed', 'refunded']) {
    const r = fixture({ local: { status }, query: async () => ({ status: 404, verified: true, data: { code: 'ORDER_NOT_EXIST' } }) });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.code === 40907);
    assert.equal(mutationCalls(r).length, 0);
  }
  const callback = fixture({ query: async () => ({ status: 404, verified: true, data: { code: 'ORDER_NOT_EXIST' } }) });
  await assert.rejects(callback.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }), /微信订单查询失败/);
  assert.equal(callback.calls.length, 0);
});

test('verified paid orders preserve manual-review status through query and repeated callbacks', async () => {
  const message = '已付款，会员关系已变更，请联系主理人处理权益或退款';
  const r = fixture({ business: async (input, state) => {
    if (input.data.path.endsWith('/query')) return { result: { code: 0, data: { ...state.local, order: state.order } } };
    assert.ok(input.data.path.endsWith('/confirm'));
    state.order.status = state.local.status = 'paid';
    Object.assign(state.order, { transactionId: input.data.data.transactionId,
      fulfillmentStatus: 'requires_review', fulfillmentMessage: message, reviewReason: 'internal-only-reason' });
    return { result: { code: 0, data: { order: state.order } } };
  } });
  for (const result of [await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID),
    await r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }),
    await r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO })]) {
    assert.equal(result.order.status, 'paid');
    assert.equal(result.order.fulfillmentStatus, 'requires_review');
    assert.equal(result.order.fulfillmentMessage, message);
    assert.equal(result.order.transactionId, r.trade.transaction_id);
    assert.doesNotMatch(JSON.stringify(result), /internal-only-reason|PRIVATE_KEY_MARKER|callbackToken|payerOpenid/);
  }
  assert.equal(r.fulfillments(), 0);
  assert.equal(r.wechatCalls.filter(call => call.method === 'unifiedOrder').length, 0);
});

test('confirmation cannot expose an unknown or unpaid fulfillment state as completed', async () => {
  for (const fulfillmentStatus of ['invented', null, 1]) {
    const r = fixture({ business: async (input, state) => input.data.path.endsWith('/query')
      ? { result: { code: 0, data: { ...state.local, order: state.order } } }
      : { result: { code: 0, data: { order: { ...state.order, status: 'paid',
        transactionId: '420000000000000000000001', fulfillmentStatus } } } } });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), /履约状态暂未确认/);
  }
  const unpaid = fixture({ trade: { trade_state: 'NOTPAY' }, business: async (input, state) => ({ result: { code: 0,
    data: { ...state.local, order: { ...state.order, fulfillmentStatus: 'requires_review' } } } }) });
  await assert.rejects(unpaid.bridge.query({ outTradeNo: ORDER_NO }, OPENID), /履约状态与付款状态不一致/);
  assert.equal(mutationCalls(unpaid).length, 0);
});

test('create ignores all injected financial identity and callback fields and uses explicit hlApi environment', async () => {
  const r = fixture();
  const params = await r.bridge.create({ outTradeNo: ORDER_NO, amountFen: 1, payerOpenid: 'attacker', requesterOpenid: 'attacker',
    appid: 'attacker-app', mchid: '000001', notify_url: 'https://invalid.example', callbackToken: 'attacker-token' }, OPENID);
  assert.deepEqual(r.calls[0], { name: 'hlApi', config: { env: MERCHANT.envId }, data: {
    path: '/internal/payment-orders/checkout', method: 'POST', data: {
      outTradeNo: ORDER_NO, requesterOpenid: OPENID, paymentProvider: 'jsapi', callbackToken: TOKEN }
  } });
  assert.deepEqual(r.wechatCalls, [{ method: 'unifiedOrder', type: 'jsapi', params: { appid: MERCHANT.appId, mchid: MERCHANT.merchantId,
    out_trade_no: ORDER_NO, description: '会员服务一年', amount: { total: 188000, currency: 'CNY' }, payer: { openid: OPENID } } }]);
  assert.deepEqual(Object.keys(params).sort(), ['nonceStr', 'package', 'paySign', 'signType', 'timeStamp']);
  assert.doesNotMatch(JSON.stringify(params), /PRIVATE_KEY_MARKER|credential|attacker|openid|callbackToken/);
});

test('create and query reject absent or different platform identity before touching WeChat', async () => {
  for (const operation of ['create', 'query']) {
    for (const identity of ['', null, 'manual_123', 'oOtherPerson000002']) {
      const r = fixture();
      await assert.rejects(r.bridge[operation]({ outTradeNo: ORDER_NO }, identity), error => error.code === 40304);
      assert.equal(r.wechatCalls.length, 0); assert.equal(mutationCalls(r).length, 0);
      if (identity === 'oOtherPerson000002') assert.equal(r.calls[0].data.data.requesterOpenid, identity);
      else assert.equal(r.calls.length, 0);
    }
  }
});

test('create rejects non-200, incomplete or non-RSA parameters without disclosing SDK credentials', async () => {
  const results = [
    { status: 400, data: { ...PAYMENT, message: TOKEN } }, { status: '200', data: PAYMENT },
    ...['timeStamp', 'nonceStr', 'package', 'paySign', 'signType'].map(key => ({ status: 200, data: { ...PAYMENT, [key]: '' } })),
    { status: 200, data: { ...PAYMENT, signType: 'MD5' } },
    { status: 200, data: { ...PAYMENT, paySign: 'not-a-signature' } },
    { status: 200, data: { ...PAYMENT, package: 'fake-prepayment' } },
    { status: 200, data: { ...PAYMENT, appId: 'wx0000000000000000' } }
  ];
  for (const result of results) {
    const r = fixture({ create: async () => result });
    await assert.rejects(r.bridge.create({ outTradeNo: ORDER_NO }, OPENID), error => !error.message.includes(TOKEN));
    assert.equal(mutationCalls(r).length, 0);
  }
  const throwing = fixture({ create: async () => { throw new Error(`secret ${TOKEN} PRIVATE_KEY_MARKER`); } });
  await assert.rejects(throwing.bridge.create({ outTradeNo: ORDER_NO }, OPENID), error => !/secret|PRIVATE_KEY_MARKER|credential/.test(error.message));
});

test('create accepts native boundary sizes and returns the original signed parameters unchanged', async () => {
  for (const patch of [{ timeStamp: '1000000000', nonceStr: 'a', package: 'prepay_id=a' },
    { timeStamp: '9999999999', nonceStr: 'a'.repeat(32), package: `prepay_id=${'a'.repeat(118)}` },
    { paySign: Buffer.alloc(256, 0x25).toString('base64') },
    { paySign: Buffer.alloc(384, 0x25).toString('base64') }]) {
    const signed = { ...PAYMENT, ...patch };
    const r = fixture({ create: async () => ({ status: 200, data: signed }) });
    const returned = await r.bridge.create({ outTradeNo: ORDER_NO }, OPENID);
    const { appId, ...expected } = signed;
    assert.deepEqual(returned, expected);
    assert.equal(mutationCalls(r).length, 0);
  }
});

test('create rejects milliseconds, oversized native fields and noncanonical RSA Base64 before returning payment parameters', async () => {
  const invalidPaddingBits = `${PAYMENT.paySign.slice(0, -3)}R==`;
  assert.equal(Buffer.from(invalidPaddingBits, 'base64').toString('base64'), PAYMENT.paySign,
    'the malformed padding bits decode but do not preserve the signed Base64 string');
  const patches = [{ timeStamp: '999999999' }, { timeStamp: '10000000000' }, { timeStamp: '1791450000000' },
    { timeStamp: '0000000000' }, { nonceStr: 'a'.repeat(33) }, { package: `prepay_id=${'a'.repeat(119)}` },
    { paySign: Buffer.alloc(255, 0x25).toString('base64') },
    { paySign: Buffer.alloc(385, 0x25).toString('base64') }, { paySign: invalidPaddingBits },
    { paySign: `${PAYMENT.paySign.slice(0, -1)}a` }];
  for (const patch of patches) {
    const r = fixture({ create: async () => ({ status: 200, data: { ...PAYMENT, ...patch } }) });
    await assert.rejects(r.bridge.create({ outTradeNo: ORDER_NO }, OPENID), /微信支付参数不完整/);
    assert.equal(r.wechatCalls.length, 1);
    assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
  }
});

test('trusted checkout mismatches, completed orders and invalid amount never reach unifiedOrder', async () => {
  for (const patch of [{ merchantId: '9999999999' }, { appId: 'wx0000000000000000' }, { currency: 'USD' }, { payerOpenid: 'oWrongOwner' },
    { amountFen: 0 }, { amountFen: 1.2 }, { amountFen: '188000' }, { userId: 0 }, { status: 'paid' }, { description: '' }]) {
    const r = fixture({ local: patch });
    await assert.rejects(r.bridge.create({ outTradeNo: ORDER_NO }, OPENID));
    assert.equal(r.wechatCalls.length, 0);
  }
});

test('query confirms only an actual matched WeChat success and returns a safe order after business acknowledgement', async () => {
  const r = fixture();
  const result = await r.bridge.query({ outTradeNo: ORDER_NO, status: 'paid', transactionId: 'injected' }, OPENID);
  assert.deepEqual(r.events, ['business:query', 'wechat:query', 'business:confirm']);
  assert.deepEqual(r.wechatCalls[0].params, { out_trade_no: ORDER_NO, mchid: MERCHANT.merchantId });
  const proof = mutationCalls(r)[0].data.data;
  assert.deepEqual(proof, { outTradeNo: ORDER_NO, merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY',
    amountFen: 188000, payerOpenid: OPENID, tradeState: 'SUCCESS', transactionId: r.trade.transaction_id,
    successTime: r.trade.success_time, paymentProvider: 'jsapi', callbackToken: TOKEN });
  assert.equal(result.order.status, 'paid'); assert.equal(r.fulfillments(), 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_MARKER|credential|callbackToken|payerOpenid|openid/);
});

test('query rejects mismatched identity, currency, amount, transaction and merchant without awarding membership', async () => {
  const changes = [{ out_trade_no: 'HLM202610080000000102' }, { mchid: '9999999999' }, { appid: 'wx0000000000000000' },
    { trade_type: 'NATIVE' }, { trade_type: undefined }, { payer: { openid: 'oDifferentPayer' } }, { payer: undefined },
    { amount: undefined }, { amount: { total: 188001, currency: 'CNY' } }, { amount: { total: '188000', currency: 'CNY' } },
    { amount: { total: 188000, currency: 'USD' } }, { amount: { total: 188000, currency: 'CNY', payer_currency: 'USD' } },
    { transaction_id: '' }, { transaction_id: 'x' }, { success_time: 'tomorrow' }, { trade_state: 'REFUND' }];
  for (const patch of changes) {
    const r = fixture({ trade: patch });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error =>
      error.status === 409 && error.code === (patch.trade_state === 'REFUND' ? 40905 : 40907));
    assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
  }
});

test('provider errors or missing orders do not become paid or failed business records', async () => {
  for (const provider of [{ status: 404, data: { code: 'ORDER_NOT_EXIST' } }, { status: 500, data: { message: TOKEN } }, { status: 200 }]) {
    const r = fixture({ query: async () => provider });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID));
    assert.equal(mutationCalls(r).length, 0);
  }
});

test('unknown and unauthorized business orders are rejected identically without querying WeChat', async () => {
  for (const code of [40100, 40102, 40304, 40400]) {
    for (const operation of ['create', 'query']) {
      const r = fixture({ business: async () => ({ result: { code, message: TOKEN } }) });
      await assert.rejects(r.bridge[operation]({ outTradeNo: ORDER_NO }, OPENID), error =>
        error.status === 403 && error.code === 40304 && !error.message.includes(TOKEN));
      assert.equal(r.wechatCalls.length, 0);
      assert.equal(r.fulfillments(), 0);
    }
  }
});

test('NOTPAY and USERPAYING leave local state unchanged; a delayed query cannot claim paid early', async () => {
  for (const state of ['NOTPAY', 'USERPAYING']) {
    const r = fixture({ trade: { trade_state: state, trade_type: undefined, payer: undefined,
      amount: undefined, transaction_id: undefined, success_time: undefined } });
    const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.equal(result.order.status, 'confirming'); assert.equal(result.tradeState, state);
    assert.equal(mutationCalls(r).length, 0);
  }
  let resolveQuery;
  const wait = new Promise(resolve => { resolveQuery = resolve; });
  const r = fixture({ query: () => wait });
  let settled = false;
  const pending = r.bridge.query({ outTradeNo: ORDER_NO }, OPENID).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(mutationCalls(r).length, 0);
  resolveQuery({ status: 200, data: r.trade });
  assert.equal((await pending).order.status, 'paid');
});

test('the actual one-fen NOTPAY response without type or payer is a read-only unpaid query', async () => {
  const r = fixture({ local: { amountFen: 1 }, query: async () => ({ status: 200, data: {
    appid: MERCHANT.appId, mchid: MERCHANT.merchantId, out_trade_no: ORDER_NO,
    trade_state: 'NOTPAY', trade_state_desc: '订单未支付', amount: { total: 1, currency: 'CNY' }
  } }) });
  const before = structuredClone(r.order);
  const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
  assert.equal(result.tradeState, 'NOTPAY'); assert.equal(result.order.status, 'confirming');
  assert.equal(result.order.amountFen, 1); assert.deepEqual(r.order, before);
  assert.deepEqual(r.events, ['business:query', 'wechat:query']);
  assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_MARKER|callbackToken|payerOpenid|openid/);
});

test('unpaid queries still reject missing merchant identity or mismatched optional financial fields', async () => {
  const changes = [{ appid: undefined }, { mchid: undefined }, { out_trade_no: undefined },
    { appid: 'wx0000000000000000' }, { mchid: '9999999999' }, { out_trade_no: 'HLM202610080000000102' },
    { trade_type: 'NATIVE' }, { trade_type: null }, { payer: { openid: 'oDifferentPayer' } }, { payer: null },
    { amount: null }, { amount: { total: 2, currency: 'CNY' } }, { amount: { total: '1', currency: 'CNY' } },
    { amount: { total: 1, currency: 'USD' } }, { amount: { total: 1, currency: 'CNY', payer_currency: 'USD' } }];
  for (const state of ['NOTPAY', 'USERPAYING']) {
    for (const patch of changes) {
      const r = fixture({ local: { amountFen: 1 }, trade: { trade_state: state, trade_type: undefined,
        payer: undefined, amount: undefined, transaction_id: undefined, success_time: undefined, ...patch } });
      await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 409 && error.code === 40907);
      assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
    }
  }
});

test('unpaid WeChat results cannot reopen or overwrite a terminal local order', async () => {
  for (const status of ['paid', 'closed', 'failed', 'refunded']) {
    for (const tradeState of ['NOTPAY', 'USERPAYING']) {
      const r = fixture({ local: { status }, trade: { trade_state: tradeState,
        trade_type: undefined, payer: undefined, amount: undefined } });
      const before = structuredClone(r.order);
      await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 409 && error.code === 40907);
      assert.deepEqual(r.order, before); assert.equal(mutationCalls(r).length, 0);
    }
  }
});

test('permanent business verification failures remain conflicts rather than transient provider errors', async () => {
  for (const code of [40001, 40907, 40908]) {
    const r = fixture({ business: async () => ({ result: { code, message: TOKEN } }) });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error =>
      error.status === 409 && error.code === 40907 && !error.message.includes(TOKEN));
    assert.equal(r.wechatCalls.length, 0); assert.equal(mutationCalls(r).length, 0);
  }
  const temporary = fixture({ business: async () => ({ result: { code: 50000, message: TOKEN } }) });
  await assert.rejects(temporary.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 503 && error.code === 50301);
});

test('SUCCESS remains strict when an unpaid response would have allowed missing financial fields', async () => {
  for (const patch of [{ trade_type: undefined }, { payer: undefined }, { payer: {} }, { amount: undefined },
    { amount: {} }, { amount: { total: 188000 } }, { amount: { currency: 'CNY' } }]) {
    for (const operation of ['query', 'confirmVerifiedCallback']) {
      const r = fixture({ trade: patch });
      await assert.rejects(operation === 'query'
        ? r.bridge.query({ outTradeNo: ORDER_NO }, OPENID)
        : r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }), error => error.status === 409 && error.code === 40907);
      assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
    }
  }
});

test('real CLOSED and PAYERROR close only matching local orders with trusted complete proof', async () => {
  for (const [state, expected] of [['CLOSED', 'closed'], ['PAYERROR', 'failed']]) {
    const r = fixture({ trade: { trade_state: state, transaction_id: undefined, success_time: undefined } });
    const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.equal(result.order.status, expected);
    const close = mutationCalls(r)[0];
    assert.equal(close.data.path, '/internal/payment-orders/close');
    assert.deepEqual(close.data.data, { outTradeNo: ORDER_NO, merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY',
      amountFen: 188000, payerOpenid: OPENID, tradeState: state, paymentProvider: 'jsapi', callbackToken: TOKEN });
    assert.equal(r.fulfillments(), 0);
  }
});

test('unpaid terminal queries tolerate absent financial fields and derive close proof only from the authenticated order', async () => {
  const omissions = [{ trade_type: undefined }, { payer: undefined }, { amount: undefined },
    { amount: { total: 188000 } }, { amount: { currency: 'CNY' } }, { amount: {}, payer: {} },
    { amount: { payer_total: 0, payer_currency: 'CNY' }, payer: {} },
    { trade_type: undefined, amount: undefined, payer: undefined }];
  for (const [tradeState, status] of [['CLOSED', 'closed'], ['PAYERROR', 'failed']]) {
    for (const omission of omissions) {
      const r = fixture({ trade: { trade_state: tradeState, transaction_id: undefined, success_time: undefined, ...omission } });
      const result = await r.bridge.query({ outTradeNo: ORDER_NO, amountFen: 1, currency: 'USD',
        payerOpenid: 'attacker', userId: 2, merchantId: '9999999999', appId: 'wx0000000000000000' }, OPENID);
      assert.equal(result.order.status, status); assert.equal(r.fulfillments(), 0);
      assert.deepEqual(mutationCalls(r)[0].data.data, { outTradeNo: ORDER_NO, merchantId: MERCHANT.merchantId,
        appId: MERCHANT.appId, currency: 'CNY', amountFen: 188000, payerOpenid: OPENID, tradeState,
        paymentProvider: 'jsapi', callbackToken: TOKEN });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_MARKER|callbackToken|payerOpenid|openid|attacker/);
    }
  }
});

test('terminal queries reject mismatched identity or any present financial field before attempting close', async () => {
  const changes = [{ appid: undefined }, { mchid: undefined }, { out_trade_no: undefined },
    { appid: 'wx0000000000000000' }, { mchid: '9999999999' }, { out_trade_no: 'HLM202610080000000102' },
    { trade_type: 'NATIVE' }, { trade_type: null }, { payer: null }, { payer: { openid: 'oDifferentPayer' } },
    { payer: { openid: null } }, { amount: null }, { amount: { total: 1 } }, { amount: { total: '188000' } },
    { amount: { currency: 'USD' } }, { amount: { currency: null } }, { amount: { payer_currency: 'USD' } },
    { amount: { payer_total: -1 } }, { amount: { payer_total: 188001 } }, { amount: { payer_total: 1.2 } },
    { amount: { payer_total: '0' } }];
  for (const tradeState of ['CLOSED', 'PAYERROR']) {
    for (const patch of changes) {
      const r = fixture({ trade: { trade_state: tradeState, trade_type: undefined, amount: undefined,
        payer: undefined, transaction_id: undefined, success_time: undefined, ...patch } });
      const before = structuredClone(r.order);
      await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 409 && error.code === 40907);
      assert.deepEqual(r.order, before); assert.equal(mutationCalls(r).length, 0); assert.equal(r.fulfillments(), 0);
    }
  }
});

test('terminal queries cannot overwrite paid or refunded orders and repeated matching closes remain idempotent', async () => {
  for (const tradeState of ['CLOSED', 'PAYERROR']) {
    for (const status of ['paid', 'refunded', tradeState === 'CLOSED' ? 'failed' : 'closed']) {
      const r = fixture({ local: { status }, trade: { trade_state: tradeState,
        trade_type: undefined, amount: undefined, payer: undefined } });
      const before = structuredClone(r.order);
      await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 409 && error.code === 40905);
      assert.deepEqual(r.order, before); assert.equal(mutationCalls(r).length, 0);
    }
    const repeated = fixture({ trade: { trade_state: tradeState, trade_type: undefined, amount: undefined, payer: undefined } });
    const first = await repeated.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    const afterFirst = structuredClone(repeated.order);
    const second = await repeated.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.deepEqual(second, first); assert.deepEqual(repeated.order, afterFirst);
    assert.equal(mutationCalls(repeated).length, 2); assert.equal(repeated.fulfillments(), 0);
  }
});

test('a paid transaction that wins the close race is preserved and the conflict is returned', async () => {
  const r = fixture({ trade: { trade_state: 'CLOSED', trade_type: undefined, amount: undefined, payer: undefined },
    business: async (input, state) => {
      if (input.data.path.endsWith('/query')) return { result: { code: 0, data: { ...state.local, order: state.order } } };
      state.order.status = 'paid'; state.order.transactionId = '420000000000000000000001';
      return { result: { code: 40905, message: 'paid transaction won the race' } };
    } });
  await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), error => error.status === 409 && error.code === 40905);
  assert.equal(r.order.status, 'paid'); assert.equal(r.order.transactionId, '420000000000000000000001');
  assert.equal(mutationCalls(r).length, 1); assert.equal(r.fulfillments(), 0);
});

test('a close response must acknowledge the exact terminal order before reporting success', async () => {
  for (const patch of [{ status: 'paid' }, { status: 'confirming' }, { amountFen: 1 }, { userId: 2 }]) {
    const r = fixture({ trade: { trade_state: 'CLOSED', trade_type: undefined, amount: undefined, payer: undefined },
      business: async (input, state) => input.data.path.endsWith('/query')
        ? { result: { code: 0, data: { ...state.local, order: state.order } } }
        : { result: { code: 0, data: { order: { ...state.order, status: 'closed', ...patch } } } } });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), /会员订单关闭状态尚未确认/);
    assert.equal(r.fulfillments(), 0);
  }
});

test('forged callback plaintext never supplies identity or paid evidence and is rechecked against WeChat', async () => {
  const r = fixture({ trade: { trade_state: 'NOTPAY' } });
  const result = await r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO, trade_state: 'SUCCESS',
    payer: { openid: 'attacker' }, mchid: 'attacker', amount: { total: 1 }, transaction_id: 'forged-transaction' });
  assert.deepEqual(r.events, ['wechat:query', 'business:query']);
  assert.equal(r.calls[0].data.data.requesterOpenid, OPENID);
  assert.equal(result.order.status, 'confirming'); assert.equal(mutationCalls(r).length, 0);
});

test('duplicate callbacks use the same verified transaction and business idempotency grants once', async () => {
  const r = fixture();
  const callback = { out_trade_no: ORDER_NO, trade_state: 'SUCCESS' };
  assert.equal((await r.bridge.confirmVerifiedCallback(callback)).order.status, 'paid');
  assert.equal((await r.bridge.confirmVerifiedCallback(callback)).order.status, 'paid');
  assert.equal(r.fulfillments(), 1);
  assert.equal(r.wechatCalls.length, 2);
  assert.equal(mutationCalls(r).length, 2, 'every retry reaches backend idempotency with checked credentials');
});

test('callback verification failures and business errors reject so the generated controller can request retry', async () => {
  const failures = [fixture({ trade: { amount: { total: 1, currency: 'CNY' } } }),
    fixture({ query: async () => { throw new Error(TOKEN); } }),
    fixture({ business: async input => input.data.path.endsWith('/query')
      ? { result: { code: 0, data: { outTradeNo: ORDER_NO, merchantId: MERCHANT.merchantId, appId: MERCHANT.appId,
        currency: 'CNY', amountFen: 188000, payerOpenid: OPENID, status: 'confirming', userId: 1 } } }
      : { result: { code: 50000, message: TOKEN } } })];
  for (const r of failures) {
    await assert.rejects(r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }), error => !error.message.includes(TOKEN));
    assert.equal(r.fulfillments(), 0);
  }
});

test('callback budget expires after 3.5 seconds and cannot start a late business write', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 8) });
  const r = fixture({ query: async () => { context.mock.timers.tick(3501); return { status: 200, data: r.trade }; } });
  await assert.rejects(r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }), error => error.code === 50301);
  assert.equal(r.calls.length, 0); assert.equal(r.fulfillments(), 0);
});

test('callback checks the shared deadline again after the owner lookup before attempting confirmation', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 8) });
  const r = fixture({ business: async (input, state) => {
    context.mock.timers.tick(3501);
    return { result: { code: 0, data: { ...state.local, order: state.order } } };
  } });
  await assert.rejects(r.bridge.confirmVerifiedCallback({ out_trade_no: ORDER_NO }), error => error.code === 50301);
  assert.deepEqual(r.events, ['wechat:query', 'business:query']);
  assert.equal(mutationCalls(r).length, 0);
});

test('an unresolved query dependency has a bounded timeout and never confirms optimistically', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 8) });
  const r = fixture({ query: () => new Promise(() => {}) });
  const pending = r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
  const rejected = assert.rejects(pending, error => error.code === 50301);
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(8001);
  await rejected;
  assert.equal(mutationCalls(r).length, 0);
});

test('business confirmation must acknowledge the exact verified transaction before returning paid', async () => {
  for (const patch of [{ status: 'confirming' }, { transactionId: 'different-transaction' }, { amountFen: 1 }, { userId: 2 }]) {
    const r = fixture({ business: async (input, state) => input.data.path.endsWith('/query')
      ? { result: { code: 0, data: { ...state.local, order: state.order } } }
      : { result: { code: 0, data: { order: { ...state.order, status: 'paid', transactionId: '420000000000000000000001', ...patch } } } } });
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID), /会员权益尚未确认/);
  }
});

test('merchant config and credential are mandatory and invalid requests do not invoke cloud functions', async () => {
  for (const configuration of [{}, { merchant: MERCHANT, callbackToken: 'short' },
    { merchant: { ...MERCHANT, envId: '' }, callbackToken: TOKEN },
    { merchant: { ...MERCHANT, businessFunctionName: 'other' }, callbackToken: TOKEN }]) {
    assert.throws(() => createMembershipBridge({ callFunction() {}, payService: { unifiedOrder() {}, queryOrderByOutTradeNo() {} }, ...configuration }));
  }
  const r = fixture();
  await assert.rejects(r.bridge.create({ outTradeNo: '../internal/confirm' }, OPENID));
  await assert.rejects(r.bridge.confirmVerifiedCallback({ out_trade_no: '' }));
  assert.equal(r.calls.length, 0); assert.equal(r.wechatCalls.length, 0);
});
