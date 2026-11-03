const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function order(status = 'pending') {
  return { outTradeNo: 'HL_ORDER_20261103', planTitle: '月度VIP', productType: 'vip', amountFen: 10000,
    durationDays: 30, serviceCount: 0, status, fulfillmentStatus: status === 'paid' ? 'fulfilled' : '', paymentProvider: 'virtual',
    createdAt: '2026-11-03T00:00:00Z' };
}

test('cancellation page reads the original order and represents a late paid result without starting payment', async () => {
  const reads = [];
  const instance = runtime('pages/user/payment-cancel.js', { source: true,
    memberApi: { orderDetail: async id => { reads.push(id); return order('paid'); } } });
  instance.page.onLoad({ outTradeNo: order().outTradeNo });
  await instance.page.onShow();
  assert.deepEqual(reads, [order().outTradeNo]);
  assert.equal(instance.page.data.order.status, 'paid');
  assert.match(instance.page.data.order.resultText, /VIP权益已确认开通/);
  instance.page.openOrder();
  assert.equal(instance.calls.navigation.at(-1).url, `/pages/user/order-detail?outTradeNo=${order().outTradeNo}`);
  assert.equal(instance.calls.requests.length, 0);
});

test('cancellation page does not claim no debit when the order is pending or unavailable', async () => {
  let unavailable = false;
  const instance = runtime('pages/user/payment-cancel.js', { source: true,
    memberApi: { orderDetail: async () => { if (unavailable) throw new Error('offline'); return order(); } } });
  instance.page.onLoad({ outTradeNo: order().outTradeNo });
  await instance.page.onShow();
  assert.equal(instance.page.data.order.status, 'pending');
  assert.match(instance.page.data.order.resultText, /尚未确认/);
  unavailable = true;
  await instance.page.refresh();
  assert.equal(instance.page.data.order, null);
  assert.match(instance.page.data.errorText, /请勿重复付款/);
});

test('cancellation page discards delayed private order data after account change or hide', async () => {
  const pending = deferred();
  const instance = runtime('pages/user/payment-cancel.js', { source: true,
    memberApi: { orderDetail: () => pending.promise } });
  instance.page.onLoad({ outTradeNo: order().outTradeNo });
  const loading = instance.page.onShow();
  await flush();
  instance.page.onHide();
  instance.session.user = { id: 2 }; instance.session.token = 'next-session';
  pending.resolve(order('paid'));
  await loading;
  assert.equal(instance.page.data.order, null);
});

const sent = { id: 8, conversationId: 7, senderId: 1, receiverId: 2, content: '你好', contentType: 'text',
  createdAt: '2026-11-03T00:00:00Z', isMine: true, readStatus: 'unread', sender: { id: 1, nickname: '我' } };
function page(messages, receipts, canViewReadReceipts = true) {
  return { conversation: { id: 7, title: '测试', conversationType: 'member_pair', canViewReadReceipts, peer: { id: 2 } },
    messages, readReceipts: receipts, total: messages.length, hasMore: false, latestId: messages.at(-1)?.id || 0 };
}

test('VIP receipt updates existing messages even when an incremental refresh has no new messages', async () => {
  let reads = 0;
  const instance = runtime('pages/user/chat.js', { source: true, chatApi: {
    listMessages: async () => ++reads === 1 ? page([sent], []) : page([], [{ id: 8, readStatus: 'read' }])
  } });
  await instance.page.onLoad({ id: '7' });
  assert.equal(instance.page.data.messages[0].readStatus, 'unread');
  await instance.page.refreshNewMessages();
  assert.equal(instance.page.data.messages[0].readStatus, 'read');
  instance.page.openRelationship();
  assert.equal(instance.calls.navigation.at(-1).url, '/pages/user/relationship-status?targetUserId=2');
});

test('receipt visibility downgrade clears previously displayed statuses and ignores peer-message receipt data', async () => {
  let reads = 0;
  const instance = runtime('pages/user/chat.js', { source: true, chatApi: {
    listMessages: async () => ++reads === 1 ? page([sent, { ...sent, id: 9, isMine: false }], [])
      : page([], [{ id: 8, readStatus: 'read' }], false)
  } });
  await instance.page.onLoad({ id: '7' });
  assert.equal(instance.page.data.messages[1].readStatus, undefined);
  await instance.page.refreshNewMessages();
  assert.ok(instance.page.data.messages.every(message => message.readStatus === undefined));
});

test('VIP expiration during a conversation clears message data and presents the membership route', async () => {
  const instance = runtime('pages/user/chat.js', { source: true, chatApi: {
    listMessages: async () => { throw Object.assign(new Error('VIP required'), { code: 40302 }); }
  } });
  await instance.page.onLoad({ id: '7' });
  assert.equal(instance.page.data.membershipRequired, true);
  assert.equal(instance.page.data.messages.length, 0);
  instance.page.openMembership();
  assert.equal(instance.calls.navigation.at(-1).url, '/pages/user/membership');
});


test('cancellation page restarts an in-flight read under the new account and rejects mismatched orders', async () => {
  const first = deferred(); let reads = 0;
  const instance = runtime('pages/user/payment-cancel.js', { source: true, memberApi: {
    orderDetail: async () => ++reads === 1 ? first.promise : { ...order(), outTradeNo: 'HL_ANOTHER_ORDER' }
  } });
  instance.page.onLoad({ outTradeNo: order().outTradeNo });
  const pending = instance.page.onShow();
  await flush();
  instance.session.user = { id: 2 }; instance.session.token = 'next-session';
  await instance.page.onShow();
  first.resolve(order('paid'));
  await pending;
  assert.equal(reads, 2);
  assert.equal(instance.page.data.order, null);
  assert.equal(instance.page.data.loading, false);
  assert.match(instance.page.data.errorText, /暂未确认/);
});
