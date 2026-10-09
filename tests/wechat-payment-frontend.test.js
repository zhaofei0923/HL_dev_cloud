const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');
const { paymentParamsFrom, assertPaymentQueryResponse } = require('../miniprogram/utils/payment-response');

const plain = value => JSON.parse(JSON.stringify(value));
const PARAMS = { timeStamp: '1791450000', nonceStr: 'nonce_123', package: 'prepay_id=wx123456', signType: 'RSA', paySign: 'testSignature==' };
const config = { available: true, reason: '', functionName: 'configured-wxpay-function',
  createPath: '/hl-membership/create', queryPath: '/hl-membership/query' };
const order = (status = 'pending', outTradeNo = 'server-order-1') => ({ id: 1, userId: 1, outTradeNo,
  planCode: 'monthly', planTitle: '月度会员', amountFen: 10000, durationDays: 30, status,
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' });
const overview = payment => ({ isPremiumMember: false, phoneBound: true, phoneMasked: '', needsMatchmaker: false,
  membership: null, plans: [{ planCode: 'monthly', title: '月度会员', durationDays: 30, priceText: '100元' }], payment: payment || config });
const wrapped = data => ({ statusCode: 200, data: { code: 0, data } });
const queried = status => wrapped({ order: order(status) });

test('payment parameters accept current and legacy envelopes and project only native RSA fields', () => {
  for (const result of [wrapped(PARAMS), { data: { payment: PARAMS } }, { data: { data: { payment: PARAMS } } },
    { status: 200, data: { code: 0, data: PARAMS } }, { data: PARAMS }, PARAMS]) {
    assert.deepEqual(paymentParamsFrom(result), PARAMS);
  }
  const { signType: _signType, ...legacyParams } = PARAMS;
  assert.deepEqual(paymentParamsFrom(wrapped({ ...legacyParams, amount: 1, openid: 'ignored', success: 'ignored' })), PARAMS);
});

test('HTTP, SDK and every nested business failure block otherwise valid payment parameters', () => {
  for (const result of [
    { statusCode: 500, data: { code: 0, data: PARAMS } }, { statusCode: '200', data: PARAMS },
    { status: 500, data: PARAMS }, { statusCode: 200, data: { status: 201, data: PARAMS } },
    { code: 9, data: PARAMS }, { data: { code: 9, data: PARAMS } },
    { data: { code: 0, data: { code: 9, payment: PARAMS } } },
    { data: { code: '0', data: PARAMS } }, { data: [] }, { data: null }, 'invalid', null
  ]) assert.throws(() => paymentParamsFrom(result));
});

test('malformed prepay packages, timestamps, nonce, signature values and non-RSA types are rejected', () => {
  for (const patch of [{ package: 'wx123' }, { package: 'prepay_id=' }, { package: 'prepay_id=wx1&amount=1' },
    { signType: 'MD5' }, { signType: 'HMAC-SHA256' }, { signType: null }, { timeStamp: 1791450000 },
    { timeStamp: 'NaN' }, { nonceStr: {} }, { nonceStr: '' }, { paySign: '' }, { paySign: {} }, { paySign: ' invalid ' }]) {
    assert.throws(() => paymentParamsFrom(wrapped({ ...PARAMS, ...patch })));
  }
});

test('query envelopes require successful transport and the exact current order identity and recognized status', () => {
  for (const status of ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']) {
    assert.doesNotThrow(() => assertPaymentQueryResponse(queried(status), 'server-order-1'));
  }
  for (const response of [{ statusCode: 502, data: { code: 0, data: { order: order('paid') } } },
    { data: { code: 1, data: { order: order('paid') } } }, wrapped({ order: order('paid', 'other-order') }),
    wrapped({ order: order('SUCCESS') }), wrapped({ order: { ...order('paid'), code: 1 } }), wrapped({ order: null }), wrapped({})]) {
    assert.throws(() => assertPaymentQueryResponse(response, 'server-order-1'));
  }
});

function checkoutRuntime(options = {}) {
  const events = [], http = [], requests = [], modals = [];
  let creates = 0, localReads = 0;
  const state = { payment: config, queryResponse: queried('paid'), localOrder: order('paid') };
  const r = runtime('pages/user/membership.js', {
    memberApi: {
      membershipOverview: async () => overview(state.payment),
      createMembershipOrder: async () => { creates++; return { order: order(), payment: config }; },
      membershipOrder: async outTradeNo => {
        localReads++; events.push('local-query');
        return options.localRead ? options.localRead(outTradeNo) : state.localOrder;
      }
    },
    wx: {
      cloud: { callHTTPFunction(call) {
        http.push(call); events.push(call.path.endsWith('/create') ? 'create' : 'bridge-query');
        if (options.httpCall) return options.httpCall(call);
        call.success(call.path.endsWith('/create') ? wrapped(PARAMS) : state.queryResponse);
      } },
      requestPayment(call) {
        requests.push(call); events.push('payment-sheet');
        if (options.paymentCall) return options.paymentCall(call);
        call.success({});
      },
      showModal: call => modals.push(call)
    }
  });
  return { ...r, events, http, requests, modals, state, creates: () => creates, localReads: () => localReads };
}

test('successful sheet payment synchronizes through the configured query bridge before reading authoritative membership order', async () => {
  const r = checkoutRuntime();
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.deepEqual(r.events, ['create', 'payment-sheet', 'bridge-query', 'local-query']);
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.modals.at(-1).title, '会员已开通');
  for (const call of r.http) {
    assert.equal(call.name, config.functionName);
    assert.equal(call.method, 'POST');
    assert.equal(call.config.env, 'test-environment');
    assert.deepEqual(plain(call.data), { outTradeNo: 'server-order-1' });
    assert.deepEqual(plain(call.header), { 'Content-Type': 'application/json' });
  }
  assert.deepEqual(Object.keys(r.requests[0]).sort(), [...Object.keys(PARAMS), 'success', 'fail'].sort());
  assert.equal(r.creates(), 1);
});

test('query bridge failure remains confirming, cannot be masked by local paid state or create a repeated charge', async () => {
  const r = checkoutRuntime();
  r.state.queryResponse = { statusCode: 200, data: { code: 7, data: { order: order('paid') } } };
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'confirming');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.localReads(), 0);
  assert.equal(r.modals.length, 0);
  await r.page.startPayment();
  assert.equal(r.localReads(), 0);
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 1);
  r.state.queryResponse = queried('paid');
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.localReads(), 1);
});

test('an HTTP-success callback carrying a failed prepay response never opens the payment sheet', async () => {
  const r = checkoutRuntime({ httpCall(call) {
    call.success({ statusCode: 503, data: { code: 0, data: PARAMS } });
  } });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.requests.length, 0);
  assert.equal(r.localReads(), 0);
  assert.equal(r.page.data.orderCanResume, true);
  assert.notEqual(r.page.data.orderStatus, 'paid');
});

test('manual query uses the current overview integration and falls back locally only for an absent legacy query path', async () => {
  const r = checkoutRuntime();
  r.state.payment = { ...config, functionName: 'current-function', queryPath: '/current/query' };
  await r.page.loadOverview();
  r.page.setData({ lastOrderId: 'server-order-1' });
  await r.page.refreshOrderStatus();
  assert.equal(r.http[0].name, 'current-function');
  assert.equal(r.http[0].path, '/current/query');
  r.state.payment = { ...config, queryPath: '' };
  await r.page.loadOverview();
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderStatus, 'confirming');
  assert.equal(r.localReads(), 1, 'an empty query route cannot bypass the bridge');
  const { queryPath: _queryPath, ...legacyConfig } = config;
  r.state.payment = legacyConfig;
  await r.page.loadOverview();
  await r.page.refreshOrderStatus();
  assert.equal(r.localReads(), 2);
  assert.equal(r.http.length, 1);
});

test('every poll synchronizes before a local read, and a paid bridge response alone cannot grant membership', async () => {
  const r = checkoutRuntime();
  r.state.localOrder = order('pending');
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  assert.equal(r.localReads(), 1);
  assert.equal(r.page.data.orderStatus, 'confirming');
  assert.equal(r.page.data.confirming, true);
  assert.equal(r.modals.length, 0);
  r.state.localOrder = order('paid');
  r.advance(1500);
  await paying;
  assert.deepEqual(r.events, ['create', 'payment-sheet', 'bridge-query', 'local-query', 'bridge-query', 'local-query']);
  assert.equal(r.page.data.orderStatus, 'paid');
});

test('cancellation and prepay network failures keep the original server order resumable', async () => {
  for (const failure of ['cancel', 'network']) {
    let once = true;
    const r = checkoutRuntime({
      paymentCall(call) {
        if (failure === 'cancel' && once) { once = false; call.fail({ errMsg: 'requestPayment:fail cancel' }); }
        else call.success({});
      },
      httpCall(call) {
        if (failure === 'network' && once) { once = false; call.fail({ errMsg: 'network unavailable' }); }
        else call.success(call.path.endsWith('/create') ? wrapped(PARAMS) : queried('paid'));
      }
    });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.page.data.orderCanResume, true);
    await r.page.startPayment();
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.creates(), 1);
    assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
  }
});

test('an account change during prepay stops the old payment sheet and cannot update the new account', async () => {
  let pending;
  const r = checkoutRuntime({ httpCall(call) { pending = call; } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'new-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  const updates = r.calls.updates.length;
  pending.success(wrapped(PARAMS));
  await paying;
  assert.equal(r.requests.length, 0);
  assert.equal(r.calls.updates.length, updates);
  assert.equal(r.page.data.lastOrderId, '');
});

test('an account change during bridge query stops local lookup, later polling and old result UI', async () => {
  let pending;
  const r = checkoutRuntime({ httpCall(call) {
    if (call.path.endsWith('/create')) call.success(wrapped(PARAMS)); else pending = call;
  } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'new-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  const updates = r.calls.updates.length;
  pending.success(queried('paid'));
  await paying;
  r.advance(3000); await flush();
  assert.equal(r.localReads(), 0);
  assert.equal(r.http.length, 2);
  assert.equal(r.calls.updates.length, updates);
  assert.equal(r.modals.length, 0);
});

test('account changes or page unload during polling sleep prevent another bridge or local call', async () => {
  for (const end of ['account', 'unload']) {
    const r = checkoutRuntime(); r.state.localOrder = order('pending');
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    if (end === 'account') {
      r.session.token = 'new-token'; r.session.user = { id: 2 };
      await r.page.onShow();
    } else r.page.onUnload();
    const updates = r.calls.updates.length;
    r.advance(1500);
    await paying;
    assert.equal(r.http.length, 2);
    assert.equal(r.localReads(), 1);
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.modals.length, 0);
  }
});

test('old local query results cannot update a replacement account after the bridge has completed', async () => {
  const local = deferred();
  const r = checkoutRuntime({ localRead: () => local.promise });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'new-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  const updates = r.calls.updates.length;
  local.resolve(order('paid'));
  await paying;
  assert.equal(r.calls.updates.length, updates);
  assert.equal(r.modals.length, 0);
  assert.equal(r.page.data.lastOrderId, '');
});
