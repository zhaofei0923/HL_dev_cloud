const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const number = 'HL_MATCHMAKER_00000001';
const payment = { provider: 'virtual', available: true, reason: '', functionName: '', createPath: '', queryPath: '' };
const order = (patch = {}) => ({ id: 1, userId: 1, outTradeNo: number, productType: 'matchmaker',
  planCode: 'matchmaker_lifetime', planTitle: '主理人长期方案', amountFen: 698000, durationDays: 0, lifetime: true,
  serviceCount: 0, paymentProvider: 'virtual', status: 'pending', fulfillmentStatus: '',
  createdAt: '2026-10-19T09:00:00Z', updatedAt: '2026-10-19T09:00:00Z', ...patch });
const overview = (patch = {}) => ({ matchmaker: null, active: false, activationSource: '', lifetime: false,
  plan: { planCode: 'matchmaker_lifetime', productType: 'matchmaker', title: '主理人长期方案', amountFen: 698000,
    durationDays: 0, lifetime: true, active: true }, phoneBound: true, payment, pendingOrder: null, ...patch });
const active = (patch = {}) => overview({ active: true, activationSource: 'paid', lifetime: true,
  matchmaker: { id: 91, userId: 1, certificationStatus: 2, status: 1, activationSource: 'paid' }, ...patch });
const paid = (patch = {}) => order({ status: 'paid', fulfillmentStatus: 'fulfilled', ...patch });
const virtual = (current = order(), attempt = 'MM_ATTEMPT_0000001') => ({ order: current, paymentAttemptNo: attempt,
  virtualPayment: { mode: 'short_series_goods', paySig: 'a'.repeat(64), signature: 'b'.repeat(64),
    signData: JSON.stringify({ offerId: '1450674507', buyQuantity: 1, env: 0, currencyType: 'CNY',
      productId: current.planCode, goodsPrice: current.amountFen, outTradeNo: attempt, attach: current.outTradeNo }) } });

function setup(options = {}) {
  const counts = { overview: 0, create: 0, checkout: 0, query: 0, native: 0, login: 0 };
  const requested = [];
  const r = runtime('pages/matchmaker/activation.js', { source: true,
    matchmakerApi: {
      activation: async () => { counts.overview += 1; return options.overview ? options.overview(counts.overview) : overview(); },
      createActivationOrder: async () => { counts.create += 1; return options.create ? options.create(counts.create) : { order: order(), payment }; }
    },
    memberApi: {
      virtualPaymentCheckout: async (outTradeNo, code) => { counts.checkout += 1; requested.push({ outTradeNo, code });
        return options.checkout ? options.checkout(counts.checkout, outTradeNo) : virtual(); },
      virtualPaymentQuery: async outTradeNo => { counts.query += 1; requested.push({ query: outTradeNo });
        return options.query ? options.query(counts.query, outTradeNo) : { order: paid(), tradeState: 'SUCCESS' }; },
      createMembershipOrder() { assert.fail('principal activation must not create a VIP purchase'); }
    },
    wx: { getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 15.0' }),
      getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.68' }),
      login: value => { counts.login += 1; value.success({ code: 'fresh-wechat-login-code' }); },
      requestVirtualPayment: value => { counts.native += 1; return options.native ? options.native(value, counts.native) : value.success({}); },
      ...options.wx }
  });
  return { ...r, counts, requested };
}

test('activation is a read until an explicit tap, with fixed lifetime terms and no VIP grants', async () => {
  const r = setup(); await r.page.onShow();
  assert.equal(r.counts.overview, 1); assert.equal(r.counts.create, 0); assert.equal(r.counts.native, 0);
  assert.equal(r.page.data.overview.plan.amountFen, 698000); assert.equal(r.page.data.overview.plan.durationDays, 0);
  assert.match(r.page.data.paymentNote, /自动开通/); assert.equal(r.session.user.isPremiumMember, undefined);
  const disabled = setup({ overview: () => overview({ phoneBound: false }) }); await disabled.page.onShow();
  await disabled.page.startPayment(); assert.equal(disabled.counts.create, 0); assert.match(disabled.calls.toasts.at(-1), /手机号/);
});

test('native success needs paid plus fulfilled plus a fresh active principal read before success', async () => {
  const grant = deferred();
  const r = setup({ overview: read => read === 1 ? overview() : grant.promise });
  await r.page.onShow(); const paying = r.page.startPayment(); await flush();
  assert.equal(r.counts.native, 1); assert.equal(r.counts.query, 1); assert.equal(r.counts.overview, 2);
  assert.equal(r.page.data.active, false); assert.equal(r.session.user.isPremiumMember, undefined);
  grant.resolve(active()); await paying;
  assert.equal(r.page.data.active, true); assert.equal(r.page.data.orderTitle, '主理人已开通');
  assert.equal(r.counts.create, 1); assert.equal(r.requested[0].outTradeNo, number);
  assert.equal(r.calls.storage.length, 0); r.page.openWorkbench();
  assert.equal(r.calls.navigation.at(-1).url, '/pages/matchmaker/workspace');
  await r.page.startPayment(); assert.equal(r.counts.create, 1); assert.equal(r.counts.native, 1);
});

test('paid without fulfillment and review-required results never open the workbench or charge again', async () => {
  for (const fulfillmentStatus of ['', 'requires_review']) {
    const r = setup({ query: () => ({ order: paid({ fulfillmentStatus }), tradeState: 'SUCCESS' }) });
    await r.page.onShow(); await r.page.startPayment();
    assert.equal(r.page.data.active, false); assert.equal(r.page.data.orderCanResume, false);
    assert.match(r.page.data.orderTitle, fulfillmentStatus ? /核查/ : /确认中/);
    r.page.openWorkbench(); assert.equal(r.calls.navigation.length, 0);
    await r.page.startPayment(); assert.equal(r.counts.create, 1); assert.equal(r.counts.native, 1);
  }
});

test('even fulfilled payments wait when the fresh activation read is still inactive', async () => {
  const r = setup(); await r.page.onShow(); await r.page.startPayment();
  assert.equal(r.page.data.active, false); assert.match(r.page.data.orderTitle, /权限确认中/);
  assert.equal(r.page.data.orderCanResume, false); r.page.openWorkbench(); assert.equal(r.calls.navigation.length, 0);
});

test('existing manual principals keep their workbench and are never asked to pay', async () => {
  const r = setup({ overview: () => active({ activationSource: 'manual', payment: { ...payment, available: false, reason: 'matchmaker_already_active' },
    matchmaker: { id: 91, userId: 1, certificationStatus: 2, status: 1, activationSource: 'manual' } }) });
  await r.page.onShow(); assert.equal(r.page.data.active, true);
  await r.page.startPayment(); assert.equal(r.counts.create, 0); assert.equal(r.counts.native, 0);
  assert.equal(r.calls.navigation.at(-1).url, '/pages/matchmaker/workspace');
});

test('a recovered unpaid order requires provider evidence and resumes with a fresh platform attempt', async () => {
  const original = order();
  const r = setup({ overview: read => read === 1 ? overview({ pendingOrder: original, pendingOrderPayment: payment }) : active(),
    query: read => read === 1 ? { order: original, tradeState: 'NOTPAY' } : { order: paid(), tradeState: 'SUCCESS' } });
  await r.page.onShow(); assert.equal(r.counts.query, 1); assert.equal(r.counts.create, 0);
  assert.equal(r.page.data.orderCanResume, true);
  await r.page.startPayment(); assert.equal(r.counts.create, 0); assert.equal(r.counts.native, 1); assert.equal(r.page.data.active, true);
});

test('reused checkout first restores the order; a second explicit tap resumes instead of recreating', async () => {
  const r = setup({ create: () => ({ order: order(), payment, reused: true, recoveryRequired: true }),
    overview: read => read === 1 ? overview() : active(),
    query: read => read === 1 ? { order: order(), providerOrderAbsent: true } : { order: paid(), tradeState: 'SUCCESS' } });
  await r.page.onShow(); await r.page.startPayment();
  assert.equal(r.counts.native, 0); assert.equal(r.page.data.orderCanResume, true);
  await r.page.startPayment(); assert.equal(r.counts.create, 1); assert.equal(r.counts.native, 1); assert.equal(r.page.data.active, true);
});

test('native cancellation queries the same order before resume, and a late paid result activates safely', async () => {
  const r = setup({ overview: read => read === 1 ? overview() : active(),
    native: value => value.fail({ errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' }),
    query: () => ({ order: paid(), tradeState: 'SUCCESS' }) });
  await r.page.onShow(); await r.page.startPayment();
  assert.equal(r.counts.query, 1); assert.equal(r.page.data.active, true); assert.equal(r.counts.native, 1);
  const cancelled = setup({ native: value => value.fail({ errCode: -2 }), query: () => ({ order: order(), tradeState: 'NOTPAY' }) });
  await cancelled.page.onShow(); await cancelled.page.startPayment();
  assert.equal(cancelled.page.data.active, false); assert.equal(cancelled.page.data.orderCanResume, true);
  assert.equal(cancelled.counts.query, 1); assert.equal(cancelled.counts.create, 1);
});

test('a failed cancellation query blocks another native attempt until the original order can be checked', async () => {
  const r = setup({ native: value => value.fail({ errCode: -2 }), query: () => { throw new Error('network'); } });
  await r.page.onShow(); await r.page.startPayment();
  assert.equal(r.page.data.orderCanResume, false); assert.match(r.page.data.orderTitle, /暂未确认/);
  await r.page.startPayment(); assert.equal(r.counts.create, 1); assert.equal(r.counts.native, 1);
});

test('native success with lagging NOTPAY stays confirming and never immediately offers repayment', async () => {
  const r = setup({ query: () => ({ order: order(), tradeState: 'NOTPAY' }) });
  await r.page.onShow(); const paying = r.page.startPayment();
  for (let i = 0; i < 7; i += 1) { await flush(); r.advance(1200); }
  await paying; assert.equal(r.counts.query, 6); assert.equal(r.page.data.active, false);
  assert.equal(r.page.data.orderCanResume, false); assert.match(r.page.data.orderTitle, /确认中/);
  await r.page.refreshOrderStatus(); assert.equal(r.page.data.orderCanResume, false);
});

test('malformed product, account, price and signed attempts fail closed before the native cashier', async () => {
  for (const patch of [{ userId: 2 }, { amountFen: 1 }, { durationDays: 365 }, { planCode: 'vip_year' }, { paymentProvider: 'jsapi' }]) {
    const r = setup({ create: () => ({ order: order(patch), payment }) }); await r.page.onShow(); await r.page.startPayment();
    assert.equal(r.counts.native, 0); assert.equal(r.page.data.active, false);
  }
  for (const patch of [{ paymentAttemptNo: 'other-attempt' }, { order: order({ amountFen: 100 }) }]) {
    const r = setup({ checkout: () => ({ ...virtual(), ...patch }) }); await r.page.onShow(); await r.page.startPayment();
    assert.equal(r.counts.native, 0); assert.equal(r.page.data.active, false);
  }
});

test('closed failed and refunded originals stay distinct and do not imply activation', async () => {
  for (const status of ['closed', 'failed', 'refunded']) {
    const r = setup({ overview: () => overview({ pendingOrder: order() }), query: () => ({ order: order({ status }) }) });
    await r.page.onShow(); assert.equal(r.page.data.order.status, status); assert.equal(r.page.data.active, false);
    assert.equal(r.page.data.orderCanResume, false); assert.equal(r.counts.native, 0);
  }
});

test('ordinary hide and unload clear private state and discard late responses', async () => {
  for (const leave of ['onHide', 'onUnload']) {
    const pending = deferred(); const r = setup({ overview: () => pending.promise });
    const show = r.page.onShow(); await flush(); r.page[leave](); const updates = r.calls.updates.length;
    pending.resolve(active()); await show;
    assert.equal(r.page.data.overview, null); assert.equal(r.page.data.active, false); assert.equal(r.calls.updates.length, updates);
  }
});

test('account replacement discards an old create result before fetching login/payment parameters', async () => {
  const creating = deferred(); const r = setup({ create: () => creating.promise });
  await r.page.onShow(); const paying = r.page.startPayment(); await flush();
  r.session.user = { id: 2 }; r.session.token = 'new-account'; await r.page.onShow();
  creating.resolve({ order: order(), payment }); await paying;
  assert.equal(r.counts.login, 0); assert.equal(r.counts.native, 0); assert.equal(r.page.data.order, null);
});

test('owned cashier hide is allowed, while unloading or switching account prevents a late activation result', async () => {
  let complete;
  const r = setup({ native: value => { complete = value; }, overview: read => read === 1 ? overview() : active() });
  await r.page.onShow(); const paying = r.page.startPayment(); await flush();
  r.page.onHide(); await r.page.onShow(); complete.success({}); await paying;
  assert.equal(r.page.data.active, true); assert.equal(r.counts.create, 1);
  const late = deferred(); const abandoned = setup({ query: () => late.promise });
  await abandoned.page.onShow(); const abandonedPay = abandoned.page.startPayment(); await flush(); abandoned.page.onUnload();
  late.resolve({ order: paid(), tradeState: 'SUCCESS' }); await abandonedPay;
  assert.equal(abandoned.page.data.active, false); assert.equal(abandoned.page.data.order, null);
  let oldCashier;
  const switched = setup({ native: value => { oldCashier = value; } });
  await switched.page.onShow(); const oldPayment = switched.page.startPayment(); await flush();
  switched.session.user = { id: 2 }; switched.session.token = 'replacement-account'; await switched.page.onShow();
  assert.equal(switched.counts.overview, 2); oldCashier.success({}); await oldPayment;
  assert.equal(switched.counts.query, 0); assert.equal(switched.page.data.active, false); assert.equal(switched.page.data.order, null);
});

test('native merchant restrictions disable retries, while a business permission error does not poison payment capability', async () => {
  const r = setup({ native: value => value.fail({ errCode: -15019, errMsg: 'requestVirtualPayment:fail merchant banned' }),
    query: () => ({ order: order(), tradeState: 'NOTPAY' }) });
  await r.page.onShow(); await r.page.startPayment();
  assert.equal(r.page.data.paymentRestricted, true); assert.equal(r.page.data.paymentAvailable, false);
  assert.equal(r.page.data.orderCanResume, false); await r.page.startPayment(); assert.equal(r.counts.native, 1);
  const business = setup({ checkout: () => { throw Object.assign(new Error('account denied'), { code: 40300 }); } });
  await business.page.onShow(); await business.page.startPayment();
  assert.equal(business.page.data.paymentRestricted, false); assert.equal(business.counts.native, 0);
});

test('existing VIP or matchmaking orders cannot be paid through activation, including a creation race', async () => {
  const foreign = order({ productType: 'vip', planCode: 'vip_year', durationDays: 365, amountFen: 99000 });
  for (const source of ['overview', 'create']) {
    const r = setup(source === 'overview' ? { overview: () => overview({ pendingOrder: foreign }) }
      : { create: () => ({ order: foreign, payment, reused: true }) });
    await r.page.onShow(); if (source === 'create') await r.page.startPayment();
    assert.equal(r.page.data.foreignOrder, true); assert.equal(r.counts.checkout, 0); assert.equal(r.counts.query, 0);
    assert.equal(r.counts.native, 0); await r.page.startPayment(); assert.equal(r.calls.navigation.at(-1).url, '/pages/user/orders');
  }
});

test('membership routes a pending principal order to activation without VIP payment or fulfillment copy', async () => {
  const r = runtime('pages/user/membership.js', { source: true, memberApi: { membershipOverview: async () => ({
    isPremiumMember: false, phoneBound: true, phoneMasked: '', needsMatchmaker: false, membership: null,
    plans: [], payment, pendingOrder: order() }),
    virtualPaymentQuery() { assert.fail('membership must delegate principal recovery'); },
    createMembershipOrder() { assert.fail('membership must not repay principal orders'); }
  } });
  await r.page.onShow(); assert.equal(r.page.data.activationOrderPending, true); assert.equal(r.page.data.onlineCheckout, false);
  assert.match(r.page.data.orderTitle, /主理人/); assert.doesNotMatch(r.page.data.orderNote, /VIP.*生效|VIP.*开通/);
  await r.page.startPayment(); assert.equal(r.calls.navigation.at(-1).url, '/pages/matchmaker/activation');
});

test('new principal orders render lifetime terms in the order center, while VIP zero-day records stay invalid', () => {
  const r = setup(); const view = r.load(path.join(miniprogramRoot, 'utils/member-order-view.ts'));
  const result = view.memberOrderView({ ...paid(), fulfillmentMessage: '' });
  assert.equal(result.termText, '主理人开通 · 长期有效'); assert.match(result.resultText, /主理人.*开通/);
  assert.throws(() => view.memberOrderView(order({ productType: 'vip', durationDays: 0 })));
  assert.throws(() => view.memberOrderView(order({ durationDays: 30 })));
});

test('access labels distinguish paid activation, old manual certification and suspended principals', () => {
  const r = setup(); const view = r.load(path.join(miniprogramRoot, 'utils/matchmaker-access-view.ts'));
  assert.equal(view.matchmakerAccessView({ certificationStatus: 2, activationSource: 'paid', status: 1 }, 'ready').statusText, '已开通');
  assert.equal(view.matchmakerAccessView({ certificationStatus: 2 }, 'ready').statusText, '已认证');
  assert.equal(view.matchmakerAccessView({ certificationStatus: 2, activationSource: 'paid', status: 0 }, 'ready').canOperate, false);
  assert.equal(view.matchmakerAccessView(null, 'ready').statusText, '待开通');
});

test('Apple version and formal-environment guards remain in force for principal activation', async () => {
  for (const wx of [
    { getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 14.8' }) },
    { getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.67' }) }
  ]) {
    const r = setup({ wx }); await r.page.onShow(); await r.page.startPayment();
    assert.equal(r.counts.create, 0); assert.equal(r.counts.native, 0);
  }
  const r = setup({ overview: () => overview({ payment: { ...payment, testMode: true } }) });
  await r.page.onShow(); await r.page.startPayment(); assert.equal(r.counts.create, 0);
  const sandbox = setup({ checkout: () => { const result = virtual();
    result.virtualPayment.signData = result.virtualPayment.signData.replace('"env":0', '"env":1'); return result; } });
  await sandbox.page.onShow(); await sandbox.page.startPayment(); assert.equal(sandbox.counts.native, 0);
});

test('activation service sends server-priced empty-body orders to its dedicated endpoint', async () => {
  const requests = [];
  const r = setup({ wx: { cloud: { callFunction: options => { requests.push(options.data); options.success({ result: { code: 0, data: {} } }); } } } });
  const api = r.load(path.join(miniprogramRoot, 'services/matchmaker.ts')).matchmakerApi;
  await api.activation(); await api.createActivationOrder();
  assert.equal(requests[0].path, '/matchmaker/activation'); assert.equal(requests[1].path, '/matchmaker/activation/orders');
  assert.equal(requests[1].method, 'POST'); assert.equal(JSON.stringify(requests[1].data), '{}');
});

test('activation WXML conditions compile as expressions and show payment only for eligible original-order states', () => {
  const markup = fs.readFileSync(path.join(miniprogramRoot, 'pages/matchmaker/activation.wxml'), 'utf8');
  const expressions = Array.from(markup.matchAll(/wx:(?:if|elif)="\{\{([^]*?)\}\}"/g), match => match[1]);
  assert.ok(expressions.length > 0);
  // WXML's expression parser does not decode XML entities inside bindings.
  // Parse the actual expressions to catch escaped operators before upload.
  for (const expression of expressions) assert.doesNotThrow(() => new Function(`return (${expression})`));
  const paymentTag = Array.from(markup.matchAll(/<button\b[^>]*>/g)).find(match => /bindtap="startPayment"/.test(match[0]))[0];
  const expression = /wx:elif="\{\{([^]*?)\}\}"/.exec(paymentTag)[1];
  const visible = new Function('foreignOrder', 'order', 'orderCanResume', `return (${expression})`);
  assert.equal(visible(false, null, false), true);
  assert.equal(visible(true, null, false), false);
  assert.equal(visible(false, order(), false), false);
  assert.equal(visible(false, order(), true), true);
  assert.equal(visible(false, paid(), false), false);
});
