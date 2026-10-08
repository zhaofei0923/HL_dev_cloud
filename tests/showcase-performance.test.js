const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);

// This is the pre-optimization algorithm. It is injected only into the test VM,
// providing a behavioral and query-count comparison without a production hook.
const legacyShowcase = `
async function legacyPublicShowcaseRows(options = {}) {
  const rows = await getAll(C.members, { status: 1 });
  const matchRecords = await getAll(C.matchRecords);
  const memberUserIds = new Set(rows.map(row => Number(row.userId)));
  const profileRows = (await getAll(C.profiles))
    .filter(row => isTrue(row.displayEnabled))
    .filter(row => !memberUserIds.has(Number(row.userId)));
  const memberViews = await Promise.all(rows.map(row => publicMemberView(row, { matchRecords }, options)));
  const profileViews = await Promise.all(profileRows.map(async row => {
    const view = await profileMemberView(row, { matchRecords });
    if (!view.displayEnabled) return null;
    return sanitizePublicMemberRow(view, options);
  }));
  return [...memberViews, ...profileViews].filter(row => row && Number(row.status) === 1);
}
exports.__test = { C, publicShowcaseRows, publicShowcaseTarget, collectionsForPath, legacyPublicShowcaseRows };
`;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function backendRuntime(fixtures) {
  const queries = [];
  function operator(kind, values) { return { __operator: kind, values }; }
  function matches(value, expected) {
    if (expected && expected.__operator === 'in') return expected.values.includes(value);
    if (expected && expected.__operator === 'eq') return value === expected.values;
    if (expected && expected.__operator === 'neq') return value !== expected.values;
    return value === expected;
  }
  function matchesQuery(row, query) {
    if (!query) return true;
    if (query.__operator === 'or') return query.values.some(part => matchesQuery(row, part));
    if (query.__operator === 'and') return query.values.every(part => matchesQuery(row, part));
    return Object.entries(query).every(([field, expected]) => matches(row[field], expected));
  }
  function collection(name) {
    const state = { query: null, skip: 0, limit: 100, fields: null, ordering: null };
    const reference = {
      where(query) { state.query = query; return this; },
      skip(count) { state.skip = count; return this; },
      limit(count) { state.limit = count; return this; },
      field(fields) { state.fields = fields; return this; },
      orderBy(field, direction) { state.ordering = { field, direction }; return this; },
      async get() {
        let rows = (fixtures[name] || []).filter(row => matchesQuery(row, state.query));
        if (state.ordering) {
          const { field, direction } = state.ordering;
          rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
        }
        rows = rows.slice(state.skip, state.skip + state.limit);
        queries.push({ collection: name, ...plain(state), returned: rows.length });
        if (state.fields) rows = rows.map(row => Object.fromEntries(
          Object.keys(state.fields).filter(field => state.fields[field] && field in row).map(field => [field, row[field]])
        ));
        return { data: structuredClone(rows) };
      },
      add() { throw new Error('Read-only test attempted to write'); },
      doc() { throw new Error('Read-only test attempted to access a document write'); }
    };
    return reference;
  }
  const db = {
    collection,
    command: {
      in: values => operator('in', values),
      eq: value => operator('eq', value),
      neq: value => operator('neq', value),
      or: values => operator('or', values),
      and: values => operator('and', values)
    },
    createCollection() { throw new Error('Read-only fixture must not create collections'); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + legacyShowcase, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'test' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'showcase-test-secret-with-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test' } },
    console: { warn() {}, error() {}, log() {} },
    Buffer,
    setTimeout,
    clearTimeout
  }, { filename: apiPath });
  return { hooks: module.exports.__test, queries };
}

function profile(userId, extra = {}) {
  return {
    _id: `profile-${userId}`,
    id: 100 + userId,
    userId,
    displayEnabled: true,
    realName: `用户${userId}`,
    gender: 2,
    age: 30,
    height: 168,
    city: '上海',
    nativePlace: '苏州',
    education: '本科',
    occupation: '设计师',
    incomeRange: '30-50万',
    maritalStatus: '未婚',
    houseStatus: '有房',
    carStatus: '无车',
    selfIntro: '喜欢摄影',
    partnerRequirement: '期待真诚沟通',
    photos: ['photo-a.jpg', 'photo-a.jpg', '', 'photo-b.jpg', 'photo-c.jpg', 'photo-d.jpg'],
    privateArchive: { credential: 'PRIVATE_MARKER' },
    phone: 'PRIVATE_MARKER',
    ...extra
  };
}

function member(userId, extra = {}) {
  return {
    _id: `member-${userId}`,
    id: 10 + userId,
    userId,
    status: 1,
    matchmakerId: 401,
    memberNo: `MEMBER-${userId}`,
    memberType: 'vip',
    serviceLevel: 'A',
    expireAt: '2027-01-01',
    remark: 'PRIVATE_MARKER',
    privateArchive: { credential: 'PRIVATE_MARKER' },
    secretNote: 'PRIVATE_MARKER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...extra
  };
}

function richFixtures() {
  return {
    hl_users: [1, 2, 3, 4, 5, 8, 9].map(id => ({
      _id: `user-${id}`, id, nickname: `昵称${id}`, gender: 2,
      status: [4, 8].includes(id) ? 0 : 1, phone: 'PRIVATE_MARKER',
      openid: `openid-${id}`, isVerified: 1, token: 'PRIVATE_MARKER'
    })),
    hl_members: [member(1), member(2), member(5, { status: 0 }), member(7), member(8), member(9), member(1, { id: 21 })],
    hl_profiles: [
      profile(1), profile(2, { displayEnabled: false }), profile(3), profile(4),
      profile(5), profile(6), profile(7), profile(8),
      profile(9, { displayEnabled: false }), profile(9, { id: 209, displayEnabled: true })
    ],
    hl_match_records: [
      { id: 1, userAId: 1, userBId: 3, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, userAId: 1, userBId: 3, status: 'accepted', createdAt: '2026-02-01T00:00:00.000Z' }
    ],
    hl_member_private_archives: [{ credential: 'PRIVATE_MARKER' }]
  };
}

function scaleFixtures(count) {
  const users = Array.from({ length: count }, (_, index) => index + 1);
  return {
    hl_users: users.map(id => ({ id, gender: 2, status: 1, openid: `openid-${id}` })),
    hl_profiles: users.map(id => profile(id)),
    hl_members: users.filter(id => id % 2).map(id => member(id)),
    hl_match_records: []
  };
}

test('batch showcase preserves public fields, visibility, precedence and missing-user behavior', async () => {
  for (const options of [{}, { keepUserId: true }]) {
    const optimized = backendRuntime(richFixtures());
    const legacy = backendRuntime(richFixtures());
    const actual = await optimized.hooks.publicShowcaseRows(options);
    const expected = await legacy.hooks.legacyPublicShowcaseRows(options);
    assert.deepEqual(plain(actual), plain(expected));
    assert.deepEqual(Array.from(actual, row => row.id), [11, 17, 18, 21, 'profile_103', 'profile_105', 'profile_106']);
    assert.equal(actual[0].lastRecommendStatus, '已同意');
    assert.deepEqual(plain(actual[0].photos), ['photo-a.jpg', 'photo-b.jpg', 'photo-c.jpg']);
    assert.ok(actual.every(row => options.keepUserId ? typeof row.userId === 'number' : !('userId' in row)));
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_MARKER/);
    for (const row of actual) {
      for (const field of ['phone', 'memberNo', 'matchmakerId', 'displayEnabled', 'serviceLevel', 'expireAt', 'remark', 'privateArchive', 'token', 'secretNote']) {
        assert.equal(field in row, false, `${row.id} must omit ${field}`);
      }
    }
    assert.ok(optimized.queries.every(query => query.collection !== 'hl_member_private_archives'));
  }
});

test('showcase database reads grow by batch count instead of one lookup per public member', async context => {
  const small = backendRuntime(scaleFixtures(8));
  const large = backendRuntime(scaleFixtures(80));
  const legacy = backendRuntime(scaleFixtures(80));
  assert.equal((await small.hooks.publicShowcaseRows()).length, 8);
  const actual = await large.hooks.publicShowcaseRows();
  const expected = await legacy.hooks.legacyPublicShowcaseRows();
  assert.deepEqual(plain(actual), plain(expected));
  assert.ok(legacy.queries.length >= 100, `legacy fixture should exercise N+1 reads: ${legacy.queries.length}`);
  assert.ok(large.queries.length <= 10, `batched reads must remain bounded: ${large.queries.length}`);
  assert.ok(large.queries.length <= small.queries.length + 3, 'ten times the profiles must not add per-person queries');
  context.diagnostic(`8 profiles: ${small.queries.length} reads; 80 profiles: ${large.queries.length} reads; legacy 80 profiles: ${legacy.queries.length} reads`);
});

test('a capped duplicate-user batch still resolves an omitted user without changing the profile', async () => {
  const fixtures = {
    hl_users: [
      ...Array.from({ length: 1000 }, (_, index) => ({ id: 1, nickname: `重复${index}`, gender: 1, openid: 'first-user' })),
      { id: 2, nickname: '第二位用户', gender: 2, openid: 'second-user' }
    ],
    hl_profiles: [profile(1), profile(2)],
    hl_members: [member(1), member(2)],
    hl_match_records: []
  };
  const optimized = backendRuntime(fixtures);
  const legacy = backendRuntime(fixtures);
  const actual = await optimized.hooks.publicShowcaseRows({ keepUserId: true });
  const expected = await legacy.hooks.legacyPublicShowcaseRows({ keepUserId: true });
  assert.deepEqual(plain(actual), plain(expected));
  assert.equal(actual[1].nickname, '第二位用户');
  assert.equal(actual[1].gender, 2);
});

test('numeric and string user references keep numeric-profile precedence and standalone visibility', async () => {
  const fixtures = {
    hl_users: [1, 2, 3].map(id => ({ id, gender: 2, status: 1, openid: `openid-${id}` })),
    hl_members: [member(1, { userId: '1' }), member(3, { userId: '3' })],
    hl_profiles: [
      profile(1, { displayEnabled: false }),
      profile('1', { id: 201, displayEnabled: true }),
      profile(1, { id: 301, displayEnabled: true }),
      profile('2', { id: 102 }),
      profile('3', { id: 203, displayEnabled: false }),
      profile(3, { id: 103 })
    ],
    hl_match_records: []
  };
  const optimized = backendRuntime(fixtures);
  const legacy = backendRuntime(fixtures);
  const actual = await optimized.hooks.publicShowcaseRows({ keepUserId: true });
  const expected = await legacy.hooks.legacyPublicShowcaseRows({ keepUserId: true });
  assert.deepEqual(plain(actual), plain(expected));
  assert.deepEqual(Array.from(actual, row => row.id), [13, 'profile_102']);
  await assert.rejects(optimized.hooks.publicShowcaseTarget({ targetUserId: 1 }), /target member not found/);
  assert.equal((await optimized.hooks.publicShowcaseTarget({ targetUserId: 2 })).id, 'profile_102');
  assert.equal((await optimized.hooks.publicShowcaseTarget({ targetUserId: 3 })).id, 13);
});

test('batch contexts are refreshed for each server request', async () => {
  const fixtures = scaleFixtures(2);
  const { hooks } = backendRuntime(fixtures);
  const first = await hooks.publicShowcaseRows({ keepUserId: true });
  fixtures.hl_profiles[0].city = '杭州';
  fixtures.hl_users[0].nickname = '更新昵称';
  const second = await hooks.publicShowcaseRows({ keepUserId: true });
  assert.equal(first[0].city, '上海');
  assert.equal(second[0].city, '杭州');
  assert.equal(second[0].nickname, '更新昵称');
});

test('interaction targets use scoped reads and preserve active-member visibility precedence', async () => {
  for (const [userId, expectedId] of [[1, 11], [3, 'profile_103'], [5, 'profile_105'], [6, 'profile_106'], [8, 18]]) {
    const runtime = backendRuntime(richFixtures());
    const target = await runtime.hooks.publicShowcaseTarget({ targetUserId: userId });
    assert.equal(target.userId, userId);
    assert.equal(target.id, expectedId);
    assert.ok(runtime.queries.length <= 4, `target ${userId} must use a bounded lookup`);
    assert.ok(runtime.queries.every(query => query.query && ['hl_users', 'hl_members', 'hl_profiles'].includes(query.collection)));
    assert.doesNotMatch(JSON.stringify(target), /PRIVATE_MARKER/);
  }
  for (const userId of [2, 4, 9, 999]) {
    const runtime = backendRuntime(richFixtures());
    await assert.rejects(runtime.hooks.publicShowcaseTarget({ targetUserId: userId }), /target member not found/);
    assert.ok(runtime.queries.every(query => query.query && ['hl_users', 'hl_members', 'hl_profiles'].includes(query.collection)));
  }
});

test('showcase and gift catalog initialize only their read dependencies', () => {
  const { hooks } = backendRuntime({});
  assert.deepEqual(Array.from(hooks.collectionsForPath('/member/gifts')).sort(), ['hl_users']);
  assert.deepEqual(Array.from(hooks.collectionsForPath('/member/showcase')).sort(), [
    'hl_match_records', 'hl_member_interactions', 'hl_members', 'hl_profiles', 'hl_users'
  ]);
  for (const route of ['/member/interactions', '/member/gifts/send']) {
    assert.ok(!hooks.collectionsForPath(route).includes('hl_member_private_archives'));
  }
});
