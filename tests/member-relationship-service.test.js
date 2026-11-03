const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemberRelationshipService } = require('../cloudfunctions/hlApi/member-relationship-service');
const { UNMATCH_REASONS, relationshipStatusPatch } = require('../cloudfunctions/hlApi/relationship-policy');

function fixture() {
  const C = Object.fromEntries(['users', 'profiles', 'memberInteractions', 'matchRecords', 'conversations'].map(name => [name, name]));
  let id = 100;
  const rows = {
    users: [1, 2, 3].map(id => ({ id, nickname: `会员${id}`, status: 1 })),
    profiles: [1, 2, 3].map(id => ({ id, userId: id, relationshipStatus: 'single', displayEnabled: true })),
    memberInteractions: [
      { id: 1, userId: 1, targetUserId: 2, actionType: 'favorite', active: true, status: 'active' },
      { id: 2, userId: 2, targetUserId: 1, actionType: 'favorite', active: true, status: 'active' }
    ],
    matchRecords: [{ id: 1, userAId: 1, userBId: 2, status: 'accepted' }],
    conversations: [{ id: 1, participantKey: '1:2', conversationType: 'member_pair', status: 'active' }]
  };
  function match(row, query) {
    if (!query) return true;
    if (query.$or) return query.$or.some(item => match(row, item));
    if (query.$and) return query.$and.every(item => match(row, item));
    return Object.entries(query).every(([key, value]) => value && value.$in ? value.$in.includes(row[key]) : row[key] === value);
  }
  const getAll = async (collection, query) => rows[collection].filter(row => match(row, query));
  const getOne = async (collection, query) => (await getAll(collection, query))[0] || null;
  const getById = (collection, id) => getOne(collection, { id });
  const addRow = async (collection, row) => { rows[collection].push(row); return row; };
  const updateRow = async (_collection, row, patch) => Object.assign(row, patch);
  const activeInteraction = (userId, targetUserId, actionType) => getOne(C.memberInteractions, { userId, targetUserId, actionType, active: true });
  const upsertMemberInteraction = async (userId, targetUserId, actionType, active, extra = {}) => {
    const row = await getOne(C.memberInteractions, { userId, targetUserId, actionType });
    const patch = { userId, targetUserId, actionType, active, status: active ? 'active' : 'inactive', ...extra };
    return row ? updateRow(C.memberInteractions, row, patch) : addRow(C.memberInteractions, { id: ++id, ...patch });
  };
  const service = createMemberRelationshipService({
    collections: C,
    command: { or: values => ({ $or: values }), and: values => ({ $and: values }), in: values => ({ $in: values }) },
    getAll, getOne, getById, addRow, updateRow, nextId: async () => ++id,
    nowIso: () => '2026-11-03T00:00:00.000Z',
    createHttpError: (message, status, code) => Object.assign(new Error(message), { status, code }),
    upsertMemberInteraction, activeInteraction,
    areMutualFavorites: async (a, b) => !!(await activeInteraction(a, b, 'favorite')) && !!(await activeInteraction(b, a, 'favorite')),
    resolveMemberPairChatAccess: async (a, b) => rows.matchRecords.find(row => [row.userAId, row.userBId].includes(a)
      && [row.userAId, row.userBId].includes(b) && !['cancelled', 'rejected'].includes(row.status)) || null
  });
  return { service, rows };
}

test('declaring success hides only the authenticated member and restoring single never auto-publishes', async () => {
  const { service, rows } = fixture();
  await service.setStatus(1, { status: 'coupled', userId: 2 });
  assert.equal(rows.profiles[0].relationshipStatus, 'coupled');
  assert.equal(rows.profiles[0].displayEnabled, false);
  assert.equal(rows.profiles[1].relationshipStatus, 'single');
  await service.setStatus(1, { status: 'single' });
  assert.equal(rows.profiles[0].displayEnabled, false);
  assert.equal(relationshipStatusPatch('married', 'now'), null);
});

test('invitation changes sender only; recipient alone may accept and becomes hidden', async () => {
  const { service, rows } = fixture();
  const { invitation } = await service.invite(1, { targetUserId: 2 });
  assert.equal(rows.profiles[0].relationshipStatus, 'coupled');
  assert.equal(rows.profiles[1].relationshipStatus, 'single');
  await assert.rejects(service.respond(3, invitation.id, { accept: true }), error => error.status === 404);
  await service.respond(2, invitation.id, { accept: true });
  assert.equal(rows.profiles[1].relationshipStatus, 'coupled');
  assert.equal(rows.profiles[1].displayEnabled, false);
  assert.equal((await service.overview(2)).incomingInvitations[0].status, 'accepted');
  await assert.rejects(service.respond(2, invitation.id, { accept: true }), error => error.code === 40943);
});

test('declining an invitation preserves recipient visibility and does not mutate sender again', async () => {
  const { service, rows } = fixture();
  const { invitation } = await service.invite(1, { targetUserId: 2 });
  await service.respond(2, invitation.id, { accept: false });
  assert.equal(rows.profiles[1].relationshipStatus, 'single');
  assert.equal(rows.profiles[1].displayEnabled, true);
  assert.equal(rows.profiles[0].relationshipStatus, 'coupled');
});

test('resetting single cancels pending invitations so they cannot later be accepted', async () => {
  const { service, rows } = fixture();
  const { invitation } = await service.invite(1, { targetUserId: 2 });
  await service.setStatus(1, { status: 'single' });
  await service.setStatus(1, { status: 'coupled' });
  await assert.rejects(service.respond(2, invitation.id, { accept: true }), error => error.code === 40943);
  assert.equal(rows.profiles[1].relationshipStatus, 'single');
});

test('unmatching persists bilateral denial, cancels hearts/formal pair/chat/invitations and is retryable', async () => {
  const { service, rows } = fixture();
  await service.invite(1, { targetUserId: 2 });
  const request = { targetUserId: 2, reason: UNMATCH_REASONS[0] };
  await service.unmatch(1, request);
  assert.equal(await service.isUnmatched(1, 2), true);
  assert.equal(await service.isUnmatched(2, 1), true);
  assert.equal(rows.matchRecords[0].status, 'cancelled');
  assert.equal(rows.conversations[0].status, 0);
  assert.ok(rows.memberInteractions.filter(row => row.actionType === 'favorite').every(row => row.active === false));
  assert.equal(rows.memberInteractions.find(row => row.actionType === 'couple_invite').invitationStatus, 'cancelled');
  assert.deepEqual((await service.overview(1)).candidates, []);
  await service.unmatch(1, request);
  await assert.rejects(service.invite(2, { targetUserId: 1 }), error => error.code === 40941);
});

test('unmatch requires one of the four supplied reasons and a real relationship', async () => {
  const { service, rows } = fixture();
  await assert.rejects(service.unmatch(1, { targetUserId: 2, reason: 'custom' }), error => error.status === 422);
  await assert.rejects(service.unmatch(1, { targetUserId: 3, reason: UNMATCH_REASONS[2] }), error => error.status === 403);
  assert.equal(rows.conversations[0].status, 'active');
  assert.equal(UNMATCH_REASONS.length, 4);
});
