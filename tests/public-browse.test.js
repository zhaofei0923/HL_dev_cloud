'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiPath = path.resolve(process.env.HL_API_TEST_PATH || path.join(__dirname, '../cloudfunctions/hlApi/index.js'));
const requireFromApi = createRequire(apiPath);
const { createPublicBrowseService } = requireFromApi('./public-browse');
const { DEFAULT_MEMBERSHIP_PLANS } = requireFromApi('./vip-membership-service');
const clone = value => JSON.parse(JSON.stringify(value));
const CURRENT = '2026-10-20T08:00:00.000Z';
const eventKeys = ['id', 'title', 'description', 'location', 'eventDate', 'maxParticipants',
  'currentParticipants', 'price', 'status', 'requiresLogin'].sort();

function fixture() {
  return { hl_salon_events: [
    { id: 1, title: '公开沙龙', description: '活动介绍', location: '成都', eventDate: '2099-10-21T12:00:00.000Z',
      maxParticipants: 12, currentParticipants: 4, price: 99, status: 'upcoming',
      organizerId: 9001, organizer: { phone: 'PRIVATE_PHONE' }, registrations: [{ userId: 8001 }],
      reviewRemark: 'PRIVATE_REVIEW', _id: 'PRIVATE_DOCUMENT', _openid: 'PRIVATE_OPENID' },
    { id: 2, title: '往期活动', eventDate: '2020-10-21T12:00:00.000Z', status: 'upcoming' },
    { id: 3, title: '已结束活动', eventDate: '2020-10-22T12:00:00.000Z', status: 'ended' },
    { id: 4, title: '已取消活动', eventDate: '2099-10-22T12:00:00.000Z', status: 'cancelled' },
    { id: 5, title: 'PRIVATE_PENDING', eventDate: '2099-10-23T12:00:00.000Z', status: 'pending' },
    { id: 6, title: 'PRIVATE_REJECTED', eventDate: '2099-10-24T12:00:00.000Z', status: 'rejected' }
  ], hl_membership_plans: DEFAULT_MEMBERSHIP_PLANS.map(plan => ({ ...plan, active: true,
    merchantId: 'PRIVATE_MERCHANT', payerOpenid: 'PRIVATE_PAYER' })) };
}

function database(input, options = {}) {
  const reads = [], logs = [];
  const db = {
    command: { in: values => ({ in: [...values] }) },
    async createCollection() { throw new Error('Guest requests must never create collections'); },
    collection(name) {
      assert.ok(['hl_salon_events', 'hl_membership_plans'].includes(name), `Private collection read: ${name}`);
      const query = { where: null, fields: null, skip: 0, limit: 100 };
      return {
        where(value) { query.where = value; return this; },
        field(value) { query.fields = value; return this; },
        skip(value) { query.skip = value; return this; },
        limit(value) { assert.ok(value > 0 && value <= 100); query.limit = value; return this; },
        async get() {
          reads.push({ name, ...clone(query) });
          if (options.error) throw options.error;
          if (!Object.hasOwn(input, name)) throw new Error('DATABASE_COLLECTION_NOT_EXIST');
          let rows = input[name].filter(row => !query.where || Object.entries(query.where).every(([key, expected]) =>
            expected && expected.in ? expected.in.includes(row[key]) : row[key] === expected));
          rows = rows.slice(query.skip, query.skip + query.limit);
          // Deliberately ignore field projections to ensure DTO safety does not
          // depend on the database removing malicious/private extra fields.
          return { data: clone(rows) };
        }
      };
    }
  };
  return { db, reads, logs };
}

function service(input = fixture(), options = {}) {
  const runtime = database(input, options);
  return { ...runtime, api: createPublicBrowseService({ db: runtime.db, plans: DEFAULT_MEMBERSHIP_PLANS,
    env: { VIP_MEMBERSHIP_CATALOG_READY: 'true', ...options.env }, now: () => CURRENT }) };
}

function runtime(input = fixture(), options = {}) {
  const state = database(input, options);
  const module = { exports: {} };
  const env = { NODE_ENV: 'test', VIP_MEMBERSHIP_CATALOG_READY: 'true',
    SEED_DATA: 'true', AUTO_CREATE_COLLECTIONS: 'true', ...options.env };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8'), {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout, process: { env },
    console: { log: (...args) => state.logs.push(args), warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'fixture-env', database: () => state.db };
      if (name === './auth-policy') {
        const policy = requireFromApi(name);
        return { ...policy, createTokenService: () => policy.createTokenService({ secret: 'public-browse-fixture-signing-secret' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  return { ...state, call: async (route, method = 'GET', data = {}, token = '') => clone(await module.exports.main({
    path: route, method, data, token
  })) };
}

test('guest list and detail return only explicit public fields without any personal identities', async () => {
  const r = service();
  const result = await r.api.handle('GET', '/public/salon/events', {});
  assert.equal(result.total, 1);
  assert.equal(result.list[0].id, 1);
  assert.deepEqual(Object.keys(result.list[0]).sort(), eventKeys);
  assert.equal(result.list[0].requiresLogin, true);
  const detail = await r.api.handle('GET', '/public/salon/events/1');
  assert.deepEqual(detail, result.list[0]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|organizer|registrations|userId|phone|avatar|review/i);
  assert.ok(r.reads.every(read => read.name === 'hl_salon_events'));
  assert.deepEqual(Object.keys(r.reads[0].fields).sort(), eventKeys.filter(key => key !== 'requiresLogin'));
});

test('published upcoming and past filters, sorting and pagination work without attendee queries', async () => {
  const r = service();
  const past = await r.api.handle('GET', '/public/salon/events', { period: 'past', page: '2', pageSize: '2' });
  assert.equal(past.total, 3);
  assert.deepEqual(past.list.map(row => row.id), [2]);
  assert.equal(past.page, 2);
  assert.equal(past.pageSize, 2);
  const pastFirst = await r.api.handle('GET', '/public/salon/events', { period: 'past', pageSize: 2 });
  assert.deepEqual(pastFirst.list.map(row => row.id), [4, 3]);
  assert.ok(r.reads.every(read => read.name === 'hl_salon_events'));
});

test('pending, rejected, unknown and invalid activity ids never expose a detail', async () => {
  const r = service();
  for (const id of ['5', '6', '7', '0', '-1', '1abc', '9007199254740992']) {
    await assert.rejects(r.api.handle('GET', `/public/salon/events/${id}`), { code: 40400 });
  }
  assert.ok(r.reads.every(read => read.name === 'hl_salon_events'));
});

test('guest catalog uses only enabled canonical six products and never trusts persisted prices or extra fields', async () => {
  const input = fixture();
  input.hl_membership_plans[0] = { ...input.hl_membership_plans[0], title: 'PRIVATE_FAKE_PRICE', amountFen: 1, durationDays: 999 };
  input.hl_membership_plans[1].active = false;
  input.hl_membership_plans.push({ planCode: 'matchmaker_lifetime', active: true, amountFen: 698000 },
    { planCode: 'matchmaking_month', active: true }, { planCode: 'custom_secret', active: true });
  const r = service(input);
  const { plans } = await r.api.handle('GET', '/public/service-plans');
  assert.equal(plans.length, 5);
  assert.deepEqual(plans[0], { planCode: 'vip_week', name: 'VIP周卡', priceFen: 6160,
    durationDays: 7, serviceTimes: 0, productType: 'vip' });
  assert.deepEqual(plans.at(-1), { planCode: 'matchmaking_month_6', name: '人工牵线1个月', priceFen: 698000,
    durationDays: 30, serviceTimes: 6, productType: 'matchmaking' });
  assert.doesNotMatch(JSON.stringify(plans), /PRIVATE|custom_secret|matchmaker_lifetime|merchant|payer/i);
  assert.ok(r.reads.every(read => read.name === 'hl_membership_plans'));
  assert.deepEqual(Object.keys(r.reads[0].fields).sort(), ['active', 'planCode']);
});

test('catalog readiness and missing collections never publish defaults or trigger collection writes', async () => {
  const disabled = service(fixture(), { env: { VIP_MEMBERSHIP_CATALOG_READY: 'false' } });
  assert.deepEqual(await disabled.api.handle('GET', '/public/service-plans'), { plans: [] });
  assert.equal(disabled.reads.length, 0);
  const missing = service({});
  assert.deepEqual(await missing.api.handle('GET', '/public/service-plans'), { plans: [] });
  assert.deepEqual(await missing.api.handle('GET', '/public/salon/events'), { list: [], total: 0, page: 1, pageSize: 20 });
  await assert.rejects(missing.api.handle('GET', '/public/salon/events/1'), { code: 40400 });
});

test('invalid guest filters and unsupported routes or methods fail before reading any collections', async () => {
  const r = service();
  for (const filters of [null, [], { page: 0 }, { page: 1.5 }, { page: 1001 }, { pageSize: 21 },
    { pageSize: [] }, { period: 'pending' }, { userId: 1 }, { status: 'pending' }]) {
    await assert.rejects(r.api.handle('GET', '/public/salon/events', filters), { code: 40001 });
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    await assert.rejects(r.api.handle(method, '/public/salon/events'), { code: 40500 });
    await assert.rejects(r.api.handle(method, '/public/salon/events/1'), { code: 40500 });
    await assert.rejects(r.api.handle(method, '/public/service-plans'), { code: 40500 });
  }
  for (const route of ['/public', '/public/user/profile', '/public/salon/events/1/register',
    '/public/salon/events/1/participants', '/public/member/payment-orders']) {
    await assert.rejects(r.api.handle('GET', route), { code: 40400 });
  }
  assert.equal(r.reads.length, 0);
});

test('real SDK failures return safe availability errors instead of disguising them as empty content', async () => {
  for (const route of ['/public/salon/events', '/public/salon/events/1', '/public/service-plans']) {
    const r = service(fixture(), { error: Object.assign(new Error('PRIVATE_DATABASE_PERMISSION_DIAGNOSTIC'), { code: 'EXCEED_AUTHORITY' }) });
    await assert.rejects(r.api.handle('GET', route), err => err.code === 50301 && err.status === 503
      && !/PRIVATE|PERMISSION|DIAGNOSTIC/.test(err.message));
  }
});

test('full hlApi public route bypasses login and both collection and seed initialization', async () => {
  const r = runtime();
  assert.equal((await r.call('/public/salon/events')).code, 0);
  assert.equal((await r.call('/public/salon/events/1')).data.id, 1);
  assert.equal((await r.call('/public/service-plans')).data.plans.length, 6);
  assert.ok(r.reads.every(read => ['hl_salon_events', 'hl_membership_plans'].includes(read.name)));
  assert.deepEqual(r.logs, []);
});

test('full API rejects public method/path escalation and redacts database diagnostics', async () => {
  const r = runtime();
  assert.equal((await r.call('/public/salon/events', 'POST', { organizerId: 1 })).code, 40500);
  assert.equal((await r.call('/public/salon/events/1/participants')).code, 40400);
  assert.equal((await r.call('/public/member/payment-orders', 'POST')).code, 40400);
  assert.equal(r.reads.length, 0);
  const broken = runtime(fixture(), { error: new Error('PRIVATE_SDK_CREDENTIAL_DIAGNOSTIC') });
  const failure = await broken.call('/public/salon/events');
  assert.equal(failure.code, 50301);
  assert.doesNotMatch(JSON.stringify([failure, broken.logs]), /PRIVATE|CREDENTIAL|DIAGNOSTIC/);
});

test('original member, registration, payment, identity and admin routes remain authentication protected', async () => {
  const r = runtime(fixture(), { env: { SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false' } });
  for (const [route, method] of [
    ['/salon/events', 'GET'], ['/salon/events/1', 'GET'], ['/salon/events/1/participants', 'GET'],
    ['/salon/events/1/register', 'POST'], ['/member/showcase', 'GET'], ['/member/membership-plans', 'GET'],
    ['/member/payment-orders', 'POST'], ['/member/payment-virtual/checkout', 'POST'],
    ['/user/profile', 'GET'], ['/user/certification-materials', 'GET'], ['/user/admin-entry', 'GET'],
    ['/user/admin/operations', 'POST'], ['/admin/payment-orders', 'GET'], ['/admin/membership-plans', 'PUT']
  ]) {
    assert.equal((await r.call(route, method)).code, 40100, `${method} ${route}`);
  }
  assert.equal(r.reads.length, 0);
});
