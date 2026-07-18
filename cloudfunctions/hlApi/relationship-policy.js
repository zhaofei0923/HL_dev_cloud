'use strict';

const PREMIUM_MEMBER_TYPES = new Set(['paid', 'vip']);

function isActiveInteraction(row) {
  return !!row && row.active !== false && String(row.status || 'active') !== 'inactive';
}

function interactionTimestamp(row) {
  return new Date((row && (row.updatedAt || row.createdAt)) || 0).getTime() || 0;
}

function newestByUser(rows, userIdField, viewerUserId) {
  const result = new Map();
  rows
    .filter(row => Number(row[userIdField]) && Number(row[userIdField]) !== Number(viewerUserId))
    .sort((a, b) => interactionTimestamp(b) - interactionTimestamp(a) || Number(b.id || 0) - Number(a.id || 0))
    .forEach(row => {
      const key = String(Number(row[userIdField]));
      if (!result.has(key)) result.set(key, row);
    });
  return new Map(Array.from(result).filter(([, row]) => isActiveInteraction(row)));
}

function relationshipAt(incomingInteraction, outgoingInteraction = null) {
  const incomingTime = interactionTimestamp(incomingInteraction);
  const outgoingTime = interactionTimestamp(outgoingInteraction);
  const latest = outgoingTime > incomingTime ? outgoingInteraction : incomingInteraction;
  return (latest && (latest.updatedAt || latest.createdAt)) || '';
}

function partitionFavoriteRelationships({
  viewerUserId,
  incomingRows = [],
  outgoingRows = [],
  hiddenRows = [],
  hiddenTargetUserIds = new Set()
} = {}) {
  const hidden = new Set(Array.from(hiddenTargetUserIds || []).map(value => Number(value)));
  newestByUser(hiddenRows, 'targetUserId', viewerUserId).forEach((_row, key) => hidden.add(Number(key)));
  const incomingBySender = newestByUser(incomingRows, 'userId', viewerUserId);
  const outgoingByTarget = newestByUser(outgoingRows, 'targetUserId', viewerUserId);
  const incoming = [];
  const mutual = [];

  incomingBySender.forEach((incomingInteraction, key) => {
    const userId = Number(key);
    if (hidden.has(userId)) return;
    const outgoingInteraction = outgoingByTarget.get(key) || null;
    const item = {
      userId,
      incomingInteraction,
      outgoingInteraction,
      relationshipAt: relationshipAt(incomingInteraction, outgoingInteraction)
    };
    if (outgoingInteraction) mutual.push(item);
    else incoming.push(item);
  });

  const sortNewest = (a, b) => {
    const timeDiff = new Date(b.relationshipAt || 0).getTime() - new Date(a.relationshipAt || 0).getTime();
    return timeDiff || Number(b.incomingInteraction.id || 0) - Number(a.incomingInteraction.id || 0);
  };
  return {
    incoming: incoming.sort(sortNewest),
    mutual: mutual.sort(sortNewest)
  };
}

function isPremiumMemberType(value) {
  return PREMIUM_MEMBER_TYPES.has(String(value || '').trim().toLowerCase());
}

function isPremiumMembership(row = {}, now = new Date()) {
  if (!isPremiumMemberType(row.memberType)) return false;
  if (row.expireAt === null || row.expireAt === undefined || String(row.expireAt).trim() === '') return true;
  const expireAt = new Date(row.expireAt).getTime();
  const referenceTime = new Date(now).getTime();
  return Number.isFinite(expireAt) && Number.isFinite(referenceTime) && expireAt > referenceTime;
}

function requiresPremiumForConversation(conversation = {}) {
  return String(conversation.conversationType || '') === 'member_pair'
    && String(conversation.chatOpenReason || '') === 'mutual_favorite'
    && !conversation.matchRecordId;
}

function createLockedRelationshipPreview({ kind = 'incoming', index = 0 } = {}) {
  const normalizedKind = kind === 'mutual' ? 'mutual' : 'incoming';
  const mutual = normalizedKind === 'mutual';
  const safeTags = mutual ? ['双方心动', '等待解锁'] : ['资料已认证', '等待回应'];
  return {
    id: `locked_${normalizedKind}_${index + 1}`,
    locked: true,
    blurred: true,
    canViewDetail: false,
    displayName: mutual ? `第 ${index + 1} 位与你互相喜欢的人` : `第 ${index + 1} 位喜欢你的人`,
    metaText: safeTags.join(' · ') || (mutual ? '你们已经互相喜欢' : '有会员对你感兴趣'),
    hint: mutual ? '你们已经互相喜欢' : '等待你的回应',
    tags: safeTags,
    coverTone: index % 4
  };
}

function relationshipNotificationView({ row = {}, sender = null, conversationId = null, isPremiumMember = false } = {}) {
  const isFavorite = String(row.messageType || '') === 'member_favorite';
  if (!isFavorite) {
    return {
      ...row,
      sender,
      conversationId,
      canChat: !!conversationId,
      locked: false
    };
  }
  if (!isPremiumMember) {
    const {
      senderId: _senderId,
      targetUserId: _targetUserId,
      targetMemberId: _targetMemberId,
      conversationId: _storedConversationId,
      ...safeRow
    } = row;
    return {
      ...safeRow,
      content: '有人喜欢了你，开通会员后可查看并回应。',
      sender: null,
      conversationId: null,
      canChat: false,
      locked: true
    };
  }
  const senderName = String((sender && sender.nickname) || '会员').trim() || '会员';
  return {
    ...row,
    content: `${senderName}喜欢了你，回应爱心后即可聊天。`,
    sender,
    conversationId,
    canChat: !!conversationId,
    locked: false
  };
}

module.exports = {
  createLockedRelationshipPreview,
  isPremiumMembership,
  isPremiumMemberType,
  partitionFavoriteRelationships,
  relationshipNotificationView,
  requiresPremiumForConversation
};
