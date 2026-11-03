const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { requiresPremiumForConversation } = require('../cloudfunctions/hlApi/relationship-policy');
const source = fs.readFileSync(require.resolve('../cloudfunctions/hlApi/index.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));

function runtime(options = {}) {
  const state = { premium: false, unmatched: false, formal: true, mutual: false,
    service: false, created: 0, ...options };
  const conversation = { id: 7, conversationType: state.service ? 'member_matchmaker' : 'member_pair',
    participantIds: [1, 2], status: 'active', matchRecordId: state.formal ? 9 : null,
    unreadBy: { 1: 0, 2: 17 }, _id: 'conversation-7' };
  const messages = [{ id: 10, conversationId: 7, senderId: 1, receiverId: 2, content: 'hello',
    contentType: 'text', status: 'active', readBy: [1], readAt: 'private-timestamp', _id: 'message-10' },
    { id: 11, conversationId: 7, senderId: 2, receiverId: 1, content: 'reply',
      contentType: 'text', status: 'active', readBy: [1, 2], readAt: 'private-timestamp', _id: 'message-11' }];
  const reads = [];
  const httpError = (message, status = 400, code = 40000) => Object.assign(new Error(message), { status, code });
  const sandbox = {
    exports: {}, C: { users: 'users', conversations: 'conversations', chatMessages: 'chat_messages' },
    requiresPremiumForConversation,
    createHttpError: httpError,
    hasPremiumMemberEntitlement: async () => state.premium,
    stripInternal: value => { const { _id, ...rest } = value; return rest; },
    chatParticipantIds: row => row.participantIds,
    chatUnreadCount: (row, userId) => row.unreadBy[userId],
    chatParticipantView: async id => ({ id, nickname: `user-${id}` }),
    chatParticipantContext: async () => ({}),
    getById: async (collection, id) => collection === 'conversations' ? conversation : { id, status: 1 },
    assertChatParticipant: (row, userId) => { if (!row.participantIds.includes(userId)) throw httpError('forbidden', 403, 40300); },
    resolveMemberMatchmakerChatAccess: async () => state.service ? { conversationType: 'member_matchmaker' } : null,
    resolveMemberPairChatAccess: async () => state.formal ? { conversationType: 'member_pair', matchRecordId: 9 } : null,
    resolveMutualFavoriteChatAccess: async () => state.mutual ? { conversationType: 'member_pair', chatOpenReason: 'mutual_favorite' } : null,
    areMutualFavorites: async () => state.mutual,
    memberRelationships: { isUnmatched: async () => state.unmatched },
    promoteChatConversation: async row => row,
    resolveTargetUserId: async data => Number(data.targetUserId),
    ensureChatConversation: async () => { state.created += 1; return conversation; },
    normalizeChatText: text => text,
    assertUserText: async () => { if (state.duringModeration) await state.duringModeration(state); },
    nextId: async () => 12,
    addRow: async (_collection, row) => { messages.push(row); return row; },
    chatUnreadMap: row => ({ ...row.unreadBy }),
    updateRow: async (_collection, row, patch) => Object.assign(row, patch),
    _: Object.fromEntries(['in', 'nin', 'lt', 'gt'].map(op => [op, value => ({ op, value })])),
    queryRead: async (_collection, query, options, count = false) => {
      reads.push({ query, options, count });
      let rows = messages.filter(row => row.conversationId === query.conversationId
        && (!query.senderId || (query.senderId.op === 'in'
          ? query.senderId.value.includes(row.senderId) : row.senderId === query.senderId))
        && (!query.id || (query.id.op === 'gt' ? row.id > query.id.value : row.id < query.id.value)));
      if (count) return { total: rows.length };
      if (options.order?.[0]?.[1] === 'desc') rows = [...rows].reverse();
      rows = rows.slice(options.offset || 0, (options.offset || 0) + options.limit);
      return { data: rows };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(section('async function chatConversationView', 'async function resolveTargetUserId')
    + section('async function resolveChatAccess', 'function conversationMetadataPatch')
    + section('const chat = {', 'function isMessageRead')
    + '\nexports.hooks = { chat, chatMessageView, chatConversationView, resolveChatAccess, getChatConversationOrThrow };', sandbox);
  sandbox.markChatRead = async userId => sandbox.exports.hooks.chatConversationView(conversation, userId);
  return { state, conversation, messages, reads, hooks: sandbox.exports.hooks };
}

test('all member pair conversations require active VIP even with a formal match; service chats stay available', async () => {
  for (const formal of [true, false]) {
    const r = runtime({ formal, mutual: !formal });
    for (const operation of [() => r.hooks.resolveChatAccess(1, 2), () => r.hooks.getChatConversationOrThrow(1, 7),
      () => r.hooks.chat.getOrCreateConversation(1, { targetUserId: 2 }), () => r.hooks.chat.sendMessage(1, 7, { content: 'hello' })]) {
      await assert.rejects(operation(), error => error.code === 40302);
    }
    assert.equal(r.state.created, 0); assert.equal(r.messages.length, 2);
    r.state.premium = true;
    assert.equal((await r.hooks.resolveChatAccess(1, 2)).conversationType, 'member_pair');
  }
  const service = runtime({ service: true, premium: false });
  assert.equal((await service.hooks.resolveChatAccess(1, 2)).conversationType, 'member_matchmaker');
  assert.equal((await service.hooks.chat.sendMessage(1, 7, { content: 'service' })).content, 'service');
});

test('VIP cannot reopen or send to an unmatched peer, and cannot bypass mutual consent', async () => {
  for (const state of [{ unmatched: true, formal: true }, { formal: false, mutual: false }]) {
    const r = runtime({ premium: true, ...state });
    await assert.rejects(r.hooks.chat.getOrCreateConversation(1, { targetUserId: 2 }), error => error.code === 40300);
    await assert.rejects(r.hooks.chat.sendMessage(1, 7, { content: 'blocked' }), error => error.code === 40300);
    assert.equal(r.messages.length, 2); assert.equal(r.state.created, 0);
  }
});

test('read receipts are projected for the VIP sender only and raw read metadata never leaves the DTO', async () => {
  const r = runtime();
  for (const premium of [false, true]) {
    r.state.premium = premium;
    for (const viewer of [1, 2]) {
      const row = await r.hooks.chatMessageView(r.messages[0], viewer);
      assert.equal(row.readBy, undefined); assert.equal(row.readAt, undefined); assert.equal(row._id, undefined);
      assert.equal(row.readStatus, premium && viewer === 1 ? 'unread' : undefined);
    }
  }
  r.messages[0].readBy.push('2');
  assert.equal((await r.hooks.chatMessageView(r.messages[0], 1)).readStatus, 'read');
});

test('conversation DTO exposes only viewer unread count without leaking the peer counter', async () => {
  const r = runtime({ service: true });
  const free = await r.hooks.chatConversationView(r.conversation, 1);
  assert.equal(free.unreadBy, undefined); assert.equal(free.unreadCount, 0);
  assert.equal(free.canViewReadReceipts, false);
  r.state.premium = true;
  assert.equal((await r.hooks.chatConversationView(r.conversation, 1)).canViewReadReceipts, true);
});

test('incremental VIP refresh returns receipt changes for old own messages when no new messages exist', async () => {
  const r = runtime({ premium: true });
  r.messages[0].readBy = [1, 2];
  const result = await r.hooks.chat.listMessages(1, 7, { afterId: 11 });
  assert.deepEqual(plain(result.messages), []);
  assert.deepEqual(plain(result.readReceipts), [{ id: 10, readStatus: 'read' }]);
  assert.equal(result.conversation.canViewReadReceipts, true);
  assert.equal(result.conversation.unreadBy, undefined);
  const receiptQuery = r.reads.find(read => read.query.senderId);
  assert.deepEqual(plain(receiptQuery.query.senderId.value), [1, '1']);
});

test('non-VIP service chat does not query or disclose read receipts; VIP send returns unread', async () => {
  const r = runtime({ service: true });
  const result = await r.hooks.chat.listMessages(1, 7);
  assert.deepEqual(plain(result.readReceipts), []);
  assert.ok(result.messages.every(row => row.readStatus === undefined && row.readBy === undefined && row.readAt === undefined));
  assert.ok(r.reads.every(read => read.query.senderId === undefined));
  r.state.premium = true;
  const sent = await r.hooks.chat.sendMessage(1, 7, { content: 'sent' });
  assert.equal(sent.readStatus, 'unread'); assert.equal(sent.readBy, undefined);
});


test('unmatch or VIP expiry during content moderation prevents delivery after the asynchronous check', async () => {
  for (const change of ['unmatched', 'premium']) {
    const r = runtime({ premium: true, duringModeration: async state => {
      if (change === 'unmatched') state.unmatched = true;
      else state.premium = false;
    } });
    await assert.rejects(r.hooks.chat.sendMessage(1, 7, { content: 'must not deliver' }),
      error => error.code === (change === 'unmatched' ? 40300 : 40302));
    assert.equal(r.messages.length, 2);
  }
});
