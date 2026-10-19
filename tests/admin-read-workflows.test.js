const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);

function runtime(input) {
  const fixtures = structuredClone(input), reads = [];
  const op = (kind, values) => ({ kind, values });
  const matches = (row, query) => !query || Object.entries(query).every(([key, expected]) =>
    expected?.kind === 'in' ? expected.values.includes(row[key]) : row[key] === expected);
  const collection = name => {
    const state = { query: null, skip: 0, limit: 100, fields: null };
    return {
      where(query) { state.query = query; return this; },
      skip(value) { state.skip = value; return this; },
      limit(value) { assert.ok(value <= 100); state.limit = value; return this; },
      field(value) { state.fields = value; return this; },
      async get() {
        let rows = (fixtures[name] || []).filter(row => matches(row, state.query)).slice(state.skip, state.skip + state.limit);
        if (state.fields) rows = rows.map(row => ({ _id: row._id, ...Object.fromEntries(Object.keys(state.fields)
          .filter(key => state.fields[key] && key in row).map(key => [key, row[key]])) }));
        reads.push({ name, ...structuredClone(state), returned: rows.length });
        return { data: structuredClone(rows) };
      },
      doc(id) { return { async get() { return { data: structuredClone((fixtures[name] || []).find(row => row._id === id)) }; } }; }
    };
  };
  const db = { collection, command: { in: values => op('in', values) } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test={admin,tokenService};', {
    module, exports: module.exports, require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'admin-read-fixture-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false', DEMO_MEMBERS: 'false' } },
    console: { log() {}, error() {}, warn() {} }, Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  return { admin: module.exports.__test.admin, main: module.exports.main, reads,
    token: module.exports.__test.tokenService.sign({ role: 'admin' }, { type: 'admin' }) };
}

function fixture() {
  return {
    hl_matchmakers: Array.from({ length: 1005 }, (_, index) => ({ _id: `mm-${index + 1}`, id: index + 1,
      userId: index + 1, status: 1, certificationStatus: (index + 1) % 3, matchmakerNo: `HLMM${index + 1}` })),
    hl_users: Array.from({ length: 1005 }, (_, index) => ({ _id: `u-${index + 1}`, id: index + 1,
      status: 1, nickname: index === 1004 ? '越界主理人' : `会员${index + 1}`, openid: 'PRIVATE_OPENID' })),
    hl_members: Array.from({ length: 1010 }, (_, index) => ({ _id: `m-${index + 1}`, id: index + 1, matchmakerId: 1005, status: 1 })),
    hl_salon_events: Array.from({ length: 1007 }, (_, index) => ({ _id: `e-${index + 1}`, id: index + 1, organizerId: 1005,
      title: index === 1006 ? '尾页活动' : `沙龙${index + 1}`, status: index % 2 ? 'upcoming' : 'pending',
      eventDate: '2099-01-01T10:00:00.000Z', maxParticipants: 10 })),
    hl_registrations: [], hl_profiles: [], hl_member_interactions: []
  };
}

test('admin dashboard counts all active records beyond 1000 with projected read fields', async () => {
  const r = runtime(fixture());
  const dashboard = await r.admin.dashboard();
  assert.equal(dashboard.pendingMatchmakers + dashboard.approvedMatchmakers + dashboard.rejectedMatchmakers, 1005);
  assert.equal(dashboard.memberCount, 1010);
  assert.equal(dashboard.salonCount, 1007);
  assert.equal(dashboard.pendingSalonCount, 504);
  assert.ok(r.reads.every(read => read.fields));
});

test('admin principal list paginates before enrichment and counts all related records', async () => {
  const r = runtime(fixture());
  const page = await r.admin.listMatchmakers({ pageSize: 2 });
  assert.equal(page.total, 1005);
  assert.deepEqual(Array.from(page.list, row => row.id), [1005, 1004]);
  assert.equal(page.list[0].memberCount, 1010);
  assert.equal(page.list[0].salonCount, 1007);
  assert.equal(page.list[0].user.openid, undefined);
  assert.equal(r.reads.filter(read => read.name === 'hl_users').reduce((sum, read) => sum + read.returned, 0), 2);
  assert.ok(r.reads.filter(read => read.name === 'hl_members').every(read => read.query.matchmakerId.values.length === 4));
});

test('admin principal keyword and approval filters find names and numbers beyond the former cap', async () => {
  const r = runtime(fixture());
  const named = await r.admin.listMatchmakers({ keyword: '越界主理人', status: 0 });
  assert.equal(named.total, 1);
  assert.equal(named.list[0].id, 1005);
  const numbered = await r.admin.listMatchmakers({ keyword: 'hlmm1005' });
  assert.equal(numbered.total, 1);
  assert.equal(numbered.list[0].id, 1005);
});

test('admin salon list enriches only the requested page and finds title or organizer beyond 1000', async () => {
  const r = runtime(fixture());
  const page = await r.admin.listSalons({ pageSize: 2 });
  assert.equal(page.total, 1007);
  assert.deepEqual(Array.from(page.list, row => row.id), [1007, 1006]);
  const registrationReads = r.reads.filter(read => read.name === 'hl_registrations');
  assert.ok(registrationReads.every(read => read.query.eventId.values.every(id => [1007, '1007', 1006, '1006'].includes(id))));
  const title = await r.admin.listSalons({ keyword: '尾页活动', status: 'pending' });
  assert.equal(title.total, 1);
  assert.equal(title.list[0].id, 1007);
  const organizer = await r.admin.listSalons({ keyword: '越界主理人', page: 101, pageSize: 10 });
  assert.equal(organizer.total, 1007);
  assert.equal(organizer.list.length, 7);
});

test('admin lists reject malformed search or unbounded pagination and anonymous requests cannot read them', async () => {
  const r = runtime(fixture());
  for (const filters of [{ page: -1 }, { page: 1.5 }, { pageSize: 101 }, { keyword: {} }, { keyword: 'a'.repeat(81) }]) {
    await assert.rejects(r.admin.listMatchmakers(filters), error => error.code === 42240);
    await assert.rejects(r.admin.listSalons(filters), error => error.code === 42240);
  }
  const denied = await r.main({ method: 'GET', path: '/admin/matchmakers' });
  assert.equal(denied.code, 40100);
  const result = await r.main({ method: 'GET', path: '/admin/matchmakers', token: r.token, data: { pageSize: 2 } });
  assert.equal(result.code, 0);
  assert.equal(result.data.total, 1005);
});
