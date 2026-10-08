const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const source = fs.readFileSync(apiPath, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

// Reference algorithms stay inside this VM; production exports remain unchanged.
const reference = `
async function legacyOwnList(userId, filters = {}) {
  const mm = await getCertifiedMatchmakerByUserIdOrThrow(userId);
  let rows = await getAll(C.members, { matchmakerId: mm.id });
  if (filters.status === undefined || filters.status === '') rows = rows.filter(row => Number(row.status) === 1);
  const matchRecords = await getAll(C.matchRecords, { matchmakerId: mm.id });
  const views = await Promise.all(rows.map(row => memberView(row, { matchRecords })));
  return resolveMemberMediaPage(paginate(views.filter(row => matchesMemberFilters(row, filters)).sort((a,b) => b.id-a.id), filters.page, filters.pageSize));
}
async function legacyDashboardStats(userId) {
  const mm = await getMatchmakerByUserIdOrThrow(userId);
  const members = await getAll(C.members, { matchmakerId: mm.id, status: 1 });
  const salons = await getAll(C.salonEvents, { organizerId: Number(userId) });
  const allMembers = await getAll(C.members, { status: 1 });
  const records = await getAll(C.matchRecords, { matchmakerId: mm.id });
  const memberIds = new Set(allMembers.map(row => Number(row.userId)));
  const profiles = (await getAll(C.profiles)).filter(row => isTrue(row.displayEnabled) && !memberIds.has(Number(row.userId)) && Number(row.userId)!==Number(userId));
  const ownViews = await Promise.all(members.map(row => memberView(row, {matchRecords:records})));
  const resourceViews = await Promise.all(allMembers.filter(row => row.matchmakerId!==mm.id).map(row => memberView(row, {matchRecords:records})));
  const profileViews = await Promise.all(profiles.map(row => profileMemberView(row, {matchRecords:records})));
  const eventIds = salons.map(row => Number(row.id));
  const registrations = eventIds.length ? (await getAll(C.registrations)).filter(row => eventIds.includes(Number(row.eventId)) && row.status==='registered') : [];
  return {
    memberCount:members.length,salonCount:salons.length,registrationCount:registrations.length,
    resourceCount:[...resourceViews,...profileViews].filter(row => Number(row.status)===1 && row.displayEnabled).length,
    recentRecommendationCount:records.filter(row => { const time=new Date(row.createdAt||0).getTime();return time && time>=Date.now()-7*86400000 }).length,
    pendingMemberRequests:(await getAll(C.memberRequests,{matchmakerId:mm.id,status:'pending'})).length,
    todoCounts:{incompleteMembers:ownViews.filter(row => row.profileCompletion.percent<70).length,pendingRecommendations:records.filter(row=>row.status==='pending').length,upcomingSalons:salons.filter(row=>row.status==='upcoming').length,salonRegistrations:registrations.length}
  };
}
async function legacyEvents(filters={}) {
  const rows=(await getAll(C.salonEvents)).filter(row=>row.status===(filters.status||'upcoming')).sort((a,b)=>new Date(a.eventDate)-new Date(b.eventDate));
  const views=await Promise.all(rows.map(row=>eventView(row)));
  return paginate(views,filters.page,filters.pageSize);
}
exports.__test={member,matchmaker,salon,chat,C,collectionsForPath,publicShowcaseRows,legacyOwnList,legacyDashboardStats,legacyEvents};
`;

function runtime(input) {
  const fixtures = structuredClone(input);
  const reads = [], writes = [];
  const op = (kind, values) => ({ kind, values });
  function matchesValue(value, expected) {
    if (!expected || !expected.kind) return value === expected;
    if (expected.kind === 'in') return Array.isArray(value) ? value.some(item => expected.values.includes(item)) : expected.values.includes(value);
    if (expected.kind === 'nin') return !matchesValue(value, op('in', expected.values));
    if (expected.kind === 'lt') return value < expected.values;
    if (expected.kind === 'gt') return value > expected.values;
    if (expected.kind === 'eq') return value === expected.values;
    if (expected.kind === 'neq') return value !== expected.values;
    if (expected.kind === 'regex') return new RegExp(expected.values.regexp, expected.values.options).test(String(value || ''));
    throw new Error(`unsupported fixture operator ${expected.kind}`);
  }
  function matches(row, query) {
    if (!query) return true;
    if (query.kind === 'or') return query.values.some(part => matches(row, part));
    if (query.kind === 'and') return query.values.every(part => matches(row, part));
    return Object.entries(query).every(([field, expected]) => matchesValue(row[field], expected));
  }
  function collection(name) {
    const state = { query: null, offset: 0, limit: 100, fields: null, order: [] };
    const ref = {
      where(query) { state.query = query; return ref; },
      skip(offset) { state.offset = offset; return ref; },
      limit(limit) { assert.ok(limit <= 100, 'wx-server-sdk page must not exceed 100'); state.limit = limit; return ref; },
      field(fields) { state.fields = fields; return ref; },
      orderBy(field, direction) { state.order.push([field, direction]); return ref; },
      async count() {
        const total = (fixtures[name] || []).filter(row => matches(row, state.query)).length;
        reads.push({ name, ...plain(state), kind: 'count', returned: 0 });
        return { total };
      },
      async get() {
        let rows = (fixtures[name] || []).filter(row => matches(row, state.query));
        if (state.order.length) rows = [...rows].sort((a, b) => {
          for (const [field, direction] of state.order) {
            const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
            if (cmp) return direction === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
        rows = rows.slice(state.offset, state.offset + state.limit);
        reads.push({ name, ...plain(state), kind: 'get', returned: rows.length });
        if (state.fields) rows = rows.map(row => Object.fromEntries(Object.keys(state.fields).filter(key => state.fields[key] && key in row).map(key => [key, row[key]])));
        return { data: structuredClone(rows) };
      },
      doc(id) {
        return {
          async update({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            assert.ok(row, `missing fixture document ${id}`);
            writes.push({ name, id, data: structuredClone(data) });
            Object.assign(row, structuredClone(data));
          },
          async get() { const row = (fixtures[name] || []).find(item => item._id === id); return { data: structuredClone(row) }; },
          set() { throw new Error('unexpected document creation'); }
        };
      },
      add() { throw new Error('unexpected row creation'); }
    };
    return ref;
  }
  const db = {
    collection,
    command: Object.fromEntries(['in','nin','lt','gt','eq','neq','or','and'].map(kind => [kind, values => op(kind, values)])),
    RegExp: values => op('regex', values),
    createCollection() { throw new Error('unexpected collection creation'); },
    runTransaction() { throw new Error('unexpected transaction for already-current conversation'); }
  };
  const module = { exports: {} };
  vm.runInNewContext(source + reference, {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'backend-local-fixture-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', DEMO_MEMBERS: 'false', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    console: { warn() {}, error() {}, log() {} }, Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  return { hooks: module.exports.__test, reads, writes, fixtures };
}

function fixture(count = 25) {
  const f = { hl_users: [{ _id: 'user-1', id: 1, status: 1, nickname: '主理人' }], hl_profiles: [], hl_members: [], hl_matchmakers: [{
    _id: 'mm-1', id: 1, userId: 1, status: 1, certificationStatus: 2, matchmakerNo: 'MM0001', inviteCode: 'INVITE1', inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-10-07'
  }], hl_conversations: [], hl_match_records: [], hl_salon_events: [], hl_registrations: [] };
  for (let index = 0; index < count; index += 1) {
    const userId = index + 2;
    f.hl_users.push({ _id: `user-${userId}`, id: userId, status: 1, nickname: `会员${userId}`, gender: index % 2 + 1, phone: 'PRIVATE_PHONE', openid: `wx-${userId}` });
    f.hl_profiles.push({ _id: `profile-${userId}`, id: 1000 + userId, userId, realName: `姓名${userId}`, displayEnabled: true, city: index % 2 ? '上海' : '杭州', gender: 2, age: 28 + index % 4, education: '本科', occupation: '设计师', photos: ['public.jpg'], privateArchive: { proof: 'PRIVATE_PROOF' } });
    f.hl_members.push({ _id: `member-${userId}`, id: 2000 + userId, userId, matchmakerId: 1, status: 1, memberType: index % 2 ? 'free' : 'vip', serviceLevel: index % 2 ? 'A' : 'B' });
    f.hl_conversations.push({ _id: `conversation-${userId}`, id: 3000 + userId, status: 'active', participantIds: [1, userId], participantKey: `1:${userId}`, conversationType: 'member_matchmaker', memberId: 2000 + userId, matchmakerId: 1, matchmakerUserId: 1 });
  }
  return f;
}

function chatFixture(count) {
  const f = fixture(2);
  f.hl_conversations = [{ _id: 'chat-1', id: 1, status: 'active', participantIds: [1, 2], participantKey: '1:2', conversationType: 'member_pair', matchRecordId: 7, unreadBy: { 1: 3 } }];
  f.hl_chat_messages = Array.from({ length: count }, (_, index) => ({ _id: `message-${index + 1}`, id: index + 1, conversationId: 1, senderId: index % 2 + 1, receiverId: index % 2 ? 1 : 2, status: 'active', readBy: [1, 2], content: `消息${index + 1}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString() }));
  return f;
}

test('latest chat window includes message 81; history and incremental cursors are exclusive', async () => {
  const r = runtime(chatFixture(81));
  const page = await r.hooks.chat.listMessages(1, 1, { pageSize: 80 });
  assert.deepEqual(Array.from(page.messages, row => row.id), Array.from({ length: 80 }, (_, index) => index + 2));
  assert.equal(page.hasMore, true); assert.equal(page.beforeId, 2); assert.equal(page.latestId, 81); assert.equal(page.total, 81);
  const history = await r.hooks.chat.listMessages(1, 1, { beforeId: 2, pageSize: 80 });
  assert.deepEqual(Array.from(history.messages, row => row.id), [1]); assert.equal(history.hasMore, false);
  const newer = await r.hooks.chat.listMessages(1, 1, { afterId: 79, pageSize: 80 });
  assert.deepEqual(Array.from(newer.messages, row => row.id), [80, 81]); assert.equal(newer.hasMore, false);
  const fromEmpty = await r.hooks.chat.listMessages(1, 1, { afterId: 0, pageSize: 80 });
  assert.equal(fromEmpty.messages[0].id, 1); assert.equal(fromEmpty.hasMore, true);
  for (const filters of [{ beforeId: 0 }, { afterId: -1 }, { afterId: 'bad' }, { beforeId: 2, afterId: 0 }]) await assert.rejects(r.hooks.chat.listMessages(1, 1, filters), /游标/);
});

test('large chat history fetches one body window and only unread metadata; participant reads are batched', async () => {
  const f = chatFixture(1105);
  f.hl_chat_messages[1103].readBy = [2];
  const r = runtime(f);
  const result = await r.hooks.chat.listMessages(1, 1, { pageSize: 80 });
  assert.equal(result.messages[0].id, 1026); assert.equal(result.latestId, 1105); assert.equal(result.total, 1105);
  const bodyReads = r.reads.filter(row => row.name === 'hl_chat_messages' && row.kind === 'get' && !row.fields);
  assert.equal(bodyReads.length, 1); assert.equal(bodyReads[0].returned, 81);
  const metadata = r.reads.filter(row => row.name === 'hl_chat_messages' && row.fields);
  assert.equal(metadata.length, 1); assert.equal(metadata[0].returned, 1);
  assert.ok(r.reads.filter(row => ['hl_users', 'hl_profiles'].includes(row.name)).length <= 2);
  assert.ok(r.fixtures.hl_chat_messages[1103].readBy.includes(1));
  assert.equal(result.conversation.unreadCount, 0);
  assert.equal(r.writes.filter(row => row.name === 'hl_chat_messages').length, 1);
});

test('100-message window stays within the SDK 100-document read limit and preserves lookahead', async () => {
  const r = runtime(chatFixture(105));
  const result = await r.hooks.chat.listMessages(1, 1, { pageSize: 100 });
  assert.equal(result.messages.length, 100); assert.equal(result.messages[0].id, 6); assert.equal(result.hasMore, true);
});

test('message sequence and cursors use stable IDs even when creation timestamps arrive out of order', async () => {
  const f = chatFixture(81);
  f.hl_chat_messages.forEach((row, index) => { row.createdAt = new Date(Date.UTC(2026, 9, 1, 0, 0, 81 - index)).toISOString(); });
  const r = runtime(f);
  const result = await r.hooks.chat.listMessages(1, 1, { pageSize: 80 });
  assert.deepEqual(Array.from(result.messages, row => row.id), Array.from({ length: 80 }, (_, index) => index + 2));
  assert.equal(result.beforeId, 2); assert.equal(result.latestId, 81);
  const old = await r.hooks.chat.listMessages(1, 1, { beforeId: result.beforeId });
  assert.deepEqual(Array.from(old.messages, row => row.id), [1]);
});

test('participant query finds own conversation beyond 1000 unrelated rows, including string participant IDs', async () => {
  const f = fixture(0);
  f.hl_matchmakers[0].certificationStatus = 0;
  f.hl_conversations = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, status: 'active', participantIds: [index + 100, index + 200], participantKey: `${index + 100}:${index + 200}`, conversationType: 'member_pair' }));
  f.hl_conversations.push({ id: 1001, status: 'active', participantIds: ['1', '2'], participantKey: '1:2', conversationType: 'member_pair', matchRecordId: 7 });
  const r = runtime(f);
  const result = await r.hooks.chat.listConversations(1, { pageSize: 20 });
  assert.equal(result.total, 1); assert.equal(result.list[0].id, 1001);
  assert.ok(r.reads.filter(row => row.name === 'hl_conversations').every(row => row.query && row.returned <= 1));
  assert.equal(r.writes.length, 0);
});

test('free-member premium chat guards remain enforced after scoped conversation lookup', async () => {
  const f = fixture(0); f.hl_matchmakers[0].certificationStatus = 0;
  f.hl_conversations = [{ _id: 'premium-chat', id: 1, status: 'active', participantIds: [1, 2], participantKey: '1:2', conversationType: 'member_pair', chatOpenReason: 'mutual_favorite' }];
  const r = runtime(f);
  assert.equal((await r.hooks.chat.listConversations(1)).total, 0);
  await assert.rejects(r.hooks.chat.listMessages(1, 1), /开通会员/);
  assert.equal(r.writes.length, 0);
});

test('member list batching preserves all cross-profile filters and DTOs', async () => {
  const f = fixture(25);
  Object.assign(f.hl_profiles[0], { height: 170, nativePlace: '苏州', incomeRange: '20万', maritalStatus: '未婚', houseStatus: '有房', carStatus: '有车', selfIntro: '自我介绍', partnerRequirement: '认真沟通' });
  // Fully complete, threshold-adjacent and empty profiles exercise the 70% gate.
  Object.assign(f.hl_profiles[1], f.hl_profiles[0], { id: 1003, userId: 3, realName: '姓名3', city: '', incomeRange: '', selfIntro: '', partnerRequirement: '', photos: [] });
  f.hl_members.push({ _id: 'removed', id: 9000, userId: 2, matchmakerId: 1, status: 0, memberType: 'free' });
  f.hl_match_records = [{ id: 1, matchmakerId: 1, userAId: 2, userBId: 3, status: 'pending', createdAt: '2026-10-06' }];
  for (const filters of [{ page: 1, pageSize: 7 }, { keyword: '姓名', city: '上海', gender: 2 }, { memberType: 'free', serviceLevel: 'A' }, { ageMin: 29, ageMax: 30, education: '本科' }, { status: 0 }]) {
    const optimized = runtime(f); const legacy = runtime(f);
    assert.deepEqual(plain(await optimized.hooks.member.listOwn(1, filters)), plain(await legacy.hooks.legacyOwnList(1, filters)));
  }
  const small = runtime(fixture(25)); const large = runtime(fixture(125));
  await small.hooks.member.listOwn(1, { pageSize: 20 }); await large.hooks.member.listOwn(1, { pageSize: 20 });
  assert.ok(small.reads.length <= 6); assert.ok(large.reads.length <= 12);
});

test('dashboard projected statistics equal legacy results across visibility, resources and registrations', async () => {
  const f = fixture(25);
  const complete = { height: 170, nativePlace: '苏州', incomeRange: '20万', maritalStatus: '未婚', houseStatus: '有房', carStatus: '有车', selfIntro: '自我介绍', partnerRequirement: '认真沟通' };
  Object.assign(f.hl_profiles[0], complete);
  Object.assign(f.hl_profiles[1], complete, { city: '', incomeRange: '', selfIntro: '', partnerRequirement: '', photos: [] });
  Object.assign(f.hl_profiles[2], complete, { houseStatus: '', carStatus: '', selfIntro: '', partnerRequirement: '' });
  f.hl_users[3].gender = 0;
  f.hl_members[20].matchmakerId = 2;
  f.hl_profiles[20].displayEnabled = false;
  f.hl_users.push({ id: 100, status: 1, nickname: '自主资料' }, { id: 101, status: 0, nickname: '停用' });
  f.hl_profiles.push({ id: 1100, userId: 100, realName: '自主资料', displayEnabled: true }, { id: 1101, userId: 101, realName: '停用', displayEnabled: true });
  f.hl_salon_events = [{ id: 1, organizerId: 1, status: 'upcoming' }, { id: 2, organizerId: 2, status: 'upcoming' }];
  f.hl_registrations = [{ id: 1, eventId: 1, status: 'registered' }, { id: 2, eventId: '1', status: 'registered' }, { id: 3, eventId: 2, status: 'registered' }, { id: 4, eventId: 1, status: 'cancelled' }];
  f.hl_member_matchmaker_requests = [{ id: 1, matchmakerId: 1, status: 'pending' }];
  f.hl_match_records = [{ id: 1, matchmakerId: 1, userAId: 2, userBId: 3, status: 'pending', createdAt: new Date().toISOString() }];
  const r = runtime(f); const legacy = runtime(f);
  const result = await r.hooks.matchmaker.dashboard(1);
  assert.deepEqual(plain({ memberCount: result.matchmaker.memberCount, salonCount: result.operations.salonCount, registrationCount: result.registrationCount, resourceCount: result.resourceCount, recentRecommendationCount: result.recentRecommendationCount, pendingMemberRequests: result.pendingMemberRequests, todoCounts: { ...result.todoCounts, pendingMemberRequests: undefined } }), plain(await legacy.hooks.legacyDashboardStats(1)));
  assert.ok(r.reads.filter(row => row.name === 'hl_registrations').every(row => row.query));
  assert.ok(r.reads.filter(row => ['hl_users','hl_profiles','hl_members'].includes(row.name)).every(row => row.fields));
  const large = runtime(fixture(125)); await large.hooks.matchmaker.dashboard(1); assert.ok(large.reads.length <= 12);
});

test('salon lists paginate before registration/user enrichment and preserve registration DTOs', async () => {
  const f = fixture(20);
  f.hl_salon_events = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, organizerId: 1, status: 'upcoming', eventDate: new Date(Date.UTC(2026, 10, index + 1)).toISOString(), maxParticipants: 50 }));
  f.hl_registrations = f.hl_salon_events.flatMap(event => Array.from({ length: 20 }, (_, index) => ({ id: event.id * 100 + index, eventId: event.id, userId: index + 2, status: 'registered' })));
  const r = runtime(f); const legacy = runtime(f);
  const result = await r.hooks.salon.listEvents({ page: 2, pageSize: 5 });
  assert.deepEqual(plain(result), plain(await legacy.hooks.legacyEvents({ page: 2, pageSize: 5 })));
  assert.ok(r.reads.length <= 5);
  const registrations = r.reads.filter(row => row.name === 'hl_registrations');
  assert.ok(registrations.every(row => row.query.eventId.values.every(id => id >= 6 && id <= 10)));
});

test('lightweight status performs no creation; invite options expose only certified active own IDs/names', async () => {
  const f = fixture(4); delete f.hl_matchmakers[0].inviteCode; delete f.hl_matchmakers[0].matchmakerNo;
  f.hl_members[0].status = 0; f.hl_members[1].matchmakerId = 2;
  const r = runtime(f);
  const status = await r.hooks.matchmaker.status(1);
  assert.equal(status.matchmaker.certificationStatus, 2); assert.equal(status.matchmaker.matchmakerNo, '');
  assert.equal(r.writes.length, 0); assert.equal(r.reads.length, 1);
  const options = await r.hooks.member.inviteOptions(1);
  assert.equal(options.total, 2);
  assert.ok(options.list.every(row => Object.keys(row).sort().join(',') === 'id,nickname,realName,userId'));
  assert.doesNotMatch(JSON.stringify(options), /PRIVATE|openid|photos|phone|inviteCode/);
  const denied = runtime({ ...fixture(1), hl_matchmakers: [{ id: 1, userId: 1, status: 1, certificationStatus: 0 }] });
  await assert.rejects(denied.hooks.member.inviteOptions(1), /认证/); assert.equal(denied.writes.length, 0);
  assert.deepEqual(Array.from(r.hooks.collectionsForPath('/matchmaker/status')).sort(), ['hl_matchmakers','hl_users']);
});

test('own member totals and public showcase pagination are complete beyond 1000 source rows', async () => {
  const own = runtime(fixture(1005));
  const page = await own.hooks.member.listOwn(1, { pageSize: 20 });
  assert.equal(page.total, 1005); assert.equal(page.list[0].id, 3006); assert.equal(page.list.length, 20);
  assert.ok(own.reads.length < 60);
  const f = fixture(1005); f.hl_members = []; f.hl_profiles[0].displayEnabled = false;
  const publicRuntime = runtime(f);
  const publicRows = await publicRuntime.hooks.publicShowcaseRows();
  assert.equal(publicRows.length, 1004);
  assert.ok(publicRows.some(row => row.id === 'profile_2006'));
  assert.doesNotMatch(JSON.stringify(publicRows), /PRIVATE_PROOF|PRIVATE_PHONE|openid|privateArchive/);
});
