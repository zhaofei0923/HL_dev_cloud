const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');
const { paymentParamsFrom, virtualPaymentParamsFrom, assertPaymentQueryResponse, isTransientPaymentQueryError } = require('../miniprogram/utils/payment-response');

const plain = value => JSON.parse(JSON.stringify(value));
const PARAMS = { timeStamp: '1791450000', nonceStr: 'nonce_123', package: 'prepay_id=wx123456', signType: 'RSA', paySign: Buffer.alloc(256, 0x25).toString('base64') };
const CHECKOUT_PATH = '/member/payment-virtual/checkout';
const QUERY_PATH = '/member/payment-virtual/query';
const config = { provider: 'virtual', available: true, reason: '', functionName: '', createPath: '', queryPath: '' };
const supportedIos = {
  getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 15.0' }),
  getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.68' })
};
const order = (status = 'pending', outTradeNo = 'server-order-1') => ({ id: 1, userId: 1, outTradeNo,
  planCode: 'monthly', planTitle: '月度会员', amountFen: 10000, durationDays: 30, status,
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' });
const overview = payment => ({ isPremiumMember: false, phoneBound: true, phoneMasked: '', needsMatchmaker: false,
  membership: null, plans: [{ planCode: 'monthly', title: '月度会员', amountFen: 10000, durationDays: 30, priceText: '100元' }], payment: payment || config });
const wrapped = data => ({ statusCode: 200, data: { code: 0, data } });
const queried = status => wrapped({ order: order(status) });
const virtualCheckoutResult = (currentOrder = order(), paymentAttemptNo = 'HLA_TEST_ATTEMPT_1') => ({
  order: currentOrder,
  paymentAttemptNo,
  virtualPayment: {
    mode: 'short_series_goods',
    signData: JSON.stringify({ offerId: '1450674507', buyQuantity: 1, env: 0, currencyType: 'CNY',
      productId: currentOrder.planCode, goodsPrice: currentOrder.amountFen, outTradeNo: paymentAttemptNo, attach: currentOrder.outTradeNo }),
    paySig: 'a'.repeat(64), signature: 'b'.repeat(64)
  }
});

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

test('native payment boundaries enforce seconds, nonce and package limits, and a bounded RSA Base64 signature', () => {
  assert.doesNotThrow(() => paymentParamsFrom(wrapped({ ...PARAMS, nonceStr: 'a'.repeat(32), package: `prepay_id=${'a'.repeat(118)}` })));
  for (const patch of [{ timeStamp: '1791450000000' }, { timeStamp: '179145' }, { timeStamp: '0000000000' },
    { nonceStr: 'a'.repeat(33) }, { package: `prepay_id=${'a'.repeat(119)}` },
    { paySign: Buffer.alloc(385, 0x25).toString('base64') }, { paySign: 'abc=' }, { paySign: `${PARAMS.paySign}a` }]) {
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

test('provider trade state is accepted only when compatible with the verified current order', () => {
  for (const tradeState of ['NOTPAY', 'USERPAYING']) {
    for (const status of ['pending', 'confirming']) {
      assert.deepEqual(assertPaymentQueryResponse(wrapped({ order: order(status), tradeState }), 'server-order-1'), { tradeState });
    }
    for (const status of ['paid', 'closed', 'failed', 'refunded']) {
      assert.throws(() => assertPaymentQueryResponse(wrapped({ order: order(status), tradeState }), 'server-order-1'));
    }
  }
  for (const tradeState of ['unknown', 'REFUND', null, {}, 0]) {
    assert.throws(() => assertPaymentQueryResponse(wrapped({ order: order('pending'), tradeState }), 'server-order-1'));
  }
  assert.deepEqual(assertPaymentQueryResponse(queried('paid'), 'server-order-1'), {});
});

function checkoutRuntime(options = {}) {
  const events = [], http = [], requests = [], modals = [];
  const virtualCheckoutInputs = [];
  let creates = 0, localReads = 0, attemptSerial = 0, checkoutOrder;
  const state = { payment: config, queryResponse: queried('paid'), localOrder: order('paid'), pendingOrder: undefined };
  function bridge(call) {
    http.push(call); events.push(call.path === CHECKOUT_PATH ? 'create' : 'bridge-query');
    if (options.httpCall) return options.httpCall(call);
    call.success(call.path === CHECKOUT_PATH ? wrapped(PARAMS) : state.queryResponse);
  }
  const serviceCall = (path, data) => new Promise((resolve, reject) => bridge({ path, data, success: resolve, fail: reject }));
  const r = runtime('pages/user/membership.js', {
    memberApi: {
      membershipOverview: async () => {
        if (state.pendingOrder) checkoutOrder = state.pendingOrder;
        return options.overviewCall ? options.overviewCall() : { ...overview(state.payment), pendingOrder: state.pendingOrder };
      },
      createMembershipOrder: async () => {
        creates++;
        const checkout = await (options.createOrder ? options.createOrder() : { order: order(), payment: config });
        checkoutOrder = checkout.order;
        return checkout;
      },
      virtualPaymentCheckout: async (outTradeNo, loginCode) => {
        const paymentAttemptNo = `HLA_TEST_ATTEMPT_${++attemptSerial}`;
        virtualCheckoutInputs.push({ outTradeNo, loginCode, paymentAttemptNo });
        const currentOrder = checkoutOrder || state.pendingOrder || order('pending', outTradeNo);
        const result = virtualCheckoutResult(currentOrder, paymentAttemptNo);
        if (options.virtualCheckoutResult) return options.virtualCheckoutResult(result);
        // Older fixtures use an RSA payload as a successful transport sentinel.
        // Adapt only that sentinel; keep all envelope errors and query checks.
        function adapt(value) {
          if (!value || typeof value !== 'object') return value;
          if (value.package === PARAMS.package) return result;
          return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, adapt(nested)]));
        }
        const response = adapt(await serviceCall(CHECKOUT_PATH, { outTradeNo, loginCode }));
        assertPaymentQueryResponse(response, outTradeNo);
        let payload = response;
        while (payload.data) payload = payload.data;
        return payload;
      },
      virtualPaymentQuery: async outTradeNo => options.virtualApiCall
        ? options.virtualApiCall(outTradeNo) : serviceCall(QUERY_PATH, { outTradeNo }),
      membershipOrder: async outTradeNo => {
        localReads++; events.push('local-query');
        return options.localRead ? options.localRead(outTradeNo) : state.localOrder;
      }
    },
    wx: {
      getDeviceInfo: () => ({ platform: 'android' }),
      getAppBaseInfo: () => ({ SDKVersion: '3.10.0' }),
      canIUse: () => false,
      login: call => call.success({ code: 'fresh-wechat-code' }),
      cloud: { callHTTPFunction: bridge },
      requestPayment() { assert.fail('membership checkout must not invoke the legacy JSAPI payment sheet'); },
      requestVirtualPayment(call) {
        requests.push(call); events.push('payment-sheet');
        if (options.paymentCall) return options.paymentCall(call);
        call.success({});
      },
      showModal: call => modals.push(call),
      ...options.wx
    }
  });
  return { ...r, events, http, requests, modals, state, virtualCheckoutInputs, creates: () => creates, localReads: () => localReads };
}

function virtualApiCall(responseForRequest) {
  const requests = [];
  const r = runtime('pages/user/membership.js', { wx: { cloud: { callFunction(call) {
    requests.push({ name: call.name, env: call.config.env, path: call.data.path,
      method: call.data.method, outTradeNo: call.data.data.outTradeNo });
    call.success({ result: responseForRequest(call.data, requests.length) });
  } } } });
  // Load the generated service and its real api.request adapter. Only the
  // native cloud SDK is mocked, preserving the actual code/message error shape.
  const actualMemberApi = r.load(require.resolve('../miniprogram/services/member.js')).memberApi;
  return { requests, query: outTradeNo => actualMemberApi.virtualPaymentQuery(outTradeNo) };
}

test('one-cent payment probe shows explicit test wording and exactly one day of membership', async () => {
  const r = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => ({ ...overview({ ...config, testMode: true }),
      plans: [{ planCode: 'hl_payment_probe', title: '微信支付测试', durationDays: 1, amountFen: 1, priceText: '0.01元' }] })
  } });
  await r.page.loadOverview();
  assert.equal(r.page.data.statusTitle, '微信支付沙箱测试');
  assert.equal(r.page.data.paymentActionText, '手动测试 ¥0.01');
  assert.match(r.page.data.expiryText, /沙箱测试金额¥0\.01，服务端确认后获得1天会员权益/);
  assert.equal(r.page.data.plans[0].descriptionText, '沙箱测试：¥0.01，确认后开通1天会员权益');
  assert.equal(r.page.data.selectedPlanCode, 'hl_payment_probe');
  assert.equal(r.page.data.onlineCheckout, true);
});

test('a completed one-cent probe removes the pay option and cannot create another charge', async () => {
  const completedPayment = { ...config, available: false, testMode: true, reason: 'payment_test_completed' };
  // The server returns no plans after this designated account has completed the probe.
  const completed = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => ({ ...overview(completedPayment), plans: [] }),
    createMembershipOrder: async () => assert.fail('completed probe cannot create another order')
  }, wx: { requestPayment: () => assert.fail('completed probe cannot open payment sheet') } });
  completed.page.setData({ selectedPlanCode: 'hl_payment_probe' });
  await completed.page.loadOverview();
  assert.equal(completed.page.data.statusTitle, '支付测试已完成');
  assert.equal(completed.page.data.paymentActionText, '支付测试已完成');
  assert.equal(completed.page.data.selectedPlanCode, '');
  assert.equal(completed.page.data.onlineCheckout, false);
  assert.equal(completed.page.data.plans.length, 0);
  await completed.page.startPayment();
  assert.equal(completed.calls.toasts.at(-1), '支付测试已完成');
});

test('authoritative probe payment completion is displayed as a test result and normal membership wording remains', async () => {
  const r = checkoutRuntime();
  r.state.payment = { ...config, testMode: true };
  await r.page.loadOverview();
  await r.page.showOrderResult({ ...order('paid'), planCode: 'hl_payment_probe', amountFen: 1, durationDays: 1 }, true);
  assert.equal(r.page.data.orderTitle, '支付测试已完成');
  assert.ok(r.page.data.orderNote.includes('1天会员权益已经生效'));
  assert.equal(r.modals.at(-1).title, '支付测试已完成');
  const normal = checkoutRuntime();
  await normal.page.loadOverview();
  assert.equal(normal.page.data.statusTitle, '开通会员权益');
  assert.equal(normal.page.data.paymentActionText, '微信支付开通会员');
  await normal.page.showOrderResult(order('paid'), true);
  assert.equal(normal.modals.at(-1).title, '会员已开通');
});

test('weekly sandbox copy follows selected server snapshot and never describes a one-cent real charge', async () => {
  const weekly = { planCode: 'vip_week', title: 'VIP周卡', productType: 'vip', durationDays: 7,
    amountFen: 6160, priceText: '61.60元', description: '旧文案：0.01元确认后开通1天会员权益' };
  const probe = { planCode: 'hl_payment_probe', title: '微信支付测试', productType: 'vip', durationDays: 1,
    amountFen: 1, priceText: '0.01元' };
  const r = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => ({ ...overview({ ...config, testMode: true }), plans: [weekly, probe] }),
    createMembershipOrder: async () => assert.fail('selecting a sandbox plan must never start payment automatically')
  }, wx: {
    requestVirtualPayment: () => assert.fail('sandbox plan selection is display only'),
    requestPayment: () => assert.fail('sandbox plans must not use ordinary payment')
  } });
  await r.page.loadOverview();
  assert.equal(r.page.data.statusTitle, '微信支付沙箱测试');
  assert.equal(r.page.data.paymentActionText, '手动测试 ¥61.60');
  assert.equal(r.page.data.plans[0].descriptionText, '沙箱测试：¥61.60，确认后开通7天会员权益');
  assert.match(r.page.data.paymentTestNotice, /沙箱测试金额¥61\.60，服务端确认后获得7天会员权益/);
  assert.match(r.page.data.paymentTestNotice, /手动发起，不自动扣款/);
  assert.doesNotMatch(r.page.data.expiryText + r.page.data.paymentTestNotice, /0\.01|1天|真实付款/);
  r.page.onPlanChange({ detail: { value: 'hl_payment_probe' } });
  assert.equal(r.page.data.paymentActionText, '手动测试 ¥0.01');
  assert.match(r.page.data.paymentTestNotice, /1天会员权益/);
  r.page.selectPlan({ currentTarget: { dataset: { code: 'vip_week' } } });
  assert.equal(r.page.data.paymentActionText, '手动测试 ¥61.60');
  assert.match(r.page.data.expiryText, /7天会员权益/);
  await r.page.showOrderResult({ ...order('paid'), planCode: 'vip_week', planTitle: 'VIP周卡', productType: 'vip',
    amountFen: 6160, durationDays: 7 }, true);
  assert.equal(r.page.data.orderTitle, '支付测试已完成');
  assert.match(r.page.data.orderNote, /金额¥61\.60，7天会员权益已经生效/);
  assert.doesNotMatch(r.page.data.orderNote, /0\.01|1天|真实付款/);
});

test('sandbox pending restoration uses original order amount and days even after the catalog changes', async () => {
  const weekly = { planCode: 'vip_week', title: 'VIP周卡', productType: 'vip', durationDays: 7,
    amountFen: 6160, priceText: '61.60元' };
  const pending = { ...order(), planCode: 'hl_payment_probe', planTitle: '微信支付测试', productType: 'vip',
    amountFen: 1, durationDays: 1, paymentProvider: 'virtual' };
  const payment = { ...config, testMode: true };
  const queries = [];
  const r = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => ({ ...overview(payment), plans: [weekly], pendingOrder: pending, pendingOrderPayment: payment }),
    virtualPaymentQuery: async outTradeNo => { queries.push(outTradeNo); return { order: pending, tradeState: 'NOTPAY' }; },
    membershipOrder: async () => pending,
    createMembershipOrder: async () => assert.fail('reopening must retain the original sandbox order'),
    virtualPaymentCheckout: async () => assert.fail('restoration must not start another sandbox attempt')
  }, wx: {
    requestVirtualPayment: () => assert.fail('restoration must never open payment automatically'),
    requestPayment: () => assert.fail('restoration must never migrate payment provider')
  } });
  await r.page.loadOverview();
  assert.equal(r.page.data.selectedPlanCode, 'hl_payment_probe');
  assert.equal(r.page.data.paymentActionText, '手动测试 ¥0.01');
  assert.match(r.page.data.paymentTestNotice, /沙箱测试金额¥0\.01，服务端确认后获得1天会员权益/);
  assert.doesNotMatch(r.page.data.paymentTestNotice, /61\.60|7天/);
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  assert.equal(reopened.data.paymentActionText, '手动测试 ¥0.01');
  assert.match(reopened.data.paymentTestNotice, /1天会员权益/);
  assert.deepEqual(queries, [pending.outTradeNo, pending.outTradeNo]);
});

test('virtual sheet payment uses hlApi checkout and query before reading authoritative membership order', async () => {
  const r = checkoutRuntime();
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.deepEqual(r.events, ['create', 'payment-sheet', 'bridge-query', 'local-query']);
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.modals.at(-1).title, '会员已开通');
  for (const call of r.http) {
    assert.equal(call.data.outTradeNo, 'server-order-1');
  }
  assert.deepEqual(plain(r.http[0].data), { outTradeNo: 'server-order-1', loginCode: 'fresh-wechat-code' });
  assert.deepEqual(r.http.map(call => call.path), [CHECKOUT_PATH, QUERY_PATH]);
  assert.deepEqual(Object.keys(r.requests[0]).sort(), ['mode', 'signData', 'paySig', 'signature', 'success', 'fail'].sort());
  assert.equal(r.creates(), 1);
});

test('a cancelled payment with a trusted NOTPAY query resumes the same business order without creating another order', async () => {
  let first = true;
  const r = checkoutRuntime({ paymentCall(call) {
    if (first) { first = false; return call.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail' }); }
    return call.success({});
  } });
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  r.state.localOrder = order('confirming');
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderTitle, '订单尚未付款');
  assert.equal(r.page.data.orderCanResume, true);
  assert.equal(r.page.data.confirming, false);
  assert.equal(r.http.filter(call => call.path.endsWith('/query')).length, 1);
  assert.equal(r.modals.length, 0);
  r.state.queryResponse = queried('paid');
  r.state.localOrder = order('paid');
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 2);
  assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
});

test('native banned and permission restrictions persist, block another payment, and preserve authoritative order queries', async () => {
  for (const errMsg of ['requestPayment:fail banned', 'requestPayment:fail no permission', 'requestPayment:fail access denied']) {
    const r = checkoutRuntime({ paymentCall(call) { call.fail({ errMsg }); } });
    r.state.localOrder = order('confirming');
    r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.page.data.paymentRestricted, true);
    assert.equal(r.page.data.orderTitle, '微信支付能力受限');
    assert.ok(r.page.data.orderNote.includes('仍可查询已有订单'));
    assert.notEqual(r.page.data.orderStatus, 'paid');
    assert.equal(r.localReads(), 0);
    assert.equal(r.modals.length, 0);
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page.data.lastOrderId, 'server-order-1');
    await r.page.onShow();
    await r.page.startPayment();
    assert.equal(r.page.data.paymentRestricted, true);
    assert.equal(r.creates(), 1);
    assert.equal(r.requests.length, 1);
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderTitle, '订单尚未付款');
    assert.equal(r.page.data.orderCanResume, false, 'NOTPAY must not override the native payment restriction');
    assert.ok(r.page.data.orderNote.includes('支付能力受限'));
    await r.page.startPayment();
    assert.equal(r.requests.length, 1);
    r.state.queryResponse = queried('paid');
    r.state.localOrder = order('paid');
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderStatus, 'paid', 'only a verified query can show that an existing order was paid');
    assert.equal(r.page.data.orderTitle, '会员已开通');
    assert.equal(r.page.data.paymentRestricted, true);
    await r.page.startPayment();
    assert.equal(r.requests.length, 1);
    assert.equal(r.creates(), 1);
  }
});

test('order API and query permission errors cannot be misclassified as a native payment restriction', async () => {
  const beforePayment = checkoutRuntime({ httpCall(call) { call.fail({ errMsg: 'requestPayment:fail banned' }); } });
  await beforePayment.page.loadOverview();
  await beforePayment.page.startPayment();
  assert.equal(beforePayment.page.data.paymentRestricted, false);
  assert.equal(beforePayment.requests.length, 0);
  assert.equal(beforePayment.page.data.orderCanResume, true);
  const queryDenied = checkoutRuntime();
  queryDenied.state.queryResponse = { statusCode: 403, data: { code: 40304, message: 'no permission' } };
  await queryDenied.page.loadOverview();
  await queryDenied.page.startPayment();
  assert.equal(queryDenied.page.data.paymentRestricted, false);
  assert.equal(queryDenied.page.data.orderTitle, '订单核验未通过');
});

test('a late native restriction from a previous session cannot disable the replacement account', async () => {
  let pending;
  const r = checkoutRuntime({ paymentCall(call) { pending = call; } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'replacement-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  pending.fail({ errMsg: 'requestPayment:fail banned' });
  await paying;
  assert.equal(r.page.data.paymentRestricted, false);
  assert.equal(r.page.data.lastOrderId, '');
  assert.equal(r.localReads(), 0);
  assert.equal(r.modals.length, 0);
});

test('USERPAYING and an absent or mismatched resumable checkout never authorize another payment', async () => {
  const r = checkoutRuntime({ paymentCall: call => call.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail' }) });
  r.state.localOrder = order('confirming');
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, true);
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'USERPAYING' });
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderTitle, '付款结果确认中');
  assert.equal(r.page.data.orderCanResume, false);
  await r.page.startPayment();
  assert.equal(r.requests.length, 1);
  assert.equal(r.creates(), 1);
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  for (const checkout of [null, { order: order('pending', 'another-order'), payment: config }]) {
    r.page._resumableCheckout = checkout;
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderTitle, '订单尚未付款');
    assert.equal(r.page.data.orderCanResume, false);
  }
});

test('an unpaid bridge result conflicting with a terminal local order is rejected without resuming payment', async () => {
  const r = checkoutRuntime();
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  r.state.localOrder = order('paid');
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderTitle, '订单核验未通过');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.http.filter(call => call.path.endsWith('/query')).length, 1);
  assert.equal(r.requests.length, 1);
  assert.equal(r.creates(), 1);
});

test('a transient post-payment network error or HTTP 502/503 retries the original order and then confirms paid', async () => {
  for (const failure of ['network', 502, 503]) {
    let queryCalls = 0;
    const r = checkoutRuntime({ httpCall(call) {
      if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
      queryCalls++;
      if (queryCalls === 1) {
        if (failure === 'network') return call.fail({ errMsg: 'callHTTPFunction:fail network timeout' });
        return call.success({ statusCode: failure, data: { code: -1 } });
      }
      return call.success(queried('paid'));
    } });
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    assert.equal(queryCalls, 1);
    assert.equal(r.localReads(), 0);
    assert.equal(r.page.data.confirming, true);
    assert.equal(r.calls.toasts.length, 0);
    r.advance(1500);
    await paying;
    assert.equal(queryCalls, 2);
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.creates(), 1);
    assert.equal(r.requests.length, 1);
    assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
  }
});

test('permanent query rejection, mismatched order and validation codes do not retry or issue another charge', async () => {
  for (const rejected of [
    { statusCode: 403, data: { code: 40304 } },
    { statusCode: 502, data: { code: 40001 } },
    { statusCode: 503, data: { code: 40906 } },
    { statusCode: 502, data: { code: 40304 } },
    wrapped({ order: order('paid', 'different-order') })
  ]) {
    const r = checkoutRuntime();
    r.state.queryResponse = rejected;
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.http.length, 2);
    assert.equal(r.localReads(), 0);
    assert.equal(r.page.data.orderStatus, 'confirming');
    assert.equal(r.page.data.orderTitle, '订单核验未通过');
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page.data.lastOrderId, 'server-order-1');
    r.advance(1500); await flush();
    assert.equal(r.http.length, 2);
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.equal(r.requests.length, 1);
  }
});

test('persistent transient query failure stops after eight attempts and leaves a manual result lookup without raw technical toast', async () => {
  let unavailable = true;
  const r = checkoutRuntime({ httpCall(call) {
    if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
    if (unavailable) return call.fail({ errMsg: 'callHTTPFunction:fail network timeout' });
    return call.success(queried('paid'));
  } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  for (let attempt = 1; attempt < 8; attempt++) { r.advance(1500); await flush(); }
  await paying;
  assert.equal(r.http.filter(call => call.path.endsWith('/query')).length, 8);
  assert.equal(r.page.data.orderTitle, '付款结果确认中');
  assert.equal(r.page.data.lastOrderId, 'server-order-1');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page.data.confirming, false);
  assert.equal(r.calls.toasts.at(-1), '付款已提交，请稍后查询结果');
  assert.ok(r.calls.toasts.every(title => !/timeout|callHTTPFunction/.test(title)));
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 1);
  unavailable = false;
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 1);
});

test('a session change during a transient retry wait stops the old order and permission-shaped network errors are permanent', async () => {
  assert.equal(isTransientPaymentQueryError({ errMsg: 'network permission denied' }), false);
  assert.equal(isTransientPaymentQueryError({ code: 40304, errMsg: 'network timeout' }), false);
  const r = checkoutRuntime({ httpCall(call) {
    if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
    return call.fail({ errMsg: 'callHTTPFunction:fail network timeout' });
  } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'replacement-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  r.advance(1500);
  await paying;
  assert.equal(r.http.length, 2);
  assert.equal(r.localReads(), 0);
  assert.equal(r.modals.length, 0);
  assert.equal(r.page.data.lastOrderId, '');
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

test('legacy order queries retain their bridge without enabling a legacy membership payment', async () => {
  const r = checkoutRuntime();
  const legacyConfig = { ...config, provider: 'jsapi', functionName: 'current-function', available: false };
  r.state.payment = { ...legacyConfig, queryPath: '/current/query' };
  await r.page.loadOverview();
  r.page.setData({ lastOrderId: 'server-order-1' });
  await r.page.refreshOrderStatus();
  assert.equal(r.http[0].name, 'current-function');
  assert.equal(r.http[0].path, '/current/query');
  r.state.payment = { ...legacyConfig, queryPath: '' };
  await r.page.loadOverview();
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderStatus, 'confirming');
  assert.equal(r.localReads(), 1, 'an empty query route cannot bypass the bridge');
  const { queryPath: _queryPath, ...legacyWithoutQuery } = legacyConfig;
  r.state.payment = legacyWithoutQuery;
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

test('prepay network failures keep the original server order resumable without opening the payment sheet', async () => {
  let once = true;
  const r = checkoutRuntime({ httpCall(call) {
    if (once) { once = false; return call.fail({ errMsg: 'network unavailable' }); }
    return call.success(call.path.endsWith('/checkout') ? wrapped(PARAMS) : queried('paid'));
  } });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, true);
  assert.equal(r.page.data.paymentRestricted, false);
  assert.equal(r.requests.length, 0);
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.creates(), 1);
  assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
});

test('cancellation queries before resuming and honors paid, unpaid, paying and closed outcomes', async () => {
  for (const [tradeState, status, expectedTitle, canResume] of [
    ['SUCCESS', 'paid', '会员已开通', false], ['NOTPAY', 'confirming', '订单尚未付款', true],
    ['USERPAYING', 'confirming', '付款结果确认中', false], ['CLOSED', 'closed', '订单已关闭', false]
  ]) {
    let pendingQuery;
    const r = checkoutRuntime({ paymentCall(call) { call.fail({ errMsg: 'requestPayment:fail cancel' }); },
      httpCall(call) {
        if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
        pendingQuery = call;
      } });
    r.state.localOrder = order(status);
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page.data.confirming, true);
    await r.page.startPayment();
    assert.equal(r.requests.length, 1, 'an unresolved cancellation cannot open another payment sheet');
    assert.equal(r.localReads(), 0);
    pendingQuery.success(wrapped({ order: order(status), tradeState }));
    await paying;
    assert.equal(r.page.data.orderTitle, expectedTitle);
    assert.equal(r.page.data.orderCanResume, canResume);
    assert.equal(r.page.data.confirming, false);
    assert.equal(r.page.data.paymentRestricted, false);
    assert.equal(r.localReads(), 1);
    assert.equal(r.creates(), 1);
    assert.equal(r.http.filter(call => call.path.endsWith('/query')).length, 1);
    assert.equal(r.calls.navigation.at(-1).url, '/pages/user/payment-cancel?outTradeNo=server-order-1');
  }
});

test('a cancelled virtual payment resumes the business order with a fresh login and a different platform attempt', async () => {
  let cancelled = false, logins = 0;
  const r = checkoutRuntime({ paymentCall(call) {
    if (!cancelled) { cancelled = true; return call.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail' }); }
    r.state.localOrder = order('paid');
    r.state.queryResponse = queried('paid');
    return call.success({});
  }, wx: { login: call => call.success({ code: `fresh-code-${++logins}` }) } });
  r.state.localOrder = order('confirming');
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, true);
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.creates(), 1);
  assert.equal(r.http.filter(call => call.path.endsWith('/checkout')).length, 2, 'each retry asks the payment server for current signed parameters');
  assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
  assert.equal(logins, 2);
  assert.deepEqual(r.virtualCheckoutInputs.map(input => input.loginCode), ['fresh-code-1', 'fresh-code-2']);
  const attemptNos = r.requests.map(call => JSON.parse(call.signData).outTradeNo);
  assert.equal(new Set(attemptNos).size, 2);
  assert.ok(attemptNos.every(id => id !== 'server-order-1'));
});

test('cancel query failure blocks payment until a later trusted unpaid query succeeds', async () => {
  let unavailable = true;
  const r = checkoutRuntime({ paymentCall(call) { call.fail({ errMsg: 'requestPayment:fail cancel' }); },
    httpCall(call) {
      if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
      if (unavailable) return call.fail({ errMsg: 'callHTTPFunction:fail network timeout' });
      return call.success(wrapped({ order: order('confirming'), tradeState: 'NOTPAY' }));
    } });
  r.state.localOrder = order('confirming');
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderTitle, '订单状态暂未确认');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page.data.confirming, false);
  assert.equal(r.page.data.lastOrderId, 'server-order-1');
  assert.equal(r.calls.toasts.length, 0);
  await r.page.startPayment();
  assert.equal(r.requests.length, 1);
  assert.equal(r.creates(), 1);
  unavailable = false;
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderTitle, '订单尚未付款');
  assert.equal(r.page.data.orderCanResume, true);
});

test('account replacement or unload during the cancel query discards its late unpaid result', async () => {
  for (const ending of ['account', 'unload']) {
    let pendingQuery;
    const r = checkoutRuntime({ paymentCall(call) { call.fail({ errMsg: 'requestPayment:fail cancel' }); },
      httpCall(call) {
        if (call.path.endsWith('/checkout')) return call.success(wrapped(PARAMS));
        pendingQuery = call;
      } });
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    if (ending === 'account') {
      r.session.token = 'replacement-token'; r.session.user = { id: 2 };
      await r.page.onShow();
    } else r.page.onUnload();
    const updates = r.calls.updates.length;
    pendingQuery.success(wrapped({ order: order('confirming'), tradeState: 'NOTPAY' }));
    await paying;
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.localReads(), 0);
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.modals.length, 0);
    assert.ok(r.calls.navigation.every(call => !call.url.includes('/payment-cancel')));
    if (ending === 'account') assert.equal(r.page.data.lastOrderId, '');
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
    if (call.path.endsWith('/checkout')) call.success(wrapped(PARAMS)); else pending = call;
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

test('reopening membership restores an old server order, queries it, and resumes only that order after verified NOTPAY', async () => {
  const r = checkoutRuntime();
  const original = { ...order('confirming'), planCode: 'annual', planTitle: '年度会员', amountFen: 99000,
    durationDays: 365, createdAt: '2026-09-01T00:00:00Z' };
  r.state.pendingOrder = original;
  r.state.localOrder = original;
  r.state.queryResponse = wrapped({ order: original, tradeState: 'NOTPAY' });
  await r.page.onShow();
  assert.equal(r.page.data.lastOrderId, original.outTradeNo);
  assert.equal(r.page.data.orderCanResume, true);
  assert.equal(r.page.data.orderPlanText, '年度会员 · ¥990.00');
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  assert.equal(reopened.data.lastOrderId, original.outTradeNo);
  assert.equal(reopened.data.orderCanResume, true);
  assert.equal(r.http.filter(call => call.path.endsWith('/query')).length, 2);
  const paid = { ...original, status: 'paid', fulfillmentStatus: 'fulfilled' };
  r.state.pendingOrder = undefined;
  r.state.localOrder = paid;
  r.state.queryResponse = wrapped({ order: paid, tradeState: 'SUCCESS' });
  await reopened.startPayment();
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 1);
  assert.ok(r.http.every(call => call.data.outTradeNo === original.outTradeNo));
  assert.equal(reopened.data.orderTitle, '会员已开通');
});

test('an existing order returned by create is recovered before payment even when it differs from the selected plan', async () => {
  const original = { ...order('confirming'), planCode: 'annual', planTitle: '原年度套餐', amountFen: 99000, durationDays: 365 };
  const r = checkoutRuntime({ createOrder: () => ({ order: original, payment: config, reused: true, recoveryRequired: true }) });
  r.state.localOrder = original;
  r.state.queryResponse = wrapped({ order: original, tradeState: 'NOTPAY' });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 0, 'recovering a different existing plan must not open the payment sheet on this tap');
  assert.deepEqual(r.events, ['bridge-query', 'local-query']);
  assert.equal(r.page.data.orderPlanText, '原年度套餐 · ¥990.00');
  assert.equal(r.page.data.orderCanResume, true);
  r.page.selectPlan({ currentTarget: { dataset: { code: 'replacement-plan' } } });
  assert.equal(r.page.data.selectedPlanCode, 'monthly');
  r.state.localOrder = { ...original, status: 'paid', fulfillmentStatus: 'fulfilled' };
  r.state.queryResponse = wrapped({ order: r.state.localOrder, tradeState: 'SUCCESS' });
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 1);
  assert.ok(r.http.every(call => call.data.outTradeNo === original.outTradeNo));
});

test('a recovery query failure keeps the original order blocked and cannot reopen payment or create another order', async () => {
  const original = order('confirming');
  const r = checkoutRuntime({ createOrder: () => ({ order: original, payment: config, reused: true, recoveryRequired: true }),
    httpCall(call) { call.fail({ errMsg: 'callHTTPFunction:fail network timeout' }); } });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderTitle, '订单状态暂未确认');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page.data.lastOrderId, original.outTradeNo);
  assert.equal(r.page.data.confirming, false);
  r.page.onPlanChange({ detail: { value: 'different-plan' } });
  assert.equal(r.page.data.selectedPlanCode, 'monthly');
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 0);
  assert.ok(r.http.every(call => call.path.endsWith('/query')));
  assert.equal(r.localReads(), 0);
});

test('maintenance still restores and queries the original order while keeping payment disabled', async () => {
  const r = checkoutRuntime();
  r.state.payment = { ...config, available: false, createPath: '', reason: 'merchant_not_configured' };
  r.state.pendingOrder = order('confirming');
  r.state.localOrder = order('confirming');
  r.state.queryResponse = wrapped({ order: order('confirming'), tradeState: 'NOTPAY' });
  await r.page.onShow();
  assert.equal(r.page.data.lastOrderId, 'server-order-1');
  assert.equal(r.http.length, 1);
  assert.equal(r.http[0].path, QUERY_PATH);
  assert.equal(r.page.data.onlineCheckout, false);
  assert.equal(r.page.data.orderCanResume, false);
  await r.page.startPayment();
  await r.page.refreshOrderStatus();
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
  assert.equal(r.http.length, 3, 'even a stale pay action can only query while maintenance disables payment');
});

test('verified paid orders requiring review never announce membership fulfillment or allow another charge', async () => {
  const r = checkoutRuntime();
  const review = { ...order('paid'), fulfillmentStatus: 'requires_review', fulfillmentMessage: '会员关系已变更' };
  r.state.localOrder = review;
  r.state.queryResponse = wrapped({ order: review, tradeState: 'SUCCESS' });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.page.data.orderRequiresReview, true);
  assert.equal(r.page.data.orderTitle, '已付款，待人工处理');
  assert.ok(r.page.data.orderNote.includes('权益尚未开通'));
  assert.equal(r.modals.at(-1).title, '已付款，待人工处理');
  assert.equal(r.page.data.onlineCheckout, false);
  assert.equal(r.page.data.orderCanResume, false);
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.requests.length, 1);
  r.state.queryResponse = { statusCode: 503, data: { code: -1 } };
  await r.page.refreshOrderStatus();
  assert.equal(r.page.data.orderStatus, 'paid', 'failed query must preserve confirmed money receipt and its review hold');
  assert.equal(r.page.data.orderRequiresReview, true);
  assert.equal(r.page.data.orderTitle, '已付款，待人工处理');
  assert.ok(r.modals.every(modal => modal.title !== '会员已开通'));
});

test('a review order survives page recreation with no active membership and keeps its query available', async () => {
  const review = { ...order('paid'), fulfillmentStatus: 'requires_review' };
  const payment = { ...config, available: false, createPath: '', reason: 'member_assignment_required' };
  const r = checkoutRuntime({ overviewCall: async () => ({ ...overview(payment), plans: [], needsMatchmaker: true, pendingOrder: review }) });
  r.state.localOrder = review;
  r.state.queryResponse = wrapped({ order: review, tradeState: 'SUCCESS' });
  await r.page.onShow();
  assert.equal(r.page.data.orderRequiresReview, true);
  assert.equal(r.page.data.statusTitle, '已付款，待人工处理');
  assert.equal(r.page.data.lastOrderId, review.outTradeNo);
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  await reopened.startPayment();
  await reopened.refreshOrderStatus();
  assert.equal(reopened.data.orderTitle, '已付款，待人工处理');
  assert.equal(reopened.data.orderStatus, 'paid');
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
  assert.equal(r.http.length, 1);
  assert.equal(r.http[0].path, QUERY_PATH);
  assert.equal(r.modals.length, 0);
});

test('create returning a paid review hold restores it without prepay or a new payment sheet', async () => {
  const review = { ...order('paid'), fulfillmentStatus: 'requires_review' };
  const r = checkoutRuntime({ createOrder: () => ({ order: review, payment: config, reused: true, recoveryRequired: true }) });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.page.data.orderRequiresReview, true);
  assert.equal(r.page.data.orderTitle, '已付款，待人工处理');
  assert.equal(r.creates(), 1);
  assert.equal(r.http.length, 0);
  assert.equal(r.requests.length, 0);
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
});

test('legacy and explicitly fulfilled paid orders remain successful, while unknown fulfillment evidence is rejected', async () => {
  for (const fulfillmentStatus of [undefined, '', 'fulfilled']) {
    const r = checkoutRuntime();
    const paid = { ...order('paid'), fulfillmentStatus };
    r.state.localOrder = paid;
    r.state.queryResponse = wrapped({ order: paid, tradeState: 'SUCCESS' });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.page.data.orderRequiresReview, false);
    assert.equal(r.page.data.orderTitle, '会员已开通');
  }
  for (const fulfillmentStatus of ['unknown', null, [], 1]) {
    assert.throws(() => assertPaymentQueryResponse(wrapped({ order: { ...order('paid'), fulfillmentStatus }, tradeState: 'SUCCESS' }), 'server-order-1'));
  }
});

test('a server pending order for a different account cannot be restored or authorize a new charge', async () => {
  const r = checkoutRuntime();
  r.state.pendingOrder = { ...order('confirming'), userId: 2 };
  await r.page.onShow();
  assert.equal(r.page.data.lastOrderId, '');
  assert.equal(r.page.data.onlineCheckout, false);
  assert.ok(r.page.data.errorText);
  await r.page.startPayment();
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
  assert.equal(r.http.length, 0);
});

test('a replacement account or page unload discards a late restored order query and its payment permissions', async () => {
  for (const ending of ['account', 'unload']) {
    let pending;
    const r = checkoutRuntime({ httpCall(call) { pending = call; } });
    r.state.pendingOrder = order('confirming');
    const restoring = r.page.onShow();
    await flush();
    assert.equal(r.page.data.confirming, true);
    assert.equal(r.page.data.orderCanResume, false);
    if (ending === 'account') {
      r.session.token = 'replacement-token'; r.session.user = { id: 2 };
      r.state.pendingOrder = undefined;
      await r.page.onShow();
    } else r.page.onUnload();
    const updates = r.calls.updates.length;
    pending.success(wrapped({ order: order('confirming'), tradeState: 'NOTPAY' }));
    await restoring;
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.localReads(), 0);
    assert.equal(r.creates(), 0);
    assert.equal(r.requests.length, 0);
    assert.equal(r.modals.length, 0);
    assert.ok(r.calls.navigation.every(call => !call.url.includes('/payment-cancel')));
    if (ending === 'account') assert.equal(r.page.data.lastOrderId, '');
  }
});

test('late overview recovery data cannot overwrite a replacement account or an unloaded page', async () => {
  for (const ending of ['account', 'unload']) {
    const response = deferred();
    let first = true;
    const r = checkoutRuntime({ overviewCall: () => {
      if (first) { first = false; return response.promise; }
      return Promise.resolve(overview(config));
    } });
    const loading = r.page.onShow();
    await flush();
    if (ending === 'account') {
      r.session.token = 'replacement-token'; r.session.user = { id: 2 };
      await r.page.onShow();
    } else r.page.onUnload();
    const updates = r.calls.updates.length;
    response.resolve({ ...overview(config), pendingOrder: order('confirming') });
    await loading;
    assert.equal(r.calls.updates.length, updates);
    assert.equal(r.page.data.lastOrderId, '');
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.http.length, 0);
    assert.equal(r.creates(), 0);
  }
});

test('verified provider-order absence is valid only for an unresolved order and cannot be combined with a trade state', () => {
  for (const status of ['pending', 'confirming']) {
    assert.deepEqual(assertPaymentQueryResponse(wrapped({ order: order(status), providerOrderAbsent: true }), 'server-order-1'), { providerOrderAbsent: true });
  }
  for (const providerOrderAbsent of [false, 'true', null, 1, undefined]) {
    assert.throws(() => assertPaymentQueryResponse(wrapped({ order: order('pending'), providerOrderAbsent }), 'server-order-1'));
  }
  for (const tradeState of ['NOTPAY', 'USERPAYING', 'SUCCESS', undefined]) {
    assert.throws(() => assertPaymentQueryResponse(wrapped({ order: order('pending'), providerOrderAbsent: true, tradeState }), 'server-order-1'));
  }
  for (const status of ['paid', 'closed', 'failed', 'refunded']) {
    assert.throws(() => assertPaymentQueryResponse(wrapped({ order: order(status), providerOrderAbsent: true }), 'server-order-1'));
  }
});

test('a recreated local order not yet sent to WeChat can first pay the same order after a trusted absent-provider result', async () => {
  const r = checkoutRuntime();
  r.state.pendingOrder = order('pending');
  r.state.localOrder = order('pending');
  r.state.queryResponse = wrapped({ order: order('pending'), providerOrderAbsent: true });
  await r.page.onShow();
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  assert.equal(reopened.data.orderCanResume, true);
  assert.ok(reopened.data.orderNote.includes('尚未提交至微信支付'));
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
  r.state.pendingOrder = undefined;
  r.state.localOrder = order('paid');
  r.state.queryResponse = queried('paid');
  await reopened.startPayment();
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 1);
  assert.equal(reopened.data.orderTitle, '会员已开通');
  assert.ok(r.http.every(call => call.data.outTradeNo === 'server-order-1'));
  assert.equal(r.http.filter(call => call.path.endsWith('/checkout')).length, 1);
});

test('raw HTTP order-not-exist errors and an absent result conflicting with local paid state never allow payment', async () => {
  for (const queryResponse of [
    { statusCode: 404, data: { code: 'ORDER_NOT_EXIST', data: { order: order('pending'), providerOrderAbsent: true } } },
    wrapped({ order: order('pending'), providerOrderAbsent: true })
  ]) {
    const r = checkoutRuntime();
    r.state.pendingOrder = order('pending');
    r.state.localOrder = order('paid');
    r.state.queryResponse = queryResponse;
    await r.page.onShow();
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page.data.orderTitle, '订单状态暂未确认');
    await r.page.startPayment();
    assert.equal(r.creates(), 0);
    assert.equal(r.requests.length, 0);
    assert.ok(r.http.every(call => call.path.endsWith('/query')));
  }
});

test('a trusted absent-provider result cannot reenable maintenance-disabled payment', async () => {
  const r = checkoutRuntime();
  r.state.payment = { ...config, available: false, createPath: '', reason: 'merchant_not_configured' };
  r.state.pendingOrder = order('pending');
  r.state.localOrder = order('pending');
  r.state.queryResponse = wrapped({ order: order('pending'), providerOrderAbsent: true });
  await r.page.onShow();
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page.data.lastOrderId, 'server-order-1');
  await r.page.startPayment();
  assert.equal(r.creates(), 0);
  assert.equal(r.requests.length, 0);
});

test('virtual parameter validation preserves the signed string and binds the platform attempt to its business snapshot', () => {
  const result = virtualCheckoutResult();
  result.virtualPayment.signData = JSON.stringify(JSON.parse(result.virtualPayment.signData), null, 1);
  const expected = { paymentAttemptNo: result.paymentAttemptNo, productId: result.order.planCode, goodsPrice: result.order.amountFen };
  const params = virtualPaymentParamsFrom(result, expected);
  assert.equal(params.signData, result.virtualPayment.signData, 'the string used for HMAC must never be reserialized');
  assert.notEqual(JSON.parse(params.signData).outTradeNo, result.order.outTradeNo);
  for (const patch of [
    { offerId: 'bad' }, { buyQuantity: 2 }, { env: 2 }, { currencyType: 'USD' },
    { productId: '' }, { goodsPrice: 0 }, { goodsPrice: 1.5 }, { outTradeNo: '_BAD_ORDER_ID' }, { attach: '' },
    { outTradeNo: 'OTHER_ATTEMPT_1' }, { productId: 'annual' }, { goodsPrice: 99000 }
  ]) {
    const changed = { ...result, virtualPayment: { ...result.virtualPayment,
      signData: JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), ...patch }) } };
    assert.throws(() => virtualPaymentParamsFrom(changed, expected));
  }
  for (const patch of [{ mode: 'short_series_coin' }, { signData: '{' }, { signData: 'x'.repeat(1025) },
    { paySig: 'bad' }, { signature: '' }, { signature: 'A'.repeat(64) }]) {
    assert.throws(() => virtualPaymentParamsFrom({ ...result, virtualPayment: { ...result.virtualPayment, ...patch } }, expected));
  }
});

test('virtual checkout rejects missing attempt identity, another business order and signed snapshot mismatches before opening payment', async () => {
  const patchSignData = (result, patch) => ({ ...result, virtualPayment: { ...result.virtualPayment,
    signData: JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), ...patch }) } });
  for (const mutate of [
    result => ({ ...result, paymentAttemptNo: undefined }),
    result => ({ ...result, paymentAttemptNo: 'OTHER_ATTEMPT_1' }),
    result => ({ ...result, order: { ...result.order, outTradeNo: 'another-business-order' } }),
    result => patchSignData(result, { productId: 'annual' }),
    result => patchSignData(result, { goodsPrice: 1 }),
    result => ({ ...result, virtualPayment: { ...result.virtualPayment, paySig: 'bad' } })
  ]) {
    const r = checkoutRuntime({ virtualCheckoutResult: mutate });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.requests.length, 0);
    assert.equal(r.localReads(), 0);
    assert.equal(r.page.data.orderCanResume, true);
    assert.equal(r.creates(), 1);
  }
});

test('a reused platform attempt from a faulty checkout response cannot open a second payment sheet', async () => {
  let firstAttempt;
  const r = checkoutRuntime({
    virtualCheckoutResult(result) {
      firstAttempt ||= result.paymentAttemptNo;
      return virtualCheckoutResult(result.order, firstAttempt);
    },
    paymentCall: call => call.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail' })
  });
  r.state.localOrder = order('confirming');
  r.state.queryResponse = wrapped({ order: r.state.localOrder, tradeState: 'NOTPAY' });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, true);
  await r.page.startPayment();
  assert.equal(r.virtualCheckoutInputs.length, 2);
  assert.equal(r.requests.length, 1);
  assert.ok(r.calls.toasts.at(-1).includes('付款尝试编号已使用'));
  assert.equal(r.creates(), 1);
});

test('a failed virtual payment resumes only after query and requests a fresh platform attempt', async () => {
  for (const errCode of [-1, -15002, -15007]) {
    const r = checkoutRuntime({ paymentCall: call => call.fail({ errCode, errMsg: 'requestVirtualPayment:fail' }) });
    r.state.localOrder = order('confirming');
    r.state.queryResponse = wrapped({ order: r.state.localOrder, tradeState: 'NOTPAY' });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.page.data.orderCanResume, false);
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderCanResume, true);
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.equal(r.requests.length, 2);
    assert.equal(new Set(r.requests.map(call => JSON.parse(call.signData).outTradeNo)).size, 2);
    assert.ok(r.virtualCheckoutInputs.every(input => input.outTradeNo === 'server-order-1'));
  }
});

test('virtual native merchant restrictions use errCode and retain queries while blocking another payment', async () => {
  for (const errCode of [-15017, -15019]) {
    const r = checkoutRuntime({ paymentCall: call => call.fail({ errCode, errMsg: 'requestVirtualPayment:fail' }) });
    r.state.localOrder = order('confirming');
    r.state.queryResponse = wrapped({ order: r.state.localOrder, tradeState: 'NOTPAY' });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.page.data.paymentRestricted, true);
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderCanResume, false);
    await r.page.startPayment();
    assert.equal(r.requests.length, 1);
    assert.equal(r.localReads(), 1);
  }
});

test('virtual payment reads the SDK version from app information and supports its legacy fallback', async () => {
  for (const wx of [
    { getAppBaseInfo: () => ({ SDKVersion: '2.19.2' }), canIUse: () => false },
    { getAppBaseInfo: undefined, getSystemInfoSync: () => ({ SDKVersion: '2.19.2', platform: 'android' }), canIUse: () => false },
    { getAppBaseInfo: () => ({ SDKVersion: '2.19.1' }), canIUse: () => true }
  ]) {
    const r = checkoutRuntime({ wx });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.requests.length, 1);
    assert.equal(r.page.data.orderStatus, 'paid');
  }
});

test('supported iOS versions can complete virtual checkout with modern and legacy device information', async () => {
  for (const wx of [
    supportedIos,
    { getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 18.4.1' }),
      getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.100' }) },
    { getDeviceInfo: undefined, getAppBaseInfo: undefined,
      getSystemInfoSync: () => ({ platform: 'ios', system: 'iOS 15', SDKVersion: '2.19.2', version: '8.0.68' }) },
    { getDeviceInfo: () => ({ platform: 'ios' }), getAppBaseInfo: () => ({ SDKVersion: '3.10.0' }),
      getSystemInfoSync: () => ({ platform: 'ios', system: 'iOS 15.1', version: '8.0.68' }) },
    { ...supportedIos, getAppBaseInfo: () => ({ SDKVersion: '2.19.1', version: '8.0.68' }), canIUse: () => true }
  ]) {
    const r = checkoutRuntime({ wx });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.equal(r.virtualCheckoutInputs.length, 1);
    assert.equal(r.requests.length, 1);
    assert.equal(JSON.parse(r.requests[0].signData).env, 0);
    assert.equal(r.page.data.orderStatus, 'paid');
  }
});

test('old or unknown iOS versions and unsupported low libraries are blocked before creating a business order', async () => {
  for (const [wx, expectedNote] of [
    [{ ...supportedIos, getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 14.9' }) }, 'iOS 15'],
    [{ ...supportedIos, getDeviceInfo: () => ({ platform: 'ios' }) }, 'iOS 15'],
    [{ ...supportedIos, getDeviceInfo: () => ({ platform: 'ios', system: 'unknown' }) }, 'iOS 15'],
    [{ ...supportedIos, getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.67' }) }, '微信 8.0.68'],
    [{ ...supportedIos, getAppBaseInfo: () => ({ SDKVersion: '3.10.0' }) }, '微信 8.0.68'],
    [{ ...supportedIos, getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: 'unknown' }) }, '微信 8.0.68'],
    [{ getDeviceInfo: undefined, getAppBaseInfo: undefined,
      getSystemInfoSync: () => ({ platform: 'ios', system: 'iOS 14.9', SDKVersion: '3.10.0', version: '8.0.68' }) }, 'iOS 15'],
    [{ ...supportedIos, getAppBaseInfo: () => ({ SDKVersion: '2.19.1', version: '8.0.68' }), canIUse: () => false }, '微信版本过低'],
    [{ getAppBaseInfo: () => ({ SDKVersion: '2.19.1' }), canIUse: () => false }, '微信版本过低']
  ]) {
    const r = checkoutRuntime({ wx });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.creates(), 0);
    assert.equal(r.requests.length, 0);
    assert.ok(r.modals.at(-1).content.includes(expectedNote));
  }
});

test('iOS test mode and prices below one yuan are blocked before creating a business order', async () => {
  for (const [payment, amountFen, expectedNote] of [
    [{ ...config, testMode: true }, 10000, '测试商品'],
    [config, 1, '1 元'], [config, 99, '1 元'], [config, undefined, '1 元']
  ]) {
    const r = checkoutRuntime({ wx: supportedIos, overviewCall: () => ({ ...overview(payment),
      plans: [{ ...overview(payment).plans[0], amountFen }] }) });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.creates(), 0);
    assert.equal(r.virtualCheckoutInputs.length, 0);
    assert.equal(r.requests.length, 0);
    assert.ok(r.modals.at(-1).content.includes(expectedNote));
  }
});

test('the native iOS payment boundary rejects sandbox or low signed prices without consuming an attempt', async () => {
  for (const [patch, expectedNote] of [[{ env: 1 }, /测试商品/], [{ goodsPrice: 99 }, /1 元/]]) {
    const r = checkoutRuntime({ wx: supportedIos });
    const params = virtualCheckoutResult().virtualPayment;
    params.signData = JSON.stringify({ ...JSON.parse(params.signData), ...patch });
    await assert.rejects(r.page.requestPayment(params), expectedNote);
    assert.equal(r.requests.length, 0);
    assert.equal(r.page._submittedVirtualPaymentAttempts.length, 0);
  }
  for (const [wx, env, goodsPrice] of [[supportedIos, 0, 100], [undefined, 1, 1]]) {
    const r = checkoutRuntime({ wx });
    const params = virtualCheckoutResult().virtualPayment;
    params.signData = JSON.stringify({ ...JSON.parse(params.signData), env, goodsPrice });
    await r.page.requestPayment(params);
    assert.equal(r.requests.length, 1);
  }
});

test('iOS rejects sandbox checkout signatures even when the public payment configuration looks ready', async () => {
  const r = checkoutRuntime({ wx: supportedIos, virtualCheckoutResult(result) {
    result.virtualPayment.signData = JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), env: 1 });
    return result;
  } });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.virtualCheckoutInputs.length, 1);
  assert.equal(r.requests.length, 0);
  assert.match(r.calls.toasts.at(-1), /测试商品/);
});

test('a JSAPI or unspecified member channel cannot fall back to legacy payment', async () => {
  for (const provider of ['jsapi', undefined]) {
    const r = checkoutRuntime();
    r.state.payment = { ...config, provider, available: true, functionName: 'legacy-function', createPath: '/create', queryPath: '/query' };
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.creates(), 0);
    assert.equal(r.requests.length, 0);
    assert.ok(r.calls.toasts.at(-1).includes('会员虚拟支付服务暂不可用'));
    await assert.rejects(r.page.callPaymentFunction({ order: order(), payment: r.state.payment }), /会员虚拟支付服务暂不可用/);
  }
});

test('a failed or replaced wx.login session cannot reach virtual checkout', async () => {
  for (const login of [call => call.fail({}), call => call.success({ code: '' })]) {
    const r = checkoutRuntime({ wx: { login } });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.virtualCheckoutInputs.length, 0);
    assert.equal(r.requests.length, 0);
    assert.equal(r.page.data.orderCanResume, true);
  }
  let pendingLogin;
  const r = checkoutRuntime({ wx: { login: call => { pendingLogin = call; } } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  r.session.token = 'replacement-token'; r.session.user = { id: 2 };
  await r.page.onShow();
  pendingLogin.success({ code: 'old-session-code' });
  await paying;
  assert.equal(r.virtualCheckoutInputs.length, 0);
  assert.equal(r.requests.length, 0);
  assert.equal(r.page.data.lastOrderId, '');
});

test('native success waits through an early NOTPAY or absent-provider result until payment becomes authoritative', async () => {
  for (const earlyState of [{ tradeState: 'NOTPAY' }, { providerOrderAbsent: true }]) {
    let queries = 0;
    const r = checkoutRuntime({ httpCall(call) {
      if (call.path === CHECKOUT_PATH) return call.success(wrapped(PARAMS));
      queries++;
      if (queries === 1) {
        r.state.localOrder = order('confirming');
        return call.success(wrapped({ order: r.state.localOrder, ...earlyState }));
      }
      r.state.localOrder = order('paid');
      return call.success(wrapped({ order: r.state.localOrder, tradeState: 'SUCCESS' }));
    } });
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    assert.equal(queries, 1);
    assert.equal(r.page.data.confirming, true);
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page._nativeSuccessOrderNo, 'server-order-1');
    assert.equal(r.modals.length, 0);
    r.advance(1500);
    await paying;
    assert.equal(queries, 2);
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.page.data.orderTitle, '会员已开通');
    assert.equal(r.page._nativeSuccessOrderNo, '');
    assert.equal(r.creates(), 1);
    assert.equal(r.virtualCheckoutInputs.length, 1);
    assert.equal(r.requests.length, 1);
  }
});

test('eight unconfirmed native-success queries preserve the same business order and never reopen payment', async () => {
  for (const unresolvedState of [{ tradeState: 'NOTPAY' }, { providerOrderAbsent: true }, {}]) {
    const r = checkoutRuntime();
    r.state.localOrder = order('confirming');
    r.state.queryResponse = wrapped({ order: r.state.localOrder, ...unresolvedState });
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    for (let attempt = 1; attempt < 8; attempt++) {
      assert.equal(r.http.filter(call => call.path === QUERY_PATH).length, attempt);
      assert.equal(r.page.data.confirming, true);
      assert.equal(r.page.data.orderCanResume, false);
      r.advance(1500);
      await flush();
    }
    await paying;
    assert.equal(r.http.filter(call => call.path === QUERY_PATH).length, 8);
    assert.equal(r.page.data.confirming, false);
    assert.equal(r.page.data.orderStatus, 'confirming');
    assert.equal(r.page.data.orderTitle, '付款结果确认中');
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.modals.at(-1).title, '付款结果确认中');
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderCanResume, false, 'a later unpaid query must not undo a native-success hold');
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.equal(r.virtualCheckoutInputs.length, 1);
    assert.equal(r.requests.length, 1);
    r.state.localOrder = order('paid');
    r.state.queryResponse = wrapped({ order: r.state.localOrder, tradeState: 'SUCCESS' });
    await r.page.refreshOrderStatus();
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.page._nativeSuccessOrderNo, '');
  }
});

test('a manual unpaid query without native success still responds once and can resume the business order', async () => {
  for (const unpaidState of [{ tradeState: 'NOTPAY' }, { providerOrderAbsent: true }]) {
    const r = checkoutRuntime();
    r.state.localOrder = order('confirming');
    r.state.queryResponse = wrapped({ order: r.state.localOrder, ...unpaidState });
    await r.page.loadOverview();
    r.page._resumableCheckout = { order: r.state.localOrder, payment: config };
    r.page.setData({ lastOrderId: 'server-order-1', orderStatus: 'confirming' });
    await r.page.refreshOrderStatus();
    assert.equal(r.http.filter(call => call.path === QUERY_PATH).length, 1);
    assert.equal(r.page.data.orderTitle, '订单尚未付款');
    assert.equal(r.page.data.orderCanResume, true);
    assert.equal(r.page._nativeSuccessOrderNo, '');
    assert.equal(r.requests.length, 0);
    assert.equal(r.creates(), 0);
  }
});

test('a paid review hold and other terminal results stop native-success polling immediately', async () => {
  for (const [status, fulfillmentStatus] of [['paid', 'requires_review'], ['closed', ''], ['failed', ''], ['refunded', '']]) {
    const r = checkoutRuntime();
    r.state.localOrder = { ...order(status), fulfillmentStatus };
    r.state.queryResponse = wrapped({ order: r.state.localOrder });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(r.http.filter(call => call.path === QUERY_PATH).length, 1);
    assert.equal(r.page.data.orderStatus, status);
    assert.equal(r.page.data.confirming, false);
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page._nativeSuccessOrderNo, '');
    if (fulfillmentStatus === 'requires_review') {
      assert.equal(r.page.data.orderRequiresReview, true);
      assert.equal(r.modals.at(-1).title, '已付款，待人工处理');
      assert.ok(!r.modals.some(modal => modal.title === '会员已开通'));
    }
  }
});

test('a session change clears native-success pending state and discards a late old-account success callback', async () => {
  let nativeCall;
  const late = checkoutRuntime({ paymentCall: call => { nativeCall = call; } });
  await late.page.loadOverview();
  const paying = late.page.startPayment();
  await flush();
  late.session.token = 'replacement-token'; late.session.user = { id: 2 };
  await late.page.onShow();
  nativeCall.success({});
  await paying;
  assert.equal(late.page._nativeSuccessOrderNo, '');
  assert.equal(late.page.data.lastOrderId, '');
  assert.equal(late.http.filter(call => call.path === QUERY_PATH).length, 0);

  const waiting = checkoutRuntime();
  waiting.state.localOrder = order('confirming');
  waiting.state.queryResponse = wrapped({ order: waiting.state.localOrder, tradeState: 'NOTPAY' });
  await waiting.page.loadOverview();
  const confirming = waiting.page.startPayment();
  await flush();
  assert.equal(waiting.page._nativeSuccessOrderNo, 'server-order-1');
  waiting.session.token = 'replacement-token'; waiting.session.user = { id: 2 };
  await waiting.page.onShow();
  waiting.advance(1500);
  await confirming;
  assert.equal(waiting.page._nativeSuccessOrderNo, '');
  assert.equal(waiting.page.data.lastOrderId, '');
  assert.equal(waiting.http.filter(call => call.path === QUERY_PATH).length, 1);
});

test('only agreed temporary business codes retry without overriding HTTP or permission failures', () => {
  for (const code of [50201, 50301]) {
    assert.equal(isTransientPaymentQueryError({ code, message: 'temporary query failure' }), true);
    for (const statusCode of [200, 400, 403, 500]) {
      assert.equal(isTransientPaymentQueryError({ code, statusCode }), false);
    }
  }
  for (const code of [40907, 40304]) {
    assert.equal(isTransientPaymentQueryError({ code, statusCode: 503, errMsg: 'network timeout' }), false);
  }
  assert.equal(isTransientPaymentQueryError({ code: 50201, statusCode: 503 }), true);
  assert.equal(isTransientPaymentQueryError({ code: 50001, message: 'network timeout' }), false);
  assert.equal(isTransientPaymentQueryError({ code: '50301', message: 'temporary query failure' }), false);
});

test('actual virtual API business error 50301 or 50201 retries and then confirms the same paid order', async () => {
  for (const code of [50301, 50201]) {
    const sdk = virtualApiCall((_request, attempt) => attempt === 1
      ? { code, message: '微信发货确认暂未完成，请稍后查询', data: null }
      : { code: 0, data: { order: order('paid'), tradeState: 'SUCCESS' } });
    const r = checkoutRuntime({ virtualApiCall: sdk.query });
    await r.page.loadOverview();
    const paying = r.page.startPayment();
    await flush();
    assert.equal(sdk.requests.length, 1);
    assert.equal(r.localReads(), 0, 'a local paid snapshot cannot bypass a failed provider reconciliation');
    assert.equal(r.page.data.confirming, true);
    assert.equal(r.page.data.orderCanResume, false);
    r.advance(1500);
    await paying;
    assert.equal(sdk.requests.length, 2);
    assert.ok(sdk.requests.every(request => request.name === 'hlApi' && request.path === QUERY_PATH
      && request.method === 'POST' && request.outTradeNo === 'server-order-1'));
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.page.data.orderTitle, '会员已开通');
    assert.equal(r.creates(), 1);
    assert.equal(r.virtualCheckoutInputs.length, 1);
    assert.equal(r.requests.length, 1);
  }
});

test('persistent actual virtual API 50301 stops after eight attempts and keeps another payment blocked', async () => {
  const sdk = virtualApiCall(() => ({ code: 50301, message: '微信发货确认暂未完成，请稍后查询', data: null }));
  const r = checkoutRuntime({ virtualApiCall: sdk.query });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  for (let attempt = 1; attempt < 8; attempt++) {
    assert.equal(sdk.requests.length, attempt);
    r.advance(1500);
    await flush();
  }
  await paying;
  assert.equal(sdk.requests.length, 8);
  assert.equal(r.localReads(), 0);
  assert.equal(r.page.data.orderTitle, '付款结果确认中');
  assert.equal(r.page.data.orderStatus, 'confirming');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page.data.confirming, false);
  assert.equal(r.calls.toasts.at(-1), '付款已提交，请稍后查询结果');
  r.advance(1500); await flush();
  assert.equal(sdk.requests.length, 8, 'automatic retry is bounded');
  await r.page.startPayment();
  assert.equal(sdk.requests.length, 9, 'another button press performs only a manual result lookup');
  assert.equal(r.creates(), 1);
  assert.equal(r.virtualCheckoutInputs.length, 1);
  assert.equal(r.requests.length, 1);
  assert.equal(r.page.data.orderCanResume, false);
});

test('actual virtual API mismatch and permission business errors do not retry or issue another payment', async () => {
  for (const code of [40907, 40304]) {
    const sdk = virtualApiCall(() => ({ code, message: 'network timeout', data: null }));
    const r = checkoutRuntime({ virtualApiCall: sdk.query });
    await r.page.loadOverview();
    await r.page.startPayment();
    assert.equal(sdk.requests.length, 1);
    assert.equal(r.localReads(), 0);
    assert.equal(r.page.data.orderTitle, '订单核验未通过');
    assert.equal(r.page.data.orderCanResume, false);
    r.advance(1500); await flush();
    assert.equal(sdk.requests.length, 1);
    assert.equal(r.creates(), 1);
    assert.equal(r.virtualCheckoutInputs.length, 1);
    assert.equal(r.requests.length, 1);
  }
});
