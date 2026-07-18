const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLockedRelationshipPreview,
  isPremiumMembership,
  isPremiumMemberType,
  partitionFavoriteRelationships,
  requiresPremiumForConversation,
  relationshipNotificationView
} = require('../cloudfunctions/hlApi/relationship-policy');

test('partitions active favorites into exclusive incoming and mutual groups', () => {
  const result = partitionFavoriteRelationships({
    viewerUserId: 9,
    incomingRows: [
      { id: 1, userId: 101, targetUserId: 9, active: true, updatedAt: '2026-07-18T01:00:00.000Z' },
      { id: 2, userId: 102, targetUserId: 9, active: true, updatedAt: '2026-07-18T02:00:00.000Z' },
      { id: 3, userId: 103, targetUserId: 9, active: false },
      { id: 4, userId: 104, targetUserId: 9, status: 'inactive' },
      { id: 5, userId: 9, targetUserId: 9, active: true }
    ],
    outgoingRows: [
      { id: 10, userId: 9, targetUserId: 102, active: true, updatedAt: '2026-07-18T03:00:00.000Z' }
    ]
  });

  assert.deepEqual(result.incoming.map(item => item.userId), [101]);
  assert.deepEqual(result.mutual.map(item => item.userId), [102]);
  assert.equal(result.mutual[0].relationshipAt, '2026-07-18T03:00:00.000Z');
});

test('deduplicates favorites, keeps the newest interaction, and excludes hidden users', () => {
  const result = partitionFavoriteRelationships({
    viewerUserId: 9,
    incomingRows: [
      { id: 1, userId: 101, targetUserId: 9, active: true, updatedAt: '2026-07-18T01:00:00.000Z' },
      { id: 2, userId: 101, targetUserId: 9, active: true, updatedAt: '2026-07-18T04:00:00.000Z' },
      { id: 3, userId: 105, targetUserId: 9, active: true, updatedAt: '2026-07-18T05:00:00.000Z' }
    ],
    outgoingRows: [],
    hiddenTargetUserIds: new Set([105])
  });

  assert.deepEqual(result.incoming.map(item => item.incomingInteraction.id), [2]);
  assert.deepEqual(result.mutual, []);
});

test('a newer inactive interaction overrides an older active duplicate', () => {
  const result = partitionFavoriteRelationships({
    viewerUserId: 9,
    incomingRows: [
      { id: 1, userId: 101, targetUserId: 9, active: true, updatedAt: '2026-07-18T01:00:00.000Z' },
      { id: 2, userId: 101, targetUserId: 9, active: false, status: 'inactive', updatedAt: '2026-07-18T04:00:00.000Z' },
      { id: 3, userId: 102, targetUserId: 9, active: true, updatedAt: '2026-07-18T02:00:00.000Z' }
    ],
    outgoingRows: [],
    hiddenRows: [
      { id: 10, userId: 9, targetUserId: 102, actionType: 'hide', active: true, updatedAt: '2026-07-18T03:00:00.000Z' },
      { id: 11, userId: 9, targetUserId: 102, actionType: 'hide', active: false, status: 'inactive', updatedAt: '2026-07-18T05:00:00.000Z' }
    ]
  });

  assert.deepEqual(result.incoming.map(item => item.userId), [102]);
  assert.deepEqual(result.mutual, []);
});

test('only mutual-favorite-only conversations require premium access', () => {
  assert.equal(requiresPremiumForConversation({
    conversationType: 'member_pair',
    chatOpenReason: 'mutual_favorite',
    matchRecordId: null
  }), true);
  assert.equal(requiresPremiumForConversation({
    conversationType: 'member_pair',
    chatOpenReason: 'mutual_favorite',
    matchRecordId: 88
  }), false);
  assert.equal(requiresPremiumForConversation({
    conversationType: 'member_matchmaker',
    chatOpenReason: 'mutual_favorite'
  }), false);
});

test('recognizes only paid and vip as premium member types', () => {
  assert.equal(isPremiumMemberType('paid'), true);
  assert.equal(isPremiumMemberType('VIP'), true);
  assert.equal(isPremiumMemberType('free'), false);
  assert.equal(isPremiumMemberType('no_consumption'), false);
  assert.equal(isPremiumMemberType(''), false);
});

test('premium entitlement honors expiry while preserving legacy lifetime records', () => {
  const now = '2026-07-18T00:00:00.000Z';
  assert.equal(isPremiumMembership({ memberType: 'paid', expireAt: null }, now), true);
  assert.equal(isPremiumMembership({ memberType: 'vip', expireAt: '' }, now), true);
  assert.equal(isPremiumMembership({ memberType: 'paid', expireAt: '2026-07-19T00:00:00.000Z' }, now), true);
  assert.equal(isPremiumMembership({ memberType: 'paid', expireAt: '2026-07-17T23:59:59.000Z' }, now), false);
  assert.equal(isPremiumMembership({ memberType: 'free', expireAt: null }, now), false);
  assert.equal(isPremiumMembership({ memberType: 'paid', expireAt: 'invalid' }, now), false);
});

test('locked relationship preview is synthetic and contains no identity, media, or profile fingerprints', () => {
  const preview = createLockedRelationshipPreview({
    kind: 'mutual',
    index: 0,
    tags: ['可关联的真实职业', '可关联的真实学历'],
    occurredAt: '2026-07-18T06:00:00.000Z'
  });

  assert.equal(preview.id, 'locked_mutual_1');
  assert.equal(preview.locked, true);
  assert.equal(preview.displayName, '第 1 位与你互相喜欢的人');
  assert.deepEqual(preview.tags, ['双方心动', '等待解锁']);
  assert.equal(Object.hasOwn(preview, 'occurredAt'), false);
  for (const field of ['userId', 'memberId', 'realName', 'nickname', 'avatarUrl', 'coverUrl', 'photos']) {
    assert.equal(Object.hasOwn(preview, field), false, `${field} must not be returned`);
  }
});

test('free-member favorite notifications hide sender and conversation identity', () => {
  const view = relationshipNotificationView({
    row: {
      id: 20,
      senderId: 101,
      receiverId: 9,
      targetUserId: 101,
      targetMemberId: 501,
      conversationId: 88,
      messageType: 'member_favorite',
      content: '真实姓名关注了你'
    },
    sender: { id: 101, nickname: '真实姓名', avatarUrl: 'cloud://secret.jpg' },
    conversationId: 88,
    isPremiumMember: false
  });

  assert.equal(view.content, '有人喜欢了你，开通会员后可查看并回应。');
  assert.equal(view.sender, null);
  assert.equal(view.conversationId, null);
  assert.equal(view.canChat, false);
  assert.equal(view.locked, true);
  for (const field of ['senderId', 'targetUserId', 'targetMemberId']) {
    assert.equal(Object.hasOwn(view, field), false, `${field} must not be returned`);
  }
});

test('premium favorite notifications expose the sender and available conversation', () => {
  const sender = { id: 101, nickname: '陈先生', avatarUrl: 'cloud://avatar.jpg' };
  const view = relationshipNotificationView({
    row: {
      id: 21,
      senderId: 101,
      targetUserId: 101,
      targetMemberId: 501,
      messageType: 'member_favorite',
      content: '有人喜欢了你'
    },
    sender,
    conversationId: 88,
    isPremiumMember: true
  });

  assert.equal(view.content, '陈先生喜欢了你，回应爱心后即可聊天。');
  assert.equal(view.sender, sender);
  assert.equal(view.conversationId, 88);
  assert.equal(view.canChat, true);
  assert.equal(view.locked, false);
  assert.equal(view.senderId, 101);
  assert.equal(view.targetUserId, 101);
  assert.equal(view.targetMemberId, 501);
});
