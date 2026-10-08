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
const dateKey = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

function runtime(input) {
  const fixtures = structuredClone(input);
  const reads = [], writes = [];
  const op = (kind, values) => ({ kind, values });
  function matchesValue(value, expected) {
    if (!expected || !expected.kind) return value === expected;
    if (expected.kind === 'in') return Array.isArray(value)
      ? value.some(item => expected.values.includes(item)) : expected.values.includes(value);
    if (expected.kind === 'nin') return !matchesValue(value, op('in', expected.values));
    if (expected.kind === 'lt') return value < expected.values;
    if (expected.kind === 'gt') return value > expected.values;
    if (expected.kind === 'eq') return value === expected.values;
    if (expected.kind === 'neq') return value !== expected.values;
    if (expected.kind === 'regex') return typeof value === 'string'
      && new RegExp(expected.values.regexp, expected.values.options).test(value);
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
      limit(limit) { assert.ok(limit <= 100, 'SDK query page exceeds 100'); state.limit = limit; return ref; },
      field(fields) { state.fields = fields; return ref; },
      orderBy(field, direction) { state.order.push([field, direction]); return ref; },
      async count() { return { total: (fixtures[name] || []).filter(row => matches(row, state.query)).length }; },
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
        reads.push({ name, ...plain(state), returned: rows.length });
        if (state.fields) rows = rows.map(row => Object.fromEntries(Object.keys(state.fields)
          .filter(key => state.fields[key] && key in row).map(key => [key, row[key]])));
        return { data: structuredClone(rows) };
      },
      doc(id) {
        return {
          async get() { return { data: structuredClone((fixtures[name] || []).find(row => row._id === id)) }; },
          async update({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            if (!row) throw new Error(`document not found: ${name}/${id}`);
            const patch = structuredClone(data);
            Object.entries(patch).forEach(([field, value]) => {
              if (value && value.kind === 'inc') patch[field] = Number(row[field] || 0) + value.values;
            });
            writes.push({ name, id, data: patch });
            Object.assign(row, patch);
          },
          async set({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            const payload = { ...structuredClone(data), _id: id };
            if (row) Object.assign(row, payload); else (fixtures[name] ||= []).push(payload);
            writes.push({ name, id, data: payload });
          }
        };
      },
      async add({ data }) {
        const payload = { ...structuredClone(data), _id: `${name}-${(fixtures[name] || []).length + 1}` };
        (fixtures[name] ||= []).push(payload);
        writes.push({ name, id: payload._id, data: payload });
        return { _id: payload._id };
      }
    };
    return ref;
  }
  const db = {
    collection,
    command: Object.fromEntries(['in', 'nin', 'lt', 'gt', 'eq', 'neq', 'or', 'and', 'inc']
      .map(kind => [kind, values => op(kind, values)])),
    RegExp: values => op('regex', values),
    async createCollection() {},
    // The tests exercise only existing rows; this supports document promotion.
    async runTransaction(callback) { return callback({ collection }); }
  };
  const module = { exports: {} };
  vm.runInNewContext(source + '\nexports.__test={member,chat,memberInteractionStateMap,areMutualFavorites,favoriteRelationshipGroups,getChatConversationOrThrow};', {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'favorite-local-fixture-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', DEMO_MEMBERS: 'false', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    console: { warn() {}, error() {}, log() {} }, Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  return { hooks: module.exports.__test, fixtures, reads, writes };
}

function favorite(id, userId, targetUserId, extra = {}) {
  return { _id: `heart-${id}`, id, userId, targetUserId, actionType: 'favorite', active: true,
    status: 'active', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    freeFavoriteDate: dateKey(), ...extra };
}

function fixture() {
  return {
    hl_users: [1, 2, 3].map(id => ({ _id: `user-${id}`, id, status: 1, nickname: `会员${id}` })),
    hl_profiles: [1, 2, 3].map(id => ({ _id: `profile-${id}`, id: 100 + id, userId: id,
      displayEnabled: true, realName: `会员${id}`, photos: [] })),
    hl_members: [1, 2].map(id => ({ _id: `member-${id}`, id: 200 + id, userId: id, status: 1, memberType: 'vip' })),
    hl_member_interactions: [favorite(1, 1, 2), favorite(2, 2, 1)],
    hl_conversations: [{ _id: 'mutual-conversation', id: 10, participantIds: [1, 2], participantKey: '1:2',
      conversationType: 'member_pair', chatOpenReason: 'mutual_favorite', status: 'active', unreadBy: { 1: 0, 2: 0 } }],
    hl_matchmakers: [], hl_match_records: [], hl_chat_messages: [], hl_messages: [], hl_counters: []
  };
}

const withdraw = r => r.hooks.member.interact(1, { actionType: 'favorite', targetUserId: 2, active: false });

test('hidden list and restoration only affect the authenticated owner, including duplicate and private targets', async () => {
  const f = fixture();
  f.hl_member_interactions.push(
    { _id: 'hide-old', id: 10, userId: 1, targetUserId: 2, actionType: 'hide', active: true },
    { _id: 'hide-current', id: 11, userId: 1, targetUserId: 2, actionType: 'hide', active: true },
    { _id: 'other-owner-hide', id: 12, userId: 3, targetUserId: 2, actionType: 'hide', active: true });
  const r = runtime(f);
  const hidden = await r.hooks.member.hidden(1, { userId: 3 });
  assert.equal(hidden.total, 1);
  assert.equal(hidden.list[0].targetUserId, 2);
  assert.deepEqual(Object.keys(hidden.list[0]).sort(), ['available', 'displayName', 'targetUserId']);
  r.fixtures.hl_profiles.find(row => row.userId === 2).displayEnabled = false;
  const unavailable = await r.hooks.member.hidden(1);
  assert.equal(unavailable.list[0].available, false);
  assert.equal(unavailable.list[0].displayName, '暂未公开资料的会员');
  const restored = await r.hooks.member.interact(1, { targetUserId: 2, userId: 3, actionType: 'hide', active: false });
  assert.equal(restored.viewerState.isHidden, false);
  assert.equal(restored.viewerState.isFavorite, true, 'restoring never changes a heart');
  assert.equal((await r.hooks.member.hidden(1)).total, 0);
  assert.equal((await r.hooks.member.hidden(3)).total, 1, 'another account remains hidden');
  assert.ok(r.writes.every(write => write.name === 'hl_member_interactions' && write.id === 'hide-current'));
  const writes = r.writes.length;
  const missing = await r.hooks.member.interact(1, { targetUserId: 999, actionType: 'hide', active: false });
  assert.equal(missing.interaction, null);
  assert.equal(r.writes.length, writes, 'unknown restoration must not create an interaction');
});

test('detail action state uses the same mutual, membership, formal pair and service rules as chat', async () => {
  for (const mode of ['premium_mutual', 'free_mutual', 'formal_pair', 'service', 'none']) {
    const f = fixture();
    if (mode !== 'premium_mutual') f.hl_members.forEach(row => { row.memberType = 'normal'; });
    if (['formal_pair', 'service', 'none'].includes(mode)) f.hl_member_interactions = [];
    if (mode === 'formal_pair') f.hl_match_records.push({ id: 90, userAId: 1, userBId: 2, status: 'pending' });
    if (mode === 'service') {
      f.hl_members[0].matchmakerId = 9;
      f.hl_matchmakers.push({ id: 9, userId: 2, status: 1, certificationStatus: 2 });
    }
    const r = runtime(f);
    const detail = await r.hooks.member.showcaseDetail(1, 202);
    assert.equal(detail.viewerState.chatAccess, mode === 'free_mutual' ? 'membership_required' : mode === 'none' ? 'unavailable' : 'allowed', mode);
    assert.equal(r.writes.length, 0, 'viewing details must not create a conversation or notification');
  }
});

test('withdrawal is allowed at an exhausted quota, keeps quota spent, and sends no notification', async () => {
  const f = fixture();
  f.hl_member_interactions.push(...Array.from({ length: 7 }, (_, index) => favorite(100 + index, 1, 20 + index)));
  const r = runtime(f);
  const response = await withdraw(r);
  assert.equal(response.active, false);
  assert.equal(response.viewerState.isFavorite, false);
  assert.equal(response.interaction.active, false);
  assert.equal(response.interaction.status, 'inactive');
  assert.equal(response.mutualFavorite, false);
  assert.equal(response.canChat, false);
  assert.equal(response.notification, null);
  assert.equal(response.favoriteQuota.used, 8);
  assert.equal(response.favoriteQuota.remaining, 0);
  assert.equal(r.fixtures.hl_messages.length, 0);
  assert.ok(r.writes.every(write => write.name === 'hl_member_interactions'));
  assert.equal(r.fixtures.hl_member_interactions.find(row => row.userId === 2).active, true);
  const again = await withdraw(r);
  assert.equal(again.viewerState.isFavorite, false);
  assert.equal(again.favoriteQuota.used, 8);
});

test('same-day resend after withdrawal reuses the spent target even at the quota limit', async () => {
  const f = fixture();
  f.hl_member_interactions = [favorite(1, 1, 2), ...Array.from({ length: 7 }, (_, index) => favorite(100 + index, 1, 20 + index))];
  const r = runtime(f);
  await withdraw(r);
  const sent = await r.hooks.member.interact(1, { actionType: 'favorite', targetUserId: 2, active: true });
  assert.equal(sent.viewerState.isFavorite, true);
  assert.equal(sent.favoriteQuota.used, 8);
  assert.equal(sent.favoriteQuota.remaining, 0);
  assert.equal(r.fixtures.hl_member_interactions.filter(row => row.userId === 1 && row.targetUserId === 2).length, 1);
  await assert.rejects(r.hooks.member.interact(1, { actionType: 'favorite', targetUserId: 3, active: true }),
    error => error.status === 429 && error.code === 42901);
});

test('withdrawal updates the latest duplicate and older active hearts cannot restore card or mutual state', async () => {
  const f = fixture();
  f.hl_member_interactions.push(favorite(3, 1, 2, { updatedAt: '2000-01-02T00:00:00.000Z' }));
  const r = runtime(f);
  const response = await withdraw(r);
  assert.equal(response.viewerState.isFavorite, false);
  assert.equal(response.interaction.id, 3);
  assert.equal(await r.hooks.areMutualFavorites(1, 2), false);
  const cardStates = await r.hooks.memberInteractionStateMap(1, [2]);
  assert.equal(!!cardStates['2']?.favorite, false);
  assert.equal((await r.hooks.favoriteRelationshipGroups(1)).mutual.length, 0);
  assert.equal((await r.hooks.favoriteRelationshipGroups(1)).incoming.length, 1);
  assert.equal((await r.hooks.favoriteRelationshipGroups(2)).incoming.length, 0);
  assert.equal((await r.hooks.favoriteRelationshipGroups(2)).mutual.length, 0);
});

test('latest inactive status and id tie-break consistently override older favorite and hide rows', async () => {
  const f = fixture();
  f.hl_member_interactions.push(favorite(3, 1, 2, { active: undefined, status: 'inactive' }),
    { _id: 'hide-old', id: 4, userId: 1, targetUserId: 2, actionType: 'hide', active: true },
    { _id: 'hide-new', id: 5, userId: 1, targetUserId: 2, actionType: 'hide', active: false, status: 'inactive' });
  const r = runtime(f);
  const states = await r.hooks.memberInteractionStateMap(1, [2]);
  assert.equal(!!states['2']?.favorite, false);
  assert.equal(!!states['2']?.hide, false);
  assert.equal(await r.hooks.areMutualFavorites(1, 2), false);
  // Preserve the existing legacy active=0 interpretation; only false/status inactive cancel.
  r.fixtures.hl_member_interactions.push(favorite(6, 1, 3, { active: 0 }));
  assert.equal(!!(await r.hooks.memberInteractionStateMap(1, [3]))['3']?.favorite, true);
});

test('a private or disabled target can be withdrawn without reading any target profile', async () => {
  const f = fixture();
  f.hl_users.find(row => row.id === 2).status = 0;
  f.hl_profiles.find(row => row.userId === 2).displayEnabled = false;
  const r = runtime(f);
  assert.equal((await withdraw(r)).viewerState.isFavorite, false);
  assert.ok(r.reads.every(read => read.name === 'hl_member_interactions'));
  const noHeart = await r.hooks.member.interact(1, { actionType: 'favorite', targetUserId: 999, active: false });
  assert.equal(noHeart.viewerState.isFavorite, false);
  assert.equal(noHeart.interaction, null);
  assert.equal(r.fixtures.hl_member_interactions.length, 2);
  assert.equal(r.writes.length, 1);
});

test('withdrawal rejects all existing mutual-only conversation operations for both participants', async () => {
  const operations = [
    (r, userId) => r.hooks.chat.listMessages(userId, 10),
    (r, userId) => r.hooks.chat.sendMessage(userId, 10, { content: '不能绕过撤回' }),
    (r, userId) => r.hooks.chat.markRead(userId, 10),
    (r, userId) => r.hooks.chat.getOrCreateConversation(userId, { targetUserId: userId === 1 ? 2 : 1 })
  ];
  for (const operation of operations) {
    for (const userId of [1, 2]) {
      const r = runtime(fixture());
      await withdraw(r);
      const writesBefore = r.writes.length;
      await assert.rejects(operation(r, userId), error => error.status === 403);
      assert.equal(r.writes.length, writesBefore);
      assert.equal(r.fixtures.hl_chat_messages.length, 0);
      assert.equal(r.fixtures.hl_conversations.length, 1);
    }
  }
});

test('withdrawn mutual-only conversation leaves the list without deleting history', async () => {
  const f = fixture();
  f.hl_chat_messages.push({ _id: 'old-message', id: 5, conversationId: 10, senderId: 1,
    receiverId: 2, content: '保留的历史消息', status: 'active' });
  const r = runtime(f);
  await withdraw(r);
  assert.equal((await r.hooks.chat.listConversations(1)).total, 0);
  assert.equal((await r.hooks.chat.listConversations(2)).total, 0);
  assert.equal(r.fixtures.hl_conversations.length, 1);
  assert.equal(r.fixtures.hl_chat_messages.length, 1);
  assert.equal(r.fixtures.hl_chat_messages[0].content, '保留的历史消息');
});

test('formal pair and matchmaker service conversations remain accessible after withdrawal', async () => {
  for (const type of ['member_pair', 'member_matchmaker']) {
    const f = fixture();
    const conversation = f.hl_conversations[0];
    if (type === 'member_pair') conversation.matchRecordId = 88;
    else Object.assign(conversation, { conversationType: type, matchmakerId: 7, matchmakerUserId: 2 });
    const r = runtime(f);
    await withdraw(r);
    for (const userId of [1, 2]) {
      assert.equal((await r.hooks.chat.listMessages(userId, 10)).conversation.id, 10);
      assert.equal((await r.hooks.chat.listConversations(userId)).total, 1);
    }
  }
});

test('a current formal pair promotes an old mutual conversation and keeps access without mutual hearts', async () => {
  const f = fixture();
  f.hl_match_records.push({ _id: 'formal-match', id: 88, userAId: 1, userBId: 2,
    status: 'pending', createdAt: '2000-01-01T00:00:00.000Z' });
  const r = runtime(f);
  await withdraw(r);
  const conversation = await r.hooks.getChatConversationOrThrow(1, 10);
  assert.equal(conversation.matchRecordId, 88);
  assert.equal(conversation.chatOpenReason, null);
  assert.equal((await r.hooks.chat.listMessages(2, 10)).conversation.id, 10);
});

test('conversation lists resolve current mutual hearts in one scoped batch rather than per conversation', async () => {
  for (const peerCount of [8, 24]) {
    const f = fixture();
    f.hl_member_interactions = [];
    f.hl_conversations = [];
    for (let index = 0; index < peerCount; index += 1) {
      const peerId = 2 + index;
      f.hl_users.push({ _id: `extra-user-${peerId}`, id: peerId, status: 1, nickname: `会员${peerId}` });
      f.hl_member_interactions.push(favorite(100 + index * 2, 1, peerId), favorite(101 + index * 2, peerId, 1));
      f.hl_conversations.push({ _id: `conversation-${peerId}`, id: 1000 + peerId, participantIds: [1, peerId],
        participantKey: `1:${peerId}`, conversationType: 'member_pair', chatOpenReason: 'mutual_favorite', status: 'active' });
    }
    f.hl_member_interactions.push(...Array.from({ length: 1000 }, (_, index) => favorite(10000 + index, 5000 + index, 7000 + index)));
    const r = runtime(f);
    assert.equal((await r.hooks.chat.listConversations(1, { pageSize: 50 })).total, peerCount);
    const heartReads = r.reads.filter(read => read.name === 'hl_member_interactions');
    assert.equal(heartReads.length, 1);
    assert.equal(heartReads[0].returned, peerCount * 2);
    assert.equal(r.writes.length, 0);
  }
});
