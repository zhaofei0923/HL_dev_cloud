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
async function legacyNotificationList(userId, filters = {}) {
  const isPremiumMember = await hasPremiumMemberEntitlement(userId);
  const rows = (await getAll(C.messages, { receiverId: Number(userId) }, 2000))
    .filter(row => Number(row.status || 1) !== 0)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || Number(b.id || 0) - Number(a.id || 0));
  const page = paginate(rows, filters.page, filters.pageSize || 20);
  return { ...page, unreadCount: rows.filter(row => !isMessageRead(row)).length,
    list: await Promise.all(page.list.map(row => notificationMessageView(row, userId, isPremiumMember))) };
}
async function legacyMembershipOverview(userId) {
  const [user, assignment, normalPlans, unresolvedOrders, vipOverview, readiness] = await Promise.all([
    getUserOrThrow(userId), activeMemberAssignment(userId), activeMembershipPlans(), unresolvedUserPaymentOrders(userId),
    vipMembership.overview(userId), vipMembership.getMatchmakingReadiness(userId)
  ]);
  let integration = membershipPaymentIntegration(userId);
  let plans = normalPlans.filter(plan => plan.planCode !== paymentTestPlan().planCode);
  if (integration.testMode) {
    const testPlan = paymentTestPlan(process.env);
    const testOrder = await getOne(C.paymentOrders, { _id: paymentTestDocumentId(process.env, userId) });
    const completed = testOrder && (testOrder.status === 'paid'
      || (testPlan.planCode === 'vip_week' && !['pending', 'confirming'].includes(testOrder.status)));
    plans = completed ? [] : [testPlan];
    if (completed) integration = { ...integration, available: false, createPath: '', reason: 'payment_test_completed' };
  }
  let payment = membershipPaymentAvailability({ config: integration, assignment, user,
    plans: plans.filter(plan => plan.productType !== 'matchmaking') });
  let matchmakingPayment = matchmakingPaymentIntegration();
  if (matchmakingPayment.available && (!user.phone || !plans.some(plan => plan.productType === 'matchmaking' && plan.active))) {
    matchmakingPayment = { ...matchmakingPayment, available: false,
      reason: !user.phone ? 'phone_required' : 'plans_not_configured' };
  }
  const pendingOrder = unresolvedOrders[0] || null;
  if (pendingOrder && pendingOrder.fulfillmentStatus === 'requires_review') {
    payment = { ...payment, available: false, createPath: '', reason: 'payment_requires_review' };
    matchmakingPayment = { ...matchmakingPayment, available: false, createPath: '', reason: 'payment_requires_review' };
  }
  const premium = vipOverview.isPremiumMember;
  return { isPremiumMember: premium, phoneBound: !!user.phone,
    phoneMasked: user.phone ? String(user.phone).slice(0, 3) + '****' + String(user.phone).slice(-4) : '',
    needsMatchmaker: !assignment,
    membership: premium || assignment ? { memberType: premium ? 'vip' : 'free', serviceLevel: assignment?.serviceLevel || '',
      expireAt: vipOverview.expireAt, lifetime: vipOverview.lifetime } : null,
    membershipTier: vipOverview.membershipTier, entitlements: vipOverview.entitlements, vipMembership: vipOverview.vipMembership,
    matchmakingPackages: (await vipMembership.packages(userId)).list, matchmakingReadiness: readiness,
    matchmakingProgress: vipOverview.matchmakingProgress, plans,
    pendingOrder: pendingOrder ? publicPaymentOrder(pendingOrder) : null,
    pendingOrderPayment: pendingOrder ? membershipOrderPaymentIntegration(userId, pendingOrder) : null,
    unresolvedOrderCount: unresolvedOrders.length, payment, matchmakingPayment };
}
exports.__test={member,matchmaker,salon,chat,messages,membership,C,collectionsForPath,publicShowcaseRows,
  legacyOwnList,legacyDashboardStats,legacyEvents,legacyNotificationList,legacyMembershipOverview};
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
          async get() {
            const row = (fixtures[name] || []).find(item => item._id === id);
            reads.push({ name, kind: 'doc', id, returned: row ? 1 : 0 });
            return { data: structuredClone(row) };
          },
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

function notificationFixture(count = 20, { premium = false, favorite = false } = {}) {
  const f = fixture(count);
  f.hl_messages = Array.from({ length: count }, (_, index) => ({ _id: `notification-${index + 1}`,
    id: index + 1, receiverId: 1, senderId: index + 2, status: 1, isRead: index % 2,
    messageType: favorite ? 'member_favorite' : 'online_reminder', content: `通知${index + 1}`,
    conversationId: 1000 + index, createdAt: '2026-10-19T00:00:00.000Z' }));
  if (premium) f.hl_vip_entitlements = [{ _id: 'vip_user_1', userId: 1,
    legacyLifetime: true, legacyExpireAt: null, grants: [] }];
  return f;
}

test('20 visible notifications preserve DTOs while sender reads fall from 40 to two batches', async () => {
  const f = notificationFixture();
  const optimized = runtime(f), legacy = runtime(f);
  const result = await optimized.hooks.messages.list(1);
  assert.deepEqual(plain(result), plain(await legacy.hooks.legacyNotificationList(1)));
  assert.equal(legacy.reads.length, 44);
  assert.equal(optimized.reads.length, 6);
  assert.equal(optimized.reads.filter(read => read.name === 'hl_profiles').length, 1);
  assert.equal(result.unreadCount, 10);
  assert.deepEqual(Array.from(result.list, row => row.id), Array.from({ length: 20 }, (_, index) => 20 - index));
  assert.equal(optimized.writes.length, 0);
});

test('free-member hidden favorite notifications never read sender identities', async () => {
  const f = notificationFixture(20, { favorite: true });
  const optimized = runtime(f), legacy = runtime(f);
  const result = await optimized.hooks.messages.list(1);
  assert.deepEqual(plain(result), plain(await legacy.hooks.legacyNotificationList(1)));
  assert.equal(optimized.reads.length, 4);
  assert.equal(legacy.reads.length, 4);
  assert.equal(optimized.reads.filter(read => read.name === 'hl_profiles').length, 0);
  assert.ok(optimized.reads.filter(read => read.name === 'hl_users')
    .every(read => read.query.id === 1));
  assert.doesNotMatch(JSON.stringify(result), /姓名|PRIVATE|wx-/);
  assert.equal(optimized.writes.length, 0);
});

test('notification batch projection preserves nickname and city seeds for sparse-profile default avatars', async () => {
  for (const seed of [{ city: '上海' }, { nickname: '小红', city: '深圳' }]) {
    const f = notificationFixture(1);
    Object.assign(f.hl_users[1], { avatarUrl: '', gender: 2 });
    Object.assign(f.hl_profiles[0], { realName: '', photos: [], gender: 2, city: '', nickname: '', ...seed });
    const optimized = runtime(f), legacy = runtime(f);
    const actual = await optimized.hooks.messages.list(1);
    const expected = await legacy.hooks.legacyNotificationList(1);
    assert.deepEqual(plain(actual), plain(expected));
    assert.equal(optimized.reads.filter(read => read.name === 'hl_profiles').length, 1);
    const profileRead = optimized.reads.find(read => read.name === 'hl_profiles');
    assert.equal(profileRead.fields.nickname, true);
    assert.equal(profileRead.fields.city, true);
    assert.match(actual.list[0].sender.avatarUrl, /avatar-female-2\.png$/);
    assert.equal(optimized.writes.length, 0);
  }
});

test('notification batching preserves premium visibility, page boundaries, unread totals and missing senders', async () => {
  for (const premium of [false, true]) {
    const f = notificationFixture(25, { premium });
    f.hl_messages[21].messageType = 'member_favorite';
    f.hl_messages[20].senderId = '003';
    f.hl_messages[19].senderId = 999;
    f.hl_messages[18].senderId = 0;
    f.hl_messages[17].status = '0';
    f.hl_messages.push({ id: 999, receiverId: 2, senderId: 1, status: 1, isRead: 0, content: 'OTHER_ACCOUNT_NOTIFICATION' });
    for (const page of [1, 2, 4, 99]) {
      const filters = { page, pageSize: 7 };
      const optimized = runtime(f), legacy = runtime(f);
      const result = await optimized.hooks.messages.list(1, filters);
      assert.deepEqual(plain(result), plain(await legacy.hooks.legacyNotificationList(1, filters)));
      const expectedSenders = new Set(f.hl_messages.filter(row => row.receiverId === 1 && Number(row.status || 1) !== 0)
        .sort((a, b) => b.id - a.id).slice((page - 1) * 7, page * 7)
        .filter(row => row.senderId && (row.messageType !== 'member_favorite' || premium))
        .map(row => Number(row.senderId)));
      for (const read of optimized.reads.filter(row => row.fields && ['hl_users', 'hl_profiles'].includes(row.name))) {
        const requested = read.query[read.name === 'hl_users' ? 'id' : 'userId'].values;
        assert.ok(requested.every(id => expectedSenders.has(id)), 'only currently visible page senders may be enriched');
      }
      assert.equal(result.total, 24);
      assert.equal(result.unreadCount, 13);
      assert.doesNotMatch(JSON.stringify(result), /OTHER_ACCOUNT_NOTIFICATION|PRIVATE/);
      assert.equal(optimized.writes.length, 0);
    }
  }
});

test('notification enrichment refreshes on each request and rejects inactive callers', async () => {
  const r = runtime(notificationFixture(1));
  const first = await r.hooks.messages.list(1);
  r.fixtures.hl_profiles[0].realName = '已更新称呼';
  const second = await r.hooks.messages.list(1);
  assert.notDeepEqual(plain(first), plain(second));
  assert.match(JSON.stringify(second), /已更新称呼/);
  r.fixtures.hl_users[0].status = 0;
  await assert.rejects(r.hooks.messages.list(1), /账号不可用/);
  assert.equal(r.writes.length, 0);
});

function membershipOverviewFixture(count = 0) {
  const f = fixture(0);
  f.hl_users[0].phone = '13800138000';
  f.hl_matchmaking_packages = [{ _id: 'matchmaking_user_1', userId: 1,
    packageIds: Array.from({ length: count }, (_, index) => `package_${index}`) },
  ...Array.from({ length: count }, (_, index) => ({ _id: `package_${index}`, id: `package_${index}`,
    userId: 1, planTitle: `已购套餐${index}`, totalCount: 6, usedCount: 1, status: 'active',
    startAt: '2026-10-01T00:00:00.000Z', expireAt: '2099-11-01T00:00:00.000Z' }))];
  return f;
}

test('membership overview reuses its existing readiness and package snapshot with identical DTOs', async () => {
  for (const [count, before, after] of [[0, 29, 23], [5, 39, 28]]) {
    const f = membershipOverviewFixture(count);
    const optimized = runtime(f), legacy = runtime(f);
    const result = await optimized.hooks.membership.overview(1);
    assert.deepEqual(plain(result), plain(await legacy.hooks.legacyMembershipOverview(1)));
    assert.equal(legacy.reads.length, before);
    assert.equal(optimized.reads.length, after);
    assert.equal(optimized.reads.filter(read => read.name === 'hl_matchmaking_packages').length, count + 1);
    assert.equal(optimized.reads.filter(read => read.name === 'hl_profiles').length, 1);
    assert.equal(optimized.writes.length, 0);
  }
});

test('membership overview keeps package sorting, service readiness, status changes and caller checks', async () => {
  const f = membershipOverviewFixture(3);
  f.hl_users.push({ _id: 'mm-user', id: 2, status: 1, nickname: '服务主理人' });
  f.hl_matchmakers[0].userId = 2;
  f.hl_members.push({ _id: 'own-member', id: 1, userId: 1, matchmakerId: 1, status: 1 });
  f.hl_profiles.push({ _id: 'own-profile', userId: 1, realName: '会员', updatedAt: '2026-10-19T00:00:00.000Z' });
  f.hl_matchmaking_packages[1].expireAt = '2099-12-01T00:00:00.000Z';
  f.hl_matchmaking_packages[2].status = 'refunded';
  f.hl_matchmaking_packages[3].expireAt = '2020-01-01T00:00:00.000Z';
  const optimized = runtime(f), legacy = runtime(f);
  const first = await optimized.hooks.membership.overview(1);
  assert.deepEqual(plain(first), plain(await legacy.hooks.legacyMembershipOverview(1)));
  assert.deepEqual(Array.from(first.matchmakingPackages, row => [row.id, row.status]),
    [['package_2', 'expired'], ['package_1', 'refunded'], ['package_0', 'active']]);
  assert.equal(first.matchmakingReadiness.activeAssignment, true);
  optimized.fixtures.hl_matchmaking_packages.find(row => row._id === 'package_0').usedCount = 3;
  const second = await optimized.hooks.membership.overview(1);
  assert.equal(second.matchmakingPackages.find(row => row.id === 'package_0').remainingCount, 3);
  optimized.fixtures.hl_users[0].status = 0;
  await assert.rejects(optimized.hooks.membership.overview(1));
  assert.equal(optimized.writes.length, 0);
});
