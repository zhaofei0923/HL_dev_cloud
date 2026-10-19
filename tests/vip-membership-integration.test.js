const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { VIP_COLLECTIONS, DEFAULT_MEMBERSHIP_PLANS } = require('../cloudfunctions/hlApi/vip-membership-service');
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const CALLBACK = 'isolated-vip-integration-callback-fixture-not-a-real-secret';
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };
const fullProfile = { realName: '测试会员', gender: 1, age: 30, height: 175, city: '杭州', nativePlace: '浙江',
  education: '本科', occupation: '职员', incomeRange: '10k', maritalStatus: '未婚', houseStatus: '有房',
  carStatus: '有车', selfIntro: '喜欢旅行', partnerRequirement: '诚恳', photos: ['/assets/fixture.png'], displayEnabled: true,
  updatedAt: '2026-10-12T00:00:00.000Z' };
function runtime(options = {}) {
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
        const saved = { ...structuredClone(data), _id: `added_${name}_${data.id}` };
        (rows[name] ||= []).push(saved); return { _id: saved._id };
      },
      doc(id) {
        return {
          async get() {
            const row = (rows[name] || []).find(row => row._id === String(id));
            if (!row) {
              if (options.sdkMissingDocument) {
                const errMsg = `document.get:fail document with _id ${id} does not exist`;
                throw Object.assign(new Error(errMsg), { errMsg });
              }
              throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            }
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            assert.equal(Object.hasOwn(data, '_id'), false, 'CloudBase system _id is not writable');
            const list = rows[name] ||= [], index = list.findIndex(row => row._id === String(id));
            const saved = { ...structuredClone(data), _id: String(id) };
            if (index < 0) list.push(saved); else list[index] = saved;
          },
          async update({ data }) {
            assert.equal(Object.hasOwn(data, '_id'), false);
            const row = (rows[name] || []).find(row => row._id === String(id));
            if (!row) throw new Error('fixture update missing document');
            for (const [field, value] of Object.entries(data)) row[field] = value && value.$operation === 'inc'
              ? Number(row[field] || 0) + value.value : structuredClone(value);
          },
          async remove() { rows[name] = (rows[name] || []).filter(row => row._id !== String(id)); }
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
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership, vipMembership };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'fixture-openid-1' }),
        callFunction() { throw new Error('network calls forbidden in VIP integration tests'); } };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'isolated-vip-jwt-fixture-not-a-real-secret' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const internal = (action, data) => module.exports.main({ path: `/internal/payment-orders/${action}`, method: 'POST', data: {
    callbackToken: CALLBACK, ...identity,
    paymentProvider: rows.hl_payment_orders?.find(order => order.outTradeNo === data.outTradeNo)?.paymentProvider || 'jsapi', ...data } });
  const call = (route, method = 'GET', data = {}, user = 1) => module.exports.main({ path: route, method, data,
    token: user ? module.exports.__test.tokenService.sign({ userId: user, authVersion: 1 }, { type: 'access' }) : '' });
  return { rows, env, call, internal, service: module.exports.__test.vipMembership,
    async confirm(order, extra = {}) { return internal('confirm', { outTradeNo: order.outTradeNo, payerOpenid: `fixture-openid-${order.userId}`,
      amountFen: order.amountFen, transactionId: `fixture_tx_${order.id}`, tradeState: 'SUCCESS', successTime: new Date().toISOString(), ...extra }); },
    async create(planCode) { const result = await call('/member/payment-orders', 'POST', { planCode }); assert.equal(result.code, 0, result.message); return result.data.order; } };
}

test('API catalog exposes six confirmed prices, independent product types, and fails closed before catalog readiness', async () => {
  const r = runtime({ unassigned: true });
  const overview = await r.call('/member/membership-plans');
  assert.equal(overview.code, 0, overview.message);
  assert.deepEqual(Array.from(overview.data.plans, plan => plan.amountFen), [6160, 19800, 39800, 69800, 298000, 698000]);
  assert.equal(overview.data.payment.provider, 'virtual');
  assert.equal(overview.data.payment.available, true);
  assert.equal(overview.data.matchmakingPayment.available, true);
  const held = runtime({ unassigned: true, env: { VIP_MEMBERSHIP_CATALOG_READY: 'false' } });
  const heldOverview = await held.call('/member/membership-plans');
  assert.equal(heldOverview.data.plans.length, 6);
  assert.equal(heldOverview.data.payment.available, false);
  assert.notEqual((await held.call('/member/payment-orders', 'POST', { planCode: 'vip_week' })).code, 0);
});

test('API unseeded ledger reads accept the real SDK missing-document message while preserving legacy VIP', async () => {
  const r = runtime({ sdkMissingDocument: true });
  const free = await r.call('/member/vip/overview');
  assert.equal(free.code, 0, free.message);
  assert.equal(free.data.membershipTier, 'free');
  assert.equal(free.data.privacy.invisible, false);
  assert.equal(free.data.matchmakingPackages.length, 0);
  assert.equal((await r.call('/member/vip/privacy')).code, 0);
  assert.equal((await r.call('/member/matchmaking/packages')).data.total, 0);
  r.rows.hl_members[0].memberType = 'paid';
  r.rows.hl_members[0].expireAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const legacy = await r.call('/member/vip/overview');
  assert.equal(legacy.code, 0, legacy.message);
  assert.equal(legacy.data.isPremiumMember, true);
  assert.equal(legacy.data.source, 'legacy');
  assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).length, 0);
});

test('unassigned member can buy VIP and trusted confirmation grants user rights without touching assignments', async () => {
  const r = runtime({ unassigned: true });
  const order = await r.create('vip_week');
  assert.equal(order.productType, 'vip'); assert.equal(order.amountFen, 6160);
  const confirmed = await r.confirm(order);
  assert.equal(confirmed.code, 0, confirmed.message);
  assert.equal(confirmed.data.order.fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows.hl_members.length, 0);
  const entitlement = await r.service.getEntitlement(1);
  assert.equal(entitlement.membershipTier, 'vip');
  const record = r.rows[VIP_COLLECTIONS.entitlements][0];
  assert.equal(Date.parse(record.expireAt) - Date.parse(record.grants[0].grantedAt), 7 * 86400000);
  await r.confirm(order);
  assert.equal(record.grants.length, 1);
});

test('purchase rejects spoofed frontend price and uses the saved product snapshot', async () => {
  const r = runtime({ unassigned: true });
  const result = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_month', amountFen: 1, durationDays: 3650, productType: 'matchmaking', serviceCount: 999 });
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.order.amountFen, 19800);
  assert.equal(result.data.order.durationDays, 30);
  assert.equal(result.data.order.productType, 'vip');
  const wrong = await r.confirm(result.data.order, { amountFen: 1 });
  assert.notEqual(wrong.code, 0);
  assert.equal((r.rows[VIP_COLLECTIONS.entitlements] || []).length, 0);
});

test('artificial-service direct purchase grants credits without prior readiness or VIP/assignment changes', async () => {
  const r = runtime();
  const originalMember = structuredClone(r.rows.hl_members[0]);
  const order = await r.create('matchmaking_month_6');
  assert.equal(order.serviceCount, 6); assert.equal(order.amountFen, 698000);
  assert.equal(order.productType, 'matchmaking');
  assert.equal(order.fulfillmentContract, 'user_entitlement_v1');
  const confirmed = await r.confirm(order);
  assert.equal(confirmed.code, 0, confirmed.message);
  assert.deepEqual(r.rows.hl_members[0], originalMember);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  assert.equal((await r.service.packages(1)).list[0].remainingCount, 6);
});

test('unassigned incomplete users buy both manual plans and receive user-owned credits plus service progress', async () => {
  for (const [planCode, count] of [['matchmaking_double', 2], ['matchmaking_month_6', 6]]) {
    const r = runtime({ unassigned: true });
    r.rows.hl_profiles[0].selfIntro = '';
    const overview = await r.call('/member/membership-plans');
    assert.equal(overview.data.matchmakingReadiness.ready, false);
    assert.equal(overview.data.matchmakingPayment.available, true);
    const order = await r.create(planCode);
    assert.equal(order.fulfillmentContract, 'user_entitlement_v1');
    const confirmed = await r.confirm(order);
    assert.equal(confirmed.code, 0, confirmed.message);
    assert.equal(confirmed.data.order.fulfillmentStatus, 'fulfilled');
    assert.equal(r.rows.hl_members.length, 0);
    assert.equal((await r.service.packages(1)).list[0].remainingCount, count);
    const after = await r.call('/member/membership-plans');
    assert.equal(after.data.pendingOrder, null, 'waiting for a principal must not retain the payment slot');
    assert.equal(after.data.matchmakingProgress.purchased, true);
    assert.equal(after.data.matchmakingProgress.status, 'needs_profile');
    const intake = r.rows[VIP_COLLECTIONS.matchmakingReadiness].find(row => row.kind === 'service_intake');
    assert.deepEqual(Array.from(intake.orderNos), [order.outTradeNo]);
    assert.equal((await r.confirm(order)).data.idempotent, true);
    assert.equal((await r.service.packages(1)).total, 1);
    assert.equal((await r.call('/member/matchmaking/requests', 'POST', { targetUserId: 2 })).code, 40903,
      'actual service still requires preparation, even after direct purchase');
  }
});

test('new direct orders survive service relationship changes while account changes still require review', async () => {
  for (const change of ['profile', 'removed_assignment', 'reassigned', 'principal_disabled', 'account_disabled']) {
    const r = runtime();
    const order = await r.create('matchmaking_double');
    if (change === 'profile') r.rows.hl_profiles[0].updatedAt = 'changed-after-purchase';
    if (change === 'removed_assignment') r.rows.hl_members.length = 0;
    if (change === 'reassigned') r.rows.hl_members[0].matchmakerId = 99;
    if (change === 'principal_disabled') r.rows.hl_matchmakers[0].status = 0;
    if (change === 'account_disabled') r.rows.hl_users[0].status = 0;
    const result = await r.confirm(order);
    assert.equal(result.code, 0, result.message);
    assert.equal(result.data.order.status, 'paid');
    assert.equal(result.data.order.fulfillmentStatus, change === 'account_disabled' ? 'requires_review' : 'fulfilled');
    assert.equal((r.rows[VIP_COLLECTIONS.matchmakingPackages] || []).filter(row => row.orderNo).length,
      change === 'account_disabled' ? 0 : 1);
    if (change === 'account_disabled') assert.equal(result.data.order.reviewReason, 'account_changed');
  }
});

test('client-supplied contract markers cannot downgrade the canonical direct purchase promise', async () => {
  const r = runtime({ unassigned: true });
  const result = await r.call('/member/payment-orders', 'POST', { planCode: 'matchmaking_double',
    fulfillmentContract: 'future_forged_contract', memberRecordId: 999, memberMatchmakerId: 999 });
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.order.fulfillmentContract, 'user_entitlement_v1');
  const stored = r.rows.hl_payment_orders[0];
  assert.equal(stored.memberRecordId, 0); assert.equal(stored.memberMatchmakerId, undefined);
});

test('unknown server-stored contracts reject confirmation, close and refund without changing orders or rights', async () => {
  for (const action of ['confirm', 'close', 'refund']) {
    const r = runtime({ unassigned: true });
    const order = await r.create('matchmaking_double');
    if (action === 'refund') assert.equal((await r.confirm(order)).code, 0);
    const stored = r.rows.hl_payment_orders[0];
    stored.fulfillmentContract = 'unknown_future_contract';
    const before = structuredClone(r.rows);
    const result = await r.internal(action, { outTradeNo: order.outTradeNo, payerOpenid: 'fixture-openid-1',
      amountFen: order.amountFen, transactionId: stored.transactionId || 'fixture_contract_tx_001',
      tradeState: action === 'close' ? 'CLOSED' : action === 'refund' ? 'REFUND' : 'SUCCESS',
      providerVerified: true, refundId: 'fixture_contract_refund_001', refundAmountFen: order.amountFen,
      observedVirtualPaymentAttempts: [] });
    assert.equal(result.code, 40907, `${action}: ${result.message}`);
    assert.deepEqual(r.rows, before);
  }
});

test('existing unfinished cashier restores its original VIP product when a different service is selected', async () => {
  const r = runtime();
  const first = await r.create('vip_month');
  const next = await r.call('/member/payment-orders', 'POST', { planCode: 'matchmaking_month_6' });
  assert.equal(next.code, 0, next.message);
  assert.equal(next.data.order.outTradeNo, first.outTradeNo);
  assert.equal(next.data.order.productType, 'vip');
  assert.equal(next.data.payment.provider, 'virtual');
  assert.equal(next.data.recoveryRequired, true);
  assert.equal(r.rows.hl_payment_orders.length, 1);
});

test('artificial cashier restores its original service and virtual provider when VIP is selected', async () => {
  const r = runtime();
  assert.equal((await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4)).code, 0);
  const first = await r.create('matchmaking_month_6');
  const restored = await r.call('/member/payment-orders', 'POST', { planCode: 'vip_month' });
  assert.equal(restored.code, 0, restored.message);
  assert.equal(restored.data.order.outTradeNo, first.outTradeNo);
  assert.equal(restored.data.order.productType, 'matchmaking');
  assert.equal(restored.data.payment.provider, 'virtual');
  assert.equal(r.rows.hl_payment_orders.length, 1);
});

test('historical unmarked order retains service-change review without granting artificial credits', async () => {
  const r = runtime();
  assert.equal((await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4)).code, 0);
  const order = await r.create('matchmaking_month_6');
  delete r.rows.hl_payment_orders.find(row => row.outTradeNo === order.outTradeNo).fulfillmentContract;
  r.rows.hl_profiles[0].updatedAt = 'changed-after-order';
  const confirmed = await r.confirm(order);
  assert.equal(confirmed.code, 0, confirmed.message);
  assert.equal(confirmed.data.order.status, 'paid');
  assert.equal(confirmed.data.order.fulfillmentStatus, 'requires_review');
  assert.equal((await r.service.packages(1)).total, 0);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
});

test('new catalog activation prevents fresh checkout of hidden legacy products', async () => {
  const r = runtime({ rows: { hl_membership_plans: [{ _id: 'old_plan', id: 1, planCode: 'paid_30d', title: '旧会员', amountFen: 9900,
    durationDays: 30, active: true }] } });
  const created = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' });
  assert.notEqual(created.code, 0, 'hidden legacy product must not accept new cashiers');
  assert.equal((r.rows.hl_payment_orders || []).length, 0);
});

test('retired matching IDs never reappear or accept fresh orders even when persisted active and catalog gate is off', async () => {
  const oldPlans = [
    ['matchmaking_month', 698000, 30, 2], ['matchmaking_quarter', 1980000, 90, 8],
    ['matchmaking_halfyear', 2980000, 180, 16], ['matchmaking_single', 298000, 30, 1],
    ['matchmaking_month_3', 698000, 30, 3]
  ];
  for (const catalogReady of ['true', 'false']) {
    const r = runtime({ env: { VIP_MEMBERSHIP_CATALOG_READY: catalogReady }, rows: { hl_membership_plans:
      oldPlans.map(([planCode, amountFen, durationDays, serviceCount], index) => ({ _id: `retired_${index}`, id: index + 1,
        planCode, title: '历史牵线套餐', productType: 'matchmaking', amountFen, durationDays, serviceCount, active: true })) } });
    const overview = await r.call('/member/membership-plans');
    assert.equal(overview.code, 0, overview.message);
    assert.ok(overview.data.plans.every(plan => !oldPlans.some(([code]) => code === plan.planCode)));
    for (const [planCode] of oldPlans) {
      const created = await r.call('/member/payment-orders', 'POST', { planCode });
      assert.equal(created.code, 40905, `${catalogReady}: ${planCode} must stay retired`);
      assert.equal((r.rows.hl_payment_orders || []).length, 0);
    }
    assert.ok(r.rows.hl_membership_plans.every(row => row.active === true), 'retirement must not rewrite historical configuration');
  }
});

test('new catalog flag dominates a configured active new plan until activation is explicitly approved', async () => {
  const r = runtime({ env: { VIP_MEMBERSHIP_CATALOG_READY: 'false' }, rows: { hl_membership_plans: [
    { _id: 'configured_new_plan', id: 1, planCode: 'vip_month', title: 'VIP月卡', productType: 'vip',
      amountFen: 19800, durationDays: 30, active: true }
  ] } });
  const overview = await r.call('/member/membership-plans');
  assert.equal(overview.code, 0, overview.message);
  assert.equal(overview.data.payment.available, false);
  assert.ok(overview.data.plans.every(plan => plan.productType !== 'vip' || !plan.active));
});

test('legacy paid rights survive matchmaker edits and removal after explicit preservation hooks', async () => {
  const r = runtime();
  Object.assign(r.rows.hl_members[0], { memberType: 'paid', expireAt: '2099-01-01' });
  const edited = await r.call('/member/11', 'PUT', { memberType: 'no_consumption', expireAt: null }, 4);
  assert.equal(edited.code, 0, edited.message);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
  assert.ok(r.rows[VIP_COLLECTIONS.entitlements].length);
  const removed = await r.call('/member/11', 'DELETE', {}, 4);
  assert.equal(removed.code, 0, removed.message);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
});

test('late legacy cashier confirmation also enters the independent ledger once before dossier mutation', async () => {
  const order = { _id: 'legacy_order', id: 99, outTradeNo: 'HLM_LEGACY_PENDING_99', userId: 1,
    memberRecordId: 11, memberMatchmakerId: 21, payerOpenid: 'fixture-openid-1', ...identity,
    planCode: 'paid_30d', planTitle: '历史月度会员', amountFen: 9900, durationDays: 30,
    status: 'pending', fulfillmentStatus: '', transactionId: '', createdAt: new Date().toISOString() };
  const r = runtime({ rows: { hl_payment_orders: [order] } });
  const confirmed = await r.confirm(order);
  assert.equal(confirmed.code, 0, confirmed.message);
  assert.equal(r.rows.hl_members[0].memberType, 'paid');
  const record = r.rows[VIP_COLLECTIONS.entitlements][0];
  assert.equal(record.grants.find(item => item.orderNo === order.outTradeNo).durationDays, 30);
  await r.confirm(order);
  assert.equal(r.rows[VIP_COLLECTIONS.entitlements][0].grants.length, 1);
  assert.equal((await r.call('/member/11', 'PUT', { memberType: 'no_consumption', expireAt: null }, 4)).code, 0);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
});

test('only authenticated internal full-refund evidence may revoke its corresponding paid VIP order', async () => {
  const r = runtime({ unassigned: true });
  const first = await r.create('vip_week'); await r.confirm(first);
  const second = await r.create('vip_month'); await r.confirm(second);
  const refundData = { outTradeNo: first.outTradeNo, payerOpenid: 'fixture-openid-1', amountFen: first.amountFen,
    refundAmountFen: first.amountFen, transactionId: `fixture_tx_${first.id}`, refundId: 'fixture_refund_VIP001', tradeState: 'REFUND', providerVerified: true };
  const unauthenticated = await r.internal('refund', { ...refundData, callbackToken: '' });
  assert.notEqual(unauthenticated.code, 0);
  const wrongAmount = await r.internal('refund', { ...refundData, amountFen: 1 });
  assert.notEqual(wrongAmount.code, 0);
  const partialRefund = await r.internal('refund', { ...refundData, refundAmountFen: 1 });
  assert.notEqual(partialRefund.code, 0);
  const selfDeclared = await r.internal('refund', { ...refundData, providerVerified: false });
  assert.notEqual(selfDeclared.code, 0);
  const refunded = await r.internal('refund', refundData);
  assert.equal(refunded.code, 0, refunded.message);
  assert.equal(refunded.data.order.status, 'refunded');
  const record = r.rows[VIP_COLLECTIONS.entitlements][0];
  assert.equal(record.grants.find(item => item.orderNo === first.outTradeNo).status, 'refunded');
  assert.equal(record.grants.find(item => item.orderNo === second.outTradeNo).status, 'active');
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
  assert.equal((await r.internal('refund', refundData)).code, 0);
});

test('artificial full refund revokes only unused credits and leaves independent VIP active', async () => {
  const r = runtime();
  const ready = await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
  assert.equal(ready.code, 0, ready.message);
  const vip = await r.create('vip_month'); await r.confirm(vip);
  const manual = await r.create('matchmaking_month_6'); await r.confirm(manual);
  const refund = await r.internal('refund', { outTradeNo: manual.outTradeNo, payerOpenid: 'fixture-openid-1', amountFen: manual.amountFen,
    refundAmountFen: manual.amountFen, transactionId: `fixture_tx_${manual.id}`, refundId: 'fixture_refund_MATCH001', tradeState: 'REFUND', providerVerified: true });
  assert.equal(refund.code, 0, refund.message);
  assert.equal((await r.service.packages(1)).list[0].status, 'refunded');
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
});

test('real API self-request, assigned approval, bilateral consent, and connection consume one service credit', async () => {
  const r = runtime();
  assert.equal((await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4)).code, 0);
  const manual = await r.create('matchmaking_month_6'); await r.confirm(manual);
  const requested = await r.call('/member/matchmaking/requests', 'POST', { targetUserId: 2 });
  assert.equal(requested.code, 0, requested.message);
  const id = requested.data.id;
  assert.equal(requested.data.serviceConfirmed, false);
  assert.notEqual((await r.call(`/member/matchmaking/requests/${id}/respond`, 'POST', { accepted: true })).code, 0);
  assert.notEqual((await r.call(`/member/matchmaking/requests/${id}/approve`, 'POST', {}, 2)).code, 0);
  assert.equal((await r.call(`/member/matchmaking/requests/${id}/approve`, 'POST', {}, 4)).code, 0);
  assert.equal((await r.call(`/member/matchmaking/requests/${id}/respond`, 'POST', { accepted: true })).code, 0);
  const connected = await r.call(`/member/matchmaking/requests/${id}/respond`, 'POST', { accepted: true }, 2);
  assert.equal(connected.code, 0, connected.message);
  assert.equal(connected.data.status, 'connected');
  assert.equal(r.rows.hl_match_records.length, 1);
  assert.equal(r.rows.hl_conversations.length, 1);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 1);
  assert.equal((await r.call(`/member/matchmaking/requests/${id}/respond`, 'POST', { accepted: true }, 2)).code, 0);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 1);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
});

test('API-level contact exchange accepts only paired users and keeps contact hidden until both consent', async () => {
  const r = runtime();
  const vip = await r.create('vip_week'); await r.confirm(vip);
  const unpaired = await r.call('/member/vip/wechat-exchanges', 'POST', { targetUserId: 2, wechatId: 'fixture_one' });
  assert.notEqual(unpaired.code, 0);
  r.rows.hl_member_interactions = [
    { _id: 'favorite_1', id: 1, userId: 1, targetUserId: 2, actionType: 'favorite', active: true, status: 'active' },
    { _id: 'favorite_2', id: 2, userId: 2, targetUserId: 1, actionType: 'favorite', active: true, status: 'active' }
  ];
  const created = await r.call('/member/vip/wechat-exchanges', 'POST', { targetUserId: 2, wechatId: 'fixture_one' });
  assert.equal(created.code, 0, created.message);
  assert.equal('wechat' in created.data, false);
  const pending = await r.call(`/member/vip/wechat-exchanges/${created.data.id}`, 'GET', {}, 2);
  assert.equal(JSON.stringify(pending).includes('fixture_one'), false);
  const accepted = await r.call(`/member/vip/wechat-exchanges/${created.data.id}/respond`, 'POST', { accepted: true, wechatId: 'fixture_two' }, 2);
  assert.equal(accepted.code, 0, accepted.message);
  assert.deepEqual(accepted.data.wechat, { mine: 'fixture_two', peer: 'fixture_one' });
  assert.notEqual((await r.call(`/member/vip/wechat-exchanges/${created.data.id}`, 'GET', {}, 4)).code, 0);
});

test('API reminder subscriptions reject public users without a mutual favorite or formal connection', async () => {
  const r = runtime();
  const vip = await r.create('vip_week'); await r.confirm(vip);
  const unrelated = await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  assert.equal(unrelated.code, 40300);
  assert.equal((r.rows[VIP_COLLECTIONS.onlineSubscriptions] || []).length, 0);
  r.rows.hl_match_records = [{ _id: 'pending_pair', id: 70, userAId: 1, userBId: 2,
    matchmakerId: 21, status: 'pending', matchType: 'paid_matchmaking' }];
  const pending = await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  assert.equal(pending.code, 40300);
});

test('API mutual favorites get one station reminder on concurrent online requests', async () => {
  const r = runtime();
  const vip = await r.create('vip_week'); await r.confirm(vip);
  r.rows.hl_member_interactions = [
    { _id: 'favorite_1', id: 1, userId: 1, targetUserId: 2, actionType: 'favorite', active: true, status: 'active' },
    { _id: 'favorite_2', id: 2, userId: 2, targetUserId: 1, actionType: 'favorite', active: true, status: 'active' }
  ];
  const subscribed = await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  assert.equal(subscribed.code, 0, subscribed.message);
  const results = await Promise.all([r.call('/member/vip/presence', 'POST', {}, 2), r.call('/member/vip/presence', 'POST', {}, 2)]);
  for (const result of results) assert.equal(result.code, 0, result.message);
  assert.equal(r.rows.hl_messages.length, 1);
  assert.equal(r.rows.hl_messages[0].receiverId, 1);
  assert.equal(r.rows.hl_messages[0].messageType, 'online_reminder');
});

test('API subscription does not notify after a favorite is withdrawn and remains cancellable after expiry', async () => {
  const r = runtime();
  const vip = await r.create('vip_week'); await r.confirm(vip);
  r.rows.hl_member_interactions = [
    { _id: 'favorite_1', id: 1, userId: 1, targetUserId: 2, actionType: 'favorite', active: true, status: 'active' },
    { _id: 'favorite_2', id: 2, userId: 2, targetUserId: 1, actionType: 'favorite', active: true, status: 'active' }
  ];
  assert.equal((await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true })).code, 0);
  r.rows.hl_member_interactions[1].active = false;
  r.rows.hl_member_interactions[1].status = 'inactive';
  const online = await r.call('/member/vip/presence', 'POST', {}, 2);
  assert.equal(online.code, 0, online.message);
  assert.equal((r.rows.hl_messages || []).length, 0);
  const entitlement = r.rows[VIP_COLLECTIONS.entitlements][0];
  entitlement.grants = [];
  entitlement.legacyExpireAt = new Date(Date.now() - 86400000).toISOString();
  const cancelled = await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: false });
  assert.equal(cancelled.code, 0, cancelled.message);
  assert.equal((await r.call('/member/vip/online-subscriptions')).data.total, 0);
});

test('API formally connected users can subscribe and receive reminders without mutual favorites', async () => {
  const r = runtime();
  const vip = await r.create('vip_week'); await r.confirm(vip);
  r.rows.hl_match_records = [{ _id: 'connected_pair', id: 71, userAId: 1, userBId: 2,
    matchmakerId: 21, status: 'connected', matchType: 'paid_matchmaking' }];
  const subscribed = await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  assert.equal(subscribed.code, 0, subscribed.message);
  assert.equal((await r.call('/member/vip/presence', 'POST', {}, 2)).code, 0);
  assert.equal(r.rows.hl_messages.length, 1);
  assert.equal(r.rows.hl_messages[0].messageType, 'online_reminder');
});

test('default catalog code set stays consistent with API exposed product snapshots', () => {
  assert.equal(new Set(DEFAULT_MEMBERSHIP_PLANS.map(plan => plan.planCode)).size, 6);
});

test('assigned matchmaker GET readiness reads the selected member instead of the actor profile', async () => {
  const r = runtime();
  const prepared = await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
  assert.equal(prepared.code, 0, prepared.message);
  const own = await r.call('/member/matchmaking/readiness', 'GET', {}, 4);
  assert.equal(own.code, 0); assert.equal(own.data.ready, false);
  const selected = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId: 1 }, 4);
  assert.equal(selected.code, 0, selected.message);
  assert.equal(selected.data.ready, true);
  assert.equal(selected.data.profileComplete, true);
  assert.equal(selected.data.matchmakerConfirmed, true);
  assert.equal(selected.data.matchmakerId, 21);
});

test('ordinary members and unrelated matchmakers cannot inspect another member readiness', async () => {
  const r = runtime();
  const ordinary = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId: 2 }, 1);
  assert.notEqual(ordinary.code, 0);
  assert.equal(ordinary.data, null);
  const unrelated = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId: 2 }, 4);
  assert.notEqual(unrelated.code, 0);
  assert.equal(unrelated.data, null);
  const self = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId: 1 }, 1);
  assert.equal(self.code, 0, self.message);
});

test('former and uncertified matchmakers lose delegated readiness access', async () => {
  for (const change of [r => { r.rows.hl_members[0].status = 0; }, r => { r.rows.hl_matchmakers[0].certificationStatus = 0; }]) {
    const r = runtime(); change(r);
    const result = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId: 1 }, 4);
    assert.notEqual(result.code, 0);
    assert.equal(result.data, null);
  }
});

test('delegated readiness rejects malformed selected member IDs before exposing state', async () => {
  const r = runtime();
  for (const memberUserId of [0, -1, 'invalid', 1.5, null]) {
    const result = await r.call('/member/matchmaking/readiness', 'GET', { memberUserId }, 4);
    assert.equal(result.code, 40001);
    assert.equal(result.data, null);
  }
});

test('actual API visitor batch projection filters eligibility before returning two exclusive pages', async () => {
  const r = runtime();
  const order = await r.create('vip_week'); await r.confirm(order);
  for (let id = 10; id < 40; id += 1) {
    r.rows.hl_users.push({ _id: `user_${id}`, id, status: 1, nickname: `来访${id}`, gender: 1 });
    r.rows.hl_profiles.push({ _id: `profile_${id}`, id, userId: id, ...fullProfile });
  }
  r.rows[VIP_COLLECTIONS.memberVisits] = Array.from({ length: 30 }, (_, index) => ({ _id: `visit_${index + 10}`, id: `visit_${index + 10}`,
    visitorUserId: index + 10, targetUserId: 1, visitedAt: new Date(Date.now() - index * 60000).toISOString() }));
  r.rows.hl_users.find(row => row.id === 11).status = 0;
  r.rows.hl_profiles.find(row => row.userId === 12).displayEnabled = false;
  r.rows.hl_member_interactions = [{ _id: 'hidden_13', id: 1, userId: 13, targetUserId: 1, actionType: 'hide', active: true, status: 'active' },
    { _id: 'hidden_14', id: 2, userId: 1, targetUserId: 14, actionType: 'hide', active: true, status: 'active' }];
  const first = await r.call('/member/vip/visitors', 'GET', { page: 1, pageSize: 20 });
  const second = await r.call('/member/vip/visitors', 'GET', { page: 2, pageSize: 20 });
  assert.equal(first.code, 0, first.message); assert.equal(second.code, 0, second.message);
  assert.equal(first.data.total, 26); assert.equal(second.data.total, 26);
  assert.equal(first.data.list.length, 20); assert.equal(second.data.list.length, 6);
  const combined = [...first.data.list, ...second.data.list];
  assert.equal(new Set(combined.map(row => row.visitorUserId)).size, 26);
  assert.ok(combined.every(row => ![11, 12, 13, 14].includes(row.visitorUserId)));
  assert.ok(combined.every(row => !('openid' in row) && !('privateArchive' in row)));
});

test('same-code cloud plan configuration cannot replace approved catalog prices, duration, service counts or product type', async () => {
  const r = runtime({ rows: { hl_membership_plans: DEFAULT_MEMBERSHIP_PLANS.map(plan => ({ _id: `configured_${plan.planCode}`,
    planCode: plan.planCode, title: '错误的旧云配置', amountFen: 1, durationDays: 3650, serviceCount: 999,
    productType: plan.productType === 'vip' ? 'matchmaking' : 'vip', active: true })) } });
  const response = await r.call('/member/membership-plans');
  assert.equal(response.code, 0, response.message);
  for (const approved of DEFAULT_MEMBERSHIP_PLANS) {
    const actual = response.data.plans.find(plan => plan.planCode === approved.planCode);
    assert.ok(actual, approved.planCode);
    assert.equal(actual.amountFen, approved.amountFen, approved.planCode);
    assert.equal(actual.durationDays, approved.durationDays, approved.planCode);
    assert.equal(actual.serviceCount || 0, approved.serviceCount, approved.planCode);
    assert.equal(actual.productType, approved.productType, approved.planCode);
  }
});

test('all six actual checkout snapshots retain approved terms despite valid-looking conflicting cloud fields', async () => {
  for (const approved of DEFAULT_MEMBERSHIP_PLANS) {
    const r = runtime({ rows: { hl_membership_plans: [{ _id: `configured_${approved.planCode}`, planCode: approved.planCode,
      title: '错误的旧云配置', amountFen: 1, durationDays: 3650, serviceCount: 999,
      productType: approved.productType === 'vip' ? 'matchmaking' : 'vip', active: true }] } });
    if (approved.productType === 'matchmaking') {
      const prepared = await r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
      assert.equal(prepared.code, 0, prepared.message);
    }
    const response = await r.call('/member/payment-orders', 'POST', { planCode: approved.planCode });
    assert.equal(response.code, 0, response.message);
    const actual = response.data.order;
    assert.equal(actual.amountFen, approved.amountFen, approved.planCode);
    assert.equal(actual.durationDays, approved.durationDays, approved.planCode);
    assert.equal(actual.serviceCount || 0, approved.serviceCount, approved.planCode);
    assert.equal(actual.productType, approved.productType, approved.planCode);
  }
});
