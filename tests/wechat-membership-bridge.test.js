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
    updatedAt: '2026-10-08T00:00:00Z', callbackToken: TOKEN, payerOpenid: OPENID, privateKey: 'PRIVATE_KEY_MARKER' };
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

test('create ignores all injected financial identity and callback fields and uses explicit hlApi environment', async () => {
  const r = fixture();
  const params = await r.bridge.create({ outTradeNo: ORDER_NO, amountFen: 1, payerOpenid: 'attacker', requesterOpenid: 'attacker',
    appid: 'attacker-app', mchid: '000001', notify_url: 'https://invalid.example', callbackToken: 'attacker-token' }, OPENID);
  assert.deepEqual(r.calls[0], { name: 'hlApi', config: { env: MERCHANT.envId }, data: {
    path: '/internal/payment-orders/checkout', method: 'POST', data: { outTradeNo: ORDER_NO, requesterOpenid: OPENID, callbackToken: TOKEN }
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
    successTime: r.trade.success_time, callbackToken: TOKEN });
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
    await assert.rejects(r.bridge.query({ outTradeNo: ORDER_NO }, OPENID));
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

test('NOTPAY and USERPAYING leave local state unchanged; a delayed query cannot claim paid early', async () => {
  for (const state of ['NOTPAY', 'USERPAYING']) {
    const r = fixture({ trade: { trade_state: state, payer: undefined, amount: undefined, transaction_id: undefined, success_time: undefined } });
    const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.equal(result.order.status, 'confirming'); assert.equal(mutationCalls(r).length, 0);
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

test('real CLOSED and PAYERROR close only matching local orders with complete proof', async () => {
  for (const [state, expected] of [['CLOSED', 'closed'], ['PAYERROR', 'failed']]) {
    const r = fixture({ trade: { trade_state: state, transaction_id: undefined, success_time: undefined } });
    const result = await r.bridge.query({ outTradeNo: ORDER_NO }, OPENID);
    assert.equal(result.order.status, expected);
    const close = mutationCalls(r)[0];
    assert.equal(close.data.path, '/internal/payment-orders/close');
    assert.deepEqual(close.data.data, { outTradeNo: ORDER_NO, merchantId: MERCHANT.merchantId, appId: MERCHANT.appId, currency: 'CNY',
      amountFen: 188000, payerOpenid: OPENID, tradeState: state, callbackToken: TOKEN });
    assert.equal(r.fulfillments(), 0);
  }
  const incomplete = fixture({ trade: { trade_state: 'CLOSED', payer: undefined } });
  await assert.rejects(incomplete.bridge.query({ outTradeNo: ORDER_NO }, OPENID));
  assert.equal(mutationCalls(incomplete).length, 0);
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
