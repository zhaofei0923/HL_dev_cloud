'use strict';

const { isCoupledProfile, relationshipStatusPatch, normalizeUnmatchReason } = require('./relationship-policy');

// Keep relationship transitions separate from commercial entitlements. No VIP is
// required to hide a profile, declare success, decline an invitation or unmatch.
function createMemberRelationshipService(deps) {
  const {
    collections: C, command: _, getAll, getOne, getById, addRow, updateRow,
    nextId, nowIso, createHttpError, upsertMemberInteraction, activeInteraction,
    areMutualFavorites, resolveMemberPairChatAccess
  } = deps;

  function targetId(userId, value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || id === Number(userId)) {
      throw createHttpError('请选择有效的匹配对象', 422, 42201);
    }
    return id;
  }

  async function activeUser(userId) {
    const user = await getById(C.users, Number(userId));
    if (!user || Number(user.status) === 0 || user.mergedIntoUserId) {
      throw createHttpError('未找到有效会员', 404, 40400);
    }
    return user;
  }

  async function isUnmatched(userAId, userBId) {
    const rows = await Promise.all([
      activeInteraction(userAId, userBId, 'unmatch'),
      activeInteraction(userBId, userAId, 'unmatch')
    ]);
    return rows.some(Boolean);
  }

  async function assertPair(userId, peerId) {
    await Promise.all([activeUser(userId), activeUser(peerId)]);
    if (await isUnmatched(userId, peerId)) throw createHttpError('你们已解除匹配', 409, 40941);
    const [mutual, formal] = await Promise.all([
      areMutualFavorites(userId, peerId), resolveMemberPairChatAccess(userId, peerId)
    ]);
    if (!mutual && !formal) throw createHttpError('只能邀请已匹配的会员', 403, 40300);
  }

  async function setStatus(userId, data = {}) {
    await activeUser(userId);
    const patch = relationshipStatusPatch(data.status, nowIso());
    if (!patch) throw createHttpError('脱单状态无效', 422, 42201);
    const profile = await getOne(C.profiles, { userId: Number(userId) });
    const saved = profile
      ? await updateRow(C.profiles, profile, patch)
      : await addRow(C.profiles, { id: await nextId('profile'), userId: Number(userId), ...patch });
    // Pending invitations from a previous declaration must never become valid
    // again just because this member declares success with somebody else later.
    if (data.status === 'single') {
      const invitations = await getAll(C.memberInteractions, {
        userId: Number(userId), actionType: 'couple_invite', invitationStatus: 'pending'
      }, Infinity);
      await Promise.all(invitations.map(row => updateRow(C.memberInteractions, row, {
        active: false, status: 'inactive', invitationStatus: 'cancelled', respondedAt: nowIso()
      })));
    }
    return { relationshipStatus: saved.relationshipStatus, displayEnabled: false, coupledAt: saved.coupledAt || null };
  }

  async function invitationView(row, viewerId) {
    const incoming = Number(row.targetUserId) === Number(viewerId);
    const peer = await getById(C.users, incoming ? Number(row.userId) : Number(row.targetUserId));
    return {
      id: Number(row.id), peerId: peer ? Number(peer.id) : null,
      peerName: peer?.nickname || '会员', direction: incoming ? 'incoming' : 'outgoing',
      status: row.invitationStatus || 'pending', createdAt: row.createdAt || '',
      respondedAt: row.respondedAt || ''
    };
  }

  async function overview(userId) {
    await activeUser(userId);
    const id = Number(userId);
    const [profile, invitations, outgoing, incoming, records] = await Promise.all([
      getOne(C.profiles, { userId: id }),
      getAll(C.memberInteractions, _.and([{ actionType: 'couple_invite' }, _.or([{ userId: id }, { targetUserId: id }])]), Infinity),
      getAll(C.memberInteractions, { userId: id, actionType: 'favorite' }, Infinity),
      getAll(C.memberInteractions, { targetUserId: id, actionType: 'favorite' }, Infinity),
      getAll(C.matchRecords, _.or([{ userAId: _.in([id, String(id)]) }, { userBId: _.in([id, String(id)]) }]), Infinity)
    ]);
    const peerIds = new Set(outgoing.filter(row => incoming.some(other => Number(other.userId) === Number(row.targetUserId)))
      .map(row => Number(row.targetUserId)));
    records.filter(row => !['rejected', 'cancelled'].includes(String(row.status || ''))).forEach(row => {
      peerIds.add(Number(row.userAId) === id ? Number(row.userBId) : Number(row.userAId));
    });
    const candidates = (await Promise.all(Array.from(peerIds).filter(peerId => peerId > 0 && peerId !== id).map(async peerId => {
      if (await isUnmatched(id, peerId)) return null;
      const [mutual, formal, peer] = await Promise.all([
        areMutualFavorites(id, peerId), resolveMemberPairChatAccess(id, peerId), getById(C.users, peerId)
      ]);
      if ((!mutual && !formal) || !peer || Number(peer.status) === 0 || peer.mergedIntoUserId) return null;
      return { userId: peerId, displayName: peer.nickname || '会员' };
    }))).filter(Boolean);
    const views = await Promise.all(invitations.sort((a, b) => Number(b.id) - Number(a.id)).map(row => invitationView(row, id)));
    return {
      relationshipStatus: isCoupledProfile(profile || {}) ? 'coupled' : 'single',
      displayEnabled: !isCoupledProfile(profile || {}) && profile?.displayEnabled === true,
      coupledAt: profile?.coupledAt || null,
      incomingInvitations: views.filter(row => row.direction === 'incoming'),
      outgoingInvitations: views.filter(row => row.direction === 'outgoing'), candidates
    };
  }

  async function invite(userId, data = {}) {
    const peerId = targetId(userId, data.targetUserId);
    await assertPair(userId, peerId);
    const peerProfile = await getOne(C.profiles, { userId: peerId });
    if (isCoupledProfile(peerProfile || {})) throw createHttpError('对方已处于脱单状态', 409, 40942);
    const pending = (await getAll(C.memberInteractions, {
      userId: Number(userId), targetUserId: peerId, actionType: 'couple_invite', invitationStatus: 'pending'
    }, Infinity))[0];
    await setStatus(userId, { status: 'coupled' });
    const invitation = pending || await addRow(C.memberInteractions, {
      id: await nextId('memberInteraction'), userId: Number(userId), targetUserId: peerId,
      actionType: 'couple_invite', active: true, status: 'active', invitationStatus: 'pending'
    });
    return { invitation: await invitationView(invitation, userId), relationshipStatus: 'coupled', displayEnabled: false };
  }

  async function respond(userId, invitationId, data = {}) {
    await activeUser(userId);
    if (typeof data.accept !== 'boolean') throw createHttpError('请选择接受或婉拒邀请', 422, 42201);
    const row = await getById(C.memberInteractions, Number(invitationId));
    if (!row || row.actionType !== 'couple_invite' || Number(row.targetUserId) !== Number(userId)) {
      throw createHttpError('未找到此邀请', 404, 40400);
    }
    if (row.invitationStatus !== 'pending') throw createHttpError('此邀请已处理', 409, 40943);
    if (data.accept) {
      await assertPair(userId, Number(row.userId));
      const sender = await getOne(C.profiles, { userId: Number(row.userId) });
      if (!isCoupledProfile(sender || {})) throw createHttpError('对方已撤回脱单状态', 409, 40943);
      await setStatus(userId, { status: 'coupled' });
    }
    const updated = await updateRow(C.memberInteractions, row, {
      invitationStatus: data.accept ? 'accepted' : 'declined', respondedAt: nowIso(), active: false, status: 'inactive'
    });
    return { invitation: await invitationView(updated, userId) };
  }

  async function unmatch(userId, data = {}) {
    const peerId = targetId(userId, data.targetUserId);
    const reason = normalizeUnmatchReason(data.reason);
    if (!reason) throw createHttpError('请选择解除匹配原因', 422, 42201);
    await activeUser(userId);
    const alreadyUnmatched = await isUnmatched(userId, peerId);
    if (!alreadyUnmatched) await assertPair(userId, peerId);
    // Persist the access-denial marker before cleanup. A retry can finish cleanup
    // after interruption without ever reopening the blocked conversation.
    await upsertMemberInteraction(userId, peerId, 'unmatch', true, { reason, unmatchedAt: nowIso() });
    await Promise.all([
      upsertMemberInteraction(userId, peerId, 'favorite', false),
      upsertMemberInteraction(peerId, userId, 'favorite', false)
    ]);
    const pairs = _.or([
      { userAId: _.in([Number(userId), String(userId)]), userBId: _.in([peerId, String(peerId)]) },
      { userBId: _.in([Number(userId), String(userId)]), userAId: _.in([peerId, String(peerId)]) }
    ]);
    const [records, conversations, invitations] = await Promise.all([
      getAll(C.matchRecords, pairs, Infinity),
      getAll(C.conversations, { participantKey: [Number(userId), peerId].sort((a, b) => a - b).join(':'), conversationType: 'member_pair' }, Infinity),
      getAll(C.memberInteractions, _.and([{ actionType: 'couple_invite', invitationStatus: 'pending' }, _.or([
        { userId: Number(userId), targetUserId: peerId }, { userId: peerId, targetUserId: Number(userId) }
      ])]), Infinity)
    ]);
    await Promise.all([
      ...records.map(row => updateRow(C.matchRecords, row, { status: 'cancelled', unmatchedBy: Number(userId), unmatchedAt: nowIso(), unmatchReason: reason })),
      ...conversations.map(row => updateRow(C.conversations, row, { status: 0, closedReason: 'unmatched', closedAt: nowIso() })),
      ...invitations.map(row => updateRow(C.memberInteractions, row, { invitationStatus: 'cancelled', active: false, status: 'inactive', respondedAt: nowIso() }))
    ]);
    return { unmatched: true, targetUserId: peerId };
  }

  return { overview, setStatus, invite, respond, unmatch, isUnmatched };
}

module.exports = { createMemberRelationshipService };
