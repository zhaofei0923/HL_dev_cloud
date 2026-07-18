const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'),
  'utf8'
);

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return source.slice(from, to);
}

test('relationship route is scoped to the authenticated session user', () => {
  assert.match(
    source,
    /path === '\/member\/relationships'[\s\S]*member\.relationships\(session\.userId, data\)/
  );
});

test('all direct conversation operations pass through the premium access guard', () => {
  const getOrCreate = between('async getOrCreateConversation(userId', 'async listMessages(userId, conversationId');
  const listMessages = between('async listMessages(userId, conversationId', 'async sendMessage(userId, conversationId');
  const sendMessage = between('async sendMessage(userId, conversationId', 'async markRead(userId, conversationId');
  const markRead = between('async markRead(userId, conversationId', 'function isMessageRead');

  assert.match(getOrCreate, /resolveChatAccess\(userId, targetUserId\)/);
  assert.match(listMessages, /getChatConversationOrThrow\(userId, conversationId\)/);
  assert.match(sendMessage, /getChatConversationOrThrow\(userId, conversationId\)/);
  assert.match(markRead, /markChatRead\(userId, conversationId\)/);
  assert.match(source, /requiresPremiumForConversation\(conversation\)[\s\S]*40302/);
});

test('formal service relationships are evaluated before premium mutual chat', () => {
  const resolveAccess = between('async function resolveChatAccess', 'async function getChatConversationOrThrow');
  const matchmaker = resolveAccess.indexOf('resolveMemberMatchmakerChatAccess');
  const formalPair = resolveAccess.indexOf('resolveMemberPairChatAccess');
  const mutual = resolveAccess.indexOf('resolveMutualFavoriteChatAccess');

  assert.ok(matchmaker >= 0 && formalPair > matchmaker && mutual > formalPair);
});

test('free conversation lists filter mutual-only chats', () => {
  const listConversations = between('async listConversations(userId', 'async getOrCreateConversation(userId');
  assert.match(listConversations, /isPremiumMember \|\| !requiresPremiumForConversation\(row\)/);
});

test('conversation creation uses a deterministic document and a transaction', () => {
  const createConversation = between('async function createChatConversationAtomically', 'async function ensureChatConversation');
  assert.match(createConversation, /conversationDocumentId\(participantKey, conversationType\)/);
  assert.match(createConversation, /db\.runTransaction/);
  assert.match(createConversation, /ref\.create\(payload\)/);
});

test('formal-pair promotion is transactional and always clears mutual-only metadata', () => {
  const metadataPatch = between('function conversationMetadataPatch', 'async function promoteChatConversation');
  const promotion = between('async function promoteChatConversation', 'function conversationDocumentId');

  assert.match(metadataPatch, /if \(metadata\.matchRecordId\)[\s\S]*patch\.chatOpenReason = null/);
  assert.match(promotion, /db\.runTransaction/);
  assert.match(promotion, /transaction\.collection\(C\.conversations\)\.doc\(conversation\._id\)/);
});

test('free relationship previews cannot be enumerated with later pages', () => {
  const relationships = between('async relationships(userId, filters', 'async likedMe(userId, filters');
  const freeBranch = relationships.slice(
    relationships.indexOf('if (!isPremiumMember)'),
    relationships.indexOf('const visibleRows')
  );

  assert.match(freeBranch, /selectedRows\.slice\(0, RELATIONSHIP_LOCKED_PREVIEW_LIMIT\)/);
  assert.match(freeBranch, /page: 1/);
  assert.doesNotMatch(freeBranch, /paginate\(/);
  assert.doesNotMatch(freeBranch, /likedMePreviewTags/);
});

test('legacy liked-me route uses the same non-pageable synthetic preview policy', () => {
  const likedMe = between('async likedMe(userId, filters', 'async interact(userId, data');
  const freeBranch = likedMe.slice(
    likedMe.indexOf('if (!isPremiumMember)'),
    likedMe.indexOf('const visibleRows')
  );

  assert.match(likedMe, /favoriteRelationshipGroups\(userId\)/);
  assert.match(freeBranch, /favoriteRows\.slice\(0, LIKED_ME_LOCKED_PREVIEW_LIMIT\)/);
  assert.match(freeBranch, /createLockedRelationshipPreview/);
  assert.match(freeBranch, /page: 1/);
  assert.doesNotMatch(freeBranch, /paginate\(/);
});
