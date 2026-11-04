const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const number = 'HL_ORDER_20261103';
const stamp = '2026-11-03T08:00:00.000Z';
const payment = { provider: 'virtual', available: true, reason: '', functionName: '', createPath: '', queryPath: '' };
const order = (status = 'pending', patch = {}) => ({ id: 1, userId: 1, outTradeNo: number, planCode: 'vip_month',
  planTitle: 'VIP月卡', amountFen: 19800, durationDays: 30, productType: 'vip', paymentProvider: 'virtual',
  status, fulfillmentStatus: status === 'paid' ? 'fulfilled' : '', createdAt: stamp, updatedAt: stamp, ...patch });
const cancelled = () => order('closed', { cancelledAt: stamp });
const overview = () => ({ isPremiumMember: false, phoneBound: true, phoneMasked: '138****0001', needsMatchmaker: false,
  membership: null, payment, plans: ['vip_month', 'vip_quarter'].map((planCode, index) => ({ planCode,
    title: index ? 'VIP季卡' : 'VIP月卡', amountFen: index ? 39800 : 19800, durationDays: index ? 90 : 30, priceText: index ? '398元' : '198元', productType: 'vip' })) });

async function setup(status = 'pending', options = {}) {
  const counts = { overview: 0, cancel: [], local: [], query: [], create: [] };
  const state = { local: order(status), cancel: cancelled() };
  const r = runtime('pages/user/membership.js', { source: true, memberApi: {
    membershipOverview: async () => { counts.overview++; return overview(); },
    cancelPaymentOrder: async id => { counts.cancel.push(id); return options.cancel ? options.cancel(id) : state.cancel; },
    membershipOrder: async id => { counts.local.push(id); return options.local ? options.local(id, counts.local.length) : state.local; },
    virtualPaymentQuery: async id => { counts.query.push(id); return options.query ? options.query(id, state) : { order: state.local }; },
    createMembershipOrder: async code => { counts.create.push(code); throw new Error('fixture stops before payment'); }
  }, wx: {
    getDeviceInfo: () => ({ platform: 'android' }), getAppBaseInfo: () => ({ SDKVersion: '3.10.0' }),
    ...options.wx
  } });
  await r.page.onShow();
  r.page.setData({ lastOrderId: number, orderStatus: status, orderCanResume: status === 'pending', orderTitle: '原订单状态', orderNote: '原订单说明' });
  r.page._resumableCheckout = { order: order(status), payment };
  await r.page.showOrderResult(order(status));
  return { ...r, state, counts };
}

test('pending confirming closed and failed orders can be explicitly cancelled once and then a new plan can be selected', async () => {
  for (const status of ['pending', 'confirming', 'closed', 'failed']) {
    const r = await setup(status);
    const reads = r.counts.overview;
    await r.page.cancelOrder();
    assert.deepEqual(r.counts.cancel, [number]);
    assert.equal(r.page.data.orderTitle, '订单已取消'); assert.equal(r.page.data.orderStatus, 'closed');
    assert.equal(r.page.data.orderCancelledAt, stamp); assert.equal(r.page.data.orderCanResume, false);
    assert.equal(r.page._resumableCheckout, null); assert.equal(r.page.data.orderCancelling, false);
    assert.equal(r.counts.overview, reads, 'cancel feedback must not be replaced by an automatic overview read');
    await r.page.cancelOrder(); assert.equal(r.counts.cancel.length, 1);
    r.page.onPlanChange({ detail: { value: 'vip_quarter' } });
    assert.equal(r.page.data.selectedPlanCode, 'vip_quarter');
    await r.page.startPayment();
    assert.deepEqual(r.counts.create, ['vip_quarter'], 'a new order is requested instead of resuming the cancelled checkout');
    assert.equal(r.page.data.orderTitle, '订单已取消', 'failed new-order creation preserves the old cancellation evidence');
  }
});

test('paid refunded and already-cancelled orders never call the cancellation endpoint', async () => {
  for (const status of ['paid', 'refunded', 'cancelled']) {
    const r = await setup(status === 'cancelled' ? 'closed' : status);
    if (status === 'cancelled') await r.page.showOrderResult(cancelled());
    await r.page.cancelOrder(); assert.equal(r.counts.cancel.length, 0);
  }
});

test('declining confirmation performs no mutation and restores the cancel control', async () => {
  const r = await setup('closed', { wx: { showModal: options => options.success({ confirm: false, cancel: true }) } });
  await r.page.cancelOrder();
  assert.equal(r.counts.cancel.length, 0); assert.equal(r.page.data.orderCancelledAt, '');
  assert.equal(r.page.data.orderCancelling, false); assert.equal(r.page.data.orderTitle, '订单已关闭');
});

test('confirmation and cancellation requests lock payment, refreshing and plan/product switching', async () => {
  let modal; const pending = deferred();
  const r = await setup('closed', { cancel: () => pending.promise, wx: { showModal: options => { modal = options; } } });
  const cancelling = r.page.cancelOrder(); await flush();
  const reads = r.counts.overview;
  for (const phase of ['modal', 'request']) {
    await r.page.cancelOrder(); await r.page.startPayment(); await r.page.refreshOrderStatus();
    await r.page.loadOverview({ pullDown: true });
    await r.page.switchProduct({ currentTarget: { dataset: { type: 'matchmaking' } } });
    r.page.selectPlan({ currentTarget: { dataset: { code: 'vip_quarter' } } });
    r.page.onPlanChange({ detail: { value: 'vip_quarter' } });
    assert.equal(r.page.data.selectedPlanCode, 'vip_month'); assert.equal(r.page.data.activeProductType, 'vip');
    assert.equal(r.counts.overview, reads); assert.equal(r.counts.query.length, 0); assert.equal(r.counts.create.length, 0);
    if (phase === 'modal') { modal.success({ confirm: true }); await flush(); }
  }
  assert.deepEqual(r.counts.cancel, [number]); pending.resolve(cancelled()); await cancelling;
  assert.equal(r.page.data.orderCancelling, false);
});

test('provider refusal and malformed success stay visible without claiming cancellation or losing the current order', async () => {
  for (const response of [new Error('支付平台尚未确认关闭，请先查询订单状态。'), order('paid'), order('closed'),
    order('closed', { cancelledAt: 'invalid' }), order('closed', { outTradeNo: 'DIFFERENT_ORDER', cancelledAt: stamp }),
    order('closed', { userId: 2, cancelledAt: stamp })]) {
    const r = await setup('closed', { cancel: async () => { if (response instanceof Error) throw response; return response; } });
    await r.page.cancelOrder();
    assert.equal(r.page.data.orderTitle, '订单已关闭'); assert.equal(r.page.data.orderCancelledAt, '');
    assert.ok(r.page.data.orderCancellationError); assert.equal(r.page.data.orderCancelling, false);
    assert.equal(r.page.data.lastOrderId, number);
  }
});

test('hidden prompt confirmation, old accounts and unloaded pages cannot apply cancellation outcomes', async () => {
  let modal;
  const prompt = await setup('closed', { wx: { showModal: value => { modal = value; } } });
  const confirming = prompt.page.cancelOrder(); await flush(); prompt.page.onHide();
  modal.success({ confirm: true }); await confirming; assert.equal(prompt.counts.cancel.length, 0);
  for (const transition of ['hidden', 'account', 'unload']) {
    const pending = deferred(); const r = await setup('pending', { cancel: () => pending.promise });
    const cancelling = r.page.cancelOrder(); await flush();
    if (transition === 'account') { r.session.token = 'next'; r.session.user = { id: 2 }; }
    else r.page[transition === 'hidden' ? 'onHide' : 'onUnload']();
    const updates = r.calls.updates.length;
    pending.resolve(cancelled()); await cancelling;
    assert.equal(r.calls.updates.length, updates); assert.equal(r.page.data.orderCancelledAt, '');
    if (transition === 'hidden') { await r.page.onShow(); assert.equal(r.page.data.orderTitle, '订单已取消'); }
  }
});

test('returning while cancellation is in flight waits, then displays its authoritative result without duplicate requests', async () => {
  const pending = deferred(); const r = await setup('pending', { cancel: () => pending.promise });
  const cancelling = r.page.cancelOrder(); await flush(); r.page.onHide();
  const showing = r.page.onShow(); await flush(); await r.page.cancelOrder();
  assert.equal(r.counts.cancel.length, 1); assert.equal(r.page.data.orderCancelling, true);
  pending.resolve(cancelled()); await Promise.all([cancelling, showing]);
  assert.equal(r.page.data.orderTitle, '订单已取消'); assert.equal(r.page.data.orderCancelling, false);
});

test('returning from another order page refreshes an old card even without an overview pending order', async () => {
  for (const updated of [cancelled(), order('paid')]) {
    const r = await setup('closed'); r.state.local = updated;
    r.page.onHide(); await r.page.onShow();
    assert.deepEqual(r.counts.local, [number]);
    assert.equal(r.page.data.orderTitle, updated.status === 'paid' ? '会员已开通' : '订单已取消');
    assert.equal(r.page.data.orderCancelledAt, updated.status === 'paid' ? '' : stamp);
  }
});

test('refreshing a cancelled order reads authoritative local status first and honours a later paid result', async () => {
  const r = await setup('closed'); await r.page.cancelOrder();
  r.state.local = order('paid', { cancelledAt: stamp });
  await r.page.refreshOrderStatus();
  assert.deepEqual(r.counts.local, [number]); assert.equal(r.counts.query.length, 0);
  assert.equal(r.page.data.orderTitle, '会员已开通'); assert.equal(r.page.data.orderCancelledAt, '');
});

test('a returning-page order read cannot overwrite a newer return or leave the query control locked', async () => {
  const old = deferred();
  const r = await setup('closed', { local: async (_id, read) => read === 1 ? old.promise : cancelled() });
  r.page.onHide(); const firstReturn = r.page.onShow(); await flush();
  assert.equal(r.page.data.orderChecking, true);
  r.page.onHide(); await r.page.onShow();
  assert.equal(r.page.data.orderChecking, false); assert.equal(r.page.data.orderTitle, '订单已取消');
  const updates = r.calls.updates.length;
  old.resolve(order('paid')); await firstReturn;
  assert.equal(r.calls.updates.length, updates); assert.equal(r.page.data.orderTitle, '订单已取消');
});

test('cancelled orders still reconcile issued payment attempts so a late payment is not hidden', async () => {
  const r = await setup('closed', { query: async (_id, state) => {
    state.local = order('paid', { cancelledAt: stamp, fulfillmentStatus: 'requires_review' });
    return { order: state.local };
  } });
  await r.page.cancelOrder(); r.state.local = cancelled();
  await r.page.refreshOrderStatus();
  assert.deepEqual(r.counts.query, [number]);
  assert.equal(r.counts.local.length, 2, 'local evidence is read both before and after provider reconciliation');
  assert.equal(r.page.data.orderTitle, '已付款，待人工处理'); assert.equal(r.page.data.orderRequiresReview, true);
  assert.equal(r.page.data.orderCancelledAt, '');
});

test('membership template exposes a conditional cancellation control and its error and busy states', () => {
  const source = fs.readFileSync(path.resolve('miniprogram/pages/user/membership.wxml'), 'utf8');
  assert.match(source, /!orderCancelledAt[\s\S]*orderStatus === 'closed'[\s\S]*bindtap="cancelOrder"/);
  assert.match(source, /orderCancellationError/); assert.match(source, /loading="\{\{orderCancelling\}\}"/);
});
