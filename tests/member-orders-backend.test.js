'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = process.env.HL_API_TEST_PATH ? path.resolve(process.env.HL_API_TEST_PATH)
  : path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const apiRequire = createRequire(apiPath);
const plain = value => JSON.parse(JSON.stringify(value));

function order(id, extra = {}) {
  return { _id: `payment_order_${id}`, id, userId: 1, outTradeNo: `HLM_ORDER_${String(id).padStart(8, '0')}`,
    planCode: 'vip_week', planTitle: 'VIP周卡', amountFen: 6160, durationDays: 7, productType: 'vip',
    status: 'pending', fulfillmentStatus: '', fulfillmentMessage: '', paymentProvider: 'virtual', virtualPaymentEnv: 0,
    createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', paidAt: null,
    payerOpenid: 'SECRET_PAYER_OPENID', merchantId: 'SECRET_MERCHANT', appId: 'SECRET_APP_ID',
    virtualPaymentOfferId: 'SECRET_OFFER', virtualPaymentAttempts: [{ outTradeNo: 'SECRET_ATTEMPT' }],
    memberRecordId: 98, memberMatchmakerId: 99, callbackToken: 'SECRET_CALLBACK', internalNotes: 'SECRET_INTERNAL',
    ...extra };
}

function runtime(input = [], options = {}) {
  const rows = { hl_users: [{ _id: 'user_1', id: 1, status: 1, authVersion: 1 },
    { _id: 'user_2', id: 2, status: 1, authVersion: 1 }], hl_payment_orders: structuredClone(input), ...(options.rows || {}) };
  const reads = [], writes = [], external = [];
  const op = (kind, value) => ({ kind, value });
  function matchesValue(actual, expected) {
    if (!expected || typeof expected !== 'object' || !expected.kind) return actual === expected;
    if (expected.kind === 'in') return expected.value.includes(actual);
    if (expected.kind === 'nin') return !expected.value.includes(actual);
    if (expected.kind === 'exists') return (actual !== undefined) === expected.value;
    if (expected.kind === 'gt') return actual > expected.value;
    if (expected.kind === 'regex') return typeof actual === 'string' && new RegExp(expected.value.regexp, expected.value.options || '').test(actual);
    throw new Error(`unhandled fixture command ${expected.kind}`);
  }
  function matches(row, query) {
    if (!query) return true;
    if (query.kind === 'and') return query.value.every(part => matches(row, part));
    if (query.kind === 'or') return query.value.some(part => matches(row, part));
    return Object.entries(query).every(([field, expected]) => matchesValue(row[field], expected));
  }
  function forbidden(name) { writes.push(name); throw new Error('read-only route attempted a write'); }
  function collection(name) {
    const state = { query: null, fields: null, offset: 0, limit: 100, order: [] };
    const ref = {
      where(value) { state.query = value; return ref; }, field(value) { state.fields = value; return ref; },
      skip(value) { state.offset = value; return ref; }, limit(value) { assert.ok(value <= 100); state.limit = value; return ref; },
      orderBy(field, direction) { state.order.push([field, direction]); return ref; },
      async count() {
        if (options.failCollection === name) throw new Error('fixture database unavailable');
        const selected = (rows[name] || []).filter(row => matches(row, state.query));
        reads.push({ name, kind: 'count', ...plain(state), total: selected.length });
        return { total: selected.length };
      },
      async get() {
        if (options.failCollection === name) throw new Error('fixture database unavailable');
        let selected = (rows[name] || []).filter(row => matches(row, state.query));
        if (state.order.length) selected = [...selected].sort((a, b) => {
          for (const [field, direction] of state.order) {
            const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
            if (cmp) return cmp * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        selected = selected.slice(state.offset, state.offset + state.limit);
        reads.push({ name, kind: 'get', ...plain(state), returned: selected.length });
        if (state.fields) selected = selected.map(row => Object.fromEntries(Object.keys(state.fields)
          .filter(field => state.fields[field] && field in row).map(field => [field, row[field]])));
        return { data: structuredClone(selected) };
      },
      add() { return forbidden('add'); }, update() { return forbidden('update'); }, remove() { return forbidden('remove'); },
      doc() { return { set() { return forbidden('set'); }, update() { return forbidden('doc.update'); } }; }
    };
    return ref;
  }
  const db = { collection, command: Object.fromEntries(['in', 'nin', 'exists', 'gt', 'and', 'or'].map(kind => [kind, value => op(kind, value)])),
    RegExp: value => op('regex', value), createCollection: () => forbidden('createCollection'),
    runTransaction: () => forbidden('runTransaction') };
  const fixtureModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__memberOrderTest={tokenService};', {
    module: fixtureModule, exports: fixtureModule.exports, Buffer, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'test', AUTO_CREATE_COLLECTIONS: 'true', DEMO_MEMBERS: 'true', SEED_DATA: 'true' } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db,
        callFunction() { external.push('callFunction'); throw new Error('external call forbidden'); },
        getTempFileURL() { external.push('getTempFileURL'); throw new Error('external call forbidden'); } };
      if (name === './auth-policy') {
        const actual = apiRequire(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'member-orders-fixture-secret-over-32-characters' }) };
      }
      if (name === './virtual-payment-policy') return { ...apiRequire(name),
        createVirtualPaymentClient() { external.push('paymentClient'); throw new Error('PSP forbidden'); } };
      return apiRequire(name);
    }
  }, { filename: apiPath });
  const token = (userId, extra = {}, type = 'access') => fixtureModule.exports.__memberOrderTest.tokenService
    .sign({ userId, authVersion: 1, ...extra }, { type });
  const call = (route = '/member/orders', data = {}, userId = 1, options = {}) => fixtureModule.exports.main({
    path: route, method: options.method || 'GET', data,
    token: options.token === undefined ? userId ? token(userId) : '' : options.token
  });
  return { rows, reads, writes, external, call, token };
}

test('member order reads require an active current ACCESS session before any initialization or order read', async () => {
  for (const setting of ['missing', 'inactive', 'merged', 'stale', 'admin']) {
    const r = runtime([order(1)]);
    let options = {};
    if (setting === 'inactive') r.rows.hl_users[0].status = 0;
    if (setting === 'merged') r.rows.hl_users[0].mergedIntoUserId = 2;
    if (setting === 'stale') r.rows.hl_users[0].authVersion = 2;
    if (setting === 'admin') options.token = r.token(1, { role: 'admin' }, 'admin');
    for (const route of ['/member/orders', `/member/orders/${order(1).outTradeNo}`]) {
      const response = await r.call(route, {}, setting === 'missing' ? 0 : 1, options);
      assert.notEqual(response.code, 0, setting);
      assert.doesNotMatch(JSON.stringify(response), /SECRET_/);
    }
    assert.equal(r.reads.filter(read => read.name === 'hl_payment_orders').length, 0);
    assert.deepEqual(r.writes, []); assert.deepEqual(r.external, []);
  }
});

test('member order list uses owner-scoped database filtering, complete totals and stable real pagination', async () => {
  const mine = Array.from({ length: 105 }, (_, index) => order(index + 1));
  const others = Array.from({ length: 130 }, (_, index) => order(1000 + index, { userId: 2 }));
  const excluded = [order(500, { _id: 'payment_probe_user_1', paymentTestPlanCode: 'vip_week', virtualPaymentEnv: 1 }),
    order(501, { _id: 'payment_guard_1' }), order(502, { isTest: true }), order(503, { status: 'unknown' })];
  const r = runtime([...mine, ...others, ...excluded]);
  const seen = [];
  for (let page = 1; page <= 6; page++) {
    const response = await r.call('/member/orders', { page, pageSize: 20, userId: 2 });
    assert.equal(response.code, 0, response.message);
    assert.equal(response.data.total, 105); assert.equal(response.data.page, page); assert.equal(response.data.pageSize, 20);
    assert.equal(response.data.hasMore, page < 6);
    seen.push(...response.data.list.map(row => row.outTradeNo));
  }
  assert.deepEqual(seen, mine.map(row => row.outTradeNo).sort().reverse());
  const orderReads = r.reads.filter(read => read.name === 'hl_payment_orders');
  assert.equal(orderReads.filter(read => read.kind === 'count').length, 6);
  assert.ok(orderReads.filter(read => read.kind === 'get').every(read => read.limit === 20 && read.returned <= 20));
  assert.ok(orderReads.every(read => JSON.stringify(read.query).includes('userId')));
  assert.deepEqual(r.writes, []); assert.deepEqual(r.external, []);
});

test('all purchase states, refunds, review status and legacy retired orders keep an explicit safe DTO', async () => {
  const statuses = ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'];
  const rows = statuses.map((status, index) => order(index + 1, { status,
    ...(status === 'paid' ? { fulfillmentStatus: 'requires_review', fulfillmentMessage: '已付款，待人工核查', paidAt: '2026-10-19T00:01:00.000Z', transactionId: 'TRANSACTION_000001' } : {}),
    ...(status === 'refunded' ? { refundedAt: '2026-10-19T00:02:00.000Z', transactionId: 'TRANSACTION_000002' } : {}) }));
  const legacy = order(20, { userId: '1', planCode: 'paid_30d', planTitle: '历史月卡', amountFen: 9900, durationDays: 30,
    status: 'paid', fulfillmentStatus: undefined, paymentProvider: undefined, productType: undefined, virtualPaymentEnv: undefined });
  delete legacy.paymentProvider; delete legacy.productType; delete legacy.fulfillmentStatus;
  const retired = order(21, { planCode: 'matchmaking_month_3', planTitle: '历史3次套餐', productType: 'matchmaking', serviceCount: 3,
    paymentProvider: 'jsapi', virtualPaymentEnv: undefined });
  const r = runtime([...rows, legacy, retired]);
  const page = await r.call(); assert.equal(page.code, 0, page.message); assert.equal(page.data.total, 8);
  for (const original of [...rows, legacy, retired]) {
    const detail = await r.call(`/member/orders/${original.outTradeNo}`);
    assert.equal(detail.code, 0, detail.message);
    assert.deepEqual(plain(detail.data), plain(page.data.list.find(row => row.outTradeNo === original.outTradeNo)));
    const keys = Object.keys(detail.data);
    assert.ok(keys.every(key => ['outTradeNo', 'planCode', 'planTitle', 'amountFen', 'durationDays', 'status', 'fulfillmentStatus',
      'fulfillmentMessage', 'createdAt', 'updatedAt', 'paidAt', 'productType', 'serviceCount', 'paymentProvider', 'refundedAt', 'transactionId'].includes(key)));
    assert.doesNotMatch(JSON.stringify(detail), /SECRET_|payerOpenid|userId|merchant|virtualPayment|paymentTest|memberRecord|callbackToken|_id/);
    assert.equal('refundedAt' in detail.data, original.status === 'refunded');
  }
  const old = page.data.list.find(row => row.planCode === 'paid_30d');
  assert.equal(old.paymentProvider, 'jsapi'); assert.equal(old.productType, 'vip'); assert.equal(old.serviceCount, 0);
  assert.equal(old.fulfillmentStatus, '', 'historical payment alone is not proof that rights were fulfilled');
  assert.equal(page.data.list.find(row => row.status === 'paid' && row.planCode === 'vip_week').fulfillmentStatus, 'requires_review');
  assert.deepEqual(r.writes, []); assert.deepEqual(r.external, []);
});

test('probe, sandbox and guard markers are excluded before count and pagination', async () => {
  const excluded = [
    { planCode: 'hl_payment_probe' }, { virtualPaymentEnv: 1 }, { virtualPaymentEnv: '1' },
    { paymentTestPlanCode: 'vip_week' }, { paymentTestRunId: 'old_run' }, { probeArchivedAt: '2026-10-18' },
    { _id: 'payment_probe_user_1' }, { _id: 'payment_guard_user_1' }, { id: 0 }, { amountFen: 0 },
    { isTest: true }, { isDemo: 1 }, { testMode: 'true' }, { isGuard: true }, { isProbe: true }, { isSandbox: true },
    { paymentGuard: true }, { guard: true }, { source: 'test' }, { dataSource: 'sandbox' }, { origin: 'probe' },
    { recordType: 'guard' }, { kind: 'TEST' }, { outTradeNo: 'GUARD_123456789' },
    { paymentProvider: 'unknown' }, { productType: 'unknown' }, { fulfillmentStatus: 'unknown' }, { status: 'UNKNOWN' }
  ].map((patch, index) => order(100 + index, patch));
  const r = runtime([order(1), ...excluded]);
  const response = await r.call('/member/orders', { pageSize: 1 });
  assert.equal(response.code, 0, response.message); assert.equal(response.data.total, 1); assert.equal(response.data.hasMore, false);
  assert.deepEqual(Array.from(response.data.list, row => row.outTradeNo), [order(1).outTradeNo]);
  for (const row of excluded) assert.equal((await r.call(`/member/orders/${row.outTradeNo}`)).code, 40400);
  assert.deepEqual(r.writes, []); assert.deepEqual(r.external, []);
});

test('unknown, foreign, conflicting, test and malformed detail responses are indistinguishable', async () => {
  const own = order(1), duplicate = order(2), other = order(3, { userId: 2 }), probe = order(4, { virtualPaymentEnv: 1 });
  const r = runtime([own, duplicate, { ...duplicate, _id: 'another_document', userId: 2 }, other, probe,
    order(5, { amountFen: 12.5 }), order(6, { status: 'INVALID' }), order(7, { createdAt: 'invalid' })]);
  const expected = plain(await r.call('/member/orders/UNKNOWN_12345678'));
  for (const value of [duplicate.outTradeNo, other.outTradeNo, probe.outTradeNo, order(5).outTradeNo, order(6).outTradeNo,
    order(7).outTradeNo, 'short', 'invalid%20order']) {
    assert.deepEqual(plain(await r.call(`/member/orders/${value}`)), expected, value);
  }
  assert.equal((await r.call(`/member/orders/${own.outTradeNo}`)).code, 0);
  const foreign = await r.call(`/member/orders/${own.outTradeNo}`, {}, 2);
  assert.deepEqual(plain(foreign), expected);
  const conflictReads = r.reads.filter(read => read.name === 'hl_payment_orders' && read.query?.outTradeNo === duplicate.outTradeNo);
  assert.ok(conflictReads.some(read => Object.keys(read.fields).join(',') === '_id'));
  assert.deepEqual(r.writes, []); assert.deepEqual(r.external, []);
});

test('empty, out-of-range, capped pagination and read errors never create collections or call a PSP', async () => {
  const r = runtime([]);
  assert.deepEqual(plain((await r.call()).data), { list: [], page: 1, pageSize: 20, total: 0, hasMore: false });
  assert.deepEqual(plain((await r.call('/member/orders', { page: 10, pageSize: 99 })).data),
    { list: [], page: 10, pageSize: 50, total: 0, hasMore: false });
  for (const data of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 'bad' }, { page: Number.MAX_SAFE_INTEGER }]) {
    assert.equal((await r.call('/member/orders', data)).code, 40001);
  }
  for (const route of ['/member/orders', `/member/orders/${order(1).outTradeNo}`]) {
    assert.equal((await r.call(route, {}, 1, { method: 'POST' })).code, 40400);
  }
  const failed = runtime([order(1)], { failCollection: 'hl_payment_orders' });
  assert.equal((await failed.call()).code, 50301);
  assert.deepEqual(r.writes, []); assert.deepEqual(failed.writes, []);
  assert.deepEqual(r.external, []); assert.deepEqual(failed.external, []);
});
