'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };
const ORDER_NO = 'HLM202610110000000001';
const ATTEMPT_NO = 'HLAfixtureattempt000000001';
const OPENID = 'fixture-virtual-payer-1';
const TRANSACTION_ID = 'fixture-virtual-transaction-001';
const ENV = { NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false',
  VPAY_OFFER_ID: '1450674507', VPAY_ENV: '0', VPAY_APP_KEY: 'fixture-vpay-app-key-0123456789',
  VPAY_SANDBOX_APP_KEY: 'fixture-sandbox-app-key-0123456789', WX_APP_SECRET: 'fixture-app-secret-0123456789',
  PAYMENT_CALLBACK_TOKEN: 'fixture-callback-token-01234567890123456789', PAYMENT_INTEGRATION_READY: 'true' };

function paidOrder(patch = {}) {
  return { order_id: ATTEMPT_NO, status: 2, order_type: 0, order_fee: 9900, paid_fee: 9900,
    env_type: 1, paid_time: Math.floor(Date.now() / 1000), wxpay_order_id: TRANSACTION_ID, ...patch };
}

function pushEvent(patch = {}) {
  return { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: OPENID,
    OutTradeNo: ATTEMPT_NO, Env: 0, GoodsInfo: { ProductId: 'paid_30d', Quantity: 1, ActualPrice: 9900 }, ...patch };
}

function runtime(options = {}) {
  const rows = {
    hl_users: [{ _id: 'user-1', id: 1, status: 1, authVersion: 1, openid: OPENID, phone: 'fixture-phone' }],
    hl_members: [{ _id: 'member-11', id: 11, userId: 1, matchmakerId: options.reassigned ? 22 : 21,
      status: 1, memberType: 'free', expireAt: null }],
    hl_payment_orders: [{ _id: 'order-1', id: 1, outTradeNo: ORDER_NO, userId: 1, memberRecordId: 11,
      memberMatchmakerId: 21, payerOpenid: OPENID, planCode: 'paid_30d', planTitle: '月度会员',
      amountFen: 9900, durationDays: 30, status: 'confirming', transactionId: '',
      createdAt: '2026-11-03T01:00:00Z', updatedAt: '2026-11-03T01:00:00Z', ...identity,
      paymentProvider: 'virtual', virtualPaymentEnv: 0, virtualPaymentOfferId: ENV.VPAY_OFFER_ID,
      virtualProviderOrderNo: ATTEMPT_NO,
      virtualPaymentAttempts: [{ outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }],
      ...(options.orderPatch || {}) }]
  };
  rows.hl_counters = (rows.hl_payment_orders[0].virtualPaymentAttempts || []).map(attempt => ({
    _id: `virtualPaymentAttempt_${attempt.outTradeNo}`, key: `virtualPaymentAttempt_${attempt.outTradeNo}`,
    orderDocumentId: rows.hl_payment_orders[0]._id, businessOutTradeNo: ORDER_NO, env: attempt.env, offerId: attempt.offerId
  }));
  const writes = [], queries = [], deliveries = [], logs = [];
  let transactionTail = Promise.resolve();
  const env = { ...ENV, ...(options.env || {}) };
  const op = (kind, value) => ({ kind, value });
  function matches(row, query) {
    if (query.kind === 'and') return query.value.every(part => matches(row, part));
    if (query.kind === 'or') return query.value.some(part => matches(row, part));
    return Object.entries(query).every(([key, expected]) => {
      const value = row[key];
      if (!expected || !expected.kind) return value === expected;
      if (expected.kind === 'in') return expected.value.includes(value);
      if (expected.kind === 'nin') return !expected.value.includes(value);
      if (expected.kind === 'gt') return value > expected.value;
      if (expected.kind === 'exists') return Object.hasOwn(row, key) === expected.value;
      if (expected.kind === 'regex') return new RegExp(expected.value.regexp, expected.value.options).test(String(value || ''));
      throw new Error(`Unexpected query ${expected.kind}`);
    });
  }
  function collection(name) {
    let query = {}, offset = 0, size = 100, fields;

    const ref = {
      where(value) { query = value; return ref; },
      skip(value) { offset = value; return ref; },
      limit(value) { size = value; return ref; },
      field(value) { fields = value; return ref; },
      orderBy() { return ref; },
      async count() { return { total: (rows[name] || []).filter(row => matches(row, query)).length }; },
      async get() {
        let selected = (rows[name] || []).filter(row => matches(row, query)).slice(offset, offset + size);
        if (fields) selected = selected.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])));
        return { data: structuredClone(selected) };
      },
      doc(id) {
        const current = () => (rows[name] || []).find(row => row._id === id);
        return {
          async get() {
            const row = current();
            if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            if (Object.hasOwn(data, '_id')) {
              throw Object.assign(new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值'),
                { errCode: -501007, errMsg: 'document.set:fail -501007 invalid parameters. 不能更新_id的值' });
            }
            const list = rows[name] ||= [];
            const index = list.findIndex(row => row._id === id);
            const saved = { ...structuredClone(data), _id: id };
            if (index < 0) list.push(saved); else list[index] = saved;
            writes.push({ name, id, data: structuredClone(data) });
          },
          async update({ data }) {
            if (options.failDeliveryWrite && data.virtualDeliveryStatus === 'confirmed') {
              throw new Error('fixture delivery-status write failure');
            }
            Object.assign(current(), structuredClone(data));
            writes.push({ name, id, data: structuredClone(data) });
          }
        };
      }
    };
    return ref;
  }
  const db = { collection, command: Object.fromEntries(['inc', 'and', 'or', 'in', 'nin', 'gt', 'exists'].map(kind => [kind, value => op(kind, value)])),
    RegExp: value => op('regex', value), async createCollection() {},
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
        if (options.beforeTransaction) await options.beforeTransaction(rows);
        const saved = structuredClone(rows), count = writes.length;
        try { return await callback({ collection: name => ({ doc: id => collection(name).doc(id) }) }); }
        catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); writes.splice(count); throw error; }
      });
      transactionTail = run.catch(() => {});
      return run;
    } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership, memberOrders, memberOrderDto, MEMBER_ORDER_FIELDS, allocateVirtualPaymentAttempt, trustedPaymentOrder };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log(value) { logs.push(value); }, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID }) };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'fixture-token-secret-01234567890123456789' }) };
      }
      if (name === './virtual-payment-policy') {
        return { ...requireFromApi(name), createVirtualPaymentClient: () => ({
          accessToken: async () => 'fixture-access-token-0123456789',
          queryOrder: async request => { queries.push({ ...request, appSecret: undefined, appKey: undefined });
            return typeof options.query === 'function' ? options.query(request) : options.xpay === undefined ? paidOrder() : structuredClone(options.xpay); },
          notifyProvideGoods: async request => {
            deliveries.push({ ...request, appSecret: undefined, appKey: undefined });
            if (options.notify) await options.notify(request, deliveries.length);
          }
        }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const hooks = module.exports.__test;
  return { rows, writes, queries, deliveries, logs, env, options, hooks,
    cancel: (userId = 1) => hooks.membership.cancelOrder(userId, ORDER_NO),
    cancelWithoutAuth: () => module.exports.main({ path: `/member/payment-orders/${ORDER_NO}/cancel`, method: 'POST' }),
    cancelApi: (data = {}) => module.exports.main({ path: `/member/payment-orders/${ORDER_NO}/cancel`, method: 'POST', data,
      token: hooks.tokenService.sign({ userId: 1, authVersion: 1 }, { type: 'access' }) }),
    push: (event, context) => module.exports.main(event || pushEvent(), context),
    close: data => module.exports.__test.membership.closePayment({ ...identity, callbackToken: ENV.PAYMENT_CALLBACK_TOKEN, paymentProvider: 'virtual',
      outTradeNo: ORDER_NO, payerOpenid: OPENID, amountFen: 9900, tradeState: 'CLOSED', ...data }),
    query: () => module.exports.__test.membership.virtualQuery(1, { outTradeNo: ORDER_NO }) };
}

const plain = value => JSON.parse(JSON.stringify(value));
const slot = r => r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1');
function reserve(r, orderDocumentId = 'order-1') {
  r.rows.hl_counters.push({ _id: 'paymentPendingUser_1', key: 'paymentPendingUser_1', userId: 1, orderDocumentId });
}
function unissued(patch = {}) {
  return runtime({ orderPatch: { status: 'pending', virtualPaymentAttempts: [], virtualProviderOrderNo: '', ...patch } });
}

test('owner cancels an unissued order atomically, releases only its slot, and repeated cancellation is idempotent', async () => {
  for (const status of ['pending', 'confirming']) {
    const r = unissued({ status }); reserve(r);
    const cancelled = await r.cancel();
    assert.equal(cancelled.status, 'closed'); assert.equal(cancelled.cancelReason, 'user_requested');
    assert.ok(Number.isFinite(Date.parse(cancelled.cancelledAt)));
    assert.equal(cancelled.tradeState, undefined, 'local cancellation must not fabricate provider CLOSED');
    assert.equal(cancelled.cancellationProof, undefined); assert.equal(cancelled.payerOpenid, undefined);
    assert.equal(cancelled.virtualPaymentAttempts, undefined); assert.equal(slot(r).orderDocumentId, '');
    assert.equal(r.rows.hl_payment_orders[0].cancellationProof, 'no_payment_attempts');
    const writes = r.writes.length;
    assert.deepEqual(plain(await r.cancel()), plain(cancelled));
    assert.equal(r.writes.length, writes); assert.equal(r.queries.length, 0);
  }
  const newer = unissued(); reserve(newer, 'newer-order');
  await newer.cancel(); assert.equal(slot(newer).orderDocumentId, 'newer-order');
});

test('already closed or failed orders become user-cancelled while retaining platform audit facts', async () => {
  for (const [status, tradeState] of [['closed', 'CLOSED'], ['failed', 'PAYERROR']]) {
    const r = runtime({ orderPatch: { status, tradeState, closedAt: '2026-11-03T02:00:00Z' } });
    const cancelled = await r.cancel();
    assert.equal(cancelled.status, 'closed'); assert.equal(cancelled.tradeState, tradeState);
    assert.equal(cancelled.closedAt, '2026-11-03T02:00:00Z'); assert.ok(cancelled.cancelledAt);
    assert.equal(r.queries.length, 0);
  }
});

test('cancellation rejects foreign orders, paid/refunded/review states and unknown historical attempt ledgers', async () => {
  const foreign = unissued(); foreign.rows.hl_users.push({ _id: 'user-2', id: 2, openid: 'foreign-user', status: 1 });
  await assert.rejects(() => foreign.cancel(2), error => error.code === 40400);
  assert.equal(foreign.writes.length, 0);
  for (const patch of [{ status: 'paid' }, { status: 'refunded' }, { status: 'closed', transactionId: TRANSACTION_ID },
    { status: 'closed', paidAt: '2026-11-03T02:00:00Z' }, { status: 'confirming', paymentReviewRequired: true },
    { status: 'closed', fulfillmentStatus: 'requires_review' }, { status: 'confirming', fulfillmentStatus: 'fulfilled' },
    { status: 'mystery' }]) {
    const r = unissued(patch); reserve(r);
    await assert.rejects(r.cancel, error => [40905, 40906].includes(error.code));
    assert.equal(r.writes.length, 0); assert.equal(slot(r).orderDocumentId, 'order-1');
  }
  for (const patch of [{ virtualPaymentAttempts: undefined }, { virtualPaymentAttempts: [], virtualProviderOrderNo: ATTEMPT_NO },
    { paymentProvider: 'jsapi', virtualPaymentAttempts: [] },
    { paymentProvider: undefined, virtualPaymentAttempts: undefined }]) {
    const r = runtime({ orderPatch: patch, xpay: null }); reserve(r);
    await assert.rejects(r.cancel, error => error.code === 40905);
    assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined);
    assert.equal(slot(r).orderDocumentId, 'order-1');
  }
});

test('malformed or conflicting attempt ledgers cannot be treated as evidence of an unpaid order', async () => {
  const attempt = { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID };
  for (const attempts of [null, {}, 'invalid', [null], [{}], [{ ...attempt, outTradeNo: 'bad number!' }],
    [{ ...attempt, env: 1 }], [{ ...attempt, offerId: 'different-offer' }], [attempt, attempt],
    Array.from({ length: 11 }, (_, index) => ({ ...attempt, outTradeNo: `HLAfixture${String(index).padStart(20, '0')}` }))]) {
    const r = runtime({ xpay: null });
    r.rows.hl_payment_orders[0].virtualPaymentAttempts = attempts;
    reserve(r);
    const response = await r.cancelApi();
    assert.notEqual(response.code, 0);
    assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined);
    assert.equal(slot(r).orderDocumentId, 'order-1');
    assert.equal(r.writes.length, 0);
  }
});

test('issued orders can be cancelled after every attempt is absent, unpaid or closed without discarding payment evidence', async () => {
  for (const states of [[null], [1], [6], [null, 1], [6, 1], [1, null], [6, 6], [null, 1, 6]]) {
    const attempts = states.map((state, index) => ({ outTradeNo: `HLAfixtureattempt${String(index + 1).padStart(9, '0')}`,
      env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: '2026-10-15T00:00:00Z' }));
    const r = runtime({ orderPatch: { virtualPaymentAttempts: attempts }, query: async request => {
      const state = states[attempts.findIndex(attempt => attempt.outTradeNo === request.outTradeNo)];
      return state === null ? null : paidOrder({ order_id: request.outTradeNo, status: state });
    } });
    reserve(r);
    const mappings = plain(r.rows.hl_counters.filter(row => row._id.startsWith('virtualPaymentAttempt_')));
    const cancelled = await r.cancel();
    assert.equal(cancelled.status, 'closed'); assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.cancelReason, 'user_requested');
    assert.deepEqual(r.queries.map(query => query.outTradeNo).sort(), attempts.map(attempt => attempt.outTradeNo).sort());
    assert.deepEqual(plain(r.rows.hl_payment_orders[0].virtualPaymentAttempts), attempts);
    assert.deepEqual(plain(r.rows.hl_counters.filter(row => row._id.startsWith('virtualPaymentAttempt_'))), mappings);
    assert.equal(slot(r).orderDocumentId, '');
    assert.equal(r.rows.hl_members[0].memberType, 'free');
    assert.equal(r.deliveries.length, 0);
    if (states.some(state => state !== 6)) assert.notEqual(cancelled.tradeState, 'CLOSED');
    const queried = await r.query();
    assert.equal(queried.order.status, 'closed');
    assert.equal(queried.order.cancelledAt, cancelled.cancelledAt);
    assert.equal(queried.order.cancelReason, 'user_requested');
    assert.equal(queried.tradeState, undefined);
    assert.equal(queried.providerOrderAbsent, undefined);
    if (states.some(state => state !== 6)) assert.notEqual(queried.tradeState, 'CLOSED');
    const writes = r.writes.length, queries = r.queries.length;
    assert.deepEqual(plain(await r.cancel()), plain(cancelled));
    assert.equal(r.writes.length, writes);
    assert.equal(r.queries.length, queries);
  }
});

test('a refunded, unknown or failed provider query prevents cancellation and retains the reservation', async () => {
  const newer = 'HLAfixtureattempt000000002';
  for (const pending of [paidOrder({ order_id: newer, status: 5 }), paidOrder({ order_id: newer, status: 8 }),
    paidOrder({ order_id: newer, status: 0 }), paidOrder({ order_id: newer, status: 7 }),
    paidOrder({ order_id: newer, status: 99 }), new Error('provider timeout')]) {
    const r = runtime({ orderPatch: { virtualPaymentAttempts: [
      { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID }, { outTradeNo: newer, env: 0, offerId: ENV.VPAY_OFFER_ID }
    ] }, query: async request => {
      if (request.outTradeNo === ATTEMPT_NO) return paidOrder({ status: 6 });
      if (pending instanceof Error) throw pending;
      return pending;
    } }); reserve(r);
    await assert.rejects(r.cancel);
    assert.equal(r.rows.hl_payment_orders[0].status, 'confirming'); assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined);
    assert.equal(slot(r).orderDocumentId, 'order-1'); assert.equal(r.writes.length, 0);
  }
});

test('a new attempt appearing during the CLOSED query prevents cancellation and retains its reservation', async () => {
  const newer = 'HLAfixtureattempt000000002'; let appended = false; let r;
  r = runtime({ query: async () => {
    if (!appended) {
      appended = true;
      r.rows.hl_payment_orders[0].virtualPaymentAttempts.push({ outTradeNo: newer, env: 0, offerId: ENV.VPAY_OFFER_ID });
    }
    return paidOrder({ status: 6 });
  } }); reserve(r);
  await assert.rejects(r.cancel, error => error.code === 40905);
  assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
  assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined); assert.equal(slot(r).orderDocumentId, 'order-1');
});

test('transaction rechecks new signed attempts or payment facts committed after the initial cancellation read', async () => {
  for (const change of ['attempt', 'paid', 'owner']) {
    let changed = false;
    const r = runtime({ orderPatch: { status: 'pending', virtualPaymentAttempts: [], virtualProviderOrderNo: '' },
      beforeTransaction: rows => {
        if (changed) return; changed = true;
        if (change === 'attempt') rows.hl_payment_orders[0].virtualPaymentAttempts.push({ outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID });
        else if (change === 'paid') Object.assign(rows.hl_payment_orders[0], { status: 'paid', transactionId: TRANSACTION_ID });
        else rows.hl_payment_orders[0].userId = 2;
      } }); reserve(r);
    await assert.rejects(r.cancel, error => [40905, 40400].includes(error.code));
    assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined); assert.equal(slot(r).orderDocumentId, 'order-1');
  }
});

test('cancellation rejects payment snapshots changed after provider queries and never releases their reservation', async () => {
  for (const change of ['attempt', 'attempt_environment', 'provider_number', 'status', 'payment', 'owner', 'amount']) {
    let changed = false;
    const r = runtime({ xpay: paidOrder({ status: 1 }), beforeTransaction: rows => {
      if (changed) return;
      changed = true;
      const current = rows.hl_payment_orders[0];
      if (change === 'attempt') current.virtualPaymentAttempts.push({ outTradeNo: 'HLAfixtureattempt000000002', env: 0, offerId: ENV.VPAY_OFFER_ID });
      else if (change === 'attempt_environment') current.virtualPaymentAttempts[0].env = 1;
      else if (change === 'provider_number') current.virtualProviderOrderNo = 'HLAfixtureattempt000000002';
      else if (change === 'status') current.status = 'failed';
      else if (change === 'payment') current.transactionId = TRANSACTION_ID;
      else if (change === 'owner') current.userId = 2;
      else current.amountFen += 100;
    } });
    reserve(r);
    await assert.rejects(r.cancel, error => [40304, 40400, 40905, 40907].includes(error.code), change);
    assert.equal(changed, true, 'provider checks must finish before exercising the transaction race');
    assert.equal(r.queries.length, 1, change);
    assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined, change);
    assert.equal(slot(r).orderDocumentId, 'order-1', change);
    assert.equal(r.writes.length, 0, change);
  }
});

test('late verified payment discovered while cancelling is fulfilled and never reported as cancelled', async () => {
  const r = runtime(); reserve(r);
  await assert.rejects(r.cancel, error => error.code === 40905);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined);
  assert.equal(r.deliveries.length, 1);
});

test('a cancelled unissued order can be queried locally without provider configuration and can never allocate a cashier', async () => {
  const r = unissued(); await r.cancel();
  r.env.VPAY_APP_KEY = '';
  const queried = await r.query();
  assert.equal(queried.order.status, 'closed'); assert.ok(queried.order.cancelledAt);
  assert.equal(queried.tradeState, undefined); assert.equal(r.queries.length, 0);
  r.env.VPAY_APP_KEY = ENV.VPAY_APP_KEY;
  const trusted = r.hooks.trustedPaymentOrder(r.rows.hl_payment_orders[0], OPENID);
  await assert.rejects(() => r.hooks.allocateVirtualPaymentAttempt(trusted,
    { env: 0, offerId: ENV.VPAY_OFFER_ID }, []), error => error.code === 40905);
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 0);
});

test('member history projection exposes only valid cancellation fields and leaves older DTO shapes unchanged', async () => {
  const r = unissued();
  const before = r.hooks.memberOrderDto(r.rows.hl_payment_orders[0], 1);
  assert.equal(Object.hasOwn(before, 'cancelledAt'), false); assert.equal(Object.hasOwn(before, 'cancelReason'), false);
  await r.cancel();
  const projected = Object.fromEntries(Object.entries(r.rows.hl_payment_orders[0]).filter(([key]) => r.hooks.MEMBER_ORDER_FIELDS[key]));
  const dto = r.hooks.memberOrderDto(projected, 1);
  assert.equal(dto.cancelledAt, r.rows.hl_payment_orders[0].cancelledAt); assert.equal(dto.cancelReason, 'user_requested');
  assert.equal(dto.cancellationProof, undefined); assert.equal(dto.status, 'closed');
  const detail = await r.hooks.memberOrders.detail(1, ORDER_NO);
  const list = await r.hooks.memberOrders.list(1);
  assert.equal(detail.cancelledAt, dto.cancelledAt);
  assert.equal(list.list[0].cancelledAt, dto.cancelledAt);
  assert.equal(list.list[0].cancelReason, 'user_requested');
});

test('the public cancel route ignores client terminal proofs and requires authentication', async () => {
  const r = runtime({ xpay: paidOrder({ status: 0 }) }); reserve(r);
  const unauthorized = await r.cancelWithoutAuth();
  assert.equal(unauthorized.code, 40100); assert.equal(r.writes.length, 0);
  const response = await r.cancelApi({ tradeState: 'CLOSED', status: 'closed', cancelledAt: 'forged' });
  assert.equal(response.code, 40905); assert.equal(r.rows.hl_payment_orders[0].cancelledAt, undefined);
  const empty = unissued();
  const success = await empty.cancelApi();
  assert.equal(success.code, 0); assert.equal(success.data.cancelReason, 'user_requested');
});


test('a verified late payment after user cancellation is recorded for review without issuing duplicate rights', async () => {
  let paid = false;
  const r = runtime({ query: async () => paidOrder({ status: paid ? 2 : 1 }) }); reserve(r);
  const cancelled = await r.cancel();
  assert.equal(cancelled.status, 'closed');
  const next = { ...r.rows.hl_payment_orders[0], _id: 'order-2', id: 2, outTradeNo: 'HLM202610110000000002',
    status: 'pending', virtualPaymentAttempts: [], virtualProviderOrderNo: '' };
  delete next.cancelledAt; delete next.cancelReason; delete next.cancellationProof;
  r.rows.hl_payment_orders.push(next);
  slot(r).orderDocumentId = 'order-2';
  paid = true;
  const result = await r.query();
  assert.equal(result.order.status, 'paid');
  assert.equal(result.order.fulfillmentStatus, 'requires_review');
  assert.equal(result.order.reviewReason, 'payment_after_cancellation');
  assert.equal(result.order.paymentReviewRequired, true);
  assert.equal(result.order.cancelledAt, cancelled.cancelledAt, 'cancellation remains audit history, not the final payment state');
  assert.equal(r.rows.hl_members[0].memberType, 'free'); assert.equal(r.deliveries.length, 0);
  assert.equal(slot(r).blockedReviewDocumentId, 'order-1');
  assert.equal(slot(r).orderDocumentId, 'order-2', 'newer order ownership must survive the review marker');
  const nextTrusted = r.hooks.trustedPaymentOrder(next, OPENID);
  await assert.rejects(() => r.hooks.allocateVirtualPaymentAttempt(nextTrusted,
    { env: 0, offerId: ENV.VPAY_OFFER_ID }, []), error => error.code === 40906);
  assert.equal(r.rows.hl_payment_orders[1].virtualPaymentAttempts.length, 0);
  assert.equal((await r.query()).order.status, 'paid', 'verified repeat query is idempotent');
  await assert.rejects(r.cancel, error => error.code === 40905);
});

test('a payment push after cancelling a provider-absent order records review without fulfilling or delivering goods', async () => {
  let paid = false;
  const r = runtime({ query: async () => paid ? paidOrder() : null }); reserve(r);
  const cancelled = await r.cancel();
  assert.equal(cancelled.status, 'closed');
  assert.notEqual(cancelled.tradeState, 'CLOSED');
  paid = true;
  await r.push();
  const current = r.rows.hl_payment_orders[0];
  assert.equal(current.status, 'paid');
  assert.equal(current.transactionId, TRANSACTION_ID);
  assert.equal(current.paymentReviewRequired, true);
  assert.equal(current.fulfillmentStatus, 'requires_review');
  assert.equal(current.reviewReason, 'payment_after_cancellation');
  assert.equal(current.cancelledAt, cancelled.cancelledAt);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.deliveries.length, 0);
  assert.equal(slot(r).blockedReviewDocumentId, 'order-1');
});

test('a cancelled-order query returns a payment callback committed while its unpaid provider query was in flight', async () => {
  let callbackDuringQuery = false, insideCallback = false, r;
  r = runtime({ query: async () => {
    if (insideCallback) return paidOrder();
    if (callbackDuringQuery) {
      callbackDuringQuery = false;
      insideCallback = true;
      try { await r.push(); } finally { insideCallback = false; }
    }
    return paidOrder({ status: 1 });
  } }); reserve(r);
  const cancelled = await r.cancel();
  callbackDuringQuery = true;
  const result = await r.query();
  assert.equal(result.order.status, 'paid');
  assert.equal(result.order.transactionId, TRANSACTION_ID);
  assert.equal(result.order.fulfillmentStatus, 'requires_review');
  assert.equal(result.order.reviewReason, 'payment_after_cancellation');
  assert.equal(result.order.cancelledAt, cancelled.cancelledAt);
  assert.equal(result.tradeState, undefined);
  assert.equal(result.providerOrderAbsent, undefined);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.deliveries.length, 0);
  assert.equal(slot(r).blockedReviewDocumentId, 'order-1');
});

test('cancelled-order queries reject changed payment attempts and unverified provider states without undoing cancellation', async () => {
  for (const change of ['attempt', 'refund', 'unknown', 'query_error']) {
    let changed = false, r;
    r = runtime({ query: async request => {
      if (!changed) return paidOrder({ status: 1 });
      if (change === 'query_error') throw new Error('provider timeout');
      if (change === 'attempt') {
        r.rows.hl_payment_orders[0].virtualPaymentAttempts.push({ outTradeNo: 'HLAfixtureattempt000000002',
          env: 0, offerId: ENV.VPAY_OFFER_ID });
      }
      return paidOrder({ order_id: request.outTradeNo, status: change === 'refund' ? 5 : change === 'unknown' ? 99 : 1 });
    } }); reserve(r);
    const cancelled = await r.cancel();
    const writes = r.writes.length;
    changed = true;
    await assert.rejects(r.query, change);
    assert.equal(r.rows.hl_payment_orders[0].status, 'closed', change);
    assert.equal(r.rows.hl_payment_orders[0].cancelledAt, cancelled.cancelledAt, change);
    assert.equal(r.writes.length, writes, change);
    assert.equal(slot(r).orderDocumentId, '', change);
  }
});


test('already terminal unissued orders remain locally queryable after user cancellation without claiming provider closure', async () => {
  for (const status of ['closed', 'failed']) {
    const r = unissued({ status });
    await r.cancel();
    const result = await r.query();
    assert.equal(result.order.status, 'closed');
    assert.ok(result.order.cancelledAt);
    assert.equal(result.tradeState, undefined);
    assert.equal(r.queries.length, 0);
  }
});
