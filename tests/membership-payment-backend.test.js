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
      userId: 1, memberRecordId: 11, payerOpenid: 'fixture-openid-1',
      planCode: 'paid_30d', planTitle: '月度会员', amountFen: 9900, durationDays: 30,
      status: 'pending', transactionId: '', createdAt: new Date().toISOString(),
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
            const row = (rows[name] || []).find(item => item._id === id);
            if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            return { data: structuredClone(row) };
          },
          async set({ data }) {
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
        try { return await callback({ collection }); }
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
    PAYMENT_CALLBACK_TOKEN: FIXTURE_TOKEN, ...(options.env || {})
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'fixture-openid-1' }) };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'isolated-payment-jwt-fixture-not-a-real-credential' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  return {
    rows, writes,
    call: (route, method = 'POST', data = {}, userId) => module.exports.main({ path: route, method, data,
      token: userId ? module.exports.__test.tokenService.sign({ userId, authVersion: 1 }, { type: 'access' }) : '' }),
    internal: (action, data = {}) => module.exports.main({ path: `/internal/payment-orders/${action}`, method: 'POST',
      data: { callbackToken: FIXTURE_TOKEN, outTradeNo: orderNumber, ...data } })
  };
}

const confirmation = extra => ({ ...identity, payerOpenid: 'fixture-openid-1', amountFen: 9900,
  tradeState: 'SUCCESS', transactionId: 'fixture-transaction-1', ...extra });

test('disabled payment configuration cannot create orders, even after the merchant number is registered', async () => {
  for (const env of [{ PAYMENT_INTEGRATION_READY: '' }, { PAYMENT_QUERY_PATH: '' }, { PAYMENT_CALLBACK_TOKEN: '' }]) {
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
  assert.equal(result.data.payment.queryPath, '/member-pay/query');
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
  assert.equal(r.writes.length, 1);
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

test('fulfillment transaction rolls back both order and member and rechecks member ownership', async () => {
  const r = runtime({ failPaidOrderWrite: true });
  const before = structuredClone(r.rows);
  assert.notEqual((await r.internal('confirm', confirmation())).code, 0);
  assert.deepEqual(r.rows, before);
  assert.equal(r.writes.length, 0);
  const raced = runtime({ beforeTransaction: rows => { rows.hl_members[0].userId = 2; } });
  assert.equal((await raced.internal('confirm', confirmation())).code, 40906);
  assert.equal(raced.writes.length, 0);
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
    { merchantId: undefined }, { appId: 'wrong' }, { currency: 'USD' }, { payerOpenid: 'wrong' }, { amountFen: 1 }]) {
    const r = runtime();
    assert.notEqual((await r.internal('close', confirmation({ tradeState: 'CLOSED', ...patch }))).code, 0);
    assert.equal(r.writes.length, 0);
  }
  const raced = runtime({ beforeTransaction: rows => { rows.hl_payment_orders[0].status = 'paid'; } });
  assert.equal((await raced.internal('close', confirmation({ tradeState: 'CLOSED' }))).code, 40905);
  assert.equal(raced.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(raced.writes.length, 0);
});
