const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/miniprogram-runtime');

function overview(extra = {}) {
  return { isPremiumMember: false, phoneBound: true, phoneMasked: '', needsMatchmaker: false,
    membership: null, plans: [{ planCode: 'monthly', title: '月度会员', durationDays: 30, priceText: '100元' }],
    payment: { available: true, reason: '', functionName: 'test-payment', createPath: '/order' }, ...extra };
}

test('membership payment distinguishes server terminal outcomes after the payment sheet succeeds', async () => {
  for (const [status, expected] of [['paid', '会员已开通'], ['closed', '订单已关闭'], ['failed', '支付未成功'], ['refunded', '订单已退款']]) {
    const modals = [];
    let queries = 0;
    const { page } = runtime('pages/user/membership.js', { memberApi: {
      membershipOverview: async () => overview(),
      createMembershipOrder: async () => ({ order: { outTradeNo: `order-${status}` }, payment: {} }),
      membershipOrder: async () => { queries++; return { status }; }
    }, wx: { showModal: value => modals.push(value) } });
    await page.loadOverview();
    page.callPaymentFunction = async () => ({});
    page.requestPayment = async () => {};
    await page.startPayment();
    assert.equal(page.data.orderTitle, expected);
    assert.equal(modals.at(-1).title, expected);
    assert.equal(queries, 1, 'terminal results must not keep polling');
    assert.equal(page.data.confirming, false);
  }
});

test('unknown payment result retains a query path and avoids another charge attempt', async () => {
  let creates = 0;
  const { page } = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => overview(),
    membershipOrder: async () => ({ status: 'paid' }),
    createMembershipOrder: async () => { creates++; return {}; }
  } });
  await page.loadOverview();
  page.setData({ lastOrderId: 'pending-order', orderStatus: 'pending' });
  await page.showOrderResult({ status: 'pending' });
  assert.match(page.data.orderTitle, /确认中/);
  await page.startPayment();
  assert.equal(creates, 0);
  assert.equal(page.data.orderStatus, 'paid');
});

test('unavailable checkout presents assisted opening, while phone authorization remains available for ready plans', async () => {
  let current = overview({ plans: [], payment: { available: false, reason: 'plans_not_configured' } });
  const { page } = runtime('pages/user/membership.js', { memberApi: { membershipOverview: async () => current } });
  await page.loadOverview();
  assert.equal(page.data.onlineCheckout, false);
  assert.doesNotMatch(page.data.paymentActionText, /配置/);
  current = overview({ payment: { available: false, reason: 'phone_required' } });
  await page.loadOverview();
  assert.equal(page.data.onlineCheckout, true);
});

test('a pre-payment network failure resumes the same order instead of blocking forever or creating another', async () => {
  let creates = 0;
  let attempts = 0;
  const orderNumbers = [];
  const { page } = runtime('pages/user/membership.js', { memberApi: {
    membershipOverview: async () => overview(),
    createMembershipOrder: async () => { creates++; return { order: { outTradeNo: 'same-order', planTitle: '月度会员', amountFen: 10000 }, payment: {} }; },
    membershipOrder: async () => ({ status: 'paid' })
  } });
  await page.loadOverview();
  page.callPaymentFunction = async checkout => {
    orderNumbers.push(checkout.order.outTradeNo);
    if (++attempts === 1) throw new Error('network unavailable');
    return {};
  };
  page.requestPayment = async () => {};
  await page.startPayment();
  assert.equal(page.data.orderCanResume, true);
  assert.match(page.data.orderTitle, /尚未开始/);
  await page.startPayment();
  assert.equal(creates, 1);
  assert.deepEqual(orderNumbers, ['same-order', 'same-order']);
  assert.equal(page.data.orderTitle, '会员已开通');
  assert.equal(page.data.orderCanResume, false);
});

test('activity tabs separate expired, cancelled and future events without changing my registrations', async () => {
  const queries = [];
  const events = [
    { id: 1, title: '过往', status: 'upcoming', eventDate: '2026-01-01T10:00:00Z' },
    { id: 2, title: '未来', status: 'upcoming', eventDate: '2099-01-01T10:00:00Z' },
    { id: 3, title: '取消', status: 'cancelled', eventDate: '2099-01-02T10:00:00Z' }
  ];
  const { page } = runtime('pages/user/salon.js', { salonApi: {
    list: async query => { queries.push(query); return { list: events }; },
    myRegistrations: async () => ({ list: events.map(event => ({ event, status: 'registered' })) })
  } });
  await page.onShow();
  assert.deepEqual(Array.from(page.data.list, row => row.id), [2]);
  assert.equal(queries[0].period, 'upcoming');
  assert.match(page.data.list[0].eventDate, /周/);
  await page.loadPast();
  assert.deepEqual(Array.from(page.data.list, row => row.id), [3, 1]);
  assert.equal(queries[1].period, 'past');
  await page.loadMine();
  assert.equal(page.data.list.length, 3);
});

test('generic conversation names are distinguishable and failed avatars have a stable fallback', async () => {
  const { page } = runtime('pages/user/messages.js', { chatApi: {
    listConversations: async () => ({ total: 2, list: [31, 32].map(id => ({
      id, peer: { id: id + 100, nickname: '新用户', avatarUrl: 'invalid-image' },
      conversationType: 'member_matchmaker', unreadCount: 0, updatedAt: '2026-10-05', lastMessageContent: ''
    })) })
  } });
  await page.onShow();
  assert.notEqual(page.data.list[0].peerName, page.data.list[1].peerName);
  page.onConversationAvatarError({ currentTarget: { dataset: { id: 31 } } });
  assert.equal(page.data.list[0].peerAvatar, '');
  assert.ok(page.data.list[0].avatarInitial);
  assert.equal(page.data.list[1].peerAvatar, 'invalid-image');
});
