const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const injectedHooks = `
async function legacyShowcasePage(userId, filters = {}) {
  const rows = await withMemberViewerState(await publicShowcaseRows({ keepUserId: true }), userId);
  return resolveMemberMediaPage(paginate(rows
    .filter(row => Number(row.userId) !== Number(userId))
    .filter(row => !row.viewerState.isHidden && matchesMemberFilters(row, filters))
    .sort(sortMemberRowsDesc), filters.page, filters.pageSize));
}
exports.__showcasePageTest = { C, publicShowcasePage, publicShowcaseRows,
  legacyShowcasePage, lastRecommendationStatusForUser };
`;

function plain(value) { return JSON.parse(JSON.stringify(value)); }

// The fake database is deliberately typed: a regex does not coerce numeric
// references to text, and a numeric equality does not match a string reference.
function backendRuntime(fixtures, onRead = () => {}) {
  const reads = [];
  const writes = [];
  const operator = (kind, value) => ({ __kind: kind, value });
  function matchesValue(actual, expected) {
    if (!expected || !expected.__kind) return actual === expected;
    if (expected.__kind === 'regex') {
      const expression = new RegExp(expected.value.regexp, expected.value.options || '');
      return typeof actual === 'string' ? expression.test(actual)
        : Array.isArray(actual) && actual.some(value => typeof value === 'string' && expression.test(value));
    }
    if (expected.__kind === 'in') return Array.isArray(actual)
      ? actual.some(value => expected.value.includes(value)) : expected.value.includes(actual);
    if (expected.__kind === 'eq') return actual === expected.value;
    if (expected.__kind === 'neq') return actual !== expected.value;
    if (expected.__kind === 'exists') return (actual !== undefined) === expected.value;
    if (expected.__kind === 'gt') return actual > expected.value;
    if (expected.__kind === 'gte') return actual >= expected.value;
    if (expected.__kind === 'lt') return actual < expected.value;
    if (expected.__kind === 'lte') return actual <= expected.value;
    throw new Error(`Unsupported fixture operator: ${expected.__kind}`);
  }
  function matchesQuery(row, query) {
    if (!query) return true;
    if (query.__kind === 'or') return query.value.some(part => matchesQuery(row, part));
    if (query.__kind === 'and') return query.value.every(part => matchesQuery(row, part));
    return Object.entries(query).every(([field, expected]) => matchesValue(row[field], expected));
  }
  function write(name) {
    writes.push(name);
    throw new Error(`Read-only showcase fixture attempted a write: ${name}`);
  }
  function collection(name) {
    const state = { query: null, offset: 0, limit: 100, fields: null, order: [] };
    const reference = {
      where(query) { state.query = query; return this; },
      skip(offset) { state.offset = offset; return this; },
      limit(limit) { state.limit = limit; return this; },
      field(fields) { state.fields = fields; return this; },
      orderBy(field, direction) { state.order.push([field, direction]); return this; },
      async get() {
        onRead(name, state);
        let rows = (fixtures[name] || []).filter(row => matchesQuery(row, state.query));
        if (state.order.length) rows = [...rows].sort((a, b) => {
          for (const [field, direction] of state.order) {
            const difference = a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0;
            if (difference) return difference * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        rows = rows.slice(state.offset, state.offset + state.limit);
        reads.push({ collection: name, ...plain(state), rows: structuredClone(rows), returned: rows.length });
        if (state.fields) rows = rows.map(row => {
          const projected = Object.fromEntries(Object.keys(state.fields)
            .filter(field => state.fields[field] && field in row).map(field => [field, row[field]]));
          if (row._id !== undefined && state.fields._id !== false) projected._id = row._id;
          return projected;
        });
        return { data: structuredClone(rows) };
      },
      async count() {
        const rows = (fixtures[name] || []).filter(row => matchesQuery(row, state.query));
        reads.push({ collection: name, ...plain(state), count: true, returned: 0, rows: [] });
        return { total: rows.length };
      },
      doc(id) { state.query = { _id: id }; return this; },
      add() { return write(name); }, set() { return write(name); },
      update() { return write(name); }, remove() { return write(name); }
    };
    return reference;
  }
  const command = Object.fromEntries(['in', 'eq', 'neq', 'exists', 'gt', 'gte', 'lt', 'lte']
    .map(kind => [kind, value => operator(kind, value)]));
  command.or = (...args) => operator('or', Array.isArray(args[0]) ? args[0] : args);
  command.and = (...args) => operator('and', Array.isArray(args[0]) ? args[0] : args);
  const db = {
    collection, command,
    RegExp: value => operator('regex', value),
    createCollection() { return write('createCollection'); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + injectedHooks, {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'test' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'showcase-page-test-secret-with-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test' } },
    console: { warn() {}, error() {}, log() {} },
    Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  return { hooks: module.exports.__showcasePageTest, reads, writes };
}

function profile(userId, extra = {}) {
  return {
    _id: `p-${userId}`, id: 2000 + Number(userId), userId, displayEnabled: true,
    realName: `姓名${userId}`, gender: 2, age: 30, height: 168, education: '本科',
    occupation: '设计师', incomeRange: '30-50万', city: '上海', province: '江苏',
    nativePlace: '苏州', maritalStatus: '未婚', houseStatus: '有房', carStatus: '无车',
    selfIntro: '喜欢摄影和阅读', partnerRequirement: '期待真诚沟通',
    photos: ['public.jpg', ' public.jpg ', '', 'second.jpg', 'third.jpg', 'fourth.jpg'],
    phone: 'PRIVATE_PHONE', privateArchive: { proof: 'PRIVATE_PROOF' }, ...extra
  };
}

function member(userId, extra = {}) {
  return {
    _id: `m-${userId}`, id: 1000 + Number(userId), userId, status: 1,
    matchmakerId: 401, memberType: 'vip', serviceLevel: 'A', memberNo: 'PRIVATE_MEMBER_NO',
    remark: 'PRIVATE_REMARK', expireAt: '2027-01-01', privateArchive: { proof: 'PRIVATE_PROOF' },
    createdAt: '2026-01-01', updatedAt: '2026-02-01', ...extra
  };
}

function richFixtures() {
  const fixtures = {
    hl_users: Array.from({ length: 21 }, (_, index) => ({
      _id: `u-${index + 1}`, id: index + 1, nickname: `昵称${index + 1}`,
      gender: index % 2 ? 2 : 1, status: 1, openid: `wx-${index + 1}`,
      isVerified: 1, phone: 'PRIVATE_PHONE', token: 'PRIVATE_TOKEN'
    })).filter(row => row.id !== 4),
    hl_profiles: Array.from({ length: 22 }, (_, index) => profile(index + 1)),
    hl_members: [member(1), member('2'), member(3), member(4), member(5, { status: 0 }),
      member(6, { status: undefined }), member(7), member(8, { status: '1' }),
      member(1, { _id: 'm-1-duplicate', id: 5001 })],
    hl_match_records: [
      { id: 1, userAId: 1, userBId: 3, status: 'pending', createdAt: '2026-01-01' },
      { id: 2, userAId: 1, userBId: 3, status: 'accepted', createdAt: '2026-02-01' }
    ],
    hl_member_interactions: [
      { userId: 20, targetUserId: 1, actionType: 'favorite', active: 0, status: 'inactive' },
      { userId: 20, targetUserId: 10, actionType: 'hide', active: 0, status: 'inactive' },
      { userId: 20, targetUserId: 11, actionType: 'hide', active: false },
      { userId: 20, targetUserId: 12, actionType: 'hide', active: true, updatedAt: '2026-01-01' },
      { userId: 20, targetUserId: 12, actionType: 'hide', active: false, updatedAt: '2026-02-01' },
      { userId: '20', targetUserId: 13, actionType: 'hide', active: true }
    ]
  };
  fixtures.hl_users.find(row => row.id === 1).openid = 'manual_1';
  fixtures.hl_users.find(row => row.id === 3).status = 0;
  fixtures.hl_users.find(row => row.id === 9).status = 0;
  delete fixtures.hl_users.find(row => row.id === 6).status;
  fixtures.hl_profiles[1].displayEnabled = false;
  fixtures.hl_profiles.splice(2, 0, profile('2', { _id: 'p-2-string', id: 3002 }),
    profile(2, { _id: 'p-2-later', id: 4002 }));
  fixtures.hl_profiles.find(row => row.userId === 7).displayEnabled = false;
  fixtures.hl_profiles.push(profile(7, { _id: 'p-7-later', id: 4007 }));
  for (const [id, enabled] of [[11, 1], [12, '1'], [13, 'true'], [14, false],
    [15, 0], [16, '0'], [17, 'false'], [18, undefined]]) {
    fixtures.hl_profiles.find(row => row.userId === id).displayEnabled = enabled;
  }
  fixtures.hl_profiles.push(profile('19', { _id: 'p-19-string', id: 3019, city: '杭州' }));
  fixtures.hl_profiles.find(row => row.userId === 5).age = null;
  fixtures.hl_profiles.find(row => row.userId === 6).education = '硕士';
  fixtures.hl_profiles.find(row => row.userId === 13).maritalStatus = '离异';
  return fixtures;
}

async function comparePage(fixtures, filters = {}, viewerUserId = 20) {
  const optimized = backendRuntime(fixtures);
  const legacy = backendRuntime(fixtures);
  const actual = await optimized.hooks.publicShowcasePage(viewerUserId, filters);
  const expected = await legacy.hooks.legacyShowcasePage(viewerUserId, filters);
  assert.deepEqual(plain(actual), plain(expected), `filters ${JSON.stringify(filters)}`);
  assert.equal(optimized.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_PHONE|PRIVATE_PROOF|PRIVATE_TOKEN|PRIVATE_REMARK|PRIVATE_MEMBER_NO/);
  return { ...optimized, actual };
}

test('showcase pages preserve visibility, typed profile precedence, state sources and complete public DTOs', async () => {
  const { actual } = await comparePage(richFixtures(), { pageSize: 100 });
  const rowsById = Object.fromEntries(actual.list.map(row => [row.id, row]));
  assert.ok(rowsById[1003], 'active member remains visible even if the user has status 0');
  assert.ok(rowsById[1004], 'member without a user retains public profile data');
  assert.ok(rowsById.profile_2006, 'standalone user with missing status defaults to 1');
  assert.ok(rowsById.profile_2022, 'standalone profile without a user remains visible');
  assert.equal(rowsById[1002], undefined, 'first numeric hidden profile blocks later/string profile fallback');
  assert.equal(rowsById[1007], undefined, 'active member cannot fall back to a later public standalone profile');
  assert.equal(rowsById.profile_2009, undefined, 'inactive standalone user is not visible');
  assert.ok(rowsById.profile_2008, 'string status member is not an active numeric assignment');
  assert.ok(rowsById.profile_2011, 'active=false hide is ignored');
  assert.ok(rowsById.profile_2010, 'inactive status overrides the legacy active=0 flag');
  assert.ok(rowsById.profile_2012, 'newer inactive hide overrides an older active duplicate');
  assert.ok(rowsById.profile_2013, 'string viewer reference does not match numeric viewer query');
  assert.ok(rowsById.profile_2019 && rowsById.profile_3019, 'duplicate standalone profiles remain distinct candidates');
  assert.equal(rowsById[1001].viewerState.isFavorite, false, 'inactive favorite status is not shown as sent');
  assert.equal(rowsById[1001].identityStatus, 'pending');
  assert.equal(rowsById[1001].identityStatusText, '待会员认领');
  assert.deepEqual(plain(rowsById[1001].photos), ['public.jpg', 'second.jpg', 'third.jpg']);
  assert.equal(rowsById[1001].lastRecommendStatus, '已同意');
  assert.equal(rowsById[1001].height, 168);
  assert.equal(rowsById[1001].partnerRequirement, '期待真诚沟通');
  assert.ok(rowsById[1001].profileCompletion.percent > 0);
  assert.equal(rowsById[1001].isVerified, 1);
});

test('showcase filters and page totals retain sanitized-public rather than private-field semantics', async () => {
  const cases = [
    {}, { keyword: '昵称1' }, { keyword: '姓名' }, { keyword: 'PRIVATE_PHONE' },
    { keyword: '设计师' }, { gender: 1 }, { gender: '2' }, { memberType: 'vip' },
    { memberType: 'self_profile' }, { memberType: 'no_consumption' }, { serviceLevel: 'A' },
    { status: 1 }, { status: '0' }, { ageMin: 29, ageMax: 31 }, { ageMax: 29 },
    { ageMin: 0 }, { education: '硕士' }, { maritalStatus: '离异' },
    { incomeRange: '30-50万' }, { city: '杭' }, { city: '不存在' },
    { keyword: '设计师', gender: 2, education: '本科', ageMin: 25, ageMax: 35 },
    { page: 2, pageSize: 3 }, { page: 100, pageSize: 3 }, { page: 0, pageSize: 0 }
  ];
  for (const filters of cases) {
    const { actual } = await comparePage(richFixtures(), filters);
    if (filters.serviceLevel || filters.keyword === 'PRIVATE_PHONE') assert.equal(actual.total, 0);
  }
});

test('sparse and non-positive references preserve legacy user lookups and standalone row identity', async () => {
  const fixtures = {
    hl_users: [
      { id: 0, nickname: '零号停用账号', status: 0, gender: 1 },
      { id: -1, nickname: '负号账号', status: 1, gender: 1 }
    ],
    hl_members: [], hl_match_records: [], hl_member_interactions: [],
    hl_profiles: [
      profile(0, { _id: 'p-zero', id: 100 }),
      profile(-1, { _id: 'p-negative', id: 101 }),
      profile(null, { _id: 'p-null', id: 102 }),
      profile(undefined, { _id: 'p-missing', id: 103 }),
      profile('bad-reference', { _id: 'p-malformed', id: 104 }),
      profile(7, { _id: 'p-7-first', id: 107, city: '上海' }),
      profile(7, { _id: 'p-7-second', id: 107, city: '杭州' })
    ]
  };
  const { actual } = await comparePage(fixtures, { pageSize: 50 });
  assert.equal(actual.list.some(row => row.userId === 0), false, 'numeric zero user status remains authoritative');
  assert.equal(actual.list.find(row => row.userId === -1).nickname, '负号账号');
  assert.deepEqual(plain(actual.list.filter(row => row.id === 'profile_107').map(row => row.city)), ['上海', '杭州'],
    'same public ID and user reference still retain distinct database rows');
});

test('recent recommendation status keeps noncanonical strings, invalid dates and stable ties', async () => {
  const fixtures = richFixtures();
  fixtures.hl_match_records = [
    { id: 1, userAId: '003', userBId: 1, createdAt: '2026-01-01', status: 'rejected' },
    { id: 8, userAId: '3.0', userBId: 19, createdAt: '2026-09-01', status: 'accepted' },
    { id: 4, userAId: 1, userBId: 19, createdAt: 'bad-date', status: 'pending' },
    { id: 6, userAId: 1, userBId: 22, createdAt: '2026-08-01', status: 'rejected' },
    { id: 9, userAId: 19, userBId: 22, createdAt: '', status: 'custom-status' },
    { id: 11, userAId: 22, userBId: 13, createdAt: '2026-10-01', status: 'accepted' },
    { id: 11, userAId: 22, userBId: 13, createdAt: '2026-10-01', status: 'rejected' },
    { id: 3, userAId: 4, userBId: 6, createdAt: '2026-01-01' },
    { id: 99, userAId: true, userBId: 900000, createdAt: '2026-11-01', status: 'accepted' }
  ];
  const { actual, hooks } = await comparePage(fixtures, { pageSize: 100 });
  for (const row of actual.list) {
    assert.equal(row.lastRecommendStatus, hooks.lastRecommendationStatusForUser(row.userId, fixtures.hl_match_records),
      `user ${row.userId} must use the original per-user date/id comparator`);
  }
  assert.equal(actual.list.find(row => row.userId === 3).lastRecommendStatus, '已同意');
  assert.equal(actual.list.find(row => row.userId === 1).lastRecommendStatus, '已同意',
    'legacy Number(true) reference remains equivalent to user 1');
  assert.equal(actual.list.find(row => row.userId === 22).lastRecommendStatus, '已同意');
});

test('more than 1000 candidates retain exact totals while only the 50-row page is fully enriched', async context => {
  const count = 1005;
  const fixtures = {
    hl_users: Array.from({ length: count }, (_, index) => ({ id: index + 1,
      nickname: `昵称${index + 1}`, status: 1, gender: 2, openid: `wx-${index + 1}`,
      isVerified: 1, phone: 'PRIVATE_PHONE' })),
    hl_profiles: Array.from({ length: count }, (_, index) => profile(index + 1)),
    hl_members: [], hl_member_interactions: [],
    hl_match_records: [
      ...Array.from({ length: 3000 }, (_, index) => ({ id: index + 1, userAId: 100000 + index,
        userBId: 200000 + index, createdAt: '2026-01-01', status: 'pending', note: 'PRIVATE_PROOF' })),
      ...Array.from({ length: 50 }, (_, index) => ({ id: 4000 + index, userAId: count - index,
        userBId: 500000 + index, createdAt: '2026-02-01', status: 'accepted', note: 'PRIVATE_PROOF' })),
      { id: 5001, userAId: '00980', userBId: 900000, createdAt: '2026-03-01', status: 'rejected' },
      { id: 5002, userAId: '999999.0', userBId: 900001, createdAt: '2026-03-01', status: 'pending' }
    ]
  };
  const optimized = backendRuntime(fixtures);
  const actual = await optimized.hooks.publicShowcasePage(20000, { page: 1, pageSize: 50 });
  assert.equal(actual.total, count);
  assert.equal(actual.list.length, 50);
  assert.equal(actual.list[0].id, 'profile_3005');
  assert.equal(actual.list.at(-1).id, 'profile_2956');
  const pageIds = new Set(actual.list.map(row => Number(row.userId)));
  const richProfiles = optimized.reads.filter(read => read.collection === 'hl_profiles'
    && (!read.fields || read.fields.photos || read.fields.selfIntro));
  const richUsers = optimized.reads.filter(read => read.collection === 'hl_users'
    && (!read.fields || read.fields.openid || read.fields.isVerified));
  assert.ok(richProfiles.length > 0 && richUsers.length > 0, 'page must hydrate full public fields');
  assert.ok(richProfiles.every(read => read.query && read.rows.every(row => pageIds.has(Number(row.userId)))),
    'full profile reads must be scoped to this page');
  assert.ok(richUsers.every(read => read.query && read.rows.every(row => pageIds.has(Number(row.id)))),
    'full user reads must be scoped to this page');
  assert.ok(optimized.reads.some(read => read.collection === 'hl_profiles' && read.fields
    && !read.fields.photos && !read.fields.selfIntro), 'global profile candidates must use a thin projection');
  const historyReads = optimized.reads.filter(read => read.collection === 'hl_match_records');
  assert.ok(historyReads.length > 0);
  assert.ok(historyReads.every(read => read.query && read.fields), 'history reads must be scoped and projected');
  const returnedHistory = historyReads.flatMap(read => read.rows);
  assert.ok(returnedHistory.every(row => typeof row.userAId === 'string' || typeof row.userBId === 'string'
    || pageIds.has(Number(row.userAId)) || pageIds.has(Number(row.userBId))),
  'unrelated numeric histories must stay in the database; string compatibility rows may be broader');
  assert.ok(returnedHistory.length < 100, `history transfer remains scoped: ${returnedHistory.length}`);
  assert.equal(actual.list.find(row => row.userId === 980).lastRecommendStatus, '已拒绝');
  assert.equal(optimized.writes.length, 0);
  const expectedStatus = optimized.hooks.lastRecommendationStatusForUser;
  for (const row of actual.list) assert.equal(row.lastRecommendStatus, expectedStatus(row.userId, fixtures.hl_match_records));
  context.diagnostic(`1005 profiles, 3052 histories: ${optimized.reads.length} reads; ${returnedHistory.length} history rows transferred`);
});

test('empty filtered pages do not enrich profiles, users or recommendation history', async () => {
  for (const filters of [{ keyword: '不存在' }, { page: 100, pageSize: 3 }]) {
    const { actual, reads } = await comparePage(richFixtures(), filters);
    assert.equal(actual.list.length, 0);
    assert.equal(reads.filter(read => read.collection === 'hl_match_records').length, 0);
    assert.ok(reads.filter(read => ['hl_profiles', 'hl_users'].includes(read.collection))
      .every(read => read.fields && !read.fields.photos && !read.fields.selfIntro && !read.fields.openid));
  }
});

test('page enrichment and visibility refresh for each request rather than using a warm global cache', async () => {
  const fixtures = richFixtures();
  const { hooks, writes } = backendRuntime(fixtures);
  const first = await hooks.publicShowcasePage(20, { pageSize: 100 });
  const target = first.list.find(row => row.userId === 1);
  assert.equal(target.city, '上海');
  fixtures.hl_profiles.find(row => row.userId === 1).city = '杭州';
  fixtures.hl_users.find(row => row.id === 1).nickname = '更新后的昵称';
  const second = await hooks.publicShowcasePage(20, { pageSize: 100 });
  assert.equal(second.list.find(row => row.userId === 1).city, '杭州');
  assert.equal(second.list.find(row => row.userId === 1).nickname, '更新后的昵称');
  fixtures.hl_profiles.find(row => row.userId === 1).displayEnabled = false;
  const third = await hooks.publicShowcasePage(20, { pageSize: 100 });
  assert.ok(third.list.every(row => row.userId !== 1));
  assert.equal(writes.length, 0);
});

test('a profile hidden between candidate scanning and hydration does not expose its public DTO', async () => {
  const fixtures = richFixtures();
  let disabledDuringHydration = false;
  const runtime = backendRuntime(fixtures, (collectionName, state) => {
    if (!disabledDuringHydration && collectionName === 'hl_profiles' && state.fields && state.fields.photos) {
      fixtures.hl_profiles.filter(row => Number(row.userId) === 19).forEach(row => { row.displayEnabled = false; });
      disabledDuringHydration = true;
    }
  });
  const actual = await runtime.hooks.publicShowcasePage(20, { pageSize: 50 });
  assert.equal(disabledDuringHydration, true, 'fixture must change visibility after the thin scan');
  assert.ok(actual.list.every(row => row.userId !== 19), 'both formerly visible standalone rows must be revalidated');
  assert.equal(runtime.writes.length, 0);
});

test('a capped duplicate identity batch does not read unrelated full users while building candidates', async () => {
  const fixtures = {
    hl_users: [
      ...Array.from({ length: 1000 }, (_, index) => ({ _id: `u-duplicate-${index}`, id: 1,
        nickname: `重复昵称${index}`, status: 1, gender: 2, phone: 'PRIVATE_PHONE', openid: 'wx-1' })),
      { _id: 'u-2', id: 2, nickname: '第二位', status: 1, gender: 2, phone: 'PRIVATE_PHONE', openid: 'wx-2' },
      { _id: 'u-3', id: 3, nickname: '第三位', status: 1, gender: 2, phone: 'PRIVATE_PHONE', openid: 'wx-3' }
    ],
    hl_profiles: [profile(1), profile(2), profile(3)],
    hl_members: [], hl_match_records: [], hl_member_interactions: []
  };
  const { actual, reads } = await comparePage(fixtures, { pageSize: 1 }, 20);
  assert.equal(actual.list[0].userId, 3);
  const fullUserReads = reads.filter(read => read.collection === 'hl_users'
    && (!read.fields || read.fields.openid || read.fields.isVerified));
  assert.ok(fullUserReads.every(read => read.rows.every(row => Number(row.id) === 3)),
    'duplicate-batch recovery must retain the thin projection for all off-page identities');
});
