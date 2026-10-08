const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function conversation(id, name = '主理人会话') {
  return { id, conversationType: 'member_matchmaker', peer: { id: 900, nickname: name }, unreadCount: 1, updatedAt: '2026-10-06T00:00:00.000Z' };
}

function premiumRelationship() {
  return {
    id: 501, userId: 77, realName: 'PRIVATE_PERSON', photos: ['PRIVATE_MEDIA'],
    city: '上海', age: 30, gender: 2, phone: 'PRIVATE_PHONE', privateArchive: { credential: 'PRIVATE_ARCHIVE' },
    canViewDetail: true, canRespond: true, canChat: true
  };
}

function relationships(premium, list = premium ? [premiumRelationship()] : [{
  id: 'locked_incoming_1', locked: true, blurred: true, displayName: '第 1 位喜欢你的人', tags: ['资料完整']
}]) {
  return { list, counts: { incoming: 1, mutual: 0 }, total: 1, page: 1, pageSize: 2, isPremiumMember: premium };
}

const itemEvent = id => ({ currentTarget: { dataset: { id } } });

test('message tab reads deduplicate and warm revisits retain conversations with safe relationship slots', async () => {
  const pending = deferred();
  let conversationReads = 0;
  let relationshipReads = 0;
  const { page } = runtime('pages/user/messages.js', {
    chatApi: { listConversations: () => { conversationReads += 1; return pending.promise; } },
    memberApi: { relationships: async () => { relationshipReads += 1; return relationships(true); } }
  });
  const first = page.onShow();
  const second = page.onShow();
  await flush();
  assert.equal(conversationReads, 1);
  assert.equal(relationshipReads, 1);
  pending.resolve({ list: [conversation(1)], total: 1 });
  await Promise.all([first, second]);
  page.onHide();
  await page.onShow();
  assert.equal(conversationReads, 1);
  assert.equal(relationshipReads, 1);
  assert.equal(page.data.list[0].id, 1);
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
  assert.equal(page.data.relationshipPermissionVerified, false);
});

test('conversation refresh errors retain existing rows and allow an explicit retry', async () => {
  let reads = 0;
  const pending = deferred();
  const { page, advance } = runtime('pages/user/messages.js', { chatApi: {
    listConversations: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ list: [conversation(1)], total: 1 });
      if (reads === 2) return pending.promise;
      return Promise.resolve({ list: [conversation(2)], total: 1 });
    }
  } });
  await page.onShow();
  advance(10001);
  const refresh = page.onShow();
  await flush();
  assert.equal(page.data.list[0].id, 1);
  pending.reject(new Error('conversation refresh failed'));
  await refresh;
  assert.equal(page.data.list[0].id, 1);
  assert.ok(page.data.conversationError);
  await page.retryConversations();
  assert.equal(reads, 3);
  assert.equal(page.data.list[0].id, 2);
  assert.equal(page.data.conversationError, '');
});

test('an initialized empty message list keeps its empty state during a pending quiet refresh', async () => {
  let reads = 0;
  const pending = deferred();
  const { page, advance } = runtime('pages/user/messages.js', { chatApi: {
    listConversations: () => ++reads === 1 ? Promise.resolve({ list: [], total: 0 }) : pending.promise
  } });
  await page.onShow();
  assert.equal(page.data.conversationInitialized, true);
  const emptyTitle = page.data.emptyTitle;
  advance(10001);
  const refresh = page.onShow();
  await flush();
  assert.equal(page.data.conversationLoading, true);
  assert.equal(page.data.conversationInitialized, true);
  assert.equal(page.data.list.length, 0);
  assert.equal(page.data.emptyTitle, emptyTitle);
  pending.resolve({ list: [], total: 0 });
  await refresh;
  assert.equal(page.data.conversationLoading, false);
  assert.equal(page.data.conversationInitialized, true);
});

test('a relationship refresh failure erases premium details and allows a safe retry', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/messages.js', { memberApi: {
    relationships: async () => {
      reads += 1;
      if (reads === 1) return relationships(true);
      if (reads === 2) throw new Error('permission refresh failed');
      return relationships(false);
    }
  } });
  await page.onShow();
  await page.retryRelationships();
  assert.ok(page.data.relationshipError);
  assert.equal(page.data.relationshipPermissionVerified, false);
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
  await page.retryRelationships();
  assert.equal(reads, 3);
  assert.equal(page.data.relationshipError, '');
  assert.equal(page.data.isPremiumMember, false);
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
});

test('hiding messages erases premium identity, media and raw profile details', async () => {
  const { page } = runtime('pages/user/messages.js', { memberApi: { relationships: async () => relationships(true) } });
  await page.onShow();
  assert.match(JSON.stringify(page.data.relationshipItems), /PRIVATE_PERSON/);
  page.onHide();
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
  assert.equal(page.data.isPremiumMember, false);
  assert.equal(page.data.relationshipPermissionVerified, false);
  assert.ok(page.data.relationshipItems.every(item => item.locked && item.raw === null && !item.canChat && !item.canRespond && !item.canViewDetail));
});

test('relationship detail rechecks current membership before storing or navigating to a private profile', async () => {
  const pending = deferred();
  let reads = 0;
  const { page, calls } = runtime('pages/user/messages.js', { memberApi: {
    relationships: () => ++reads === 1 ? Promise.resolve(relationships(true)) : pending.promise
  } });
  await page.onShow();
  const opening = page.openRelationshipMember(itemEvent(501));
  await flush();
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
  assert.equal(calls.storage.length, 0);
  assert.equal(calls.navigation.length, 0);
  pending.resolve(relationships(false));
  await opening;
  assert.equal(calls.storage.length, 0);
  assert.ok(calls.navigation.every(call => call.url === '/pages/user/membership'));
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
});

test('premium detail navigation stores only public profile fields after successful revalidation', async () => {
  const { page, calls } = runtime('pages/user/messages.js', { memberApi: { relationships: async () => relationships(true) } });
  await page.onShow();
  await page.openRelationshipMember(itemEvent(501));
  assert.equal(calls.storage.length, 1);
  assert.equal(calls.storage[0].key, 'selectedUserMember');
  assert.equal(calls.storage[0].value.userId, 77);
  assert.equal('phone' in calls.storage[0].value, false);
  assert.equal('privateArchive' in calls.storage[0].value, false);
  assert.equal('canChat' in calls.storage[0].value, false);
  assert.equal(calls.navigation[0].url, '/pages/user/member-detail?id=501');
});

test('a permission downgrade replaces expanded premium results instead of appending locked rows', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/messages.js', { memberApi: {
    relationships: async () => ++reads === 1 ? { ...relationships(true), total: 20 } : relationships(false)
  } });
  await page.loadRelationships('incoming', { expanded: true, force: true });
  await page.loadRelationships('incoming', { expanded: true, append: true, force: true });
  assert.doesNotMatch(JSON.stringify(page.data.relationshipItems), /PRIVATE_/);
  assert.equal(page.data.relationshipItems.length, 1);
  assert.equal(page.data.relationshipExpanded, false);
  assert.equal(page.data.relationshipHasMore, false);
  assert.equal(page.data.isPremiumMember, false);
});

test('old account message responses cannot repopulate the new session', async () => {
  const oldConversations = deferred();
  const oldRelationships = deferred();
  let conversationReads = 0;
  let relationshipReads = 0;
  const { page, session } = runtime('pages/user/messages.js', {
    chatApi: { listConversations: () => ++conversationReads === 1 ? oldConversations.promise : Promise.resolve({ list: [conversation(2, '第二账户会话')], total: 1 }) },
    memberApi: { relationships: () => ++relationshipReads === 1 ? oldRelationships.promise : Promise.resolve(relationships(false)) }
  });
  const first = page.onShow();
  await flush();
  session.token = 'second-account-session';
  session.user = { id: 2 };
  const second = page.onShow();
  assert.equal(page.data.list.length, 0);
  assert.equal(page.data.relationshipItems.length, 0);
  await second;
  oldConversations.resolve({ list: [conversation(1, 'PRIVATE_OLD_ACCOUNT')], total: 1 });
  oldRelationships.resolve(relationships(true));
  await first;
  assert.equal(page.data.list[0].id, 2);
  assert.doesNotMatch(JSON.stringify(page.data), /PRIVATE_/);
});
