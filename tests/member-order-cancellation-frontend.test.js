const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const number = 'HL_ORDER_20261103';
const cancelledAt = '2026-11-03T08:00:00.000Z';
const order = (patch = {}) => ({ outTradeNo: number, planCode: 'vip_month', planTitle: 'VIP月卡', amountFen: 9900,
  durationDays: 30, status: 'closed', fulfillmentStatus: '', fulfillmentMessage: '', productType: 'vip',
  serviceCount: 0, paymentProvider: 'virtual', createdAt: '2026-11-03T07:00:00.000Z', updatedAt: cancelledAt, paidAt: null, ...patch });
const cancelled = () => order({ cancelledAt });
const pages = ['order-detail', 'payment-cancel'];

function pageRuntime(name, overrides = {}) {
  const reads = [], cancellations = [], modals = [];
  let current = order();
  const r = runtime(`pages/user/${name}.js`, { source: true,
    memberApi: {
      orderDetail: async value => { reads.push(value); return overrides.read ? overrides.read(reads.length) : current; },
      cancelPaymentOrder: async value => {
        cancellations.push(value);
        if (overrides.cancel) return overrides.cancel(cancellations.length);
        current = cancelled(); return current;
      }
    },
    wx: { showModal: options => {
      modals.push(options);
      if (overrides.modal) overrides.modal(options);
      else options.success({ confirm: true });
    } }
  });
  r.page.onLoad({ outTradeNo: number });
  return { ...r, reads, cancellations, modals };
}

test('order view offers cancellation only for unfulfilled unpaid states and paid takes precedence over cancelledAt', () => {
  const r = pageRuntime('order-detail');
  const helper = r.load(path.resolve('miniprogram/utils/member-order-view.ts'));
  for (const status of ['pending', 'confirming', 'closed', 'failed']) {
    assert.equal(helper.memberOrderView(order({ status })).canCancel, true, status);
    assert.equal(helper.memberOrderView(order({ status, fulfillmentStatus: 'requires_review' })).canCancel, false);
  }
  for (const status of ['paid', 'refunded']) assert.equal(helper.memberOrderView(order({ status })).canCancel, false);
  const view = helper.memberOrderView(cancelled());
  assert.equal(view.statusText, '已取消'); assert.equal(view.canCancel, false);
  const late = helper.memberOrderView(order({ status: 'paid', cancelledAt, fulfillmentStatus: 'requires_review' }));
  assert.equal(late.isCancelled, false); assert.equal(late.statusText, '待核查'); assert.equal(late.canCancel, false);
});

test('both pages confirm the exact order, lock duplicate cancellation and refresh, then render authoritative cancellation', async () => {
  for (const name of pages) {
    const pending = deferred(); let completed = false;
    const r = pageRuntime(name, { read: () => completed ? cancelled() : order(), cancel: () => pending.promise });
    await r.page.onShow();
    const cancelling = r.page.cancelOrder(), duplicate = r.page.cancelOrder(); await flush();
    assert.equal(r.modals.length, 1); assert.deepEqual(r.cancellations, [number]); assert.equal(r.page.data.cancelling, true);
    await r.page.refresh(); assert.equal(r.reads.length, 1, 'refresh cannot supersede the pending mutation');
    assert.equal(r.page.data.order.isCancelled, false);
    completed = true; pending.resolve(cancelled()); await Promise.all([cancelling, duplicate]);
    assert.equal(r.reads.length, 2); assert.equal(r.page.data.order.statusText, '已取消'); assert.equal(r.page.data.cancelling, false);
    await r.page.cancelOrder(); assert.equal(r.cancellations.length, 1);
  }
});

test('declining cancellation never writes and rejection retains order with friendly server explanation', async () => {
  for (const name of pages) {
    const declined = pageRuntime(name, { modal: options => options.success({ confirm: false }) });
    await declined.page.onShow(); await declined.page.cancelOrder();
    assert.equal(declined.cancellations.length, 0); assert.equal(declined.page.data.cancelling, false);
    const denied = pageRuntime(name, { cancel: async () => { throw { code: 40914, message: '订单正在支付中，请稍后刷新支付结果' }; } });
    await denied.page.onShow(); await denied.page.cancelOrder();
    assert.match(denied.page.data.errorText, /正在支付中/);
    assert.equal(denied.page.data.order.isCancelled, false); assert.equal(denied.page.data.order.canCancel, true);
    assert.equal(denied.page.data.cancelling, false);
  }
});

test('successful cancellation remains visible when re-reading fails and a late paid result takes precedence', async () => {
  for (const name of pages) {
    const failedRead = pageRuntime(name, { read: read => read === 1 ? order() : Promise.reject(new Error('offline')) });
    await failedRead.page.onShow(); await failedRead.page.cancelOrder();
    assert.equal(failedRead.page.data.order.statusText, '已取消');
    assert.equal(failedRead.page.data.order.canCancel, false);
    assert.match(failedRead.page.data.errorText, /订单已取消.*暂时无法读取/);
    const latePaid = pageRuntime(name, { read: read => read === 1 ? order()
      : order({ status: 'paid', cancelledAt, fulfillmentStatus: 'requires_review', fulfillmentMessage: '收到付款，请等待核查' }) });
    await latePaid.page.onShow(); await latePaid.page.cancelOrder();
    assert.equal(latePaid.page.data.order.status, 'paid'); assert.equal(latePaid.page.data.order.isCancelled, false);
    assert.equal(latePaid.page.data.order.statusText, '待核查'); assert.match(latePaid.page.data.order.resultText, /收到付款/);
  }
});

test('mismatched, unconfirmed or invalid cancellation replies cannot claim success', async () => {
  for (const name of pages) for (const result of [order(), order({ status: 'paid', cancelledAt }),
    order({ outTradeNo: 'HL_ANOTHER_123456', cancelledAt }), order({ cancelledAt: 'invalid' })]) {
    const r = pageRuntime(name, { cancel: async () => result });
    await r.page.onShow(); await r.page.cancelOrder();
    assert.equal(r.page.data.order.isCancelled, false); assert.match(r.page.data.errorText, /取消结果暂未确认/);
    assert.equal(r.reads.length, 1); assert.equal(r.page.data.cancelling, false);
  }
});

test('hide or replacement account before modal confirmation prevents a mutation', async () => {
  for (const name of pages) for (const action of ['hide', 'account']) {
    const r = pageRuntime(name, { modal() {} });
    await r.page.onShow(); const cancelling = r.page.cancelOrder(); await flush();
    if (action === 'hide') r.page.onHide();
    else { r.session.token = 'other-token'; r.session.user = { id: 2 }; await r.page.onShow(); }
    const updates = r.calls.updates.length;
    r.modals[0].success({ confirm: true }); await cancelling;
    assert.equal(r.cancellations.length, 0); assert.equal(r.calls.updates.length, updates);
  }
});

test('same-account hide/show keeps a mutation locked, then refreshes instead of applying stale private output', async () => {
  for (const name of pages) {
    const pending = deferred(); let completed = false;
    const r = pageRuntime(name, { read: () => completed ? cancelled() : order(), cancel: () => pending.promise });
    await r.page.onShow(); const cancelling = r.page.cancelOrder(); await flush();
    r.page.onHide(); const returning = r.page.onShow();
    assert.equal(r.page.data.order, null); assert.equal(r.page.data.cancelling, true);
    const duplicate = r.page.cancelOrder(); await flush();
    assert.equal(r.cancellations.length, 1); assert.equal(r.reads.length, 1);
    completed = true; pending.resolve(cancelled()); await Promise.all([cancelling, returning, duplicate]);
    assert.equal(r.reads.length, 2); assert.equal(r.page.data.order.isCancelled, true); assert.equal(r.page.data.cancelling, false);
  }
});

test('replacement account ignores old cancellation success and authorization failure', async () => {
  for (const name of pages) for (const outcome of ['success', 'unauthorized']) {
    const pending = deferred();
    const r = pageRuntime(name, { cancel: () => pending.promise,
      read: read => read === 1 ? order() : order({ planTitle: '当前账号订单', status: 'paid', fulfillmentStatus: 'fulfilled' }) });
    await r.page.onShow(); const cancelling = r.page.cancelOrder(); await flush();
    r.session.token = 'other-token'; r.session.user = { id: 2 }; await r.page.onShow();
    const updates = r.calls.updates.length;
    if (outcome === 'success') pending.resolve(cancelled()); else pending.reject({ code: 40100, message: '登录过期' });
    await cancelling;
    assert.equal(r.calls.updates.length, updates); assert.equal(r.page.data.order.planTitle, '当前账号订单');
    assert.equal(r.page.data.order.status, 'paid'); assert.equal(r.calls.navigation.length, 0);
  }
});

test('current unauthorized cancellation clears private data and routes back through orders login', async () => {
  for (const name of pages) {
    const r = pageRuntime(name, { cancel: async () => { throw { code: 40100, message: '登录已失效' }; } });
    await r.page.onShow(); await r.page.cancelOrder();
    assert.equal(r.page.data.order, null); assert.equal(r.page.data.cancelling, false);
    assert.equal(r.calls.navigation.at(-1).url, '/pages/index/index?returnTo=orders');
  }
});
