const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);

function runtime(records = []) {
  const rows = structuredClone(records), reads = [];
  function collection(name) {
    let offset = 0, size = 100;
    const ref = {
      skip(value) { offset = value; return ref; },
      limit(value) { size = value; return ref; },
      async get() {
        reads.push({ name, offset, size });
        return { data: structuredClone(name === 'hl_payment_orders' ? rows.slice(offset, offset + size) : []) };
      }
    };
    return ref;
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership };', {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => ({ collection, command: {} }), getWXContext: () => ({}) };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'admin-order-regression-fixture-not-a-real-secret' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const tokens = module.exports.__test.tokenService;
  return {
    rows, reads,
    list: filters => module.exports.__test.membership.listOrdersForAdmin(filters),
    call: (filters = {}, credentials = 'admin') => module.exports.main({ path: '/admin/payment-orders', method: 'GET', data: filters,
      token: credentials === 'admin' ? tokens.sign({ role: 'admin' }, { type: 'admin' })
        : credentials === 'user' ? tokens.sign({ userId: 1 }, { type: 'access' }) : '' })
  };
}

function order(id, patch = {}) {
  return { _id: `order_${id}`, id, outTradeNo: `HLM_AUDIT_${id}`, userId: 1, planCode: 'vip_week', planTitle: 'VIP周卡',
    amountFen: 6160, durationDays: 7, productType: 'vip', paymentProvider: 'virtual', status: 'paid', fulfillmentStatus: 'fulfilled',
    transactionId: `fixture_transaction_${id}`, payerOpenid: 'fixture-private-payer', memberRecordId: 11, memberMatchmakerId: 21,
    virtualPaymentAttempts: [{ outTradeNo: 'fixture-private-attempt' }], ...patch };
}

test('admin order pagination includes records beyond the old 2000-row prefix and reports the complete total', async () => {
  const r = runtime(Array.from({ length: 2001 }, (_, index) => order(index + 1)));
  const first = await r.list({ page: 1, pageSize: 20 });
  assert.equal(first.total, 2001);
  assert.deepEqual(Array.from(first.list, row => row.id), Array.from({ length: 20 }, (_, index) => 2001 - index));
  const final = await r.list({ page: 101, pageSize: 20 });
  assert.equal(final.total, 2001);
  assert.deepEqual(Array.from(final.list, row => row.id), [1]);
  assert.ok(r.reads.some(read => read.offset === 2000));
});

test('admin filters and search find a review order beyond 2000 completed orders without exposing payment internals', async () => {
  const target = order(2001, { status: 'paid', fulfillmentStatus: 'requires_review', userId: 2, productType: 'matchmaking',
    planCode: 'matchmaking_single', planTitle: '人工牵线单次', transactionId: 'SPECIAL_TRANSACTION_2001' });
  const r = runtime([...Array.from({ length: 2000 }, (_, index) => order(index + 1)), target]);
  for (const filters of [{ fulfillmentStatus: 'requires_review' }, { userId: '2' }, { productType: 'matchmaking' },
    { keyword: ' HLM_AUDIT_2001 ' }, { keyword: '人工牵线' }, { keyword: 'special_transaction_2001' },
    { keyword: 'matchmaking_single', status: 'paid', fulfillmentStatus: 'requires_review', userId: 2, productType: 'matchmaking' }]) {
    const result = await r.list(filters);
    assert.equal(result.total, 1);
    assert.equal(result.list[0].id, 2001);
    for (const field of ['_id', 'payerOpenid', 'memberRecordId', 'memberMatchmakerId', 'virtualPaymentAttempts']) {
      assert.equal(Object.hasOwn(result.list[0], field), false);
    }
  }
  assert.equal((await r.list({ status: 'refunded' })).total, 0);
  assert.deepEqual(r.rows, [...Array.from({ length: 2000 }, (_, index) => order(index + 1)), target]);
});

test('legacy product filtering includes only historical orders without an independent product type', async () => {
  const r = runtime([order(1, { productType: undefined, fulfillmentStatus: undefined }), order(2), order(3, { productType: 'matchmaking' })]);
  const legacy = await r.list({ productType: 'legacy' });
  assert.equal(legacy.total, 1);
  assert.equal(legacy.list[0].id, 1);
  assert.equal((await r.list({ productType: 'legacy', fulfillmentStatus: 'fulfilled' })).total, 1);
});

test('invalid administration filters and pagination fail before any order read', async () => {
  const r = runtime([order(1)]);
  for (const filters of [null, [], { status: 'successful' }, { status: {} }, { fulfillmentStatus: 'pending' },
    { productType: 'svip' }, { userId: 0 }, { userId: '1 OR 1=1' }, { userId: true },
    { page: 1.5 }, { page: -1 }, { page: Number.MAX_SAFE_INTEGER, pageSize: 100 },
    { pageSize: 101 }, { keyword: {} }, { keyword: 'x'.repeat(129) }, { keyword: 'unsafe\nsearch' }]) {
    await assert.rejects(r.list(filters), error => error.status === 400 && error.code === 40001);
  }
  assert.equal(r.reads.length, 0);
});

test('admin payment order route requires an administrator token and remains read-only', async () => {
  const r = runtime([order(1)]);
  for (const credentials of ['anonymous', 'user']) {
    const rejected = await r.call({}, credentials);
    assert.notEqual(rejected.code, 0);
  }
  assert.equal(r.reads.length, 0);
  const result = await r.call({ keyword: 'audit' });
  assert.equal(result.code, 0);
  assert.equal(result.data.total, 1);
  assert.deepEqual(r.rows, [order(1)]);
});
