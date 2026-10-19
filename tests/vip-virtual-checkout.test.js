const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { VIP_COLLECTIONS } = require('../cloudfunctions/hlApi/vip-membership-service');
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const CALLBACK = 'isolated-vip-checkout-callback-fixture-not-a-real-secret';
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };
const fullProfile = { realName: '测试会员', gender: 1, age: 30, height: 175, city: '杭州', nativePlace: '浙江',
  education: '本科', occupation: '职员', incomeRange: '10k', maritalStatus: '未婚', houseStatus: '有房',
  carStatus: '有车', selfIntro: '喜欢旅行', partnerRequirement: '诚恳', photos: ['/assets/fixture.png'], displayEnabled: true,
  updatedAt: '2026-10-12T00:00:00.000Z' };
function runtime(options = {}) {
  const writes = [], queries = [], deliveries = [], loginCalls = [], providerOrders = new Map();
  const rows = {
    hl_users: [1, 2, 4].map(id => ({ _id: `user_${id}`, id, status: 1, authVersion: 1,
      openid: `fixture-openid-${id}`, phone: `1380013800${id}`, nickname: `测试${id}`, gender: 1,
      currentRole: id === 4 ? 'matchmaker' : 'user' })),
    hl_members: options.unassigned ? [] : [{ _id: 'member_11', id: 11, userId: 1, matchmakerId: 21,
      status: 1, memberType: 'free', expireAt: null }],
    hl_profiles: [1, 2].map(id => ({ _id: `profile_${id}`, id, userId: id, ...fullProfile })),
    hl_matchmakers: [{ _id: 'matchmaker_21', id: 21, userId: 4, status: 1, certificationStatus: 2 }],
    hl_membership_plans: [],
    ...(options.rows || {})
  };
  let transactionTail = Promise.resolve();
  const operation = (kind, value) => ({ $operation: kind, value });
  function valueMatches(actual, expected) {
    if (!expected || typeof expected !== 'object' || !expected.$operation) return actual === expected;
    if (expected.$operation === 'in') return expected.value.includes(actual);
    if (expected.$operation === 'neq') return actual !== expected.value;
    if (expected.$operation === 'eq') return actual === expected.value;
    if (expected.$operation === 'gte') return actual >= expected.value;
    if (expected.$operation === 'gt') return actual > expected.value;
    if (expected.$operation === 'lte') return actual <= expected.value;
    if (expected.$operation === 'lt') return actual < expected.value;
    throw new Error(`Unsupported fixture value operation ${expected.$operation}`);
  }
  function matches(row, query) {
    if (!query) return true;
    if (query.$operation === 'or') return query.value.some(item => matches(row, item));
    if (query.$operation === 'and') return query.value.every(item => matches(row, item));
    return Object.entries(query).every(([field, expected]) => valueMatches(row[field], expected));
  }
  function collection(name) {
    const query = { where: null, skip: 0, limit: 100, order: [] };
    const ref = {
      where(value) { query.where = value; return ref; },
      skip(value) { query.skip = value; return ref; },
      limit(value) { query.limit = value; return ref; },
      field() { return ref; },
      orderBy(field, direction) { query.order.push([field, direction]); return ref; },
      async count() { return { total: (rows[name] || []).filter(row => matches(row, query.where)).length }; },
      async get() {
        let result = (rows[name] || []).filter(row => matches(row, query.where));
        for (const [field, direction] of query.order.reverse()) result = [...result].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
        return { data: structuredClone(result.slice(query.skip, query.skip + query.limit)) };
      },
      async add({ data }) {
        writes.push({ collection: name, operation: 'add', data: structuredClone(data) });
        const saved = { ...structuredClone(data), _id: `added_${name}_${data.id}` };
        (rows[name] ||= []).push(saved); return { _id: saved._id };
      },
      doc(id) {
        return {
          async get() {
            const row = (rows[name] || []).find(row => row._id === String(id));
            if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            writes.push({ collection: name, operation: 'set', id, data: structuredClone(data) });
            assert.equal(Object.hasOwn(data, '_id'), false, 'CloudBase system _id is not writable');
            const list = rows[name] ||= [], index = list.findIndex(row => row._id === String(id));
            const saved = { ...structuredClone(data), _id: String(id) };
            if (index < 0) list.push(saved); else list[index] = saved;
          },
          async update({ data }) {
            writes.push({ collection: name, operation: 'update', id, data: structuredClone(data) });
            assert.equal(Object.hasOwn(data, '_id'), false);
            const row = (rows[name] || []).find(row => row._id === String(id));
            if (!row) throw new Error('fixture update missing document');
            for (const [field, value] of Object.entries(data)) row[field] = value && value.$operation === 'inc'
              ? Number(row[field] || 0) + value.value : structuredClone(value);
          },
          async remove() { writes.push({ collection: name, operation: 'remove', id }); rows[name] = (rows[name] || []).filter(row => row._id !== String(id)); }
        };
      }
    };
    return ref;
  }
  const db = { collection, command: Object.fromEntries(['in', 'neq', 'eq', 'gte', 'gt', 'lte', 'lt', 'inc', 'or', 'and'].map(kind => [kind, value => operation(kind, value)])),
    async createCollection() {},
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
        const saved = structuredClone(rows);
        try { return await callback({ collection: name => ({ doc: id => collection(name).doc(id) }) }); }
        catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); throw error; }
      });
      transactionTail = run.catch(() => {}); return run;
    } };
  const env = { NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false', AUTO_CREATE_COLLECTIONS: 'false',
    PAYMENT_INTEGRATION_READY: 'true', MATCHMAKING_PAYMENT_READY: 'true', VIP_MEMBERSHIP_CATALOG_READY: 'true',
    PAYMENT_FUNCTION_NAME: 'fixture-service-payment-bridge', PAYMENT_CREATE_PATH: '/fixture/create', PAYMENT_QUERY_PATH: '/fixture/query',
    PAYMENT_CALLBACK_TOKEN: CALLBACK, VPAY_ENV: '0', VPAY_OFFER_ID: '1450674507',
    VPAY_APP_KEY: 'isolated-vip-integration-app-key-fixture-not-a-real-secret',
    WX_APP_SECRET: 'isolated-vip-integration-app-secret-fixture-not-a-real-secret', ...(options.env || {}) };
  const virtualClient = {
    async code2session(_secret, code) {
      loginCalls.push(code);
      if (options.beforeLoginResult) options.beforeLoginResult(rows, env);
      return { openid: options.loginOpenid || 'fixture-openid-1', sessionKey: 'fixture-session-key-01234567890123456789' };
    },
    async accessToken() { return 'fixture-access-token-01234567890123456789'; },
    async queryOrder(input) {
      queries.push(structuredClone(input));
      if (options.beforeProviderQuery) options.beforeProviderQuery(rows, env);
      return structuredClone(providerOrders.get(input.outTradeNo) || null);
    },
    async notifyProvideGoods(input) { deliveries.push(structuredClone(input)); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership, vipMembership };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'fixture-openid-1' }),
        callFunction() { throw new Error('network calls forbidden in VIP integration tests'); } };
      if (name === './virtual-payment-policy') return { ...requireFromApi(name), createVirtualPaymentClient: () => virtualClient };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'isolated-vip-jwt-fixture-not-a-real-secret' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const internal = (action, data) => module.exports.main({ path: `/internal/payment-orders/${action}`, method: 'POST', data: { callbackToken: CALLBACK, ...identity, ...data } });
  const call = (route, method = 'GET', data = {}, user = 1) => module.exports.main({ path: route, method, data,
    token: user ? module.exports.__test.tokenService.sign({ userId: user, authVersion: 1 }, { type: 'access' }) : '' });
  return { rows, env, call, internal, writes, queries, deliveries, loginCalls, providerOrders,
    push: event => module.exports.main(event, { request_id: 'fixture-refund-push-request' }),
    checkout: (order, data = {}, user = 1) => call('/member/payment-virtual/checkout', 'POST', { outTradeNo: order.outTradeNo, loginCode: 'fixture-login-code-0123456789', ...data }, user),
    query: order => call('/member/payment-virtual/query', 'POST', { outTradeNo: order.outTradeNo }),
    service: module.exports.__test.vipMembership,
    async confirm(order, extra = {}) { return internal('confirm', { outTradeNo: order.outTradeNo, payerOpenid: `fixture-openid-${order.userId}`,
      amountFen: order.amountFen, transactionId: `fixture_tx_${order.id}`, tradeState: 'SUCCESS', successTime: new Date().toISOString(), ...extra }); },
    async create(planCode) { const result = await call('/member/payment-orders', 'POST', { planCode }); assert.equal(result.code, 0, result.message); return result.data.order; } };
}

function notPaid(attemptNo) {
  return { order_id: attemptNo, env_type: 1, status: 1 };
}

function paid(attemptNo, amountFen) {
  return { order_id: attemptNo, env_type: 1, status: 2, order_type: 0,
    order_fee: amountFen, paid_fee: amountFen, paid_time: Math.floor(Date.now() / 1000),
    wxpay_order_id: 'fixture-paid-vip-checkout-transaction-001' };
}

function assertCashier(result, order) {
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.order.outTradeNo, order.outTradeNo);
  assert.equal(result.data.order.productType, order.productType);
  assert.equal(result.data.virtualPayment.mode, 'short_series_goods');
  const signed = JSON.parse(result.data.virtualPayment.signData);
  assert.equal(signed.outTradeNo, result.data.paymentAttemptNo);
  assert.equal(signed.productId, order.planCode);
  assert.equal(signed.goodsPrice, order.amountFen);
  assert.equal(signed.buyQuantity, 1);
  assert.equal(signed.env, 0);
  assert.equal(signed.currencyType, 'CNY');
  assert.match(result.data.virtualPayment.paySig, /^[a-f0-9]{64}$/);
  assert.match(result.data.virtualPayment.signature, /^[a-f0-9]{64}$/);
  return result.data.paymentAttemptNo;
}

test('unassigned VIP opens a cashier, recovers NOTPAY to a new attempt, and fulfils exactly once after provider SUCCESS', async () => {
  const r = runtime({ unassigned: true });
  const order = await r.create('vip_week');
  assert.equal(order.amountFen, 6160);
  const firstNo = assertCashier(await r.checkout(order, { amountFen: 1, productId: 'untrusted-product' }), order);
  r.providerOrders.set(firstNo, notPaid(firstNo));
  const unpaid = await r.query(order);
  assert.equal(unpaid.code, 0, unpaid.message);
  assert.equal(unpaid.data.tradeState, 'NOTPAY');
  assert.equal(unpaid.data.order.status, 'confirming');
  assert.equal((await r.service.getEntitlement(1)).membershipTier, 'free');

  const secondNo = assertCashier(await r.checkout(order), order);
  assert.notEqual(secondNo, firstNo);
  assert.equal(r.rows.hl_payment_orders.length, 1);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 2);
  r.providerOrders.set(secondNo, paid(secondNo, order.amountFen));
  for (let i = 0; i < 2; i += 1) {
    const settled = await r.query(order);
    assert.equal(settled.code, 0, settled.message);
    assert.equal(settled.data.tradeState, 'SUCCESS');
    assert.equal(settled.data.order.status, 'paid');
    assert.equal(settled.data.order.fulfillmentStatus, 'fulfilled');
  }
  const rights = await r.service.getEntitlement(1);
  assert.equal(rights.membershipTier, 'vip');
  assert.equal(rights.entitlements.chat, true);
  const record = r.rows[VIP_COLLECTIONS.entitlements][0];
  assert.equal(record.grants.length, 1);
  assert.equal(Date.parse(record.expireAt) - Date.parse(record.grants[0].grantedAt), 7 * 86400000);
  assert.equal(r.rows.hl_members.length, 0);
  assert.equal(r.writes.filter(write => write.collection === 'hl_members').length, 0);
  assert.deepEqual(r.deliveries.map(item => item.outTradeNo), [secondNo]);
  assert.ok(r.queries.every(input => input.openid === 'fixture-openid-1'));
  assert.ok(r.queries.some(input => input.outTradeNo === firstNo));
  assert.ok(r.queries.some(input => input.outTradeNo === secondNo));
  assert.equal(r.rows.hl_counters.filter(row => row.key?.startsWith('virtualPaymentAttempt_')).length, 2);
  const checkoutAfterPaid = await r.checkout(order);
  assert.notEqual(checkoutAfterPaid.code, 0);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 2);
  assert.equal(r.deliveries.length, 1);
});

test('VIP continuation survives a removed or reassigned matchmaker relationship without modifying that relationship', async () => {
  for (const change of ['removed', 'reassigned']) {
    const r = runtime();
    const order = await r.create('vip_month');
    const firstNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(firstNo, notPaid(firstNo));
    if (change === 'removed') r.rows.hl_members = [];
    else Object.assign(r.rows.hl_members[0], { matchmakerId: 999, status: 0 });
    const membersBefore = structuredClone(r.rows.hl_members);
    const writeCount = r.writes.length;
    const secondNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(secondNo, paid(secondNo, order.amountFen));
    const settled = await r.query(order);
    assert.equal(settled.code, 0, settled.message);
    assert.equal(settled.data.order.fulfillmentStatus, 'fulfilled');
    assert.equal((await r.service.getEntitlement(1)).membershipTier, 'vip');
    assert.deepEqual(r.rows.hl_members, membersBefore);
    assert.equal(r.writes.slice(writeCount).filter(write => write.collection === 'hl_members').length, 0);
  }
});

test('VIP relationship independence preserves login identity, account status and phone checks before every cashier', async () => {
  const mismatch = runtime({ unassigned: true, loginOpenid: 'fixture-openid-2' });
  const mismatchOrder = await mismatch.create('vip_week');
  assert.equal((await mismatch.checkout(mismatchOrder)).code, 40304);
  assert.equal(mismatch.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 0);

  for (const patch of [{ phone: '' }, { status: 0 }, { mergedIntoUserId: 2 }, { openid: 'fixture-openid-2' }]) {
    const r = runtime({ unassigned: true });
    const order = await r.create('vip_week');
    const firstNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(firstNo, notPaid(firstNo));
    Object.assign(r.rows.hl_users[0], patch);
    const writeCount = r.writes.length;
    const checkout = await r.checkout(order);
    assert.notEqual(checkout.code, 0, `changed user ${JSON.stringify(patch)} must not open a cashier`);
    assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 1);
    assert.equal(r.writes.length, writeCount);
    assert.equal(r.deliveries.length, 0);
    assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).some(row => row.grants?.length), false);
  }
});

test('VIP never falls back to a JSAPI bridge or an undefined/mismatched provider snapshot', async () => {
  const normal = runtime({ unassigned: true });
  const order = await normal.create('vip_week');
  const before = normal.writes.length;
  const jsapi = await normal.internal('checkout', { outTradeNo: order.outTradeNo, requesterOpenid: 'fixture-openid-1' });
  assert.notEqual(jsapi.code, 0);
  assert.equal(normal.writes.length, before);
  for (const provider of [undefined, 'jsapi', 'unknown']) {
    const r = runtime({ unassigned: true });
    const vip = await r.create('vip_week');
    r.rows.hl_payment_orders[0].paymentProvider = provider;
    const writeCount = r.writes.length;
    assert.notEqual((await r.checkout(vip)).code, 0);
    const bridge = await r.internal('checkout', { outTradeNo: vip.outTradeNo, requesterOpenid: 'fixture-openid-1' });
    assert.notEqual(bridge.code, 0, `VIP provider ${String(provider)} must never open JSAPI`);
    assert.equal(r.writes.length, writeCount);
    assert.equal(r.loginCalls.length, 0);
    assert.equal(r.queries.length, 0);
  }
});

test('approved matchmaking opens a virtual cashier and grants the standalone package once', async () => {
  const r = runtime();
  const readiness = await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
  assert.equal(readiness.code, 0, readiness.message);
  assert.equal(readiness.data.ready, true);
  const order = await r.create('matchmaking_month_6');
  assert.equal(order.productType, 'matchmaking');
  assert.equal(r.rows.hl_payment_orders[0].paymentProvider, 'virtual');
  const before = r.writes.length;
  assert.notEqual((await r.internal('checkout', { outTradeNo: order.outTradeNo,
    requesterOpenid: 'fixture-openid-1', paymentProvider: 'jsapi' })).code, 0);
  assert.equal(r.writes.length, before);
  assert.equal(r.loginCalls.length, 0);
  assert.equal(r.queries.length, 0);
  assert.equal(r.deliveries.length, 0);
  const attemptNo = assertCashier(await r.checkout(order), order);
  r.providerOrders.set(attemptNo, paid(attemptNo, order.amountFen));
  const memberBefore = structuredClone(r.rows.hl_members);
  const [first, second] = await Promise.all([r.query(order), r.query(order)]);
  assert.equal(first.code, 0, first.message);
  assert.equal(second.code, 0, second.message);
  const packages = await r.service.packages(1);
  assert.equal(packages.total, 1);
  assert.equal(packages.list[0].remainingCount, 6);
  assert.equal(Date.parse(packages.list[0].expireAt) - Date.parse(packages.list[0].startAt), 30 * 86400000);
  assert.deepEqual(r.rows.hl_members, memberBefore);
  assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).some(row => row.grants?.length), false);
});

async function readyMatchmaking(r) {
  const response = await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
  assert.equal(response.code, 0, response.message);
}

test('unassigned incomplete user completes a manual virtual cashier, late query and idempotent delivery', async () => {
  for (const [planCode, count] of [['matchmaking_double', 2], ['matchmaking_month_6', 6]]) {
    const r = runtime({ unassigned: true });
    r.rows.hl_profiles[0].selfIntro = '';
    const order = await r.create(planCode);
    const attemptNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(attemptNo, notPaid(attemptNo));
    const retryNo = assertCashier(await r.checkout(order), order);
    assert.notEqual(retryNo, attemptNo);
    r.providerOrders.set(retryNo, paid(retryNo, order.amountFen));
    r.env.MATCHMAKING_PAYMENT_READY = 'false';
    const result = await r.query(order);
    assert.equal(result.code, 0, result.message);
    assert.equal(result.data.order.fulfillmentStatus, 'fulfilled');
    assert.equal((await r.service.packages(1)).list[0].remainingCount, count);
    assert.equal(r.rows.hl_members.length, 0);
    assert.equal((await r.query(order)).code, 0);
    assert.equal((await r.service.packages(1)).total, 1);
    assert.equal((await r.call('/member/membership-plans')).data.pendingOrder, null);
  }
});

test('new direct virtual retries and fulfillment do not depend on current principal readiness', async () => {
  for (const change of ['profile', 'assignment', 'curator']) {
    const r = runtime();
    const order = await r.create('matchmaking_double');
    const attemptNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(attemptNo, notPaid(attemptNo));
    if (change === 'profile') r.rows.hl_profiles[0].updatedAt = 'changed-after-order';
    if (change === 'assignment') r.rows.hl_members.length = 0;
    if (change === 'curator') r.rows.hl_matchmakers[0].certificationStatus = 0;
    const retryNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(retryNo, paid(retryNo, order.amountFen));
    const result = await r.query(order);
    assert.equal(result.code, 0, result.message);
    assert.equal(result.data.order.fulfillmentStatus, 'fulfilled');
    assert.equal((await r.service.packages(1)).list[0].totalCount, 2);
  }
});

test('both matching virtual products retain exact price, period, credits and provider snapshots', async () => {
  for (const [planCode, amountFen, durationDays, serviceCount] of [
    ['matchmaking_double', 298000, 30, 2], ['matchmaking_month_6', 698000, 30, 6]
  ]) {
    const r = runtime();
    await readyMatchmaking(r);
    const response = await r.call('/member/payment-orders', 'POST', { planCode, paymentProvider: 'jsapi',
      amountFen: 1, serviceCount: 999, durationDays: 1, productType: 'vip' });
    assert.equal(response.code, 0, response.message);
    const order = response.data.order;
    assert.equal(response.data.payment.provider, 'virtual');
    assert.equal(order.paymentProvider, 'virtual');
    assert.equal(order.productType, 'matchmaking');
    assert.equal(order.amountFen, amountFen);
    assert.equal(order.durationDays, durationDays);
    assert.equal(order.serviceCount, serviceCount);
    assert.equal(order.virtualPaymentOfferId, r.env.VPAY_OFFER_ID);
    assert.equal(order.virtualPaymentEnv, 0);
    const attemptNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(attemptNo, paid(attemptNo, amountFen));
    const delivered = await r.query(order);
    assert.equal(delivered.code, 0, delivered.message);
    const packageRow = (await r.service.packages(1)).list[0];
    assert.equal(packageRow.totalCount, serviceCount);
    assert.equal(packageRow.remainingCount, serviceCount);
    assert.equal(Date.parse(packageRow.expireAt) - Date.parse(packageRow.startAt), durationDays * 86400000);
    assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  }
});

test('matching virtual gate and credential requirements fail closed independently and cannot use the VIP test bypass', async () => {
  for (const env of [{ MATCHMAKING_PAYMENT_READY: 'false' }, { VPAY_APP_KEY: '' }, { VPAY_OFFER_ID: '' },
    { WX_APP_SECRET: '' }, { VPAY_ENV: '' }]) {
    const r = runtime({ env });
    await readyMatchmaking(r);
    const overview = await r.call('/member/membership-plans');
    assert.equal(overview.code, 0, overview.message);
    assert.equal(overview.data.matchmakingPayment.provider, 'virtual');
    assert.equal(overview.data.matchmakingPayment.available, false);
    assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'matchmaking_month_6' })).code, 50301);
    assert.equal((r.rows.hl_payment_orders || []).length, 0);
    assert.equal(r.loginCalls.length, 0);
  }
  const r = runtime({ env: { PAYMENT_INTEGRATION_READY: 'false', MATCHMAKING_PAYMENT_READY: 'true' } });
  await readyMatchmaking(r);
  const overview = await r.call('/member/membership-plans');
  assert.equal(overview.data.payment.available, false);
  assert.equal(overview.data.matchmakingPayment.available, true);
  const order = await r.create('matchmaking_month_6');
  r.env.MATCHMAKING_PAYMENT_READY = 'false';
  assert.equal((await r.checkout(order)).code, 50301);
  assert.equal(r.loginCalls.length, 0, 'closed gate must stop before a login exchange');
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 0);
  const controlled = runtime({ env: { PAYMENT_INTEGRATION_READY: 'false', MATCHMAKING_PAYMENT_READY: 'false',
    PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: '1',
    PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() } });
  await readyMatchmaking(controlled);
  const testOverview = await controlled.call('/member/membership-plans');
  assert.equal(testOverview.data.payment.testMode, true);
  assert.equal(testOverview.data.matchmakingPayment.available, false);
  assert.equal((await controlled.call('/member/payment-orders', 'POST', { planCode: 'matchmaking_month_6' })).code, 50301);
  assert.equal((controlled.rows.hl_payment_orders || []).length, 0);
});

test('historical unmarked matching retries retain readiness requirements and changed service review', async () => {
  for (const change of ['profile', 'confirmation', 'assignment', 'curator']) {
    const r = runtime();
    await readyMatchmaking(r);
    const order = await r.create('matchmaking_month_6');
    delete r.rows.hl_payment_orders.find(row => row.outTradeNo === order.outTradeNo).fulfillmentContract;
    const attemptNo = assertCashier(await r.checkout(order), order);
    r.providerOrders.set(attemptNo, notPaid(attemptNo));
    if (change === 'profile') r.rows.hl_profiles[0].updatedAt = 'new-profile-version';
    if (change === 'confirmation') r.rows[VIP_COLLECTIONS.matchmakingReadiness][0].confirmed = false;
    if (change === 'assignment') r.rows.hl_members[0].matchmakerId = 99;
    if (change === 'curator') r.rows.hl_matchmakers[0].certificationStatus = 0;
    assert.notEqual((await r.checkout(order)).code, 0, `${change} must stop another cashier`);
    assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 1);
    r.providerOrders.set(attemptNo, paid(attemptNo, order.amountFen));
    r.env.MATCHMAKING_PAYMENT_READY = 'false';
    const settled = await r.query(order);
    assert.equal(settled.code, 0, settled.message);
    assert.equal(settled.data.order.status, 'paid');
    assert.equal(settled.data.order.fulfillmentStatus, 'requires_review');
    assert.equal((await r.service.packages(1)).total, 0);
    assert.equal(r.deliveries.length, 0);
  }
});

test('JSAPI internal query, confirmation, close and refund cannot cross into a matching virtual order', async () => {
  const r = runtime();
  await readyMatchmaking(r);
  const order = await r.create('matchmaking_month_6');
  const evidence = { outTradeNo: order.outTradeNo, paymentProvider: 'jsapi', requesterOpenid: 'fixture-openid-1',
    payerOpenid: 'fixture-openid-1', amountFen: order.amountFen, transactionId: 'fixture-cross-provider-transaction',
    tradeState: 'SUCCESS', providerVerified: true, refundId: 'fixture-cross-provider-refund', refundAmountFen: order.amountFen };
  const initial = structuredClone(r.rows);
  for (const action of ['query', 'confirm', 'close', 'refund']) {
    const response = await r.internal(action, { ...evidence,
      tradeState: action === 'close' ? 'CLOSED' : action === 'refund' ? 'REFUND' : 'SUCCESS' });
    assert.equal(response.code, 40907, `${action} must reject the wrong provider`);
  }
  assert.deepEqual(r.rows, initial);
  assert.equal(r.queries.length, 0);
  assert.equal((await r.internal('query', { ...evidence, paymentProvider: 'unknown' })).code, 40907);
});

test('historical matching JSAPI orders keep original recovery, late fulfillment and full refund with cashiers closed', async () => {
  for (const [planCode, amountFen, durationDays, serviceCount] of [
    ['matchmaking_month', 698000, 30, 2], ['matchmaking_quarter', 1980000, 90, 8],
    ['matchmaking_halfyear', 2980000, 180, 16]
  ]) {
  for (const paymentProvider of ['jsapi', undefined]) {
    const order = { _id: 'historic_matching_99', id: 99, outTradeNo: 'HLM_historic_matching_99',
      userId: 1, memberRecordId: 11, memberMatchmakerId: 21, payerOpenid: 'fixture-openid-1', ...identity,
      planCode, planTitle: '历史人工牵线套餐', amountFen, durationDays,
      serviceCount, productType: 'matchmaking', status: 'confirming', transactionId: '', paymentProvider };
    const r = runtime({ rows: { hl_payment_orders: [order] } });
    await readyMatchmaking(r);
    const recovered = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_month' });
    assert.equal(recovered.code, 0, recovered.message);
    assert.equal(recovered.data.order.outTradeNo, order.outTradeNo);
    assert.equal(recovered.data.payment.provider, 'jsapi');
    assert.equal(recovered.data.payment.available, false);
    assert.equal(recovered.data.payment.createPath, '');
    r.env.PAYMENT_INTEGRATION_READY = 'false';
    r.env.MATCHMAKING_PAYMENT_READY = 'false';
    const overview = await r.call('/member/membership-plans');
    assert.equal(overview.data.pendingOrderPayment.provider, 'jsapi');
    assert.equal(overview.data.pendingOrderPayment.available, false);
    assert.equal(overview.data.pendingOrderPayment.functionName, r.env.PAYMENT_FUNCTION_NAME);
    assert.equal(overview.data.pendingOrderPayment.queryPath, r.env.PAYMENT_QUERY_PATH);
    const queried = await r.internal('query', { outTradeNo: order.outTradeNo,
      requesterOpenid: 'fixture-openid-1' });
    assert.equal(queried.code, 0, queried.message);
    assert.deepEqual(r.rows.hl_payment_orders[0], order);
    assert.notEqual((await r.checkout(order)).code, 0);
    const confirmed = await r.confirm(order);
    assert.equal(confirmed.code, 0, confirmed.message);
    assert.equal(confirmed.data.order.fulfillmentStatus, 'fulfilled');
    const packageRow = (await r.service.packages(1)).list[0];
    assert.equal(packageRow.remainingCount, serviceCount);
    assert.equal(Date.parse(packageRow.expireAt) - Date.parse(packageRow.startAt), durationDays * 86400000);
    const refunded = await r.internal('refund', { outTradeNo: order.outTradeNo,
      payerOpenid: 'fixture-openid-1', amountFen: order.amountFen, transactionId: `fixture_tx_${order.id}`,
      tradeState: 'REFUND', providerVerified: true, refundId: 'fixture-historic-jsapi-refund', refundAmountFen: order.amountFen });
    assert.equal(refunded.code, 0, refunded.message);
    assert.equal((await r.service.packages(1)).list[0].remainingCount, 0);
    assert.equal(r.rows.hl_payment_orders[0].paymentProvider, paymentProvider);
    assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts, undefined);
    assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
    assert.equal(r.queries.length, 0);
  }
  }
});

test('retired virtual cashiers cannot issue fresh attempts but existing attempts query, fulfill late and refund original terms', async () => {
  for (const [planCode, amountFen, durationDays, serviceCount] of [
    ['matchmaking_month', 698000, 30, 2], ['matchmaking_quarter', 1980000, 90, 8],
    ['matchmaking_halfyear', 2980000, 180, 16], ['matchmaking_single', 298000, 30, 1],
    ['matchmaking_month_3', 698000, 30, 3]
  ]) {
    for (const hasIssuedAttempt of [false, true]) {
      const attemptNo = 'HLA_historical_matching_99';
      const order = { _id: 'historic_virtual_matching_99', id: 99, outTradeNo: 'HLM_historic_virtual_99',
        userId: 1, memberRecordId: 11, memberMatchmakerId: 21, payerOpenid: 'fixture-openid-1', ...identity,
        planCode, planTitle: '历史人工牵线套餐', amountFen, durationDays, serviceCount, productType: 'matchmaking',
        status: hasIssuedAttempt ? 'confirming' : 'pending', transactionId: '', paymentProvider: 'virtual',
        virtualPaymentEnv: 0, virtualPaymentOfferId: '1450674507', virtualPaymentAttempts: hasIssuedAttempt
          ? [{ outTradeNo: attemptNo, env: 0, offerId: '1450674507', createdAt: new Date().toISOString() }] : [] };
      const r = runtime({ rows: { hl_payment_orders: [order], hl_counters: hasIssuedAttempt
        ? [{ _id: `virtualPaymentAttempt_${attemptNo}`, key: `virtualPaymentAttempt_${attemptNo}`,
          orderDocumentId: order._id, businessOutTradeNo: order.outTradeNo, env: 0, offerId: '1450674507' }] : [] } });
      await readyMatchmaking(r);
      if (hasIssuedAttempt) r.providerOrders.set(attemptNo, notPaid(attemptNo));
      const before = structuredClone(r.rows.hl_payment_orders[0]);
      const writeCount = r.writes.length;
      assert.equal((await r.checkout(order)).code, 40905, `${planCode} must not issue another cashier`);
      assert.equal((await r.internal('checkout', { outTradeNo: order.outTradeNo,
        requesterOpenid: 'fixture-openid-1', paymentProvider: 'virtual' })).code, 40905);
      assert.equal(r.loginCalls.length, 0);
      assert.equal(r.writes.length, writeCount);
      assert.deepEqual(r.rows.hl_payment_orders[0], before);
      const unpaid = await r.query(order);
      assert.equal(unpaid.code, 0, unpaid.message);
      if (hasIssuedAttempt) assert.equal(unpaid.data.tradeState, 'NOTPAY');
      else assert.equal(unpaid.data.order.status, 'pending');
      const overview = await r.call('/member/membership-plans');
      assert.equal(overview.code, 0, overview.message);
      assert.equal(overview.data.pendingOrder.outTradeNo, order.outTradeNo);
      assert.equal(overview.data.pendingOrderPayment.provider, 'virtual');
      assert.equal(overview.data.pendingOrderPayment.available, false);
      assert.equal(overview.data.pendingOrderPayment.reason, 'retired_plan_query_required');
      const recovered = await r.call('/member/payment-orders', 'POST', { planCode: 'matchmaking_month_6' });
      assert.equal(recovered.code, 0, recovered.message);
      assert.equal(recovered.data.recoveryRequired, true);
      assert.equal(recovered.data.order.planCode, planCode);
      assert.equal(recovered.data.order.serviceCount, serviceCount);
      assert.equal(recovered.data.order.amountFen, amountFen);
      assert.equal(recovered.data.order.durationDays, durationDays);
      assert.equal(recovered.data.payment.provider, 'virtual');
      assert.equal(recovered.data.payment.available, false);
      assert.equal(r.rows.hl_payment_orders.length, 1);
      if (!hasIssuedAttempt) continue;
      r.env.PAYMENT_INTEGRATION_READY = 'false';
      r.env.MATCHMAKING_PAYMENT_READY = 'false';
      r.providerOrders.set(attemptNo, paid(attemptNo, amountFen));
      const event = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: 'fixture-openid-1',
        OutTradeNo: attemptNo, Env: 0, GoodsInfo: { ProductId: planCode, Quantity: 1, ActualPrice: amountFen } };
      assert.equal((await r.push(event)).ErrCode, 0);
      const fulfilled = await r.query(order);
      assert.equal(fulfilled.code, 0, fulfilled.message);
      assert.equal(fulfilled.data.order.fulfillmentStatus, 'fulfilled');
      assert.equal((await r.push(event)).ErrCode, 0);
      const packages = await r.service.packages(1);
      assert.equal(packages.total, 1);
      assert.equal(packages.list[0].totalCount, serviceCount);
      assert.equal(Date.parse(packages.list[0].expireAt) - Date.parse(packages.list[0].startAt), durationDays * 86400000);
      assert.equal(r.rows.hl_payment_orders[0].amountFen, amountFen);
      assert.equal(r.rows.hl_payment_orders[0].planCode, planCode);
      assert.equal(r.rows.hl_payment_orders[0].serviceCount, serviceCount);
      assert.equal(r.rows.hl_payment_orders[0].durationDays, durationDays);
      assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
      r.providerOrders.set(attemptNo, refundProvider(attemptNo, amountFen));
      assert.equal((await r.push(refundPush(attemptNo))).ErrCode, 0);
      assert.equal((await r.service.packages(1)).list[0].remainingCount, 0);
      const savedPackage = r.rows[VIP_COLLECTIONS.matchmakingPackages].find(row => row.orderNo === order.outTradeNo);
      assert.equal(savedPackage.originalTotalCount, serviceCount);
      assert.equal(savedPackage.planCode, planCode);
      assert.equal(r.rows.hl_payment_orders[0].serviceCount, serviceCount);
      assert.equal(r.rows.hl_payment_orders[0].durationDays, durationDays);
    }
  }
});

test('matching virtual delivery push verifies product and grants once; full refund removes only unused credits', async () => {
  const r = runtime();
  await readyMatchmaking(r);
  const order = await r.create('matchmaking_month_6');
  const attemptNo = assertCashier(await r.checkout(order), order);
  const event = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: 'fixture-openid-1',
    OutTradeNo: attemptNo, Env: 0, GoodsInfo: { ProductId: order.planCode, Quantity: 1, ActualPrice: order.amountFen } };
  r.providerOrders.set(attemptNo, paid(attemptNo, order.amountFen));
  assert.notEqual((await r.push({ ...event, GoodsInfo: { ...event.GoodsInfo, ProductId: 'vip_month' } })).ErrCode, 0);
  assert.equal(r.queries.length, 0);
  assert.equal((await r.push(event)).ErrCode, 0);
  assert.equal((await r.push(event)).ErrCode, 0);
  const packages = await r.service.packages(1);
  assert.equal(packages.total, 1);
  const packageRow = r.rows[VIP_COLLECTIONS.matchmakingPackages].find(row => row.orderNo === order.outTradeNo);
  packageRow.usedCount = 1;
  r.env.MATCHMAKING_PAYMENT_READY = 'false';
  r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen));
  assert.equal((await r.push(refundPush(attemptNo))).ErrCode, 0);
  assert.equal((await r.query(order)).data.order.status, 'refunded');
  const refunded = (await r.service.packages(1)).list[0];
  assert.equal(refunded.usedCount, 1);
  assert.equal(refunded.remainingCount, 0);
  assert.equal(packageRow.originalTotalCount, 6);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  assert.equal(r.deliveries.length, 1);
});

async function buyVip(r, planCode = 'vip_week') {
  const order = await r.create(planCode);
  const attemptNo = assertCashier(await r.checkout(order), order);
  r.providerOrders.set(attemptNo, paid(attemptNo, order.amountFen));
  const result = await r.query(order);
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.order.fulfillmentStatus, 'fulfilled');
  return { order, attemptNo };
}

function refundProvider(attemptNo, amountFen, extra = {}) {
  return { ...paid(attemptNo, amountFen), status: 5, left_fee: 0, ...extra };
}

function refundPush(attemptNo, extra = {}) {
  return { MsgType: 'event', Event: 'xpay_refund_notify', MchOrderId: attemptNo,
    OpenId: 'fixture-openid-1', Env: 0, ...extra };
}

for (const planCode of ['vip_week', 'matchmaking_month_6']) {
  test(`Apple ${planCode} delivery and verified original-payment refund are idempotent and preserve other rights`, async () => {
    const vip = planCode === 'vip_week';
    const r = runtime({ unassigned: vip });
    if (!vip) await readyMatchmaking(r);
    const order = await r.create(planCode);
    const attemptNo = assertCashier(await r.checkout(order), order);
    const appleOrder = { ...paid(attemptNo, order.amountFen), order_type: 7, wxpay_order_id: '',
      channel_order_id: `apple-original-${planCode}-transaction-001` };
    r.providerOrders.set(attemptNo, appleOrder);
    // Apple deliveries may omit the WeChatPayInfo object. All financial
    // evidence still comes from the original payment queried server-side.
    const event = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: 'fixture-openid-1',
      OutTradeNo: attemptNo, Env: 0, GoodsInfo: { ProductId: planCode, Quantity: 1, ActualPrice: order.amountFen } };
    assert.equal((await r.push(event)).ErrCode, 0);
    assert.equal((await r.push(event)).ErrCode, 0);
    const settled = await r.query(order);
    assert.equal(settled.code, 0, settled.message);
    assert.equal(settled.data.order.transactionId, appleOrder.channel_order_id);
    assert.equal(settled.data.order.status, 'paid');
    assert.equal(settled.data.order.fulfillmentStatus, 'fulfilled');
    assert.equal(r.deliveries.length, 1);
    const other = await buyVip(r, 'vip_month');
    const otherGrant = structuredClone(r.rows[VIP_COLLECTIONS.entitlements][0].grants
      .find(grant => grant.orderNo === other.order.outTradeNo));
    let purchasedPackage;
    if (vip) {
      assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants.length, 2);
    } else {
      purchasedPackage = r.rows[VIP_COLLECTIONS.matchmakingPackages].find(row => row.orderNo === order.outTradeNo);
      assert.equal(purchasedPackage.totalCount, 6);
      purchasedPackage.usedCount = 1;
    }
    r.providerOrders.set(attemptNo, { ...appleOrder, status: 8, left_fee: 0 });
    const refunded = await r.push(refundPush(attemptNo, { Attach: planCode,
      WxTransactionId: appleOrder.channel_order_id, RetCode: 0, RefundFee: order.amountFen }));
    assert.equal(refunded.ErrCode, 0, refunded.ErrMsg);
    const queriedRefund = await r.query(order);
    assert.equal(queriedRefund.code, 0, queriedRefund.message);
    assert.equal(queriedRefund.data.order.status, 'refunded');
    assert.notEqual(queriedRefund.data.tradeState, 'SUCCESS');
    const retainedGrant = r.rows[VIP_COLLECTIONS.entitlements][0].grants
      .find(grant => grant.orderNo === other.order.outTradeNo);
    for (const field of ['orderNo', 'durationDays', 'grantedAt', 'status']) {
      assert.equal(retainedGrant[field], otherGrant[field]);
    }
    assert.equal(Date.parse(retainedGrant.expireAt) - Date.parse(retainedGrant.startAt), 30 * 86400000);
    assert.equal((await r.service.getEntitlement(1)).membershipTier, 'vip');
    if (vip) {
      assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants
        .find(grant => grant.orderNo === order.outTradeNo).status, 'refunded');
    } else {
      const refundedPackage = r.rows[VIP_COLLECTIONS.matchmakingPackages].find(row => row.orderNo === order.outTradeNo);
      assert.equal(refundedPackage.status, 'refunded');
      assert.equal(refundedPackage.usedCount, 1);
      assert.equal(refundedPackage.refundedCount, 5);
      assert.equal(refundedPackage.totalCount, 1);
    }
    const writeCount = r.writes.length;
    assert.equal((await r.push(refundPush(attemptNo))).ErrCode, 0);
    assert.equal(r.writes.length, writeCount);
    assert.equal(r.deliveries.length, 2);
  });
}

test('verified full virtual refund states 5 and 8 revoke only the paid grant and repeated query stays refunded without SUCCESS', async () => {
  for (const status of [5, 8]) {
    const r = runtime({ unassigned: true });
    const { order, attemptNo } = await buyVip(r);
    r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen, { status }));
    const first = await r.query(order);
    assert.equal(first.code, 0, first.message);
    assert.equal(first.data.providerRefunded, true);
    assert.equal(first.data.order.status, 'refunded');
    assert.notEqual(first.data.tradeState, 'SUCCESS');
    assert.equal(first.data.order.refundAmountFen, order.amountFen);
    assert.equal((await r.service.getEntitlement(1)).membershipTier, 'free');
    const record = r.rows[VIP_COLLECTIONS.entitlements][0];
    assert.equal(record.grants.length, 1);
    assert.equal(record.grants[0].status, 'refunded');
    const refundedRecord = structuredClone(record);
    const writes = r.writes.length;
    const repeated = await r.query(order);
    assert.equal(repeated.code, 0, repeated.message);
    assert.equal(repeated.data.order.status, 'refunded');
    assert.notEqual(repeated.data.tradeState, 'SUCCESS');
    assert.deepEqual(r.rows[VIP_COLLECTIONS.entitlements][0], refundedRecord);
    assert.equal(r.writes.length, writes);
    assert.equal(r.deliveries.length, 1);
    assert.equal(r.writes.filter(write => write.collection === 'hl_members').length, 0);
  }
});

test('refund of one virtual VIP order preserves a later purchased grant', async () => {
  const r = runtime({ unassigned: true });
  const first = await buyVip(r);
  const second = await buyVip(r, 'vip_month');
  r.providerOrders.set(first.attemptNo, refundProvider(first.attemptNo, first.order.amountFen));
  const refunded = await r.query(first.order);
  assert.equal(refunded.code, 0, refunded.message);
  const grants = r.rows[VIP_COLLECTIONS.entitlements][0].grants;
  assert.equal(grants.find(item => item.orderNo === first.order.outTradeNo).status, 'refunded');
  assert.equal(grants.find(item => item.orderNo === second.order.outTradeNo).status, 'active');
  assert.equal((await r.service.getEntitlement(1)).membershipTier, 'vip');
  assert.equal(r.rows.hl_payment_orders.find(row => row.outTradeNo === second.order.outTradeNo).status, 'paid');
  assert.equal(r.deliveries.length, 2);
});

function weeklySandboxRuntime(options = {}) {
  return runtime({ unassigned: true, ...options, env: {
    PAYMENT_INTEGRATION_READY: 'false', MATCHMAKING_PAYMENT_READY: 'false', VPAY_ENV: '1',
    VPAY_SANDBOX_APP_KEY: 'isolated-week-sandbox-key-fixture-not-a-real-secret',
    PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: '1', PAYMENT_TEST_PLAN_CODE: 'vip_week',
    PAYMENT_TEST_RUN_ID: 'week_20261013', PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    ...(options.env || {})
  } });
}
function assertWeeklyCashier(result, order) {
  assert.equal(result.code, 0, result.message);
  const signed = JSON.parse(result.data.virtualPayment.signData);
  assert.deepEqual([signed.productId, signed.goodsPrice, signed.buyQuantity, signed.env], ['vip_week', 6160, 1, 1]);
  assert.equal(result.data.order.outTradeNo, order.outTradeNo);
  assert.match(result.data.virtualPayment.paySig, /^[a-f0-9]{64}$/);
  return result.data.paymentAttemptNo;
}

test('weekly sandbox exposes one exact product to its account, ignores client scope, and concurrent creates reserve one order without a matchmaker', async () => {
  const r = weeklySandboxRuntime();
  const overview = await r.call('/member/membership-plans');
  assert.equal(overview.data.needsMatchmaker, true);
  assert.equal(overview.data.payment.testMode, true);
  assert.equal(overview.data.payment.available, true);
  assert.equal(overview.data.matchmakingPayment.available, false);
  assert.deepEqual(Array.from(overview.data.plans, p => [p.planCode, p.amountFen, p.durationDays, p.productType]),
    [['vip_week', 6160, 7, 'vip']]);
  assert.equal((await r.call('/member/membership-plans', 'GET', {}, 2)).data.payment.available, false);
  for (const [planCode, user] of [['vip_month', 1], ['matchmaking_double', 1], ['hl_payment_probe', 1], ['vip_week', 2]]) {
    assert.notEqual((await r.call('/member/payment-orders', 'POST', { planCode }, user)).code, 0);
  }
  const results = await Promise.all([r.call('/member/payment-orders', 'POST', { planCode: 'vip_week', amountFen: 1,
    durationDays: 1, productType: 'matchmaking', serviceCount: 999, PAYMENT_TEST_RUN_ID: 'client_run', PAYMENT_TEST_PLAN_CODE: 'vip_month' }),
    r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' })]);
  assert.ok(results.every(result => result.code === 0));
  assert.equal(results[0].data.order.outTradeNo, results[1].data.order.outTradeNo);
  assert.equal(r.rows.hl_payment_orders.length, 1);
  const saved = r.rows.hl_payment_orders[0];
  assert.deepEqual([saved._id, saved.amountFen, saved.durationDays, saved.productType, saved.memberRecordId,
    saved.paymentTestPlanCode, saved.paymentTestRunId],
  ['payment_probe_user_1_run_week_20261013', 6160, 7, 'vip', 0, 'vip_week', 'week_20261013']);
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, saved._id);
  assert.ok(!JSON.stringify(results[0].data).includes('week_20261013'));
  assert.equal(r.env.PAYMENT_INTEGRATION_READY, 'false'); assert.equal(r.env.MATCHMAKING_PAYMENT_READY, 'false');
});

test('weekly sandbox push-only test grants an unassigned account seven independent VIP days exactly once and closes the batch after success', async () => {
  const r = weeklySandboxRuntime({ env: { PAYMENT_TEST_PUSH_ONLY: 'true' } });
  const order = await r.create('vip_week');
  const attemptNo = assertWeeklyCashier(await r.checkout(order), order);
  r.providerOrders.set(attemptNo, { ...paid(attemptNo, 6160), env_type: 2 });
  const queryCount = r.queries.length;
  const local = await r.query(order);
  assert.equal(local.data.tradeState, 'NOTPAY'); assert.equal(r.queries.length, queryCount);
  assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).length, 0);
  const event = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: 'fixture-openid-1',
    OutTradeNo: attemptNo, Env: 1, GoodsInfo: { ProductId: 'vip_week', Quantity: 1, ActualPrice: 6160 } };
  assert.equal((await r.push(event)).ErrCode, 0); assert.equal((await r.push(event)).ErrCode, 0);
  const record = r.rows[VIP_COLLECTIONS.entitlements][0];
  assert.equal(record.grants.length, 1); assert.equal(record.grants[0].durationDays, 7);
  assert.equal(record.grants[0].orderNo, order.outTradeNo);
  assert.equal(Date.parse(record.expireAt) - Date.parse(record.grants[0].startAt), 7 * 86400000);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
  assert.equal(r.rows.hl_members.length, 0);
  assert.equal(r.writes.filter(write => write.collection === 'hl_members').length, 0);
  assert.equal(r.rows.hl_payment_orders[0].confirmationSource, 'wechat_push');
  const writes = r.writes.length;
  assert.notEqual((await r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' })).code, 0);
  assert.equal(r.writes.length, writes); assert.equal(r.rows.hl_payment_orders.length, 1);
  const completed = await r.call('/member/membership-plans');
  assert.equal(completed.data.payment.available, false); assert.equal(completed.data.plans.length, 0);
  assert.equal(r.env.PAYMENT_INTEGRATION_READY, 'false'); assert.equal(r.env.MATCHMAKING_PAYMENT_READY, 'false');
});

test('weekly sandbox terminal batches cannot archive or replace even trusted closed or refunded records', async () => {
  for (const status of ['closed', 'failed', 'refunded', 'paid']) {
    const r = weeklySandboxRuntime();
    await r.create('vip_week');
    Object.assign(r.rows.hl_payment_orders[0], { status, tradeState: status === 'closed' ? 'CLOSED' : '',
      ...(status === 'paid' ? { transactionId: 'fixture-final-week-transaction', fulfillmentStatus: 'fulfilled' } : {}) });
    Object.assign(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1'), { orderDocumentId: '', blockedReviewDocumentId: '' });
    const before = structuredClone(r.rows), writes = r.writes.length;
    assert.notEqual((await r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' })).code, 0);
    assert.deepEqual(r.rows, before); assert.equal(r.writes.length, writes);
    const overview = await r.call('/member/membership-plans');
    assert.equal(overview.data.payment.available, false); assert.equal(overview.data.plans.length, 0);
  }
});

test('weekly sandbox adds seven days to the existing independent expiry and preserves permanent eligibility', async () => {
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  for (const lifetime of [false, true]) {
    const r = weeklySandboxRuntime({ rows: { [VIP_COLLECTIONS.entitlements]: [{ _id: 'vip_user_1', userId: 1,
      legacyLifetime: lifetime, legacyExpireAt: lifetime ? null : expiry, lifetime,
      expireAt: lifetime ? null : expiry, grants: [], createdAt: new Date().toISOString() }] } });
    const order = await r.create('vip_week');
    const attemptNo = assertWeeklyCashier(await r.checkout(order), order);
    r.providerOrders.set(attemptNo, { ...paid(attemptNo, 6160), env_type: 2 });
    assert.equal((await r.query(order)).data.order.fulfillmentStatus, 'fulfilled');
    const record = r.rows[VIP_COLLECTIONS.entitlements][0];
    assert.equal(record.grants.length, 1); assert.equal(record.grants[0].durationDays, 7);
    assert.equal(record.lifetime, lifetime);
    assert.equal(record.expireAt, lifetime ? null : new Date(Date.parse(expiry) + 7 * 86400000).toISOString());
    assert.equal(r.rows.hl_members.length, 0);
  }
});

test('modified weekly test snapshots cannot open another cashier or fulfill an already-signed payment', async () => {
  for (const patch of [{ amountFen: 1 }, { durationDays: 1 }, { planTitle: '微信支付测试' },
    { productType: 'matchmaking' }, { membershipTier: undefined }, { serviceCount: 1 },
    { paymentTestRunId: undefined }, { paymentTestPlanCode: undefined }]) {
    const r = weeklySandboxRuntime();
    const order = await r.create('vip_week');
    const attemptNo = assertWeeklyCashier(await r.checkout(order), order);
    Object.assign(r.rows.hl_payment_orders[0], patch);
    const count = r.writes.length;
    assert.notEqual((await r.checkout(order)).code, 0);
    assert.equal(r.writes.length, count);
    r.providerOrders.set(attemptNo, { ...paid(attemptNo, 6160), env_type: 2 });
    assert.notEqual((await r.query(order)).code, 0);
    assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).length, 0);
    assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
    assert.equal(r.writes.length, count);
  }
});

test('weekly expiry forbids a fresh attempt but the issued sandbox payment can query, fulfill and refund seven-day rights idempotently', async () => {
  const r = weeklySandboxRuntime();
  const order = await r.create('vip_week');
  const attemptNo = assertWeeklyCashier(await r.checkout(order), order);
  r.env.PAYMENT_TEST_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  const count = r.writes.length, logins = r.loginCalls.length;
  assert.notEqual((await r.checkout(order)).code, 0);
  assert.notEqual((await r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' })).code, 0);
  assert.equal(r.writes.length, count); assert.equal(r.loginCalls.length, logins);
  r.providerOrders.set(attemptNo, { ...paid(attemptNo, 6160), env_type: 2 });
  assert.equal((await r.query(order)).data.order.fulfillmentStatus, 'fulfilled');
  assert.equal((await r.query(order)).data.order.fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants.length, 1);
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants[0].durationDays, 7);
  r.providerOrders.set(attemptNo, refundProvider(attemptNo, 6160, { env_type: 2 }));
  assert.equal((await r.query(order)).data.order.status, 'refunded');
  assert.equal((await r.query(order)).data.order.status, 'refunded');
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants[0].status, 'refunded');
  assert.equal(r.rows.hl_members.length, 0);
});

test('changing the weekly operator batch preserves the unpaid original slot and forbids signing it under the new batch', async () => {
  const r = weeklySandboxRuntime();
  const order = await r.create('vip_week');
  const saved = structuredClone(r.rows.hl_payment_orders[0]);
  r.env.PAYMENT_TEST_RUN_ID = 'week_second_batch';
  const recovered = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' });
  assert.equal(recovered.code, 0, recovered.message); assert.equal(recovered.data.recoveryRequired, true);
  assert.equal(recovered.data.order.outTradeNo, order.outTradeNo);
  assert.equal(recovered.data.payment.available, false); assert.equal(recovered.data.payment.reason, 'historical_test_query_required');
  assert.equal((await r.call('/member/membership-plans')).data.pendingOrderPayment.available, false);
  const count = r.writes.length;
  assert.notEqual((await r.checkout(order)).code, 0); assert.equal(r.writes.length, count);
  assert.deepEqual(r.rows.hl_payment_orders[0], saved);
  assert.equal(r.rows.hl_payment_orders.length, 1);
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, saved._id);
  assert.equal(r.loginCalls.length, 0);
});

test('a full-price ordinary weekly order cannot borrow the test account window but stays ordinary under formal readiness', async () => {
  const normal = { _id: 'payment_order_normal_week', id: 99, outTradeNo: 'HLM_normal_week_99', userId: 1,
    memberRecordId: 0, payerOpenid: 'fixture-openid-1', ...identity, planCode: 'vip_week', planTitle: 'VIP周卡',
    productType: 'vip', membershipTier: 'vip', amountFen: 6160, durationDays: 7, paymentProvider: 'virtual',
    virtualPaymentEnv: 1, virtualPaymentOfferId: '1450674507', virtualPaymentAttempts: [], status: 'pending' };
  const r = weeklySandboxRuntime({ rows: { hl_payment_orders: [normal] } });
  const count = r.writes.length;
  assert.notEqual((await r.checkout(normal)).code, 0); assert.equal(r.writes.length, count);
  assert.equal(r.loginCalls.length, 0);
  r.env.PAYMENT_TEST_ENABLED = 'false'; r.env.PAYMENT_INTEGRATION_READY = 'true';
  assertWeeklyCashier(await r.checkout(normal), normal);
});

test('weekly checkout rechecks batch, selected product, deadline and formal flags after the login and provider-query boundaries', async () => {
  for (const boundary of ['beforeLoginResult', 'beforeProviderQuery']) {
    for (const patch of [{ PAYMENT_TEST_RUN_ID: 'another_batch' }, { PAYMENT_TEST_PLAN_CODE: undefined },
      { PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() },
      { PAYMENT_INTEGRATION_READY: 'true' }, { MATCHMAKING_PAYMENT_READY: 'true' }]) {
      let armed = false;
      const r = weeklySandboxRuntime({ [boundary](_rows, env) { if (armed) Object.assign(env, patch); } });
      const order = await r.create('vip_week');
      if (boundary === 'beforeProviderQuery') {
        const first = assertWeeklyCashier(await r.checkout(order), order);
        r.providerOrders.set(first, { ...notPaid(first), env_type: 2 });
      }
      const before = structuredClone(r.rows.hl_payment_orders[0]), count = r.writes.length;
      armed = true;
      assert.notEqual((await r.checkout(order)).code, 0, `${boundary}: ${Object.keys(patch)[0]}`);
      assert.equal(r.writes.length, count); assert.deepEqual(r.rows.hl_payment_orders[0], before);
    }
  }
});

test('old one-fen sandbox orders keep query, delayed one-day fulfillment and refund when the active product is weekly', async () => {
  const attemptNo = 'HLA_old_probe_attempt';
  const old = { _id: 'payment_probe_user_1_run_old_probe', id: 99, outTradeNo: 'HLM_old_probe_99',
    userId: 1, memberRecordId: 11, memberMatchmakerId: 21, payerOpenid: 'fixture-openid-1', ...identity,
    planCode: 'hl_payment_probe', planTitle: '微信支付测试', amountFen: 1, durationDays: 1,
    paymentProvider: 'virtual', virtualPaymentEnv: 1, virtualPaymentOfferId: '1450674507',
    virtualPaymentAttempts: [{ outTradeNo: attemptNo, env: 1, offerId: '1450674507', createdAt: new Date().toISOString() }],
    status: 'confirming', transactionId: '', fulfillmentStatus: '' };
  const r = weeklySandboxRuntime({ unassigned: false, rows: { hl_payment_orders: [old] } });
  r.providerOrders.set(attemptNo, { ...notPaid(attemptNo), env_type: 2 });
  const recovered = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_week' });
  assert.equal(recovered.code, 0, recovered.message); assert.equal(recovered.data.order.planCode, 'hl_payment_probe');
  assert.equal(recovered.data.payment.available, false);
  assert.equal((await r.query(old)).data.tradeState, 'NOTPAY');
  assert.notEqual((await r.checkout(old)).code, 0);
  r.env.PAYMENT_TEST_ENABLED = 'false'; r.env.PAYMENT_TEST_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  r.providerOrders.set(attemptNo, { ...paid(attemptNo, 1), env_type: 2 });
  const fulfilled = await r.query(old);
  assert.equal(fulfilled.code, 0, fulfilled.message); assert.equal(fulfilled.data.order.fulfillmentStatus, 'fulfilled');
  assert.equal((await r.query(old)).data.order.amountFen, 1);
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants.length, 1);
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants[0].durationDays, 1);
  r.providerOrders.set(attemptNo, refundProvider(attemptNo, 1, { env_type: 2 }));
  assert.equal((await r.query(old)).data.order.status, 'refunded');
  assert.equal((await r.query(old)).data.order.status, 'refunded');
  assert.equal(r.rows.hl_payment_orders.length, 1); assert.equal(r.rows.hl_payment_orders[0].durationDays, 1);
});

test('missing, partial, or malformed remaining-fee proof preserves VIP and flags the paid order for review', async () => {
  for (const leftFee of [undefined, 1, -1, '0']) {
    const r = runtime({ unassigned: true });
    const { order, attemptNo } = await buyVip(r);
    const before = structuredClone(r.rows[VIP_COLLECTIONS.entitlements][0]);
    r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen, { left_fee: leftFee }));
    const result = await r.query(order);
    assert.equal(result.code, 40907, result.message);
    assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
    assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'requires_review');
    assert.equal(r.rows.hl_payment_orders[0].paymentReviewRequired, true);
    assert.equal(r.rows.hl_payment_orders[0].reviewReason, 'virtual_refund_proof_missing');
    assert.deepEqual(r.rows[VIP_COLLECTIONS.entitlements][0], before);
    assert.equal((await r.service.getEntitlement(1)).membershipTier, 'vip');
    assert.equal(r.deliveries.length, 1);
    const push = await r.push(refundPush(attemptNo, { RefundFee: order.amountFen, RetCode: 0 }));
    assert.notEqual(push.ErrCode, 0);
    assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  }
});

test('refund query with a different transaction, amount, environment or attempt cannot revoke VIP', async () => {
  for (const patch of [{ wxpay_order_id: 'fixture-other-refund-transaction-001' },
    { order_fee: 1 }, { paid_fee: 1 }, { env_type: 2 }, { order_id: 'fixture-other-refund-attempt-001' }]) {
    const r = runtime({ unassigned: true });
    const { order, attemptNo } = await buyVip(r);
    const before = structuredClone(r.rows[VIP_COLLECTIONS.entitlements][0]);
    r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen, patch));
    assert.notEqual((await r.query(order)).code, 0);
    assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
    assert.deepEqual(r.rows[VIP_COLLECTIONS.entitlements][0], before);
    assert.equal((await r.service.getEntitlement(1)).membershipTier, 'vip');
    assert.equal(r.deliveries.length, 1);
  }
});

test('refund push treats fees and return codes as untrusted and ACKs only a platform-verified full refund', async () => {
  const r = runtime({ unassigned: true });
  const { order, attemptNo } = await buyVip(r);
  const before = structuredClone(r.rows[VIP_COLLECTIONS.entitlements][0]);
  const queryCount = r.queries.length;
  const forged = await r.push(refundPush(attemptNo, {
    RefundFee: order.amountFen, RetCode: 0, RefundId: 'forged-refund-id-001', RefundStatus: 'SUCCESS' }));
  assert.notEqual(forged.ErrCode, 0);
  assert.ok(r.queries.length > queryCount, 'a callback must query the platform rather than trust its financial fields');
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.deepEqual(r.rows[VIP_COLLECTIONS.entitlements][0], before);
  r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen, { status: 8 }));
  const verified = await r.push(refundPush(attemptNo, {
    RefundFee: 1, RetCode: 12345, RefundId: 'untrusted-monetary-fields-ignored' }));
  assert.equal(verified.ErrCode, 0, verified.ErrMsg);
  assert.equal(r.rows.hl_payment_orders[0].status, 'refunded');
  assert.equal(r.rows.hl_payment_orders[0].refundAmountFen, order.amountFen);
  assert.equal(r.rows.hl_payment_orders[0].refundId, `vpay_refund_${attemptNo}`);
  assert.equal((await r.service.getEntitlement(1)).membershipTier, 'free');
  const repeated = await r.push(refundPush(attemptNo));
  assert.equal(repeated.ErrCode, 0, repeated.ErrMsg);
  assert.equal(r.deliveries.length, 1);
});

test('refund push rejects an unknown attempt, another payer or another environment before querying the platform', async () => {
  for (const patch of [{ MchOrderId: 'fixture-unknown-refund-attempt-001' },
    { OpenId: 'fixture-openid-2' }, { Env: 1 }, { MchOrderId: undefined }]) {
    const r = runtime({ unassigned: true });
    const { order, attemptNo } = await buyVip(r);
    r.providerOrders.set(attemptNo, refundProvider(attemptNo, order.amountFen));
    const before = structuredClone(r.rows[VIP_COLLECTIONS.entitlements][0]);
    const queryCount = r.queries.length;
    const result = await r.push(refundPush(attemptNo, patch));
    assert.notEqual(result.ErrCode, 0);
    assert.equal(r.queries.length, queryCount);
    assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
    assert.deepEqual(r.rows[VIP_COLLECTIONS.entitlements][0], before);
  }
});

test('refund of the original attempt keeps duplicate paid money in review and cannot release the user order slot', async () => {
  const r = runtime({ unassigned: true });
  const order = await r.create('vip_week');
  const firstNo = assertCashier(await r.checkout(order), order);
  r.providerOrders.set(firstNo, notPaid(firstNo));
  const secondNo = assertCashier(await r.checkout(order), order);
  r.providerOrders.set(firstNo, paid(firstNo, order.amountFen));
  r.providerOrders.set(secondNo, { ...paid(secondNo, order.amountFen),
    wxpay_order_id: 'fixture-second-paid-transaction-002' });
  assert.equal((await r.query(order)).code, 40908);
  assert.equal(r.rows.hl_payment_orders[0].duplicateVirtualPayments.length, 1);
  r.providerOrders.set(firstNo, refundProvider(firstNo, order.amountFen));
  await r.query(order);
  assert.equal(r.rows.hl_payment_orders[0].paymentReviewRequired, true);
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'requires_review');
  const overview = await r.call('/member/membership-plans');
  assert.equal(overview.code, 0, overview.message);
  assert.equal(overview.data.pendingOrder?.outTradeNo, order.outTradeNo,
    'a second verified payment remains unresolved until its own refund is reviewed');
  const callback = await r.push(refundPush(firstNo));
  assert.notEqual(callback.ErrCode, 0, 'original-attempt refund must not ACK a business order with unresolved duplicate payment');
  const next = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_month' });
  assert.equal(next.code, 0, next.message);
  assert.equal(next.data.recoveryRequired, true);
  assert.equal(next.data.order.outTradeNo, order.outTradeNo);
});
