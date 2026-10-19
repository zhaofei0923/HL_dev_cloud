const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const number = id => `HL_ORDER_${String(id).padStart(8, '0')}`;
const order = (id = 1, patch = {}) => ({ outTradeNo: number(id), planCode: 'vip_month', planTitle: 'VIP月卡',
  amountFen: 19800, durationDays: 30, status: 'paid', fulfillmentStatus: 'fulfilled', fulfillmentMessage: '',
  createdAt: '2026-10-19T01:00:00.000Z', updatedAt: '2026-10-19T01:01:00.000Z', paidAt: '2026-10-19T01:01:00.000Z',
  productType: 'vip', serviceCount: 0, paymentProvider: 'virtual', ...patch });
const pageResult = (list = [], page = 1, total = list.length, hasMore = false) => ({ list, page, pageSize: 20, total, hasMore });
const listEvent = outTradeNo => ({ currentTarget: { dataset: { outTradeNo } } });
const loginPath = '/pages/index/index?returnTo=orders';

function pageRuntime(kind, read, extra = {}) {
  const reads = [], clipboard = [];
  const r = runtime(`pages/user/${kind === 'list' ? 'orders' : 'order-detail'}.js`, { source: true, memberApi: {
    orders: (page, pageSize) => { reads.push({ page, pageSize }); return read(reads.length, page); },
    orderDetail: outTradeNo => { reads.push({ outTradeNo }); return read(reads.length, outTradeNo); },
    createMembershipOrder() { assert.fail('order center must not create a payment order'); },
    virtualPaymentCheckout() { assert.fail('order center must not prepare payment'); },
    virtualPaymentQuery() { assert.fail('order center must not actively query the payment provider'); }
  }, wx: { setClipboardData: value => clipboard.push(value.data), ...extra.wx } });
  if (kind === 'detail') r.page.onLoad({ outTradeNo: number(1), ...extra.options });
  return { ...r, reads, clipboard };
}
const refresh = (r, kind) => kind === 'list' ? r.page.retry() : r.page.refresh();
const visibleOrder = (r, kind) => kind === 'list' ? r.page.data.list[0] : r.page.data.order;
const response = (kind, title) => kind === 'list' ? pageResult([order(1, { planTitle: title })]) : order(1, { planTitle: title });

test('orders start with one shared read, paginate all states, deduplicate overlap and open only listed orders', async () => {
  const first = deferred(), second = deferred();
  const r = pageRuntime('list', read => read === 1 ? first.promise : second.promise);
  const initial = r.page.onShow(), duplicate = r.page.onShow(); await flush();
  assert.equal(r.reads.length, 1); assert.deepEqual(r.reads[0], { page: 1, pageSize: 20 });
  const statuses = ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'];
  first.resolve(pageResult(Array.from({ length: 20 }, (_, index) => order(index + 1, { status: statuses[index % 6] })), 1, 39, true));
  await Promise.all([initial, duplicate]);
  assert.equal(r.page.data.list.length, 20); assert.equal(r.page.data.hasMore, true);
  const more = r.page.loadMore(), moreDuplicate = r.page.loadMore(); await flush();
  assert.equal(r.reads.length, 2); assert.equal(r.reads[1].page, 2);
  second.resolve(pageResult([order(20), ...Array.from({ length: 19 }, (_, index) => order(index + 21))], 2, 39, false));
  await Promise.all([more, moreDuplicate]);
  assert.equal(r.page.data.list.length, 39); assert.equal(r.page.data.page, 2); assert.equal(r.page.data.hasMore, false);
  assert.equal(new Set(r.page.data.list.map(item => item.outTradeNo)).size, 39);
  await r.page.loadMore(); assert.equal(r.reads.length, 2);
  r.page.openOrder(listEvent(number(2)));
  assert.equal(r.calls.navigation.at(-1).url, `/pages/user/order-detail?outTradeNo=${number(2)}`);
  r.page.openOrder(listEvent(number(900))); assert.equal(r.calls.navigation.length, 1);
});

test('order list empty state, read errors and retry preserve the read-only request contract', async () => {
  let failed = true;
  const r = pageRuntime('list', async () => { if (failed) throw new Error('network failed'); return pageResult(); });
  await r.page.onShow(); assert.match(r.page.data.errorText, /重试/); assert.equal(r.page.data.loading, false);
  failed = false; await r.page.retry();
  assert.equal(r.page.data.errorText, ''); assert.equal(r.page.data.initialized, true); assert.equal(r.page.data.list.length, 0);
  await r.page.onPullDownRefresh(); assert.equal(r.calls.stopRefresh, 1);
});

test('a list refresh supersedes an older append and old completion cannot clear newer progress', async () => {
  const append = deferred(), newest = deferred();
  const r = pageRuntime('list', async read => read === 1 ? pageResult([order()], 1, 2, true) : read === 2 ? append.promise : newest.promise);
  await r.page.onShow(); const more = r.page.loadMore(); await flush();
  const resetting = r.page.retry(); await flush();
  append.resolve(pageResult([order(2)], 2, 2, false)); await more;
  assert.equal(r.page.data.refreshing, true); assert.equal(r.page.data.list.length, 1);
  newest.resolve(pageResult([order(3)], 1, 1, false)); await resetting;
  assert.equal(r.page.data.page, 1); assert.equal(r.page.data.list[0].outTradeNo, number(3));
});

test('detail uses the requested order identity, preserves snapshot terms, copies its number and refreshes without payment calls', async () => {
  const sample = order(1, { productType: 'matchmaking', planTitle: '人工牵线3次', durationDays: 30, serviceCount: 3,
    amountFen: 698000, paymentProvider: 'jsapi' });
  const r = pageRuntime('detail', async () => sample);
  await Promise.all([r.page.onShow(), r.page.onShow()]);
  assert.equal(r.reads.length, 1); assert.equal(r.reads[0].outTradeNo, number(1));
  assert.equal(r.page.data.order.amountText, '¥6980.00'); assert.equal(r.page.data.order.termText, '30天服务期 · 3次牵线');
  r.page.copyOrderNumber(); assert.deepEqual(r.clipboard, [number(1)]);
  r.page.openPrivileges(); assert.equal(r.calls.navigation.at(-1).url, '/pages/user/vip-privileges?type=matchmaking');
  await r.page.refresh(); assert.equal(r.reads.length, 2);
  r.page.onHide(); r.page.copyOrderNumber(); r.page.openPrivileges();
  assert.equal(r.clipboard.length, 1); assert.equal(r.calls.navigation.length, 1);
});

test('paid requires explicit fulfillment and review takes priority; closed failed and refunded stay distinct', async () => {
  const r = pageRuntime('detail', async () => order());
  const helper = r.load(path.resolve('miniprogram/utils/member-order-view.ts'));
  const held = helper.memberOrderView(order(1, { fulfillmentStatus: 'requires_review', fulfillmentMessage: '已付款，权益待核查' }));
  assert.equal(held.statusText, '待核查'); assert.match(held.resultText, /待核查/); assert.doesNotMatch(held.resultText, /已确认开通/);
  const unresolved = helper.memberOrderView(order(1, { fulfillmentStatus: '' }));
  assert.equal(unresolved.statusText, '权益确认中'); assert.doesNotMatch(unresolved.resultText, /已确认开通/);
  assert.equal(helper.memberOrderView(order(1, { status: 'closed' })).statusText, '已关闭');
  assert.equal(helper.memberOrderView(order(1, { status: 'failed' })).statusText, '支付未成功');
  assert.equal(helper.memberOrderView(order(1, { status: 'refunded' })).statusText, '已退款');
  assert.throws(() => helper.memberOrderView(order(1, { status: 'unknown' })));
  assert.throws(() => helper.memberOrderView(order(1, { amountFen: NaN })));
});

test('missing or invalid detail identity never issues a request and mismatched responses never render', async () => {
  for (const outTradeNo of ['', '../other', 'bad?parameter=1', '_INVALID_ORDER_1']) {
    const r = pageRuntime('detail', async () => assert.fail('invalid order must not be queried'), { options: { outTradeNo } });
    await r.page.onShow(); assert.equal(r.page.data.invalidLink, true); assert.equal(r.reads.length, 0);
  }
  const r = pageRuntime('detail', async () => order(2));
  await r.page.onShow(); assert.equal(r.page.data.order, null); assert.match(r.page.data.errorText, /重试/);
});

test('both order pages require login, clear private records and return to the allowlisted order-center login flow', async () => {
  for (const kind of ['list', 'detail']) {
    const r = pageRuntime(kind, async () => response(kind, 'PRIVATE_ORDER'));
    await r.page.onShow(); assert.ok(visibleOrder(r, kind));
    r.session.token = ''; r.session.user = null;
    await r.page.onShow();
    assert.equal(kind === 'list' ? r.page.data.list.length : r.page.data.order, kind === 'list' ? 0 : null);
    assert.equal(r.calls.navigation.at(-1).url, loginPath);
  }
});

test('current 401 failures clear private rows even when the API has already removed the session', async () => {
  for (const kind of ['list', 'detail']) for (const apiCleared of [false, true]) {
    const pending = deferred();
    const r = pageRuntime(kind, async read => read === 1 ? response(kind, 'PRIVATE_ORDER') : pending.promise);
    await r.page.onShow(); const refreshing = refresh(r, kind); await flush();
    if (apiCleared) { r.session.token = ''; r.session.user = null; }
    pending.reject(Object.assign(new Error('expired'), { code: 40100 })); await refreshing;
    assert.equal(kind === 'list' ? r.page.data.list.length : r.page.data.order, kind === 'list' ? 0 : null);
    assert.equal(r.page.data.loading, false); assert.equal(r.page.data.refreshing, false);
    assert.equal(r.calls.navigation.at(-1).url, loginPath);
  }
});

test('hidden and unloaded responses never write private rows; returning pages own a new read', async () => {
  for (const kind of ['list', 'detail']) for (const leave of ['onHide', 'onUnload']) {
    const first = deferred(), second = deferred();
    const r = pageRuntime(kind, read => read === 1 ? first.promise : second.promise);
    const oldShow = r.page.onShow(); await flush(); r.page[leave]();
    const updates = r.calls.updates.length;
    first.resolve(response(kind, 'OLD_PRIVATE_ORDER')); await oldShow;
    assert.equal(r.calls.updates.length, updates);
    const returning = r.page.onShow(); await flush(); assert.equal(r.reads.length, 2);
    second.resolve(response(kind, 'CURRENT_ORDER')); await returning;
    assert.equal(visibleOrder(r, kind).planTitle, 'CURRENT_ORDER');
  }
});

test('an older hide/show generation cannot populate rows or clear a newer loading state', async () => {
  for (const kind of ['list', 'detail']) {
    const first = deferred(), second = deferred();
    const r = pageRuntime(kind, read => read === 1 ? first.promise : second.promise);
    const oldShow = r.page.onShow(); await flush(); r.page.onHide();
    const newShow = r.page.onShow(); await flush();
    const updates = r.calls.updates.length;
    first.resolve(response(kind, 'OLD_PRIVATE_ORDER')); await oldShow;
    assert.equal(r.calls.updates.length, updates); assert.equal(r.page.data.loading, true);
    second.resolve(response(kind, 'NEW_PRIVATE_ORDER')); await newShow;
    assert.equal(visibleOrder(r, kind).planTitle, 'NEW_PRIVATE_ORDER'); assert.equal(r.page.data.loading, false);
  }
});

test('replacement account data survives old success, failure and unauthorized replies without cross-account cache', async () => {
  for (const kind of ['list', 'detail']) for (const result of ['success', 'failure', 'unauthorized']) {
    const first = deferred();
    const r = pageRuntime(kind, read => read === 1 ? first.promise : Promise.resolve(response(kind, 'NEW_ACCOUNT_ORDER')));
    const oldShow = r.page.onShow(); await flush();
    r.session.token = 'replacement-token'; r.session.user = { id: 44 };
    await r.page.onShow(); const updates = r.calls.updates.length;
    if (result === 'success') first.resolve(response(kind, 'OLD_ACCOUNT_ORDER'));
    else first.reject(Object.assign(new Error('old request failed'), { code: result === 'unauthorized' ? 40100 : 500 }));
    await oldShow;
    assert.equal(r.calls.updates.length, updates); assert.equal(visibleOrder(r, kind).planTitle, 'NEW_ACCOUNT_ORDER');
    assert.equal(r.calls.navigation.length, 0);
  }
});

test('newer explicit detail reads supersede older reads and hide before dispatch prevents a read', async () => {
  const first = deferred(), second = deferred();
  const r = pageRuntime('detail', read => read === 1 ? first.promise : second.promise);
  const oldShow = r.page.onShow(); await flush(); const newest = r.page.refresh(); await flush();
  second.resolve(order(1, { planTitle: 'NEW_SNAPSHOT' })); await newest;
  first.resolve(order(1, { planTitle: 'OLD_SNAPSHOT' })); await oldShow;
  assert.equal(r.page.data.order.planTitle, 'NEW_SNAPSHOT');
  for (const kind of ['list', 'detail']) {
    const hidden = pageRuntime(kind, async () => assert.fail('hidden request must not be dispatched'));
    const showing = hidden.page.onShow(); hidden.page.onHide(); await showing;
    assert.equal(hidden.reads.length, 0);
  }
});

test('old pull-refresh completion cannot stop a newer refresh and hidden retry events cannot touch the replacement session', async () => {
  for (const kind of ['list', 'detail']) {
    const first = deferred(), second = deferred();
    const r = pageRuntime(kind, read => read === 1 ? Promise.resolve(response(kind, 'INITIAL')) : read === 2 ? first.promise : second.promise);
    await r.page.onShow();
    const older = r.page.onPullDownRefresh(); await flush();
    const newer = r.page.onPullDownRefresh(); await flush();
    first.resolve(response(kind, 'OLD')); await older;
    assert.equal(r.calls.stopRefresh, 0);
    second.resolve(response(kind, 'NEW')); await newer;
    assert.equal(r.calls.stopRefresh, 1);
    r.page.onHide(); r.session.token = 'replacement-token'; r.session.user = { id: 44 };
    const updates = r.calls.updates.length, reads = r.reads.length;
    await refresh(r, kind);
    assert.equal(r.calls.updates.length, updates); assert.equal(r.reads.length, reads);
  }
});

test('the order center exposes no cashier, refund or payment-recovery action in either template', () => {
  for (const name of ['orders', 'order-detail']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/user', `${name}.ts`), 'utf8');
    const template = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/user', `${name}.wxml`), 'utf8');
    assert.doesNotMatch(source, /requestVirtualPayment|requestPayment|virtualPaymentQuery|createMembershipOrder|virtualPaymentCheckout/);
    assert.doesNotMatch(template, /继续支付|立即付款|申请退款|确认退款/);
  }
});
