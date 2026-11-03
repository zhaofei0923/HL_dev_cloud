const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const virtual = { provider: 'virtual', available: true, reason: '', functionName: '', createPath: '', queryPath: '' };
const jsapi = { provider: 'jsapi', available: true, reason: '', functionName: 'safe-payment-function', createPath: '/pay/create', queryPath: '/pay/query' };
const ready = { ready: true, profileComplete: true, matchmakerConfirmed: true, matchmakerId: 2, reason: '' };
const plans = [
  ['vip_week', '周卡', 6160, 7, 'vip', 0], ['vip_month', '月卡', 19800, 30, 'vip', 0],
  ['vip_quarter', '季卡', 39800, 90, 'vip', 0], ['vip_year', '年卡', 69800, 365, 'vip', 0],
  ['matchmaking_double', '人工牵线2次', 298000, 30, 'matchmaking', 2],
  ['matchmaking_month_6', '人工牵线1个月', 698000, 30, 'matchmaking', 6]
].map(([planCode, title, amountFen, durationDays, productType, serviceCount]) => ({ planCode, title,
  amountFen, durationDays, productType, serviceCount, priceText: `${amountFen / 100}元`, active: true, description: '', badge: '', sortOrder: 1 }));
const overview = patch => ({ isPremiumMember: false, phoneBound: true, phoneMasked: '138****8888', needsMatchmaker: false,
  membership: null, membershipTier: 'free', plans, payment: virtual, matchmakingPayment: virtual,
  matchmakingReadiness: ready, matchmakingPackages: [], ...patch });
const order = patch => ({ id: 1, outTradeNo: 'HL_MATCHMAKING_001', userId: 1, planCode: 'matchmaking_month_6',
  planTitle: '人工牵线1个月', productType: 'matchmaking', serviceCount: 6, amountFen: 698000, durationDays: 30,
  status: 'pending', paymentProvider: 'virtual', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', ...patch });
const event = type => ({ currentTarget: { dataset: { type } } });
const packageBalance = extra => ({ id: 'package_current', planTitle: '人工牵线2次', totalCount: 2, usedCount: 0, remainingCount: 2,
  expireAt: '2026-11-05T00:00:00Z', status: 'active', ...extra });
const progress = extra => ({ status: 'not_purchased', purchased: false, profileComplete: false, assigned: false,
  matchmakerConfirmed: false, matchmakerId: null, matchmakerUserId: null, matchmakerName: '', requestedAt: null,
  remainingCount: 0, earliestExpireAt: null, ...extra });
const envelope = data => ({ statusCode: 200, data: { code: 0, data } });
const virtualResult = (currentOrder, paymentAttemptNo = 'HLA_MATCHMAKING_ATTEMPT_1') => ({ order: currentOrder, paymentAttemptNo,
  virtualPayment: { mode: 'short_series_goods',
    signData: JSON.stringify({ offerId: '1450674507', buyQuantity: 1, env: 1, currencyType: 'CNY',
      productId: currentOrder.planCode, goodsPrice: currentOrder.amountFen, outTradeNo: paymentAttemptNo, attach: currentOrder.outTradeNo }),
    paySig: 'a'.repeat(64), signature: 'b'.repeat(64) } });

function matchmakingRuntime(options = {}) {
  let creates = 0, queryCount = 0, attemptSerial = 0;
  const native = [], virtualInputs = [], queries = [], modals = [], createdPlanCodes = [];
  const state = { currentOrder: order(), paid: true, pendingOrder: null };
  const r = runtime('pages/user/membership.js', { source: true, memberApi: {
    membershipOverview: async () => overview({ pendingOrder: state.pendingOrder, ...options.overview }),
    createMembershipOrder: async planCode => {
      creates++;
      createdPlanCodes.push(planCode);
      const plan = plans.find(item => item.planCode === planCode);
      state.currentOrder = order({ ...plan, planTitle: plan.title });
      return options.createOrder ? options.createOrder(state.currentOrder) : { order: state.currentOrder, payment: virtual };
    },
    virtualPaymentCheckout: async (outTradeNo, loginCode) => {
      const paymentAttemptNo = `HLA_MATCHMAKING_ATTEMPT_${++attemptSerial}`;
      virtualInputs.push({ outTradeNo, loginCode, paymentAttemptNo });
      const result = virtualResult(state.currentOrder, paymentAttemptNo);
      return options.checkoutResult ? options.checkoutResult(result) : result;
    },
    virtualPaymentQuery: async outTradeNo => {
      queryCount++; queries.push(outTradeNo);
      if (options.query) return options.query(state, queryCount);
      return { order: order({ ...state.currentOrder, status: state.paid ? 'paid' : 'confirming', fulfillmentStatus: state.paid ? 'fulfilled' : '' }),
        tradeState: state.paid ? 'SUCCESS' : 'NOTPAY' };
    },
    membershipOrder: async () => order({ ...state.currentOrder, status: state.paid ? 'paid' : 'confirming', fulfillmentStatus: state.paid ? 'fulfilled' : '' })
  }, wx: {
    getDeviceInfo: () => ({ platform: 'android' }), getAppBaseInfo: () => ({ SDKVersion: '3.10.0' }),
    login: call => call.success({ code: `fresh-code-${attemptSerial + 1}` }),
    requestVirtualPayment(call) { native.push(call); return options.native ? options.native(call, state) : call.success({}); },
    requestPayment() { assert.fail('new human service must not use the JSAPI cashier'); },
    cloud: { callHTTPFunction() { assert.fail('new human service must not call JSAPI create or query'); } },
    showModal: call => modals.push(call), ...options.wx
  } });
  r.page.onLoad({ type: 'matchmaking' });
  return { ...r, state, native, virtualInputs, queries, modals, createdPlanCodes, creates: () => creates };
}

test('VIP plans stay independent from principal readiness and preserve exact prices and terms', async () => {
  const r = runtime('pages/user/membership.js', { source: true, memberApi: { membershipOverview: async () => overview({
    needsMatchmaker: true, matchmakingReadiness: { ...ready, ready: false, matchmakerConfirmed: false } }) } });
  await r.page.loadOverview();
  assert.equal(r.page.data.onlineCheckout, true);
  assert.equal(r.page.data.activeProductType, 'vip');
  assert.deepEqual(Array.from(r.page.data.plans, p => [p.amountFen, p.durationDays]),
    [[6160, 7], [19800, 30], [39800, 90], [69800, 365]]);
  assert.equal(r.page.data.plans[0].dailyPriceText, '约 8.8 元/天');
  assert.equal(r.page.data.benefits.length, 11)
  assert.equal(r.page.data.benefits.some(item => item.key === 'specialZones'), false);
  assert.equal(r.page.data.benefits.find(p => p.key === 'readReceipts').title, '消息已读');
  assert.equal(r.page.data.benefits.find(p => p.key === 'onlineReminder').note.includes('站内提醒'), true);
});

test('matchmaking purchase is independent from profile and principal readiness with or without progress', async () => {
  const r = matchmakingRuntime({ overview: {
    needsMatchmaker: true, matchmakingReadiness: { ...ready, ready: false, profileComplete: false, matchmakerConfirmed: false, matchmakerId: null } } });
  await r.page.loadOverview();
  assert.equal(r.page.data.onlineCheckout, true);
  assert.deepEqual(Array.from(r.page.data.plans, p => [p.planCode, p.title]),
    [['matchmaking_double', '人工牵线2次'], ['matchmaking_month_6', '人工牵线1个月']]);
  assert.deepEqual(Array.from(r.page.data.plans, p => [p.amountFen, p.durationDays, p.serviceCount]),
    [[298000, 30, 2], [698000, 30, 6]]);
  assert.deepEqual(Array.from(r.page.data.plans, p => p.durationText), ['30 天有效', '30 天有效']);
  assert.deepEqual(Array.from(r.page.data.plans, p => p.descriptionText), ['付款确认后即获得 2 次牵线权益', '付款确认后即获得 6 次牵线权益']);
  assert.match(r.page.data.matchmakingReadinessText, /可直接选择套餐购买/);
  assert.equal(r.page.data.canContactMatchmaker, false);
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.native.length, 1);
  assert.equal(r.page.data.orderStatus, 'paid');
});

test('server progress never makes profile or assignment a prerequisite for either purchase', async () => {
  for (const type of ['vip', 'matchmaking']) {
    const r = matchmakingRuntime({ overview: { needsMatchmaker: true, matchmakingReadiness: undefined,
      matchmakingProgress: progress() } });
    r.page.data.activeProductType = type;
    await r.page.loadOverview();
    assert.equal(r.page.data.onlineCheckout, true);
    assert.equal(r.page.data.canContactMatchmaker, false);
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.equal(r.native.length, 1);
    assert.equal(r.page.data.orderStatus, 'paid');
  }
});

test('matchmaking balances lead to using rights and repeat purchase confirms independent expiry', async () => {
  for (const confirm of [false, true]) {
    const confirmation = [];
    const r = matchmakingRuntime({ overview: { matchmakingPackages: [packageBalance(), packageBalance({ id: 'second', totalCount: 6, remainingCount: 3,
      expireAt: '2026-11-01T00:00:00Z' })] }, wx: { showModal(call) { confirmation.push(call); call.success?.({ confirm }); } } });
    await r.page.loadOverview();
    assert.equal(r.page.data.matchmakingRemainingCount, 5);
    assert.match(r.page.data.matchmakingEarliestExpiry, /2026年11月1日/);
    assert.equal(r.page.data.paymentActionText, '再购买人工牵线');
    await r.page.startPayment();
    const prompt = confirmation.find(call => call.title === '确认新增牵线套餐');
    assert.ok(prompt);
    assert.match(prompt.content, /剩余 5 次/);
    assert.match(prompt.content, /2026年11月1日/);
    assert.match(prompt.content, /独立有效30天/);
    assert.match(prompt.content, /原套餐到期时间不会延长/);
    assert.equal(r.creates(), confirm ? 1 : 0);
    assert.equal(r.native.length, confirm ? 1 : 0);
    assert.equal(r.page.data.paymentStarting, false);
  }
});

test('repeat purchase cancellation after an account change cannot create an order', async () => {
  let answer;
  const r = matchmakingRuntime({ overview: { matchmakingPackages: [packageBalance()] },
    wx: { showModal(call) { answer = call; } } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  assert.equal(r.creates(), 0);
  r.session.user = { id: 9 };
  answer.success({ confirm: true });
  await paying;
  assert.equal(r.creates(), 0);
  assert.equal(r.native.length, 0);
});

test('an unassigned member sees platform arrangement and is never sent to find a principal', async () => {
  const r = matchmakingRuntime({ overview: { matchmakingReadiness: { ...ready, matchmakerId: null, activeAssignment: false } } });
  await r.page.loadOverview();
  await r.page.contactMatchmaker();
  assert.equal(r.calls.navigation.length, 0);
  assert.match(r.modals.at(-1).content, /平台会安排主理人/);
  assert.equal(r.modals.at(-1).showCancel, false);
});

test('original pending JSAPI service order queries its saved provider while new plans are virtual and never resumes payment', async () => {
  const pending = order({ paymentProvider: 'jsapi', planCode: 'matchmaking_month', planTitle: '1个月牵线', serviceCount: 2 });
  const http = [];
  const r = runtime('pages/user/membership.js', { source: true, memberApi: {
    membershipOverview: async () => overview({ pendingOrder: pending,
      pendingOrderPayment: { ...jsapi, available: false, reason: 'historical_payment_query_required' } }),
    membershipOrder: async () => pending,
    virtualPaymentQuery: async () => assert.fail('must query the original JSAPI provider'),
    createMembershipOrder: async () => assert.fail('must not create a replacement while the original order is pending')
  }, wx: { cloud: { callHTTPFunction(call) { http.push(call); call.success(envelope({ order: pending, tradeState: 'NOTPAY' })); } },
    requestPayment() { assert.fail('legacy JSAPI payment must stay closed'); },
    requestVirtualPayment() { assert.fail('old JSAPI order must not migrate into a virtual attempt'); } } });
  await r.page.loadOverview();
  assert.equal(r.page.data.activeProductType, 'matchmaking');
  assert.equal(r.page.data.activePayment.provider, 'jsapi');
  assert.equal(http[0].path, '/pay/query');
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page._resumableCheckout, null);
  assert.match(r.page.data.orderNote, /原支付通道已停止新付款/);
  assert.match(r.page.data.orderPlanText, /1个月牵线/);
  await r.page.switchProduct(event('vip'));
  assert.equal(r.page.data.activeProductType, 'matchmaking');
  assert.match(r.calls.toasts.at(-1), /当前订单/);
  await r.page.startPayment();
  assert.equal(http.length, 2);
  assert.ok(http.every(call => call.path === '/pay/query'));
});

test('both matchmaking plans open only virtual payment and grant service only after server confirmation', async () => {
  for (const plan of plans.filter(item => item.productType === 'matchmaking')) {
    const r = matchmakingRuntime();
    await r.page.loadOverview();
    r.page.selectPlan({ currentTarget: { dataset: { code: plan.planCode } } });
    await r.page.startPayment();
    assert.equal(r.creates(), 1);
    assert.deepEqual(r.createdPlanCodes, [plan.planCode]);
    assert.equal(r.state.currentOrder.serviceCount, plan.serviceCount);
    assert.equal(r.native.length, 1);
    assert.deepEqual(r.queries, ['HL_MATCHMAKING_001']);
    assert.deepEqual(r.virtualInputs.map(input => [input.outTradeNo, input.loginCode]), [['HL_MATCHMAKING_001', 'fresh-code-1']]);
    const signed = JSON.parse(r.native[0].signData);
    assert.equal(signed.productId, plan.planCode);
    assert.equal(signed.goodsPrice, plan.amountFen);
    assert.equal(signed.attach, 'HL_MATCHMAKING_001');
    assert.equal(r.page.data.orderStatus, 'paid');
    assert.equal(r.page.data.orderTitle, '牵线服务已开通');
    assert.equal(r.page.data.overview.isPremiumMember, false);
  }
});

for (const retired of [
  { planCode: 'matchmaking_month', planTitle: '1个月牵线', serviceCount: 2 },
  { planCode: 'matchmaking_single', planTitle: '人工牵线单次', serviceCount: 1, amountFen: 298000 },
  { planCode: 'matchmaking_month_3', planTitle: '人工牵线1个月', serviceCount: 3 }
]) test(`retired virtual ${retired.planCode} restores only its original query across page reopenings and never opens another cashier`, async () => {
  const pending = order(retired);
  const queryOnly = { ...virtual, available: false, reason: 'retired_plan_query_required' };
  const queries = [];
  const r = runtime('pages/user/membership.js', { source: true, memberApi: {
    membershipOverview: async () => overview({ pendingOrder: pending, pendingOrderPayment: queryOnly }),
    membershipOrder: async () => pending,
    virtualPaymentQuery: async outTradeNo => { queries.push(outTradeNo); return { order: pending, tradeState: 'NOTPAY' }; },
    createMembershipOrder: async () => assert.fail('retired pending order must keep its original occupancy'),
    virtualPaymentCheckout: async () => assert.fail('retired product must never create another payment attempt')
  }, wx: {
    requestVirtualPayment() { assert.fail('retired product cashier must stay closed'); },
    requestPayment() { assert.fail('retired virtual product must never fall back to ordinary payment'); },
    cloud: { callHTTPFunction() { assert.fail('retired virtual product must retain the original virtual query'); } }
  } });
  await r.page.loadOverview();
  assert.equal(r.page.data.activeProductType, 'matchmaking');
  assert.equal(r.page.data.activePayment.provider, 'virtual');
  assert.equal(r.page.data.onlineCheckout, false);
  assert.equal(r.page.data.orderCanResume, false);
  assert.equal(r.page._resumableCheckout, null);
  assert.match(r.page.data.orderNote, /该套餐已停售，请查询原订单或联系主理人/);
  assert.ok(r.page.data.orderPlanText.includes(retired.planTitle));
  await r.page.refreshOrderStatus();
  await r.page.startPayment();
  await r.page.switchProduct(event('vip'));
  assert.equal(r.page.data.activeProductType, 'matchmaking');
  assert.equal(r.page.data.lastOrderId, pending.outTradeNo);
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  assert.equal(reopened.data.activeProductType, 'matchmaking');
  assert.equal(reopened.data.onlineCheckout, false);
  assert.equal(reopened.data.orderCanResume, false);
  assert.equal(reopened._resumableCheckout, null);
  assert.match(reopened.data.orderNote, /该套餐已停售/);
  await reopened.startPayment();
  assert.deepEqual(queries, Array(5).fill(pending.outTradeNo));
});

test('both services reject JSAPI or missing current providers before creating an order', async () => {
  for (const product of ['vip', 'matchmaking']) for (const provider of ['jsapi', undefined]) {
    const r = matchmakingRuntime({ overview: product === 'vip'
      ? { payment: { ...jsapi, provider } } : { matchmakingPayment: { ...jsapi, provider } } });
    r.page.onLoad({ type: product });
    if (product === 'vip') r.page.data.activeProductType = 'vip';
    await r.page.loadOverview(); await r.page.startPayment();
    assert.equal(r.native.length, 0);
    assert.equal(r.creates(), 0);
    assert.match(r.calls.toasts.at(-1), /虚拟支付/);
  }
});

test('malformed or mismatched artificial-service virtual responses never open payment', async () => {
  for (const mutate of [
    result => ({ ...result, virtualPayment: { ...result.virtualPayment, paySig: 'bad' } }),
    result => ({ ...result, order: { ...result.order, productType: 'vip' } }),
    result => ({ ...result, order: { ...result.order, paymentProvider: 'jsapi' } }),
    result => ({ ...result, virtualPayment: { ...result.virtualPayment,
      signData: JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), productId: 'vip_month' }) } }),
    result => ({ ...result, virtualPayment: { ...result.virtualPayment,
      signData: JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), goodsPrice: 1 }) } })
  ]) {
    const r = matchmakingRuntime({ checkoutResult: mutate });
    await r.page.loadOverview(); await r.page.startPayment();
    assert.equal(r.native.length, 0);
    assert.equal(r.creates(), 1);
  }
});

test('matchmaking cancellation and page reopening reuse the same business order with a fresh virtual attempt', async () => {
  const r = matchmakingRuntime({ native(call, state) {
    if (r.native.length === 1) {
      state.paid = false;
      return call.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail' });
    }
    state.paid = true; state.pendingOrder = null;
    call.success({});
  } });
  await r.page.loadOverview(); await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, true);
  assert.equal(r.queries.length, 1);
  r.state.pendingOrder = r.state.currentOrder;
  r.page.onUnload();
  const reopened = r.recreatePage();
  await reopened.onShow();
  assert.equal(reopened.data.activeProductType, 'matchmaking');
  assert.equal(reopened.data.orderCanResume, true);
  assert.equal(r.creates(), 1);
  await reopened.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.native.length, 2);
  assert.equal(new Set(r.native.map(call => JSON.parse(call.signData).outTradeNo)).size, 2);
  assert.ok(r.virtualInputs.every(input => input.outTradeNo === 'HL_MATCHMAKING_001'));
  assert.equal(reopened.data.orderStatus, 'paid');
  assert.equal(reopened.data.orderTitle, '牵线服务已开通');
});

test('unconfirmed native service success blocks switching and another charge until authoritative confirmation', async () => {
  const r = matchmakingRuntime({ native(call, state) { state.paid = false; call.success({}); } });
  await r.page.loadOverview();
  const paying = r.page.startPayment();
  await flush();
  assert.equal(r.page.data.confirming, true);
  assert.equal(r.page.data.orderCanResume, false);
  await r.page.switchProduct(event('vip'));
  assert.equal(r.page.data.activeProductType, 'matchmaking');
  assert.match(r.calls.toasts.at(-1), /当前订单结果/);
  await r.page.startPayment();
  assert.equal(r.native.length, 1);
  assert.equal(r.creates(), 1);
  r.state.paid = true;
  r.advance(1500);
  await paying;
  assert.equal(r.page.data.orderStatus, 'paid');
  assert.equal(r.page.data.orderTitle, '牵线服务已开通');
});

test('a new wrong product, price or service-count snapshot cannot open or resume the cashier', async () => {
  for (const patch of [{ productType: 'vip' }, { planCode: 'matchmaking_quarter' }, { amountFen: 1 }, { serviceCount: 16 }]) {
    const r = matchmakingRuntime({ createOrder: current => ({ order: { ...current, ...patch }, payment: virtual }) });
    await r.page.loadOverview(); await r.page.startPayment();
    assert.equal(r.native.length, 0);
    assert.equal(r.virtualInputs.length, 0);
    assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page.data.orderStatus, 'confirming');
    assert.match(r.calls.toasts.at(-1), /当前选择的服务不一致/);
  }
});

test('matching virtual checkout observes closed gates and unsupported devices before creating an order', async () => {
  for (const options of [
    { overview: { matchmakingPayment: { ...virtual, available: false, reason: 'integration_incomplete' } } },
    { overview: { phoneBound: false, matchmakingPayment: { ...virtual, available: false, reason: 'phone_required' } } },
    { overview: { phoneBound: false } },
    { wx: { getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 14.9' }),
      getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.68' }) } },
    { wx: { getAppBaseInfo: () => ({ SDKVersion: '2.19.1' }), canIUse: () => false } }
  ]) {
    const r = matchmakingRuntime(options);
    await r.page.loadOverview(); await r.page.startPayment();
    assert.equal(r.creates(), 0);
    assert.equal(r.native.length, 0);
  }
});

test('matching virtual checkout supports eligible iOS devices with production signatures', async () => {
  const r = matchmakingRuntime({ wx: {
    getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 15' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.68' })
  }, checkoutResult(result) {
    result.virtualPayment.signData = JSON.stringify({ ...JSON.parse(result.virtualPayment.signData), env: 0 });
    return result;
  } });
  await r.page.loadOverview();
  await r.page.startPayment();
  assert.equal(r.creates(), 1);
  assert.equal(r.virtualInputs.length, 1);
  assert.equal(r.native.length, 1);
  assert.equal(r.page.data.orderStatus, 'paid');
});

test('an old JSAPI paid query can fulfill the original service and permits returning to VIP without another payment', async () => {
  const pending = order({ paymentProvider: 'jsapi', planCode: 'matchmaking_month', planTitle: '1个月牵线', serviceCount: 2 });
  const paid = order({ paymentProvider: 'jsapi', planCode: 'matchmaking_month', planTitle: '1个月牵线', serviceCount: 2,
    status: 'paid', fulfillmentStatus: 'fulfilled' });
  let queries = 0;
  const r = runtime('pages/user/membership.js', { source: true, memberApi: {
    membershipOverview: async () => overview({ pendingOrder: queries ? null : pending,
      pendingOrderPayment: { ...jsapi, available: false, reason: 'historical_payment_query_required' } }),
    membershipOrder: async () => paid,
    virtualPaymentQuery: async () => assert.fail('old paid JSAPI evidence must stay on the original provider')
  }, wx: { cloud: { callHTTPFunction(call) { queries++; assert.equal(call.path, '/pay/query');
    call.success(envelope({ order: paid, tradeState: 'SUCCESS' })); } },
    requestPayment() { assert.fail('only query an old order'); },
    requestVirtualPayment() { assert.fail('never migrate an old paid order'); } } });
  await r.page.loadOverview();
  assert.equal(r.page.data.orderTitle, '牵线服务已开通');
  assert.equal(r.page.data.orderCanResume, false);
  await r.page.switchProduct(event('vip'));
  assert.equal(r.page.data.activeProductType, 'vip');
  assert.equal(queries, 1);
});

test('service balances display confirmed package counts and entitlement management opens the matching tab', async () => {
  const r = runtime('pages/user/membership.js', { source: true, memberApi: { membershipOverview: async () => overview({
    matchmakingPackages: [{ id: 'P1', planTitle: '3个月牵线', totalCount: 8, usedCount: 3, remainingCount: 5,
      expireAt: '2027-01-10T00:00:00Z', status: 'active' }] }) } });
  r.page.onLoad({ type: 'matchmaking' }); await r.page.loadOverview();
  const balance = r.page.data.matchmakingPackages[0];
  assert.deepEqual([balance.totalCount, balance.usedCount, balance.remainingCount], [8, 3, 5]);
  assert.equal(r.page.data.hasMatchmakingService, true);
  r.page.openPrivileges();
  assert.equal(r.calls.navigation.at(-1).url, '/pages/user/vip-privileges?type=matchmaking');
});

test('a late overview from a previous account cannot reveal service records', async () => {
  const delayed = deferred();
  const r = runtime('pages/user/membership.js', { source: true, memberApi: { membershipOverview: () => delayed.promise } });
  const loading = r.page.loadOverview();
  r.session.user = { id: 2 };
  delayed.resolve(overview({ matchmakingPackages: [{ id: 'private-package', planTitle: '旧账号服务', status: 'active',
    totalCount: 2, usedCount: 0, remainingCount: 2, expireAt: '2027-01-01' }] }));
  await loading;
  assert.equal(r.page.data.matchmakingPackages.length, 0);
});

test('membership UI promises manual renewal and excludes removed marketing privileges', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/user/membership.wxml'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/user/membership.ts'), 'utf8');
  assert.match(ui, /手动续费，不自动扣款/);
  assert.match(ui, /VIP会员/);
  assert.match(ui, /人工牵线/);
  assert.match(ui, /使用我的牵线服务/);
  assert.match(ui, /付款确认后次数立即到账/);
  assert.match(ui, /每次购买独立成包/);
  for (const removed of ['联系主理人开通', '购买前确认', '主理人确认后购买', '由主理人协助开通']) assert.equal((ui + source).includes(removed), false, removed);
  for (const removed of ['超级喜欢', '消息防撤回', '清除广告', '超级曝光', '送礼雨', '头像装饰', '优质异性推荐', '尊享专属标识']) {
    assert.equal((ui + source).includes(removed), false, removed);
  }
});
