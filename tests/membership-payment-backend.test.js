const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.resolve(process.env.HL_API_TEST_PATH || path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'));
const requireFromApi = createRequire(apiPath);
const merchant = requireFromApi('./payment-merchant-config.json');
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };
const FIXTURE_TOKEN = 'isolated-payment-fixture-token-not-a-real-credential';
const plain = value => JSON.parse(JSON.stringify(value));
const orderNumber = 'HLM202610080000000001';

function fixtures(orderPatch = {}) {
  return {
    hl_users: [1, 2].map(id => ({ _id: `user-${id}`, id, status: 1, authVersion: 1,
      openid: `fixture-openid-${id}`, phone: `fixture-phone-${id}` })),
    hl_members: [{ _id: 'member-11', id: 11, userId: 1, matchmakerId: 21, status: 1,
      memberType: 'free', expireAt: null }],
    hl_membership_plans: [{ _id: 'plan-1', id: 1, planCode: 'paid_30d', title: '月度会员',
      amountFen: 9900, durationDays: 30, active: true }],
    hl_payment_orders: [{ _id: 'order-1', id: 1, outTradeNo: orderNumber,
      userId: 1, memberRecordId: 11, memberMatchmakerId: 21, payerOpenid: 'fixture-openid-1',
      planCode: 'paid_30d', planTitle: '月度会员', amountFen: 9900, durationDays: 30,
      status: 'pending', transactionId: '', createdAt: new Date().toISOString(),
      paymentProvider: 'virtual', virtualPaymentEnv: 0, virtualPaymentOfferId: '1450674507', virtualPaymentAttempts: [],
      ...identity, ...orderPatch }]
  };
}

function runtime(options = {}) {
  const rows = structuredClone(options.rows || fixtures()), writes = [];
  let transactionTail = Promise.resolve();
  const operator = (kind, value) => ({ kind, value });
  const matches = (row, query) => !query || Object.entries(query).every(([key, value]) => row[key] === value);
  function collection(name) {
    const query = { where: null, skip: 0, limit: 100 };
    const ref = {
      where(value) { query.where = value; return ref; },
      skip(value) { query.skip = value; return ref; },
      limit(value) { query.limit = value; return ref; },
      async get() {
        return { data: structuredClone((rows[name] || []).filter(row => matches(row, query.where))
          .slice(query.skip, query.skip + query.limit)) };
      },
      async add({ data }) {
        const saved = { ...structuredClone(data), _id: `added-${name}-${data.id}` };
        (rows[name] ||= []).push(saved); writes.push({ name, data: structuredClone(data) });
        return { _id: saved._id };
      },
      doc(id) {
        return {
          async get() {
            if (name === 'hl_counters' && id === 'paymentOrderAtomic' && options.counterReadError) {
              throw options.counterReadError;
            }
            const row = (rows[name] || []).find(item => item._id === id);
            if (name === 'hl_payment_orders' && String(id).startsWith('payment_probe_user_') && options.probeReadError) {
              throw options.probeReadError;
            }
            if (!row && name === 'hl_payment_orders' && String(id).startsWith('payment_probe_user_') && options.missingProbeSnapshot) {
              return { data: null };
            }
            if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            // Match the deployed SDK: _id is selected by doc(id), never writable in data.
            if (Object.hasOwn(data, '_id')) {
              throw Object.assign(new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值'),
                { errCode: -501007, errMsg: 'document.set:fail -501007 invalid parameters. 不能更新_id的值' });
            }
            if (name === 'hl_counters' && id === 'paymentOrderAtomic' && options.counterWriteError) {
              throw options.counterWriteError;
            }
            const list = rows[name] ||= [];
            const index = list.findIndex(item => item._id === id);
            const saved = { ...structuredClone(data), _id: id };
            if (index < 0) list.push(saved); else list[index] = saved;
            writes.push({ name, id, data: structuredClone(data) });
          },
          async update({ data }) {
            if (options.failPaidOrderWrite && name === 'hl_payment_orders' && data.status === 'paid') {
              throw new Error('isolated order-write failure');
            }
            const row = (rows[name] || []).find(item => item._id === id);
            if (!row) throw new Error('missing fixture update');
            for (const [field, value] of Object.entries(data)) {
              row[field] = value && value.kind === 'inc' ? Number(row[field] || 0) + value.value : structuredClone(value);
            }
            writes.push({ name, id, data: structuredClone(data) });
          }
        };
      }
    };
    return ref;
  }
  const db = {
    collection, command: { inc: value => operator('inc', value) },
    async createCollection() {},
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
        if (options.beforeTransaction) options.beforeTransaction(rows);
        const saved = structuredClone(rows), beforeWrites = writes.length;
        // CloudBase transactions support document operations, not where queries.
        const transactionCollection = name => ({ doc: id => collection(name).doc(id) });
        try { return await callback({ collection: transactionCollection }); }
        catch (error) {
          for (const key of Object.keys(rows)) delete rows[key];
          Object.assign(rows, saved); writes.splice(beforeWrites); throw error;
        }
      });
      transactionTail = run.catch(() => {});
      return run;
    }
  };
  const env = {
    NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false',
    PAYMENT_INTEGRATION_READY: 'true', PAYMENT_FUNCTION_NAME: 'fixture-payment-bridge',
    PAYMENT_CREATE_PATH: '/member-pay/create', PAYMENT_QUERY_PATH: '/member-pay/query',
    VPAY_ENV: '0', VPAY_OFFER_ID: '1450674507',
    VPAY_APP_KEY: 'isolated-virtual-payment-app-key-fixture-not-a-real-credential',
    WX_APP_SECRET: 'isolated-wechat-app-secret-fixture-not-a-real-credential',
    PAYMENT_CALLBACK_TOKEN: FIXTURE_TOKEN, ...(options.env || {})
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'fixture-openid-1' }) };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'isolated-payment-jwt-fixture-not-a-real-credential' }) };
      }
      if (name === './virtual-payment-policy' && options.virtualClient) {
        return { ...requireFromApi(name), createVirtualPaymentClient: () => options.virtualClient };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  return {
    rows, writes, env,
    adminOrders: filters => module.exports.__test.membership.listOrdersForAdmin(filters),
    call: (route, method = 'POST', data = {}, userId) => module.exports.main({ path: route, method, data,
      token: userId ? module.exports.__test.tokenService.sign({ userId, authVersion: 1 }, { type: 'access' }) : '' }),
    internal: (action, data = {}) => module.exports.main({ path: `/internal/payment-orders/${action}`, method: 'POST',
      data: { callbackToken: FIXTURE_TOKEN, outTradeNo: orderNumber,
        paymentProvider: action === 'checkout' ? 'virtual' : rows.hl_payment_orders
          .find(order => order.outTradeNo === String(data.outTradeNo || orderNumber))?.paymentProvider || 'jsapi',
        ...(action === 'close' ? { observedVirtualPaymentAttempts: structuredClone(rows.hl_payment_orders
          .find(order => order.outTradeNo === String(data.outTradeNo || orderNumber))?.virtualPaymentAttempts) } : {}),
        ...data } })
  };
}

const confirmation = extra => ({ ...identity, payerOpenid: 'fixture-openid-1', amountFen: 9900,
  tradeState: 'SUCCESS', transactionId: 'fixture-transaction-1', ...extra });

test('closing a legacy order releases its existing slot without rewriting the SDK system id or membership', async () => {
  const rows = fixtures({ status: 'confirming' });
  rows.hl_counters = [{ _id: 'paymentPendingUser_1', key: 'paymentPendingUser_1', userId: 1,
    orderDocumentId: 'order-1', auditMarker: 'fixture-original-slot-marker' }];
  const memberBefore = structuredClone(rows.hl_members[0]);
  const r = runtime({ rows });
  const result = await r.internal('close', { ...identity, payerOpenid: 'fixture-openid-1', amountFen: 9900, tradeState: 'CLOSED' });
  assert.equal(result.code, 0);
  assert.equal(r.rows.hl_payment_orders[0].status, 'closed');
  const slot = r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1');
  assert.equal(slot.orderDocumentId, '');
  assert.equal(slot.auditMarker, 'fixture-original-slot-marker');
  assert.deepEqual(r.rows.hl_members[0], memberBefore);
  assert.ok(r.writes.some(write => write.id === 'paymentPendingUser_1'));
  assert.ok(r.writes.filter(write => write.id === 'paymentPendingUser_1').every(write => !Object.hasOwn(write.data, '_id')));
});

function virtualRuntime(options = {}) {
  const seed = fixtures({ paymentProvider: 'virtual', virtualPaymentEnv: 0,
    virtualPaymentOfferId: '1450674507', virtualPaymentAttempts: [], ...(options.orderPatch || {}) });
  const queries = [], deliveries = [], loginCalls = [];
  const providerOrders = new Map();
  const virtualClient = {
    code2session: async (_secret, code) => { loginCalls.push(code); return {
      openid: options.loginOpenid || 'fixture-openid-1', sessionKey: 'fixture-session-key-01234567890123456789' }; },
    accessToken: async () => 'fixture-access-token-01234567890123456789',
    queryOrder: async input => { queries.push(input.outTradeNo);
      return options.query ? options.query(input) : providerOrders.get(input.outTradeNo) || null; },
    notifyProvideGoods: async input => { deliveries.push(input.outTradeNo); }
  };
  const r = runtime({ rows: seed, virtualClient, ...(options.runtimeOptions || {}) });
  return { ...r, queries, deliveries, loginCalls, providerOrders,
    checkout: (data = {}) => r.call('/member/payment-virtual/checkout', 'POST',
      { outTradeNo: orderNumber, loginCode: 'fixture-login-code-0123456789', ...data }, 1),
    query: () => r.call('/member/payment-virtual/query', 'POST', { outTradeNo: orderNumber }, 1) };
}

function paidVirtualAttempt(attemptNo, extra = {}) {
  return { order_id: attemptNo, status: 2, order_type: 0, order_fee: 9900, paid_fee: 9900,
    env_type: 1, paid_time: Math.floor(Date.now() / 1000), wxpay_order_id: 'fixture-paid-virtual-transaction-001', ...extra };
}

function activationRows() {
  const rows = fixtures();
  rows.hl_payment_orders = [];
  rows.hl_members = [];
  rows.hl_users[0].isVerified = false;
  rows.hl_member_certifications = [{ _id: 'certification-1', userId: 1, current: null, applications: [] }];
  return rows;
}

async function createActivation(r, data = {}) {
  const result = await r.call('/matchmaker/activation/orders', 'POST', data, 1);
  assert.equal(result.code, 0, result.message);
  return result.data.order;
}

function activationProof(order, extra = {}) {
  return confirmation({ outTradeNo: order.outTradeNo, amountFen: 698000, ...extra });
}

test('principal activation overview is read-only and always quotes canonical 6980 lifetime terms', async () => {
  const rows = activationRows();
  rows.hl_membership_plans.push({ _id: 'fake-principal-price', planCode: 'matchmaker_lifetime', productType: 'matchmaker',
    title: '错误配置', amountFen: 1, durationDays: 1, active: true });
  const r = runtime({ rows }), before = plain(r.rows);
  const result = await r.call('/matchmaker/activation', 'GET', {}, 1);
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.plan.productType, 'matchmaker'); assert.equal(result.data.plan.planCode, 'matchmaker_lifetime');
  assert.equal(result.data.plan.amountFen, 698000); assert.equal(result.data.plan.durationDays, 0); assert.equal(result.data.plan.lifetime, true);
  assert.equal(result.data.active, false); assert.equal(result.data.phoneBound, true); assert.equal(result.data.payment.available, true);
  assert.equal(result.data.matchmaker, null); assert.equal(result.data.pendingOrder, null);
  assert.deepEqual(plain(r.rows), before); assert.equal(r.writes.length, 0);
});

test('principal purchase needs no member assignment and captures an internal immutable pending application', async () => {
  const r = runtime({ rows: activationRows() });
  const publicOrder = await createActivation(r, { planCode: 'vip_week', amountFen: 1, durationDays: 365, lifetime: false,
    userId: 2, matchmakerId: 999, matchmakerDocumentId: 'other-app', matchmakerAuthorizationSnapshot: 'forged' });
  const stored = r.rows.hl_payment_orders.find(row => row.outTradeNo === publicOrder.outTradeNo), application = r.rows.hl_matchmakers[0];
  assert.equal(stored.userId, 1); assert.equal(stored.productType, 'matchmaker'); assert.equal(stored.planCode, 'matchmaker_lifetime');
  assert.equal(stored.amountFen, 698000); assert.equal(stored.durationDays, 0); assert.equal(stored.lifetime, true);
  assert.equal(stored.memberRecordId, 0); assert.equal(stored.fulfillmentContract, 'user_entitlement_v1');
  assert.equal(stored.userDocumentId, 'user-1'); assert.equal(stored.matchmakerDocumentId, application._id);
  assert.equal(stored.matchmakerId, application.id); assert.match(stored.matchmakerAuthorizationSnapshot, /^[a-f0-9]{64}$/);
  assert.equal(application.certificationStatus, 0); assert.equal(application.status, 1); assert.equal(application.userId, 1);
  assert.doesNotMatch(JSON.stringify(publicOrder), /payerOpenid|userDocumentId|matchmakerDocumentId|matchmakerAuthorizationSnapshot|memberRecordId/);
  assert.equal(r.rows.hl_members.length, 0);
  const checkout = await r.internal('checkout', { outTradeNo: stored.outTradeNo, requesterOpenid: 'fixture-openid-1' });
  assert.equal(checkout.code, 0, checkout.message); assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
});

test('principal purchase requires the current verified phone before creating a payable order', async () => {
  const rows = activationRows(); rows.hl_users[0].phone = '';
  const r = runtime({ rows }), usersBefore = plain(r.rows.hl_users), overview = await r.call('/matchmaker/activation', 'GET', {}, 1);
  assert.equal(overview.data.payment.available, false); assert.equal(overview.data.payment.reason, 'phone_required');
  const created = await r.call('/matchmaker/activation/orders', 'POST', {}, 1);
  assert.equal(created.code, 40003); assert.equal(r.rows.hl_payment_orders.length, 0);
  assert.equal((r.rows.hl_matchmakers || []).length, 0);
  assert.equal((r.rows.hl_counters || []).length, 0);
  assert.deepEqual(plain(r.rows.hl_users), usersBefore);
  assert.equal(r.writes.length, 0);
});

test('concurrent first principal purchases create exactly one application and one payable cashier', async () => {
  const r = runtime({ rows: activationRows() });
  const results = await Promise.all([1, 2, 3].map(() => r.call('/matchmaker/activation/orders', 'POST', {}, 1)));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results.map(result => ({ code: result.code, message: result.message }))));
  assert.equal(r.rows.hl_matchmakers.length, 1);
  assert.equal(r.rows.hl_matchmakers[0]._id, 'paid_matchmaker_user_1');
  assert.equal(r.rows.hl_matchmakers[0].userId, 1);
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 0);
  assert.equal(r.rows.hl_payment_orders.length, 1);
  assert.equal(new Set(results.map(result => result.data.order.outTradeNo)).size, 1);
  assert.equal(r.rows.hl_payment_orders[0].matchmakerDocumentId, r.rows.hl_matchmakers[0]._id);
  assert.equal(r.rows.hl_payment_orders[0].matchmakerId, r.rows.hl_matchmakers[0].id);
  assert.equal(r.writes.filter(write => write.name === 'hl_matchmakers').length, 1);
  assert.equal(r.writes.filter(write => write.name === 'hl_counters' && write.id === 'paidMatchmakerAtomic').length, 1);
  assert.equal((r.rows.hl_vip_entitlements || []).length, 0);
});

test('a foreign pending slot rejects principal purchase before any application, role or counter write', async () => {
  const rows = activationRows();
  rows.hl_payment_orders = [{ ...fixtures().hl_payment_orders[0], _id: 'foreign-order', userId: 2, payerOpenid: 'fixture-openid-2' }];
  rows.hl_counters = [{ _id: 'paymentPendingUser_1', key: 'paymentPendingUser_1', userId: 1, orderDocumentId: 'foreign-order' }];
  const r = runtime({ rows }), before = plain(r.rows);
  const created = await r.call('/matchmaker/activation/orders', 'POST', {}, 1);
  assert.equal(created.code, 40906);
  assert.deepEqual(plain(r.rows), before);
  assert.equal((r.rows.hl_matchmakers || []).length, 0);
  assert.equal(r.writes.length, 0);
});

test('a principal payment allocation failure rolls back its new application, role and independent counter', async () => {
  const r = runtime({ rows: activationRows(), counterWriteError: new Error('fixture payment allocation failed') });
  const before = plain(r.rows), created = await r.call('/matchmaker/activation/orders', 'POST', {}, 1);
  assert.notEqual(created.code, 0);
  assert.deepEqual(plain(r.rows), before);
  assert.equal((r.rows.hl_matchmakers || []).length, 0);
  assert.equal((r.rows.hl_counters || []).length, 0);
  assert.equal(r.writes.length, 0);
});

test('trusted principal payment activates only role, and duplicate confirmation cannot undo administrator revocation', async () => {
  const r = runtime({ rows: activationRows() }), order = await createActivation(r), userBefore = plain(r.rows.hl_users[0]),
    certificationsBefore = plain(r.rows.hl_member_certifications);
  const untrusted = await r.call('/internal/payment-orders/confirm', 'POST', activationProof(order));
  assert.notEqual(untrusted.code, 0); assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 0);
  const settled = await r.internal('confirm', activationProof(order));
  assert.equal(settled.code, 0, settled.message); assert.equal(settled.data.order.status, 'paid');
  assert.equal(settled.data.order.fulfillmentStatus, 'fulfilled'); assert.equal(settled.data.membership, null);
  const application = r.rows.hl_matchmakers[0];
  assert.equal(application.certificationStatus, 2); assert.equal(application.activationSource, 'paid');
  assert.equal(application.activationLifetime, true); assert.equal(application.activationExpireAt, null);
  assert.equal(application.activationOrderNo, order.outTradeNo); assert.equal(application.activationGrants.length, 1);
  assert.deepEqual(plain(r.rows.hl_users[0]), userBefore); assert.deepEqual(plain(r.rows.hl_member_certifications), certificationsBefore);
  assert.equal(r.rows.hl_members.length, 0); assert.equal((r.rows.hl_vip_entitlements || []).length, 0);
  assert.equal((r.rows.hl_matchmaking_packages || []).length, 0);
  Object.assign(application, { certificationStatus: 0, activationStatus: 'revoked', activationSource: 'manual' });
  const beforeRetry = r.writes.length, repeated = await r.internal('confirm', activationProof(order));
  assert.equal(repeated.code, 0); assert.equal(repeated.data.idempotent, true);
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 0); assert.equal(r.writes.length, beforeRetry);
});

test('verified full principal refund revokes its paid role while preserving unrelated lifetime VIP and certifications', async () => {
  const rows = activationRows();
  rows.hl_vip_entitlements = [{ _id: 'vip_user_1', userId: 1, legacyLifetime: true, grants: [] }];
  const r = runtime({ rows }), order = await createActivation(r);
  assert.equal((await r.internal('confirm', activationProof(order))).code, 0);
  const vipBefore = plain(r.rows.hl_vip_entitlements), certBefore = plain(r.rows.hl_member_certifications);
  const refund = activationProof(order, { tradeState: 'REFUND', providerVerified: true,
    refundId: 'fixture-refund-principal-001', refundAmountFen: 698000 });
  assert.notEqual((await r.internal('refund', { ...refund, providerVerified: false })).code, 0);
  assert.notEqual((await r.internal('refund', { ...refund, refundAmountFen: 1 })).code, 0);
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 2);
  const result = await r.internal('refund', refund);
  assert.equal(result.code, 0, result.message); assert.equal(result.data.order.status, 'refunded');
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 0); assert.equal(r.rows.hl_matchmakers[0].activationStatus, 'refunded');
  assert.equal(r.rows.hl_matchmakers[0].activationGrants[0].status, 'refunded');
  assert.deepEqual(plain(r.rows.hl_vip_entitlements), vipBefore); assert.deepEqual(plain(r.rows.hl_member_certifications), certBefore);
  Object.assign(r.rows.hl_matchmakers[0], { certificationStatus: 2, activationSource: 'manual', activationStatus: 'manual' });
  const writesBefore = r.writes.length, repeated = await r.internal('refund', refund);
  assert.equal(repeated.code, 0); assert.equal(repeated.data.idempotent, true);
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 2); assert.equal(r.writes.length, writesBefore);
});

test('principal application changes after checkout record real money as paid review without granting access', async () => {
  for (const patch of [{ certificationStatus: 1, certificationRemark: '人工拒绝' }, { status: 0 },
    { certificationStatus: 2, activationSource: 'manual', activationStatus: 'manual' }, { updatedAt: '2030-01-01T00:00:00.000Z' }]) {
    const r = runtime({ rows: activationRows() }), order = await createActivation(r);
    Object.assign(r.rows.hl_matchmakers[0], patch);
    const before = plain(r.rows.hl_matchmakers[0]), result = await r.internal('confirm', activationProof(order));
    assert.equal(result.code, 0, result.message); assert.equal(result.data.order.status, 'paid');
    assert.equal(result.data.order.fulfillmentStatus, 'requires_review'); assert.equal(result.data.order.reviewReason, 'matchmaker_application_changed');
    assert.equal(result.data.order.transactionId, 'fixture-transaction-1'); assert.equal(result.data.membership, null);
    assert.deepEqual(plain(r.rows.hl_matchmakers[0]), before); assert.equal((r.rows.hl_vip_entitlements || []).length, 0);
    const overview = await r.call('/matchmaker/activation', 'GET', {}, 1);
    assert.equal(overview.data.payment.available, false); assert.equal(overview.data.payment.reason, 'payment_requires_review');
    assert.equal(overview.data.pendingOrder.outTradeNo, order.outTradeNo);
  }
});

test('existing legacy principal approval blocks repeat charges without adding expiry or paid membership', async () => {
  const rows = activationRows(); rows.hl_matchmakers = [{ _id: 'manual-matchmaker-8', id: 8, userId: 1, status: 1, certificationStatus: 2 }];
  const r = runtime({ rows }), overview = await r.call('/matchmaker/activation', 'GET', {}, 1);
  assert.equal(overview.data.active, true); assert.equal(overview.data.activationSource, 'manual'); assert.equal(overview.data.lifetime, true);
  assert.equal(overview.data.payment.available, false); assert.equal(overview.data.payment.reason, 'matchmaker_already_active');
  assert.equal((await r.call('/matchmaker/activation/orders', 'POST', {}, 1)).code, 40906);
  assert.equal(r.writes.length, 0); assert.equal(r.rows.hl_payment_orders.length, 0);
});

test('principal entry recovers another product unpaid order and existing role order blocks another product purchase', async () => {
  const legacy = runtime(), saved = plain(legacy.rows.hl_payment_orders[0]), usersBefore = plain(legacy.rows.hl_users);
  const overview = await legacy.call('/matchmaker/activation', 'GET', {}, 1);
  assert.equal(overview.data.pendingOrder.outTradeNo, saved.outTradeNo);
  const recovered = await createActivation(legacy);
  assert.equal(recovered.outTradeNo, saved.outTradeNo); assert.equal(recovered.amountFen, 9900);
  assert.equal(legacy.rows.hl_payment_orders.length, 1); assert.deepEqual(plain(legacy.rows.hl_payment_orders[0]), saved);
  assert.equal((legacy.rows.hl_matchmakers || []).length, 0);
  assert.deepEqual(plain(legacy.rows.hl_users), usersBefore);
  assert.equal(legacy.writes.some(write => write.name === 'hl_matchmakers'
    || write.name === 'hl_counters' && write.id === 'paidMatchmakerAtomic'), false);
  const principal = runtime({ rows: activationRows() }), roleOrder = await createActivation(principal);
  const vip = await principal.call('/member/payment-orders', 'POST', { planCode: 'vip_week' }, 1);
  assert.equal(vip.code, 0, vip.message); assert.equal(vip.data.recoveryRequired, true);
  assert.equal(vip.data.order.outTradeNo, roleOrder.outTradeNo); assert.equal(vip.data.order.productType, 'matchmaker');
  assert.equal(principal.rows.hl_payment_orders.length, 1);
});

test('principal payment proof tampering never records payment or grants role', async () => {
  for (const patch of [{ amountFen: 1 }, { payerOpenid: 'fixture-openid-2' }, { appId: 'other-app' }, { currency: 'USD' },
    { tradeState: 'NOTPAY' }, { paymentProvider: 'jsapi' }]) {
    const r = runtime({ rows: activationRows() }), order = await createActivation(r), before = plain(r.rows.hl_matchmakers[0]);
    const result = await r.internal('confirm', activationProof(order, patch));
    assert.notEqual(result.code, 0); assert.equal(r.rows.hl_payment_orders[0].status, 'pending');
    assert.deepEqual(plain(r.rows.hl_matchmakers[0]), before); assert.equal((r.rows.hl_vip_entitlements || []).length, 0);
  }
});

test('principal virtual cashier signs the canonical price and provider query fulfills lifetime role exactly once', async () => {
  const providerOrders = new Map(), queried = [], deliveries = [];
  const virtualClient = {
    code2session: async () => ({ openid: 'fixture-openid-1', sessionKey: 'fixture-session-key-01234567890123456789' }),
    accessToken: async () => 'fixture-access-token-01234567890123456789',
    queryOrder: async input => { queried.push(input.outTradeNo); return providerOrders.get(input.outTradeNo) || null; },
    notifyProvideGoods: async input => { deliveries.push(input.outTradeNo); }
  };
  const r = runtime({ rows: activationRows(), virtualClient }), order = await createActivation(r);
  const checkout = await r.call('/member/payment-virtual/checkout', 'POST', { outTradeNo: order.outTradeNo,
    loginCode: 'fixture-login-code-0123456789', amountFen: 1, productId: 'vip_week', lifetime: false }, 1);
  assert.equal(checkout.code, 0, checkout.message);
  const signData = JSON.parse(checkout.data.virtualPayment.signData), attempt = checkout.data.paymentAttemptNo;
  assert.equal(signData.productId, 'matchmaker_lifetime'); assert.equal(signData.goodsPrice, 698000);
  assert.equal(signData.buyQuantity, 1); assert.equal(signData.outTradeNo, attempt);
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 0);
  providerOrders.set(attempt, paidVirtualAttempt(attempt, { order_fee: 698000, paid_fee: 698000 }));
  const settled = await r.call('/member/payment-virtual/query', 'POST', { outTradeNo: order.outTradeNo }, 1);
  assert.equal(settled.code, 0, settled.message); assert.equal(settled.data.order.status, 'paid');
  assert.equal(settled.data.order.fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows.hl_matchmakers[0].certificationStatus, 2); assert.equal(r.rows.hl_matchmakers[0].activationLifetime, true);
  assert.equal(r.rows.hl_matchmakers[0].activationGrants.length, 1); assert.equal((r.rows.hl_vip_entitlements || []).length, 0);
  assert.deepEqual(deliveries, [attempt]); assert.deepEqual(queried, [attempt]);
  assert.equal((await r.call('/member/payment-virtual/query', 'POST', { outTradeNo: order.outTradeNo }, 1)).code, 0);
  assert.equal(r.rows.hl_matchmakers[0].activationGrants.length, 1); assert.deepEqual(deliveries, [attempt]);
});

test('virtual retries issue distinct platform numbers while preserving business identity and server prices', async () => {
  const r = virtualRuntime();
  const first = await r.checkout({ amountFen: 1, productId: 'attacker', paymentAttemptNo: 'attacker-order-number' });
  assert.equal(first.code, 0);
  const firstNo = first.data.paymentAttemptNo;
  r.providerOrders.set(firstNo, { order_id: firstNo, env_type: 1, status: 1 });
  const second = await r.checkout();
  assert.equal(second.code, 0);
  assert.notEqual(second.data.paymentAttemptNo, firstNo);
  for (const result of [first, second]) {
    const params = JSON.parse(result.data.virtualPayment.signData);
    assert.equal(params.outTradeNo, result.data.paymentAttemptNo);
    assert.equal(params.productId, 'paid_30d');
    assert.equal(params.goodsPrice, 9900);
    assert.equal(result.data.order.outTradeNo, orderNumber);
    assert.equal('virtualPaymentAttempts' in result.data.order, false);
  }
  assert.equal(r.rows.hl_payment_orders.length, 1);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 2);
  assert.deepEqual(r.queries, [firstNo]);
  const maps = r.rows.hl_counters.filter(row => row.key.startsWith('virtualPaymentAttempt_'));
  assert.equal(maps.length, 2);
  assert.ok(maps.every(row => row.businessOutTradeNo === orderNumber));
});

test('a late payment from an earlier attempt settles the business order and prevents another cashier', async () => {
  const r = virtualRuntime();
  const first = await r.checkout();
  const firstNo = first.data.paymentAttemptNo;
  const second = await r.checkout();
  assert.equal(second.code, 0);
  r.providerOrders.set(firstNo, paidVirtualAttempt(firstNo));
  const third = await r.checkout();
  assert.equal(third.code, 40905);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 2);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(r.rows.hl_members[0].memberType, 'paid');
  assert.deepEqual(r.deliveries, [firstNo]);
});

test('push-only sandbox checkout blocks an already-paid attempt without query compensation or another cashier', async () => {
  const r = virtualRuntime({ orderPatch: { _id: 'payment_probe_user_1_run_push_20261011_2127',
    virtualPaymentEnv: 1, planCode: 'hl_payment_probe', planTitle: '微信支付测试', amountFen: 1, durationDays: 1 },
    runtimeOptions: { env: { PAYMENT_INTEGRATION_READY: 'false', VPAY_ENV: '1',
      VPAY_SANDBOX_APP_KEY: 'fixture-repeat-sandbox-key-0123456789', PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: '1',
      PAYMENT_TEST_RUN_ID: 'push_20261011_2127', PAYMENT_TEST_PUSH_ONLY: 'true',
      PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 45 * 60 * 1000).toISOString() } } });
  const first = await r.checkout();
  assert.equal(first.code, 0);
  r.providerOrders.set(first.data.paymentAttemptNo,
    paidVirtualAttempt(first.data.paymentAttemptNo, { env_type: 2, order_fee: 1, paid_fee: 1 }));
  assert.equal((await r.checkout()).code, 40905);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 1);
  assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
  assert.equal(r.rows.hl_payment_orders[0].confirmationSource, undefined);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.deliveries.length, 0);
  const queries = r.queries.length, writes = r.writes.length;
  assert.equal((await r.query()).data.tradeState, 'NOTPAY');
  assert.equal(r.queries.length, queries); assert.equal(r.writes.length, writes);
});

test('internal payloads cannot forge payment-confirmation origin or push receipt fields', async () => {
  const r = runtime();
  const result = await r.internal('confirm', confirmation({ confirmationSource: 'wechat_push', origin: 'wechat_push',
    confirmationRequestId: 'client-forged-confirmation-request',
    virtualPushHandledAt: 'client-forged-time', virtualPushRequestId: 'client-forged-request', virtualPushOrderNo: 'client-forged-attempt' }));
  assert.equal(result.code, 0);
  assert.equal(r.rows.hl_payment_orders[0].confirmationSource, 'internal');
  assert.equal(r.rows.hl_payment_orders[0].confirmationRequestId, '');
  assert.equal(r.rows.hl_payment_orders[0].virtualPushHandledAt, undefined);
  assert.equal(r.rows.hl_payment_orders[0].virtualPushRequestId, undefined);
  assert.equal(r.rows.hl_payment_orders[0].virtualPushOrderNo, undefined);
});

test('concurrent virtual checkout snapshots cannot allocate two fresh attempts', async () => {
  const r = virtualRuntime();
  const results = await Promise.all([r.checkout(), r.checkout()]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  assert.equal(results.filter(result => result.code === 40905).length, 1);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 1);
});

test('virtual checkout rejects legacy orders and changed environment or offer snapshots before any cashier', async () => {
  for (const orderPatch of [{ paymentProvider: undefined }, { paymentProvider: 'jsapi' },
    { virtualPaymentEnv: 1 }, { virtualPaymentOfferId: '9999999999' }]) {
    const r = virtualRuntime({ orderPatch });
    assert.notEqual((await r.checkout()).code, 0);
    assert.equal(r.loginCalls.length, 0);
    assert.equal(r.writes.length, 0);
    assert.equal(r.queries.length, 0);
  }
});

test('virtual checkout authenticates login identity and refuses a provider response for another attempt', async () => {
  const mismatch = virtualRuntime({ loginOpenid: 'fixture-openid-2' });
  assert.equal((await mismatch.checkout()).code, 40304);
  assert.equal(mismatch.writes.length, 0);
  const r = virtualRuntime({ query: () => paidVirtualAttempt('fixture-other-attempt-001') });
  assert.equal((await r.checkout()).code, 0);
  assert.equal((await r.checkout()).code, 40907);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 1);
});

test('virtual business orders cannot be checked out by the old JSAPI bridge', async () => {
  const r = virtualRuntime();
  const result = await r.call('/internal/payment-orders/checkout', 'POST', {
    callbackToken: FIXTURE_TOKEN, outTradeNo: orderNumber, requesterOpenid: 'fixture-openid-1'
  });
  assert.equal(result.code, 40304);
  assert.equal(r.writes.length, 0);
});

test('disabled payment configuration cannot create orders, even after the merchant number is registered', async () => {
  for (const env of [{ PAYMENT_INTEGRATION_READY: '' }, { VPAY_APP_KEY: '' }, { PAYMENT_CALLBACK_TOKEN: '' }]) {
    const r = runtime({ env });
    const result = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1);
    assert.equal(result.code, 50301);
    assert.equal(r.writes.length, 0);
  }
});

test('new member orders snapshot the registered identity and trusted plan rather than client fields', async () => {
  const seed = fixtures(); seed.hl_payment_orders = [];
  const r = runtime({ rows: seed });
  const result = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d', amountFen: 1,
    durationDays: 3650, payerOpenid: 'attacker', merchantId: 'wrong', appId: 'wrong', currency: 'USD' }, 1);
  assert.equal(result.code, 0);
  const order = r.rows.hl_payment_orders[0];
  assert.equal(order.amountFen, 9900); assert.equal(order.durationDays, 30);
  assert.equal(order.payerOpenid, 'fixture-openid-1');
  for (const [field, value] of Object.entries(identity)) assert.equal(order[field], value);
  assert.equal('payerOpenid' in result.data.order, false);
  assert.equal(result.data.payment.provider, 'virtual');
  assert.equal(result.data.payment.queryPath, '');
  assert.equal((await r.call(`/member/payment-orders/${order.outTradeNo}`, 'GET', {}, 2)).code, 40400);
});

test('internal query is read-only and requires both the bridge token and the exact payer OPENID', async () => {
  const r = runtime();
  for (const input of [{ callbackToken: '' }, { callbackToken: 'wrong' }, { requesterOpenid: '' }, { requesterOpenid: 'fixture-openid-2' }]) {
    const result = await r.internal('query', { requesterOpenid: 'fixture-openid-1', ...input });
    assert.equal(result.code, 40304);
    assert.equal(result.data, null);
  }
  const result = await r.internal('query', { requesterOpenid: 'fixture-openid-1' });
  assert.equal(result.code, 0);
  assert.equal(result.data.status, 'pending');
  assert.equal(result.data.payerOpenid, 'fixture-openid-1');
  for (const [field, value] of Object.entries(identity)) assert.equal(result.data[field], value);
  assert.equal('payerOpenid' in result.data.order, false);
  assert.equal(r.writes.length, 0);
});

test('historical JSAPI cashiers cannot reopen through the ordinary bridge even while new virtual payment is ready', async () => {
  for (const paymentProvider of [undefined, 'jsapi']) {
    const r = runtime({ rows: fixtures({ paymentProvider }) });
    const before = structuredClone(r.rows);
    for (const requestedProvider of ['jsapi', 'virtual', undefined]) {
      const result = await r.internal('checkout', { requesterOpenid: 'fixture-openid-1', paymentProvider: requestedProvider });
      assert.equal(result.code, 40304, `immutable ${String(paymentProvider)} cannot reopen as ${String(requestedProvider)}`);
    }
    assert.deepEqual(r.rows, before);
    assert.equal(r.writes.length, 0);
    assert.equal((await r.internal('query', { requesterOpenid: 'fixture-openid-1', paymentProvider: 'jsapi' })).code, 0);
  }
});

test('checkout validates payer before mutation and cannot reopen an order paid during its initial read', async () => {
  for (const requesterOpenid of [undefined, '', 'fixture-openid-2']) {
    const r = runtime();
    assert.equal((await r.internal('checkout', { requesterOpenid })).code, 40304);
    assert.equal(r.rows.hl_payment_orders[0].status, 'pending');
    assert.equal(r.writes.length, 0);
  }
  const r = runtime();
  const first = await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' });
  assert.equal(first.code, 0); assert.equal(first.data.status, 'confirming');
  assert.equal(first.data.order.status, 'confirming');
  assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal(r.writes.length, 2, 'one user slot and one checkout state write; repeated checkout adds neither');
  const raced = runtime({ beforeTransaction: rows => { rows.hl_payment_orders[0].status = 'paid'; } });
  assert.equal((await raced.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40905);
  assert.equal(raced.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(raced.writes.length, 0);
});

test('legacy orders use registered identity without writes while conflicting snapshots are rejected', async () => {
  const seed = fixtures();
  for (const field of Object.keys(identity)) delete seed.hl_payment_orders[0][field];
  const r = runtime({ rows: seed });
  const query = await r.internal('query', { requesterOpenid: 'fixture-openid-1' });
  assert.equal(query.code, 0);
  for (const [field, value] of Object.entries(identity)) assert.equal(query.data[field], value);
  assert.equal(r.writes.length, 0);
  assert.equal((await r.internal('confirm', confirmation())).code, 0);
  for (const field of Object.keys(identity)) {
    const invalid = runtime({ rows: fixtures({ [field]: 'wrong' }) });
    assert.equal((await invalid.internal('query', { requesterOpenid: 'fixture-openid-1' })).code, 40907);
    assert.equal((await invalid.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40907);
    assert.equal((await invalid.internal('confirm', confirmation())).code, 40907);
    assert.equal(invalid.writes.length, 0);
  }
});

test('confirmation rejects missing or mismatched identities, payer, amount and non-success results without fulfillment', async () => {
  const inputs = [{ amountFen: 1 }, { payerOpenid: 'fixture-openid-2' }, { tradeState: 'NOTPAY' },
    ...Object.keys(identity).flatMap(field => [{ [field]: undefined }, { [field]: '' }, { [field]: 'wrong' }])];
  for (const patch of inputs) {
    const r = runtime();
    assert.equal((await r.internal('confirm', confirmation(patch))).code, 40907);
    assert.equal(r.writes.length, 0);
    assert.equal(r.rows.hl_members[0].memberType, 'free');
  }
});

test('concurrent confirmations fulfill once and reject a conflicting transaction or later close', async () => {
  const r = runtime();
  const results = await Promise.all([r.internal('confirm', confirmation()), r.internal('confirm', confirmation())]);
  assert.deepEqual(results.map(row => row.code), [0, 0]);
  assert.deepEqual(results.map(row => row.data.idempotent).sort(), [false, true]);
  assert.equal(r.writes.filter(row => row.name === 'hl_members').length, 1);
  assert.equal(r.writes.filter(row => row.name === 'hl_payment_orders').length, 1);
  const expiry = r.rows.hl_members[0].expireAt;
  assert.equal((await r.internal('confirm', confirmation({ transactionId: 'fixture-transaction-2' }))).code, 40908);
  assert.equal((await r.internal('close', confirmation({ tradeState: 'CLOSED' }))).code, 40905);
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
});

test('fulfillment transaction rolls back both order and member and records reassignment for review', async () => {
  const r = runtime({ failPaidOrderWrite: true });
  const before = structuredClone(r.rows);
  assert.notEqual((await r.internal('confirm', confirmation())).code, 0);
  assert.deepEqual(r.rows, before);
  assert.equal(r.writes.length, 0);
  const raced = runtime({ beforeTransaction: rows => { rows.hl_members[0].userId = 2; } });
  const review = await raced.internal('confirm', confirmation());
  assert.equal(review.code, 0);
  assert.equal(review.data.order.fulfillmentStatus, 'requires_review');
  assert.equal(review.data.membership, null);
  assert.equal(raced.rows.hl_members[0].memberType, 'free');
  assert.equal(raced.writes.filter(write => write.name === 'hl_members').length, 0);
});

test('trusted CLOSED and PAYERROR close pending orders idempotently without changing membership', async () => {
  for (const [tradeState, status] of [['CLOSED', 'closed'], ['PAYERROR', 'failed']]) {
    const r = runtime();
    const memberBefore = plain(r.rows.hl_members[0]);
    const first = await r.internal('close', confirmation({ tradeState }));
    assert.equal(first.code, 0); assert.equal(first.data.order.status, status);
    assert.equal(first.data.idempotent, false);
    const second = await r.internal('close', confirmation({ tradeState }));
    assert.equal(second.code, 0); assert.equal(second.data.idempotent, true);
    assert.deepEqual(plain(r.rows.hl_members[0]), memberBefore);
    assert.equal(r.writes.length, 1);
    assert.equal((await r.internal('confirm', confirmation())).code, 40905);
    assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40905);
  }
});

test('close rejects untrusted or non-terminal results and cannot overwrite payment that won a race', async () => {
  for (const patch of [{ callbackToken: '' }, { tradeState: 'NOTPAY' }, { tradeState: 'SUCCESS' },
    { merchantId: undefined }, { appId: 'wrong' }, { currency: undefined }, { currency: 'USD' },
    { payerOpenid: undefined }, { payerOpenid: 'wrong' }, { amountFen: undefined }, { amountFen: 1 }]) {
    const r = runtime();
    assert.notEqual((await r.internal('close', confirmation({ tradeState: 'CLOSED', ...patch }))).code, 0);
    assert.equal(r.writes.length, 0);
  }
  const raced = runtime({ beforeTransaction: rows => { rows.hl_payment_orders[0].status = 'paid'; } });
  assert.equal((await raced.internal('close', confirmation({ tradeState: 'CLOSED' }))).code, 40905);
  assert.equal(raced.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(raced.writes.length, 0);
});

test('concurrent matching close requests write once and recheck the financial snapshot inside the transaction', async () => {
  for (const tradeState of ['CLOSED', 'PAYERROR']) {
    const r = runtime();
    const beforeMember = plain(r.rows.hl_members[0]);
    const results = await Promise.all([r.internal('close', confirmation({ tradeState })),
      r.internal('close', confirmation({ tradeState }))]);
    assert.deepEqual(results.map(result => result.code), [0, 0]);
    assert.deepEqual(results.map(result => result.data.idempotent).sort(), [false, true]);
    assert.equal(r.writes.length, 1); assert.deepEqual(plain(r.rows.hl_members[0]), beforeMember);
    for (const patch of [{ payerOpenid: 'fixture-openid-2' }, { amountFen: 1 }, { appId: 'wrong' }]) {
      const raced = runtime({ beforeTransaction: rows => Object.assign(rows.hl_payment_orders[0], patch) });
      assert.equal((await raced.internal('close', confirmation({ tradeState }))).code, 40907);
      assert.equal(raced.rows.hl_payment_orders[0].status, 'pending'); assert.equal(raced.writes.length, 0);
      assert.equal(raced.rows.hl_members[0].memberType, 'free');
    }
  }
});

function controlledPaymentRuntime(options = {}) {
  const rows = fixtures();
  // The historical ordinary cashier is closed; a live ordinary cashier would
  // intentionally block creation of a new controlled-test cashier as well.
  rows.hl_payment_orders[0].status = 'closed';
  rows.hl_members.push({ _id: 'member-12', id: 12, userId: 2, matchmakerId: 21, status: 1,
    memberType: 'free', expireAt: null });
  // Even an operator-created row using the reserved name must not set test price.
  rows.hl_membership_plans.push({ _id: 'malicious-probe-plan', id: 2, planCode: 'hl_payment_probe',
    title: '运营数据库同名套餐', amountFen: 500000, durationDays: 3650, active: true });
  return runtime({ ...options, rows: options.rows || rows, env: {
    PAYMENT_INTEGRATION_READY: 'false', PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: '1',
    PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(), ...(options.env || {})
  } });
}

async function createControlledOrder(r, data = {}) {
  return r.call('/member/payment-orders', 'POST', { planCode: 'hl_payment_probe', ...data }, 1);
}

function controlledConfirmation(outTradeNo, extra = {}) {
  return confirmation({ outTradeNo, amountFen: 1, transactionId: 'fixture-controlled-payment-transaction', ...extra });
}

test('controlled overview exposes only the fixed probe to the designated account without leaking configuration', async () => {
  const r = controlledPaymentRuntime();
  const mine = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(mine.code, 0);
  assert.equal(mine.data.payment.available, true);
  assert.equal(mine.data.payment.testMode, true);
  assert.equal(mine.data.plans.length, 1);
  assert.equal(mine.data.plans[0].planCode, 'hl_payment_probe');
  assert.equal(mine.data.plans[0].title, '微信支付测试');
  assert.equal(mine.data.plans[0].amountFen, 1);
  assert.equal(mine.data.plans[0].durationDays, 1);
  assert.match(mine.data.plans[0].description, /0\.01元真实付款/);
  assert.match(mine.data.plans[0].description, /1天会员权益/);
  assert.doesNotMatch(JSON.stringify(mine.data), /PAYMENT_TEST_USER_ID|PAYMENT_TEST_EXPIRES_AT|PAYMENT_CALLBACK_TOKEN|allowlist/);
  assert.ok(!JSON.stringify(mine.data).includes(FIXTURE_TOKEN));
  assert.ok(!JSON.stringify(mine.data).includes(r.env.PAYMENT_TEST_EXPIRES_AT));
  const other = await r.call('/member/membership-plans', 'GET', {}, 2);
  assert.equal(other.code, 0);
  assert.equal(other.data.payment.available, false);
  assert.equal(other.data.payment.testMode, undefined);
  assert.deepEqual(plain(other.data.plans.map(plan => plan.planCode)), ['paid_30d']);
  assert.equal(r.writes.length, 0);
});

test('controlled order creation ignores injected amount, duration, payer and merchant', async () => {
  const r = controlledPaymentRuntime();
  const created = await createControlledOrder(r, { amountFen: 1000000, durationDays: 3650,
    planTitle: '替换套餐', payerOpenid: 'attacker-openid', userId: 2,
    merchantId: 'wrong', appId: 'wrong', currency: 'USD' });
  assert.equal(created.code, 0);
  const probe = r.rows.hl_payment_orders.find(order => order.planCode === 'hl_payment_probe');
  assert.equal(probe._id, 'payment_probe_user_1');
  assert.equal(probe.amountFen, 1);
  assert.equal(probe.durationDays, 1);
  assert.equal(probe.planTitle, '微信支付测试');
  assert.equal(probe.userId, 1);
  assert.equal(probe.memberRecordId, 11);
  assert.equal(probe.payerOpenid, 'fixture-openid-1');
  for (const [field, value] of Object.entries(identity)) assert.equal(probe[field], value);
  assert.equal(created.data.order.outTradeNo, probe.outTradeNo);
  assert.equal('payerOpenid' in created.data.order, false);
  const checkout = await r.internal('checkout', { outTradeNo: probe.outTradeNo, requesterOpenid: 'fixture-openid-1' });
  assert.equal(checkout.code, 0);
  assert.equal(checkout.data.amountFen, 1);
  assert.equal(checkout.data.order.durationDays, 1);
});

test('ordinary plans and other accounts cannot create or checkout during the controlled window', async () => {
  const r = controlledPaymentRuntime();
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).code, 40304);
  for (const planCode of ['paid_30d', 'hl_payment_probe']) {
    assert.equal((await r.call('/member/payment-orders', 'POST', { planCode }, 2)).code, 50301);
  }
  assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40001);
  assert.equal(r.rows.hl_payment_orders[0].status, 'closed');
  assert.equal(r.writes.length, 0);
  const created = await createControlledOrder(r);
  assert.equal(created.code, 0);
  const before = r.writes.length;
  assert.equal((await r.internal('checkout', { outTradeNo: created.data.order.outTradeNo,
    requesterOpenid: 'fixture-openid-2' })).code, 40304);
  assert.equal(r.writes.length, before);
});

test('concurrent controlled creates converge on one fixed document and never create a second payable order', async () => {
  const r = controlledPaymentRuntime();
  const results = await Promise.all([createControlledOrder(r), createControlledOrder(r), createControlledOrder(r)]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
  assert.equal(new Set(results.map(result => result.data.order.outTradeNo)).size, 1);
  assert.equal(r.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, 1);
  assert.equal(r.writes.filter(write => write.name === 'hl_payment_orders').length, 1);
  const resumed = await createControlledOrder(r);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.data.order.outTradeNo, results[0].data.order.outTradeNo);
  assert.equal(r.writes.filter(write => write.name === 'hl_payment_orders').length, 1);
});

test('paid controlled orders are one-time and disappear from overview without enabling ordinary checkout', async () => {
  const r = controlledPaymentRuntime();
  const created = await createControlledOrder(r);
  const outTradeNo = created.data.order.outTradeNo;
  assert.equal((await r.internal('confirm', controlledConfirmation(outTradeNo))).code, 0);
  const paid = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(paid.code, 0);
  assert.equal(paid.data.payment.available, false);
  assert.equal(paid.data.payment.reason, 'payment_test_completed');
  assert.equal(paid.data.payment.createPath, '');
  assert.deepEqual(plain(paid.data.plans), []);
  assert.equal(paid.data.isPremiumMember, true);
  assert.equal((await createControlledOrder(r)).code, 40905);
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).code, 40304);
  assert.equal((await r.internal('checkout', { outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 40905);
  assert.equal(r.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, 1);
  assert.equal(r.writes.filter(write => write.name === 'hl_members').length, 1);
});

function enableSandboxRun(r, runId = 'push_20261011_2127') {
  Object.assign(r.env, { PAYMENT_TEST_RUN_ID: runId, VPAY_ENV: '1',
    VPAY_SANDBOX_APP_KEY: 'isolated-repeat-sandbox-app-key-not-a-real-credential' });
}

test('a separate sandbox run preserves a paid legacy probe and extends existing membership exactly once', async () => {
  const r = controlledPaymentRuntime();
  const first = await createControlledOrder(r);
  const oldNo = first.data.order.outTradeNo;
  assert.equal((await r.internal('confirm', controlledConfirmation(oldNo))).code, 0);
  const oldProbe = plain(r.rows.hl_payment_orders.find(row => row._id === 'payment_probe_user_1'));
  const baselineMember = plain(r.rows.hl_members.find(row => row.userId === 1));
  enableSandboxRun(r);
  const overview = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.data.payment.available, true);
  assert.equal(overview.data.plans.length, 1);
  const second = await createControlledOrder(r, { runId: 'client-selected-run', PAYMENT_TEST_RUN_ID: 'client-selected-run' });
  assert.equal(second.code, 0);
  assert.equal(second.data.reused, false);
  assert.notEqual(second.data.order.outTradeNo, oldNo);
  const current = r.rows.hl_payment_orders.find(row => row._id === 'payment_probe_user_1_run_push_20261011_2127');
  assert.equal(current.outTradeNo, second.data.order.outTradeNo);
  assert.equal(current.virtualPaymentEnv, 1);
  assert.equal(current.amountFen, 1); assert.equal(current.durationDays, 1);
  assert.deepEqual(plain(r.rows.hl_payment_orders.find(row => row._id === oldProbe._id)), oldProbe);
  assert.deepEqual(plain(r.rows.hl_members.find(row => row.userId === 1)), baselineMember);
  assert.ok(!JSON.stringify(overview.data).includes(r.env.PAYMENT_TEST_RUN_ID));
  const slot = () => r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1');
  assert.equal(slot().orderDocumentId, current._id);
  const writesBeforeReplay = r.writes.length;
  assert.equal((await r.internal('confirm', controlledConfirmation(oldNo))).data.idempotent, true);
  assert.equal(r.writes.length, writesBeforeReplay);
  assert.equal(slot().orderDocumentId, current._id);
  assert.equal((await r.internal('checkout', { outTradeNo: current.outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
  const secondProof = controlledConfirmation(current.outTradeNo, { transactionId: 'fixture-second-run-payment-transaction' });
  const paid = await r.internal('confirm', secondProof);
  assert.equal(paid.code, 0); assert.equal(paid.data.idempotent, false);
  const member = r.rows.hl_members.find(row => row.userId === 1);
  assert.equal(Date.parse(member.expireAt), Date.parse(baselineMember.expireAt) + 24 * 60 * 60 * 1000);
  assert.equal(member.lastPaymentOrderNo, current.outTradeNo);
  assert.equal(slot().orderDocumentId, '');
  const finalMember = plain(member), finalWrites = r.writes.length;
  assert.equal((await r.internal('confirm', secondProof)).data.idempotent, true);
  assert.equal((await r.internal('confirm', controlledConfirmation(oldNo))).data.idempotent, true);
  assert.deepEqual(plain(member), finalMember); assert.equal(r.writes.length, finalWrites);
  assert.deepEqual(plain(r.rows.hl_payment_orders.find(row => row._id === oldProbe._id)), oldProbe);
  assert.equal((await r.call(`/member/payment-orders/${oldNo}`, 'GET', {}, 1)).data.status, 'paid');
  const completed = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(completed.data.payment.reason, 'payment_test_completed');
  assert.equal((await createControlledOrder(r)).code, 40905);
});

test('parallel sandbox-run creates use one new document and one global user slot', async () => {
  const r = controlledPaymentRuntime();
  enableSandboxRun(r);
  const results = await Promise.all([createControlledOrder(r), createControlledOrder(r), createControlledOrder(r)]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
  assert.equal(new Set(results.map(result => result.data.order.outTradeNo)).size, 1);
  assert.equal(results.filter(result => !result.data.reused).length, 1);
  const probes = r.rows.hl_payment_orders.filter(row => row.planCode === 'hl_payment_probe');
  assert.equal(probes.length, 1);
  assert.equal(probes[0]._id, 'payment_probe_user_1_run_push_20261011_2127');
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, probes[0]._id);
  assert.equal(r.writes.filter(write => write.name === 'hl_payment_orders').length, 1);
  assert.equal(r.writes.filter(write => write.name === 'hl_members').length, 0);
  r.env.PAYMENT_TEST_RUN_ID = 'next_operator_run';
  const next = await createControlledOrder(r);
  assert.equal(next.code, 0); assert.equal(next.data.reused, true);
  assert.equal(next.data.order.outTradeNo, probes[0].outTradeNo);
  assert.equal(r.rows.hl_payment_orders.filter(row => row.planCode === 'hl_payment_probe').length, 1);
});

test('invalid, production and expired run settings cannot create a repeat sandbox probe', async () => {
  for (const patch of [{ PAYMENT_TEST_RUN_ID: '' }, { PAYMENT_TEST_RUN_ID: '../probe' },
    { VPAY_ENV: '0' }, { PAYMENT_INTEGRATION_READY: undefined },
    { VPAY_SANDBOX_APP_KEY: '' }, { WX_APP_SECRET: '' },
    { PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }]) {
    const r = controlledPaymentRuntime();
    enableSandboxRun(r);
    Object.assign(r.env, patch);
    const before = plain(r.rows);
    assert.equal((await createControlledOrder(r)).code, 50301);
    assert.deepEqual(plain(r.rows), before); assert.equal(r.writes.length, 0);
    assert.equal((await r.call('/member/membership-plans', 'GET', {}, 1)).data.payment.available, false);
  }
});

test('expired test access closes creation and checkout but allows query and delayed idempotent one-day fulfillment', async () => {
  const r = controlledPaymentRuntime();
  const created = await createControlledOrder(r);
  const outTradeNo = created.data.order.outTradeNo;
  assert.equal((await r.internal('checkout', { outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
  r.env.PAYMENT_TEST_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  const before = r.writes.length;
  assert.equal((await createControlledOrder(r)).code, 50301);
  assert.equal((await r.internal('checkout', { outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 50301);
  const queried = await r.internal('query', { outTradeNo, requesterOpenid: 'fixture-openid-1' });
  assert.equal(queried.code, 0);
  assert.equal(queried.data.status, 'confirming');
  assert.equal(r.writes.length, before);
  const first = await r.internal('confirm', controlledConfirmation(outTradeNo));
  assert.equal(first.code, 0);
  assert.equal(first.data.idempotent, false);
  const probe = r.rows.hl_payment_orders.find(order => order.outTradeNo === outTradeNo);
  const member = r.rows.hl_members.find(row => row.userId === 1);
  assert.equal(Date.parse(member.expireAt) - Date.parse(member.membershipPaidAt), 24 * 60 * 60 * 1000);
  const expiry = member.expireAt;
  const repeated = await r.internal('confirm', controlledConfirmation(outTradeNo));
  assert.equal(repeated.code, 0);
  assert.equal(repeated.data.idempotent, true);
  assert.equal(member.expireAt, expiry);
  assert.equal(probe.status, 'paid');
  assert.equal(r.writes.filter(write => write.name === 'hl_members').length, 1);
  assert.equal((await createControlledOrder(r)).code, 50301);
});

test('modified controlled order snapshots are rejected before checkout without mutating the order', async () => {
  for (const patch of [{ amountFen: 9900 }, { durationDays: 90 }, { planTitle: '月度会员' },
    { planCode: 'paid_30d' }]) {
    const r = controlledPaymentRuntime();
    const created = await createControlledOrder(r);
    const outTradeNo = created.data.order.outTradeNo;
    const probe = r.rows.hl_payment_orders.find(order => order.outTradeNo === outTradeNo);
    Object.assign(probe, patch);
    const before = r.writes.length;
    assert.equal((await r.internal('checkout', { outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 40001);
    assert.equal(probe.status, 'pending');
    assert.equal(r.writes.length, before);
  }
});

test('controlled checkout rechecks both the deadline and snapshot within its document transaction', async () => {
  for (const mutation of ['expiry', 'duration']) {
    let armed = false;
    let r;
    r = controlledPaymentRuntime({ beforeTransaction: rows => {
      if (!armed) return;
      if (mutation === 'expiry') r.env.PAYMENT_TEST_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
      else rows.hl_payment_orders.find(order => order.planCode === 'hl_payment_probe').durationDays = 90;
    } });
    const created = await createControlledOrder(r);
    const before = r.writes.length;
    armed = true;
    const denied = await r.internal('checkout', { outTradeNo: created.data.order.outTradeNo, requesterOpenid: 'fixture-openid-1' });
    assert.equal(denied.code, mutation === 'expiry' ? 50301 : 40001);
    assert.equal(r.rows.hl_payment_orders.find(order => order.outTradeNo === created.data.order.outTradeNo).status, 'pending');
    assert.equal(r.writes.length, before);
  }
});

test('only a trusted CLOSED probe can be archived and replaced; failed probes stay final', async () => {
  for (const tradeState of ['CLOSED', 'PAYERROR']) {
    const r = controlledPaymentRuntime();
    const created = await createControlledOrder(r);
    const outTradeNo = created.data.order.outTradeNo;
    assert.equal((await r.internal('close', controlledConfirmation(outTradeNo, { tradeState }))).code, 0);
    const resumed = await createControlledOrder(r);
    assert.equal(resumed.code, tradeState === 'CLOSED' ? 0 : 40905);
    assert.equal(r.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, tradeState === 'CLOSED' ? 2 : 1);
    assert.equal(r.writes.filter(write => write.name === 'hl_members').length, 0);
  }
});

test('normal production readiness preserves full-price checkout and prevents access to the reserved probe', async () => {
  const r = controlledPaymentRuntime({ env: { PAYMENT_INTEGRATION_READY: 'true' } });
  const overview = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.code, 0);
  assert.equal(overview.data.payment.available, true);
  assert.equal(overview.data.payment.testMode, undefined);
  assert.deepEqual(plain(overview.data.plans.map(plan => plan.planCode)), ['paid_30d']);
  assert.equal((await createControlledOrder(r)).code, 40304);
  const created = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d', amountFen: 1 }, 1);
  assert.equal(created.code, 0);
  assert.equal(created.data.order.amountFen, 9900);
  assert.equal(created.data.order.durationDays, 30);
  assert.equal((await r.internal('checkout', { outTradeNo: created.data.order.outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal(r.rows.hl_payment_orders.some(order => order.planCode === 'hl_payment_probe'), false);
});

test('test reservation handles empty-document snapshots but never treats permission or network failures as absence', async () => {
  const empty = controlledPaymentRuntime({ missingProbeSnapshot: true });
  assert.equal((await createControlledOrder(empty)).code, 0);
  assert.equal(empty.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, 1);
  for (const error of [new Error('permission denied'), new Error('network request failed'),
    Object.assign(new Error('collection does not exist'), { errCode: 'COLLECTION_NOT_EXIST' })]) {
    const denied = controlledPaymentRuntime({ probeReadError: error });
    assert.notEqual((await createControlledOrder(denied)).code, 0);
    assert.equal(denied.rows.hl_payment_orders.some(order => order.planCode === 'hl_payment_probe'), false);
    assert.equal(denied.writes.filter(write => write.name === 'hl_payment_orders').length, 0);
  }
});

test('genuine one-fen confirmation cannot fulfill a modified probe snapshot after checkout or during the transaction', async () => {
  for (const stage of ['after-checkout', 'in-transaction']) {
    for (const patch of [{ durationDays: 90 }, { planCode: 'paid_30d', planTitle: '月度会员', durationDays: 90 }]) {
      let armed = false;
      const r = controlledPaymentRuntime({ beforeTransaction: rows => {
        if (armed) Object.assign(rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1'), patch);
      } });
      const created = await createControlledOrder(r);
      const outTradeNo = created.data.order.outTradeNo;
      assert.equal((await r.internal('checkout', { outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
      if (stage === 'after-checkout') Object.assign(r.rows.hl_payment_orders.find(order => order.outTradeNo === outTradeNo), patch);
      else armed = true;
      const before = r.writes.length;
      const result = await r.internal('confirm', controlledConfirmation(outTradeNo));
      assert.equal(result.code, 40001, `${stage}: ${Object.keys(patch).join(',')}`);
      assert.equal(r.writes.length, before);
      assert.equal(r.rows.hl_members.find(member => member.userId === 1).memberType, 'free');
      assert.equal(r.rows.hl_members.find(member => member.userId === 1).expireAt, null);
      assert.equal(r.rows.hl_payment_orders.find(order => order.outTradeNo === outTradeNo).status, 'confirming');
    }
  }
});

test('the immutable probe document prevents repeated test display or production checkout after its plan metadata changes', async () => {
  const completed = controlledPaymentRuntime();
  const created = await createControlledOrder(completed);
  const outTradeNo = created.data.order.outTradeNo;
  assert.equal((await completed.internal('confirm', controlledConfirmation(outTradeNo))).code, 0);
  Object.assign(completed.rows.hl_payment_orders.find(order => order.outTradeNo === outTradeNo), {
    planCode: 'paid_30d', planTitle: '月度会员'
  });
  const before = completed.writes.length;
  const overview = await completed.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.code, 0);
  assert.equal(overview.data.payment.reason, 'payment_test_completed');
  assert.equal(overview.data.plans.length, 0);
  assert.notEqual((await createControlledOrder(completed)).code, 0);
  assert.equal(completed.writes.length, before);
  assert.equal(completed.rows.hl_payment_orders.filter(order => order._id === 'payment_probe_user_1').length, 1);

  const pending = controlledPaymentRuntime();
  const second = await createControlledOrder(pending);
  Object.assign(pending.rows.hl_payment_orders.find(order => order.outTradeNo === second.data.order.outTradeNo), {
    planCode: 'paid_30d', planTitle: '月度会员'
  });
  pending.env.PAYMENT_INTEGRATION_READY = 'true';
  const count = pending.writes.length;
  assert.equal((await pending.internal('checkout', { outTradeNo: second.data.order.outTradeNo,
    requesterOpenid: 'fixture-openid-1' })).code, 40304);
  assert.equal(pending.writes.length, count);
});

function freshOrdinaryRows() {
  const rows = fixtures();
  rows.hl_payment_orders = [];
  rows.hl_members.push({ _id: 'member-12', id: 12, userId: 2, matchmakerId: 21, status: 1,
    memberType: 'free', expireAt: null });
  rows.hl_membership_plans.push({ _id: 'plan-2', id: 2, planCode: 'paid_90d', title: '季度会员',
    amountFen: 24900, durationDays: 90, active: true });
  return rows;
}

test('concurrent same-user ordinary creates reserve one cashier across identical and different plans', async () => {
  for (const plans of [['paid_30d', 'paid_30d', 'paid_30d'], ['paid_30d', 'paid_90d', 'paid_30d']]) {
    const r = runtime({ rows: freshOrdinaryRows() });
    const results = await Promise.all(plans.map(planCode => r.call('/member/payment-orders', 'POST', { planCode }, 1)));
    assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
    assert.equal(new Set(results.map(result => result.data.order.outTradeNo)).size, 1);
    assert.equal(r.rows.hl_payment_orders.length, 1);
    assert.equal(results.filter(result => !result.data.reused && !result.data.recoveryRequired).length, 1);
    assert.equal(results.filter(result => result.data.reused && result.data.recoveryRequired).length, 2);
    assert.equal(r.writes.filter(write => write.name === 'hl_payment_orders').length, 1);
    assert.equal(r.writes.filter(write => write.name === 'hl_counters' && write.id === 'paymentOrderAtomic').length, 1);
  }
});

test('parallel users receive distinct atomic payment IDs and merchant numbers without changing generic counters', async () => {
  const rows = freshOrdinaryRows();
  rows.hl_counters = [{ _id: 'paymentOrder', key: 'paymentOrder', value: 7 }, { _id: 'member', key: 'member', value: 55 }];
  const r = runtime({ rows });
  const results = await Promise.all([1, 2].map(userId => r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, userId)));
  assert.deepEqual(results.map(result => result.code), [0, 0]);
  assert.equal(new Set(r.rows.hl_payment_orders.map(order => order.id)).size, 2);
  assert.equal(new Set(r.rows.hl_payment_orders.map(order => order.outTradeNo)).size, 2);
  for (const order of r.rows.hl_payment_orders) {
    assert.ok(Number.isSafeInteger(order.id) && order.id > 7);
    assert.match(order.outTradeNo, /^[A-Za-z0-9_-]{8,32}$/);
    assert.equal(order.memberMatchmakerId, 21);
  }
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentOrder').value, 7);
  assert.equal(r.rows.hl_counters.find(row => row._id === 'member').value, 55);
});

test('atomic counter read and write failures roll back reservations and never reset an existing sequence', async () => {
  for (const options of [{ counterReadError: new Error('network failed') },
    { counterReadError: new Error('permission denied') }, { counterWriteError: new Error('network failed') }]) {
    const rows = freshOrdinaryRows();
    rows.hl_counters = [{ _id: 'paymentOrderAtomic', key: 'paymentOrderAtomic', value: 7 }];
    const r = runtime({ ...options, rows });
    const before = plain(r.rows);
    assert.notEqual((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).code, 0);
    assert.deepEqual(plain(r.rows), before);
    assert.equal(r.writes.length, 0);
  }
});

test('old and repriced unpaid orders survive a page reentry and block a different-plan cashier', async () => {
  const rows = fixtures({ createdAt: '2020-01-01T00:00:00.000Z' });
  rows.hl_membership_plans[0].amountFen = 19900;
  rows.hl_membership_plans.push({ _id: 'plan-2', id: 2, planCode: 'paid_90d', title: '季度会员',
    amountFen: 24900, durationDays: 90, active: true });
  const r = runtime({ rows });
  const overview = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.data.pendingOrder.outTradeNo, orderNumber);
  for (const planCode of ['paid_30d', 'paid_90d']) {
    const recovered = await r.call('/member/payment-orders', 'POST', { planCode }, 1);
    assert.equal(recovered.code, 0);
    assert.equal(recovered.data.order.outTradeNo, orderNumber);
    assert.equal(recovered.data.order.amountFen, 9900);
    assert.equal(recovered.data.reused, true);
    assert.equal(recovered.data.recoveryRequired, true);
  }
  r.rows.hl_membership_plans[0].active = false;
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).data.order.outTradeNo, orderNumber);
  assert.equal(r.rows.hl_payment_orders.length, 1);
});

test('recovery scans status-filtered legacy orders beyond one hundred completed records and preserves every unresolved cashier', async () => {
  const rows = fixtures();
  const pending = rows.hl_payment_orders[0];
  const second = { ...pending, _id: 'order-2', id: 2, outTradeNo: 'HLM202610080000000002', status: 'confirming' };
  rows.hl_payment_orders = Array.from({ length: 150 }, (_, index) => ({ ...pending, _id: `history-${index}`,
    id: index + 100, outTradeNo: `HLM20261008${String(index + 100).padStart(10, '0')}`, status: 'paid', fulfillmentStatus: 'fulfilled' }));
  rows.hl_payment_orders.push(pending, second);
  const r = runtime({ rows });
  let overview = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.data.pendingOrder.outTradeNo, orderNumber);
  assert.equal(overview.data.unresolvedOrderCount, 2);
  const created = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1);
  assert.equal(created.data.order.outTradeNo, orderNumber);
  assert.equal(r.rows.hl_payment_orders.length, 152);
  assert.equal((await r.internal('close', confirmation({ tradeState: 'CLOSED' }))).code, 0);
  overview = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(overview.data.pendingOrder.outTradeNo, second.outTradeNo);
  assert.equal(overview.data.unresolvedOrderCount, 1);
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).data.order.outTradeNo, second.outTradeNo);
});

test('maintenance recovery remains owner-scoped with virtual checkout closed and historical internal queries available', async () => {
  const r = runtime({ env: { PAYMENT_INTEGRATION_READY: 'false' } });
  const mine = await r.call('/member/membership-plans', 'GET', {}, 1);
  assert.equal(mine.data.pendingOrder.outTradeNo, orderNumber);
  assert.equal(mine.data.payment.provider, 'virtual');
  assert.equal(mine.data.payment.functionName, '');
  assert.equal(mine.data.payment.queryPath, '');
  assert.equal(mine.data.payment.createPath, '');
  assert.doesNotMatch(JSON.stringify(mine.data.pendingOrder), /payerOpenid|memberRecordId|memberMatchmakerId|callbackToken/);
  const other = await r.call('/member/membership-plans', 'GET', {}, 2);
  assert.equal(other.data.pendingOrder, null);
  assert.equal((await r.call(`/member/payment-orders/${orderNumber}`, 'GET', {}, 2)).code, 40400);
  assert.equal((await r.internal('query', { requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal(r.writes.length, 0);
});

test('checkout rejects stopped, deleted or reassigned membership before any new payment preparation', async () => {
  for (const change of [rows => { rows.hl_members[0].status = 0; },
    rows => { rows.hl_members = []; }, rows => { rows.hl_members[0].userId = 2; },
    rows => { rows.hl_members[0].matchmakerId = 99; }]) {
    for (const timing of ['before-read', 'in-transaction']) {
      const rows = fixtures(); if (timing === 'before-read') change(rows);
      const r = runtime({ rows, ...(timing === 'in-transaction' ? { beforeTransaction: change } : {}) });
      assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40906);
      assert.equal(r.rows.hl_payment_orders[0].status, 'pending');
      assert.equal(r.writes.length, 0);
      assert.equal((await r.internal('query', { requesterOpenid: 'fixture-openid-1' })).code, 0);
    }
  }
});

test('late verified SUCCESS records a paid review without reviving a stopped, missing or changed relation', async () => {
  for (const [change, reason] of [[rows => { rows.hl_members[0].status = 0; }, 'membership_inactive'],
    [rows => { rows.hl_members = []; }, 'membership_missing'],
    [rows => { rows.hl_members[0].userId = 2; }, 'membership_changed'],
    [rows => { rows.hl_members[0].matchmakerId = 99; }, 'membership_changed'],
    [rows => { delete rows.hl_payment_orders[0].memberMatchmakerId; }, 'membership_snapshot_missing']]) {
    const rows = fixtures(); change(rows);
    const beforeMembers = plain(rows.hl_members);
    const r = runtime({ rows });
    const proof = confirmation({ successTime: '2026-10-10T12:00:00+08:00' });
    const settled = await r.internal('confirm', proof);
    assert.equal(settled.code, 0);
    assert.equal(settled.data.order.status, 'paid');
    assert.equal(settled.data.order.fulfillmentStatus, 'requires_review');
    assert.equal(settled.data.order.reviewReason, reason);
    assert.equal(settled.data.order.transactionId, proof.transactionId);
    assert.equal(settled.data.order.paidAt, '2026-10-10T04:00:00.000Z');
    assert.match(settled.data.order.fulfillmentMessage, /工作人员/);
    assert.equal(settled.data.membership, null);
    assert.deepEqual(plain(r.rows.hl_members), beforeMembers);
    const writesBeforeRetry = r.writes.length;
    r.rows.hl_members = plain(fixtures().hl_members);
    const repeated = await r.internal('confirm', proof);
    assert.equal(repeated.code, 0); assert.equal(repeated.data.idempotent, true);
    assert.equal(repeated.data.order.fulfillmentStatus, 'requires_review');
    assert.equal(repeated.data.membership, null);
    assert.equal(r.writes.length, writesBeforeRetry);
    assert.equal(r.rows.hl_members[0].memberType, 'free');
    const overview = await r.call('/member/membership-plans', 'GET', {}, 1);
    assert.equal(overview.data.pendingOrder.outTradeNo, orderNumber);
    assert.equal(overview.data.payment.reason, 'payment_requires_review');
    assert.equal(overview.data.payment.available, false);
    const retryCreate = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1);
    assert.equal(retryCreate.data.recoveryRequired, true);
    assert.equal(retryCreate.data.order.fulfillmentStatus, 'requires_review');
    assert.equal(r.rows.hl_payment_orders.length, 1);
    assert.equal((await r.adminOrders({ fulfillmentStatus: 'requires_review' })).total, 1);
    assert.equal((await r.adminOrders({ fulfillmentStatus: 'fulfilled' })).total, 0);
  }
});

test('pending legacy checkout snapshots its valid relation, while confirming legacy orders never guess a new owner', async () => {
  const rows = fixtures(); delete rows.hl_payment_orders[0].memberMatchmakerId;
  const r = runtime({ rows });
  assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal(r.rows.hl_payment_orders[0].memberMatchmakerId, 21);
  assert.equal((await r.internal('confirm', confirmation())).data.order.fulfillmentStatus, 'fulfilled');
  const old = fixtures({ status: 'confirming' }); delete old.hl_payment_orders[0].memberMatchmakerId;
  old.hl_members[0].matchmakerId = 99;
  const legacy = runtime({ rows: old });
  assert.equal((await legacy.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40906);
  assert.equal(legacy.writes.length, 0);
  assert.equal((await legacy.internal('query', { requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal((await legacy.internal('confirm', confirmation())).data.order.fulfillmentStatus, 'requires_review');
  assert.equal(legacy.rows.hl_members[0].memberType, 'free');
});

test('legacy second cashiers cannot bypass the canonical user slot but their real payments still settle', async () => {
  const rows = fixtures();
  const second = { ...rows.hl_payment_orders[0], _id: 'order-2', id: 2, outTradeNo: 'HLM202610080000000002' };
  rows.hl_payment_orders.push(second);
  const r = runtime({ rows });
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).data.order.outTradeNo, orderNumber);
  const writes = r.writes.length;
  assert.equal((await r.internal('checkout', { outTradeNo: second.outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 40905);
  assert.equal(r.writes.length, writes);
  assert.equal((await r.internal('query', { outTradeNo: second.outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
  assert.equal((await r.internal('confirm', confirmation({ outTradeNo: second.outTradeNo }))).code, 0);
  assert.equal(r.rows.hl_payment_orders.find(order => order._id === 'order-2').status, 'paid');
  assert.equal(r.rows.hl_payment_orders[0].status, 'pending');
});

test('a noncanonical legacy payment requiring review blocks the canonical unpaid cashier atomically', async () => {
  const rows = fixtures();
  const second = { ...rows.hl_payment_orders[0], _id: 'order-2', id: 2,
    outTradeNo: 'HLM202610080000000002', memberMatchmakerId: 99 };
  rows.hl_payment_orders.push(second);
  const r = runtime({ rows });
  assert.equal((await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1)).data.order.outTradeNo, orderNumber);
  const review = await r.internal('confirm', confirmation({ outTradeNo: second.outTradeNo }));
  assert.equal(review.data.order.fulfillmentStatus, 'requires_review');
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').blockedReviewDocumentId, 'order-2');
  const beforeCheckout = r.writes.length;
  assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40905);
  assert.equal(r.writes.length, beforeCheckout);
  const blocked = await r.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1);
  assert.equal(blocked.data.order.outTradeNo, second.outTradeNo);
  assert.equal(blocked.data.order.fulfillmentStatus, 'requires_review');
  assert.equal(r.rows.hl_payment_orders.length, 2);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
});

test('native-identity checkout cannot bypass stopped, merged or mismatched application accounts', async () => {
  for (const patch of [{ status: 0 }, { mergedIntoUserId: 2 }, { openid: 'other-openid' }, { phone: '' }]) {
    const r = runtime({ beforeTransaction: rows => Object.assign(rows.hl_users[0], patch) });
    assert.equal((await r.internal('checkout', { requesterOpenid: 'fixture-openid-1' })).code, 40304);
    assert.equal(r.writes.length, 0);
    assert.equal(r.rows.hl_payment_orders[0].status, 'pending');
    const settled = await r.internal('confirm', confirmation());
    assert.equal(settled.code, 0);
    assert.equal(settled.data.order.status, 'paid');
    assert.equal(settled.data.order.fulfillmentStatus, patch.phone === '' ? 'fulfilled' : 'requires_review');
  }
});

test('duplicate historical merchant numbers cannot select an arbitrary owner or plan for checkout or fulfillment', async () => {
  for (const duplicatePatch of [{ planCode: 'paid_90d', amountFen: 24900, durationDays: 90 },
    { userId: 2, payerOpenid: 'fixture-openid-2' }]) {
    const rows = fixtures();
    rows.hl_payment_orders.push({ ...rows.hl_payment_orders[0], _id: 'duplicate', id: 2, ...duplicatePatch });
    const r = runtime({ rows });
    for (const action of ['checkout', 'query', 'confirm', 'close']) {
      const result = await r.internal(action, { ...confirmation(), requesterOpenid: 'fixture-openid-1',
        ...(action === 'close' ? { tradeState: 'CLOSED' } : {}) });
      assert.equal(result.code, 40908);
    }
    assert.equal((await r.call(`/member/payment-orders/${orderNumber}`, 'GET', {}, 1)).code, 40908);
    assert.equal(r.writes.length, 0);
    assert.equal(r.rows.hl_members[0].memberType, 'free');
  }
  const rows = fixtures(); rows.hl_payment_orders.push({ ...rows.hl_payment_orders[0], _id: 'duplicate', id: 2 });
  const r = runtime({ rows });
  assert.equal((await r.call(`/member/payment-orders/${orderNumber}`, 'GET', {}, 2)).code, 40400);
});

test('trusted CLOSED legacy probes restart under a new number and keep the original closed order queryable', async () => {
  const r = controlledPaymentRuntime();
  const initial = await createControlledOrder(r);
  const oldNo = initial.data.order.outTradeNo;
  const original = r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1');
  original.status = 'confirming'; delete original.memberMatchmakerId;
  assert.equal((await r.internal('checkout', { outTradeNo: oldNo, requesterOpenid: 'fixture-openid-1' })).code, 40906);
  assert.equal((await r.internal('close', controlledConfirmation(oldNo, { tradeState: 'CLOSED' }))).code, 0);
  const before = plain(r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1'));
  const resumed = await createControlledOrder(r);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.data.reused, false); assert.equal(resumed.data.recoveryRequired, false);
  assert.notEqual(resumed.data.order.outTradeNo, oldNo);
  const next = r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1');
  assert.equal(next.status, 'pending'); assert.equal(next.memberMatchmakerId, 21);
  assert.equal(next.amountFen, 1); assert.equal(next.durationDays, 1);
  const archive = r.rows.hl_payment_orders.find(order => order._id === `payment_order_${before.id}`);
  const archiveComparable = { ...plain(archive), _id: before._id }; delete archiveComparable.probeArchivedAt;
  assert.deepEqual(archiveComparable, before);
  assert.equal(r.rows.hl_payment_orders.filter(order => order.outTradeNo === oldNo).length, 1);
  assert.equal((await r.internal('query', { outTradeNo: oldNo, requesterOpenid: 'fixture-openid-1' })).data.status, 'closed');
  assert.equal((await r.call(`/member/payment-orders/${oldNo}`, 'GET', {}, 1)).data.status, 'closed');
  assert.equal((await r.call(`/member/payment-orders/${oldNo}`, 'GET', {}, 2)).code, 40400);
  assert.equal((await r.internal('confirm', controlledConfirmation(oldNo))).code, 40905);
  assert.equal((await r.internal('checkout', { outTradeNo: next.outTradeNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
  const confirmed = await r.internal('confirm', controlledConfirmation(next.outTradeNo));
  assert.equal(confirmed.data.order.fulfillmentStatus, 'fulfilled');
  const member = r.rows.hl_members.find(row => row.userId === 1);
  assert.equal(Date.parse(member.expireAt) - Date.parse(member.membershipPaidAt), 24 * 60 * 60 * 1000);
});

test('parallel CLOSED-probe restarts converge on one new cashier and one historical archive', async () => {
  const r = controlledPaymentRuntime();
  const initial = await createControlledOrder(r);
  const oldNo = initial.data.order.outTradeNo;
  assert.equal((await r.internal('close', controlledConfirmation(oldNo, { tradeState: 'CLOSED' }))).code, 0);
  const results = await Promise.all([createControlledOrder(r), createControlledOrder(r), createControlledOrder(r)]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
  assert.equal(new Set(results.map(result => result.data.order.outTradeNo)).size, 1);
  assert.notEqual(results[0].data.order.outTradeNo, oldNo);
  assert.equal(results.filter(result => !result.data.reused).length, 1);
  assert.equal(r.rows.hl_payment_orders.filter(order => order.outTradeNo === oldNo).length, 1);
  assert.equal(r.rows.hl_payment_orders.filter(order => order.outTradeNo === results[0].data.order.outTradeNo).length, 1);
  assert.equal(r.rows.hl_payment_orders.filter(order => order._id === 'payment_probe_user_1').length, 1);
  assert.equal(r.writes.filter(write => write.name === 'hl_counters' && write.id === 'paymentOrderAtomic').length, 2);
  const before = r.writes.length;
  const again = await createControlledOrder(r);
  assert.equal(again.data.reused, true); assert.equal(again.data.order.outTradeNo, results[0].data.order.outTradeNo);
  assert.equal(r.writes.filter(write => write.name === 'hl_counters' && write.id === 'paymentOrderAtomic').length, 2);
  assert.equal(r.writes.slice(before).filter(write => write.name === 'hl_payment_orders').length, 0);
});

test('paid, refunded, failed and unresolved legacy probes cannot use CLOSED recovery', async () => {
  for (const status of ['paid', 'refunded', 'failed', 'confirming']) {
    const r = controlledPaymentRuntime();
    const created = await createControlledOrder(r);
    const probe = r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1');
    probe.status = status; delete probe.memberMatchmakerId;
    const before = r.writes.length;
    const attempted = await createControlledOrder(r);
    if (status === 'confirming') {
      assert.equal(attempted.code, 0); assert.equal(attempted.data.recoveryRequired, true);
      assert.equal(attempted.data.order.outTradeNo, created.data.order.outTradeNo);
      assert.equal((await r.internal('checkout', { outTradeNo: created.data.order.outTradeNo,
        requesterOpenid: 'fixture-openid-1' })).code, 40906);
    } else assert.equal(attempted.code, 40905);
    assert.equal(r.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, 1);
    assert.equal(r.writes.slice(before).filter(write => write.name === 'hl_payment_orders').length, 0);
  }
  for (const patch of [{ tradeState: undefined }, { transactionId: 'already-paid-transaction' },
    { paidAt: '2026-10-10T00:00:00.000Z' }, { fulfillmentStatus: 'fulfilled' }, { fulfillmentStatus: 'requires_review' }]) {
    const r = controlledPaymentRuntime();
    const created = await createControlledOrder(r);
    await r.internal('close', controlledConfirmation(created.data.order.outTradeNo, { tradeState: 'CLOSED' }));
    Object.assign(r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1'), patch);
    const before = r.writes.length;
    assert.equal((await createControlledOrder(r)).code, 40905);
    assert.equal(r.writes.length, before);
    assert.equal(r.rows.hl_payment_orders.filter(order => order.planCode === 'hl_payment_probe').length, 1);
  }
});

test('CLOSED-probe recovery validates existing archives and never overwrites a conflicting historical order', async () => {
  for (const conflict of [false, true]) {
    const r = controlledPaymentRuntime();
    const created = await createControlledOrder(r);
    const oldNo = created.data.order.outTradeNo;
    await r.internal('close', controlledConfirmation(oldNo, { tradeState: 'CLOSED' }));
    const probe = r.rows.hl_payment_orders.find(order => order._id === 'payment_probe_user_1');
    const archive = { ...plain(probe), _id: `payment_order_${probe.id}`, probeArchivedAt: '2026-10-10T00:00:00.000Z',
      ...(conflict ? { outTradeNo: 'DIFFERENT_HISTORICAL_ORDER', payerOpenid: 'another-payer', amountFen: 999 } : {}) };
    r.rows.hl_payment_orders.push(archive);
    const before = plain(r.rows), beforeWrites = r.writes.length;
    const recovered = await createControlledOrder(r);
    if (conflict) {
      assert.equal(recovered.code, 40908); assert.deepEqual(plain(r.rows), before);
      assert.equal(r.writes.length, beforeWrites);
    } else {
      assert.equal(recovered.code, 0); assert.notEqual(recovered.data.order.outTradeNo, oldNo);
      assert.equal(r.rows.hl_payment_orders.filter(order => order.outTradeNo === oldNo).length, 1);
      assert.deepEqual(plain(r.rows.hl_payment_orders.find(order => order._id === archive._id)), archive);
      assert.equal((await r.internal('query', { outTradeNo: oldNo, requesterOpenid: 'fixture-openid-1' })).code, 0);
    }
  }
});

test('CLOSED recovery is limited to an active controlled test and leaves ordinary checkout behavior unchanged', async () => {
  const expired = controlledPaymentRuntime();
  const created = await createControlledOrder(expired);
  await expired.internal('close', controlledConfirmation(created.data.order.outTradeNo, { tradeState: 'CLOSED' }));
  expired.env.PAYMENT_TEST_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
  const before = plain(expired.rows), writes = expired.writes.length;
  assert.equal((await createControlledOrder(expired)).code, 50301);
  assert.deepEqual(plain(expired.rows), before); assert.equal(expired.writes.length, writes);
  const ordinary = runtime({ rows: fixtures({ status: 'closed', tradeState: 'CLOSED' }) });
  const saved = plain(ordinary.rows.hl_payment_orders[0]);
  const next = await ordinary.call('/member/payment-orders', 'POST', { planCode: 'paid_30d' }, 1);
  assert.equal(next.code, 0); assert.notEqual(next.data.order.outTradeNo, saved.outTradeNo);
  assert.equal(next.data.order.amountFen, 9900);
  assert.deepEqual(plain(ordinary.rows.hl_payment_orders[0]), saved);
  assert.equal(ordinary.rows.hl_payment_orders.some(order => order.probeArchivedAt), false);
});
