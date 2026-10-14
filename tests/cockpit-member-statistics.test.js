const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCockpitMemberStatistics } = require('../cloudfunctions/hlApi/cockpit-member-statistics');
const { createVipMembershipService } = require('../cloudfunctions/hlApi/vip-membership-service');
const { ownCertificationOverview, publicCertificationFields } = require('../cloudfunctions/hlApi/showcase-policy');

const NOW = '2026-10-14T02:15:00.000Z';
const NOW_MS = Date.parse(NOW);
const OLD = '2026-08-01T00:00:00.000Z';
const RECENT = '2026-10-12T00:00:00.000Z';
const projections = {
  getEntitlement: () => ({ isPremiumMember: false }),
  getCertification: () => ownCertificationOverview({}, NOW_MS)
};
function input(overrides = {}) {
  return { now: NOW, days: 30, users: [], members: [], profiles: [], matchmakers: [], certifications: [], presence: [], ...overrides };
}
function user(id, extra = {}) { return { id, status: 1, nickname: `会员${id}`, createdAt: OLD, ...extra }; }
function profile(userId, extra = {}) { return { userId, createdAt: OLD, displayEnabled: false, ...extra }; }
function member(userId, extra = {}) { return { userId, status: 1, createdAt: OLD, ...extra }; }
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}

test('empty complete snapshots return actual zero counts and a Beijing calendar window', async () => {
  const result = await buildCockpitMemberStatistics(input());
  assert.deepEqual([result.members.total, result.members.newCount, result.members.vip, result.members.ordinary,
    result.members.verified, result.members.publicCount], [0, 0, 0, 0, 0, 0]);
  assert.equal(result.members.trend.length, 30);
  assert.deepEqual(result.members.trend[0], { date: '2026-09-15', newCount: 0, cumulative: 0 });
  assert.deepEqual(result.members.trend.at(-1), { date: '2026-10-14', newCount: 0, cumulative: 0 });
  assert.deepEqual(result.matchmakers, { approved: 0, pending: 0, rejected: 0, active30d: 0, ranking: [] });
  assert.equal(result.members.quality.demoDetectionIncomplete, true);
  assert.equal(result.members.quality.trendBasis, 'current_active_archives');
});

test('member union deduplicates numeric references and excludes registration-only, merged and disabled accounts', async () => {
  const seen = [];
  const data = input({ days: 7,
    users: [user(1, { identitySource: 'manual_claimed', claimedAt: NOW }), user(2, { currentRole: 'matchmaker' }),
      user(3), user(4, { status: 0 }), user(5, { status: 0, mergedIntoUserId: 1 })],
    members: [member(1, { createdAt: '2026-10-08T00:00:00.000Z' }), member('1', { createdAt: RECENT }),
      member(4), member(5), member(99), member(3, { status: 0 })],
    profiles: [profile('1', { createdAt: RECENT }), profile(2), profile(4), profile(5)] });
  const result = await buildCockpitMemberStatistics(data, { ...projections,
    getEntitlement(id, context) { seen.push(id); assert.equal(context.now, NOW); return { isPremiumMember: false }; } });
  assert.equal(result.members.total, 2);
  assert.equal(result.members.newCount, 1);
  assert.equal(result.members.ordinary, 2);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(result.members.trend[0], { date: '2026-10-08', newCount: 1, cumulative: 2 });
  assert.equal(result.members.trend.at(-1).cumulative, 2);
});

test('the first archived date includes inactive prior assignments without turning reactivation or claims into new members', async () => {
  const result = await buildCockpitMemberStatistics(input({ users: [user(1, { claimedAt: RECENT, createdAt: RECENT })],
    members: [member(1, { status: 0, createdAt: OLD }), member(1, { createdAt: RECENT })],
    profiles: [profile(1, { createdAt: RECENT })] }), projections);
  assert.equal(result.members.total, 1);
  assert.equal(result.members.newCount, 0);
  assert.equal(result.members.trend.at(-1).cumulative, 1);
});

test('Beijing midnight boundaries, current cutoff and seven or ninety natural days are exact', async () => {
  const dates = ['2026-10-07T15:59:59.999Z', '2026-10-07T16:00:00.000Z', '2026-10-13T15:59:59.999Z',
    '2026-10-13T16:00:00.000Z', NOW];
  const data = input({ days: 7, users: dates.map((_, index) => user(index + 1)),
    profiles: dates.map((createdAt, index) => profile(index + 1, { createdAt })) });
  const result = await buildCockpitMemberStatistics(data, projections);
  assert.equal(result.members.newCount, 4);
  assert.deepEqual(result.members.trend[0], { date: '2026-10-08', newCount: 1, cumulative: 2 });
  assert.deepEqual(result.members.trend.at(-2), { date: '2026-10-13', newCount: 1, cumulative: 3 });
  assert.deepEqual(result.members.trend.at(-1), { date: '2026-10-14', newCount: 2, cumulative: 5 });
  const ninety = await buildCockpitMemberStatistics({ ...data, days: 90 }, projections);
  assert.equal(ninety.members.trend.length, 90);
  assert.equal(ninety.members.trend[0].date, '2026-07-17');
});

test('undated, malformed, local-time, zero and future first dates remain unknown instead of becoming zero or 1970', async () => {
  for (const createdAt of [undefined, null, '', 0, 'invalid', '2026-10-14T00:00:00', '2026-10-15T00:00:00Z']) {
    const result = await buildCockpitMemberStatistics(input({ users: [user(1), user(2)],
      profiles: [profile(1, { createdAt }), profile(2, { createdAt: RECENT })] }), projections);
    assert.equal(result.members.total, 2);
    assert.equal(result.members.newCount, null);
    assert.equal(result.members.quality.missingFirstCreatedAt, 1);
    assert.equal(result.members.quality.knownNewCount, 1);
    assert.equal(result.members.trend.every(point => point.newCount === null && point.cumulative === null), true);
  }
  const mixed = await buildCockpitMemberStatistics(input({ users: [user(1)],
    members: [member(1, { createdAt: undefined })], profiles: [profile(1, { createdAt: RECENT })] }), projections);
  assert.equal(mixed.members.newCount, null);
});

test('explicit demo and mock provenance propagates by user but genuine manual members and test-like names remain', async () => {
  const result = await buildCockpitMemberStatistics(input({
    users: [user(1, { openid: 'real-wechat-id', nickname: '测试会员' }),
      user(2, { openid: 'manual_2', identitySource: 'matchmaker_manual', nickname: '演示' }),
      user(3, { openid: 'mock_123456' }), user(4, { openid: 'seed-mm-1' }), user(5, { isDemo: true }),
      user(6), user(7), user(8), user(9), user(10)],
    profiles: [1, 2, 3, 4, 5, 6, 8, 9, 10].map(id => profile(id)),
    members: [member(2, { matchmakerId: 104 }), member(6, { remark: '虚拟演示会员' }),
      member(7, { isTest: true }), member(9, { remark: '备注中包含虚拟演示会员字样' })],
    matchmakers: [{ id: 104, userId: 4, status: 1, certificationStatus: 2 },
      { id: 108, userId: 8, status: 1, certificationStatus: 2, dataSource: 'demo' }],
    presence: [{ userId: 10, source: 'test', lastSeenAt: NOW }] }), projections);
  assert.equal(result.members.total, 3);
  assert.equal(result.members.quality.excludedSourceUsers, 7);
  assert.equal(result.matchmakers.approved, 0);
  assert.equal(result.members.quality.warnings.some(message => message.includes('统一来源标记')), true);
});

test('existing entitlement and certification projectors decide VIP, legacy lifetime, refunds and pending renewal', async () => {
  const data = input({ users: [1, 2, 3, 4, 5].map(id => user(id, { isVerified: 1 })),
    members: [member(2, { memberType: 'vip', expireAt: null })],
    profiles: [1, 2, 3, 4, 5].map(id => profile(id, { displayEnabled: id < 3 })),
    certifications: [{ userId: 2, current: { identity: { status: 'approved', source: 'identity_document' } },
      applications: { identity: { status: 'pending', source: 'identity_document' } } }] });
  const vipRows = {
    vip_user_3: { legacyExpireAt: OLD, grants: [{ orderNo: 'refunded', grantedAt: RECENT,
      durationDays: 365, status: 'refunded', retainedDurationMs: 0 }] },
    vip_user_4: { grants: [{ orderNo: 'paid', grantedAt: RECENT, durationDays: 7 }] },
    vip_user_5: { legacyExpireAt: NOW, grants: [] }
  };
  const service = createVipMembershipService({ now: () => NOW,
    getById: async (_name, id) => data.users.find(row => row.id === id),
    getOne: async () => null,
    getAll: async (_name, query) => data.members.filter(row => row.userId === query.userId && row.status === query.status),
    db: { collection: () => ({ doc: id => ({ async get() {
      if (!vipRows[id]) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
      return { data: vipRows[id] };
    } }) }) } });
  const result = await buildCockpitMemberStatistics(data, {
    getEntitlement: id => service.getEntitlement(id, { now: NOW }),
    getCertification: (_id, context) => ownCertificationOverview(context.certification || {}, NOW_MS)
  });
  assert.equal(result.members.vip, 2);
  assert.equal(result.members.ordinary, 3);
  assert.equal(result.members.verified, 1);
  assert.equal(result.members.publicCount, 2);
});

test('public certification DTO is supported and legacy isVerified or untrusted approved status never substitutes for it', async () => {
  const data = input({ users: [user(1, { isVerified: 1 }), user(2)],
    profiles: [profile(1), profile(2, { showcaseCertification: { policyVersion: 1,
      identity: { status: 'approved', source: 'identity_document' } } })] });
  const result = await buildCockpitMemberStatistics(data, { ...projections,
    getCertification: (_id, context) => publicCertificationFields(context.profile, NOW_MS) });
  assert.equal(result.members.verified, 1);
  const missing = await buildCockpitMemberStatistics(data, {
    getEntitlement: () => ({}), getCertification: () => ({ status: 'approved' })
  });
  assert.equal(missing.members.vip, null);
  assert.equal(missing.members.ordinary, null);
  assert.equal(missing.members.verified, null);
  assert.equal(missing.members.quality.unknownEntitlement, 2);
  assert.equal(missing.members.quality.unknownIdentityVerification, 2);
});

test('matchmaker status, fixed thirty-day usage and current assignment ranking use separate dimensions', async () => {
  const result = await buildCockpitMemberStatistics(input({ days: 7,
    users: [1, 2, 3, 4, 5, 6, 7, 8].map(id => user(id, { nickname: `主理人${id}` })),
    profiles: [profile(1, { city: '杭州' }), profile(2, { province: '浙江' })],
    matchmakers: [{ id: 11, userId: 1, status: 1, certificationStatus: 2 },
      { id: 12, userId: 2, status: 1, certificationStatus: 2 },
      { id: 13, userId: 3, status: 1, certificationStatus: 0 },
      { id: 14, userId: 4, status: 1, certificationStatus: 1 },
      { id: 15, userId: 5, status: 0, certificationStatus: 2 }],
    members: [member(6, { matchmakerId: 11, createdAt: RECENT }),
      member('6', { matchmakerId: '11', createdAt: RECENT }), member(7, { matchmakerId: 11 }),
      member(8, { matchmakerId: 12, createdAt: RECENT }), member(7, { matchmakerId: 12, status: 0 })],
    presence: [{ userId: 1, lastSeenAt: '2026-09-14T16:00:00.000Z' },
      { userId: 2, lastSeenAt: '2026-09-14T15:59:59.999Z' }, { userId: 3, lastSeenAt: NOW },
      { userId: 4, lastSeenAt: '2026-10-15T00:00:00.000Z' }] }), projections);
  assert.deepEqual(result.matchmakers, { approved: 2, pending: 1, rejected: 1, active30d: 2,
    ranking: [{ name: '主理人1', city: '杭州', memberCount: 2, newAssignments: 1 },
      { name: '主理人2', city: '未填写', memberCount: 1, newAssignments: 1 }] });
});

test('ranking is limited to ten and its output cannot leak identifiers or sensitive source data', async () => {
  const data = input({ users: Array.from({ length: 13 }, (_, index) => user(index + 1,
    { openid: 'sensitive-real-openid', phone: 'sensitive-phone', privateNote: 'sensitive-note' })),
    profiles: Array.from({ length: 13 }, (_, index) => profile(index + 1, { city: '上海', photos: ['sensitive-file'] })),
    matchmakers: Array.from({ length: 13 }, (_, index) => ({ id: 100 + index, userId: index + 1,
      status: 1, certificationStatus: 2, sealedVerification: 'sensitive-sealed-proof' })) });
  const snapshot = structuredClone(data);
  deepFreeze(data);
  const result = await buildCockpitMemberStatistics(data, projections);
  assert.equal(result.matchmakers.ranking.length, 10);
  assert.deepEqual(Object.keys(result.matchmakers.ranking[0]), ['name', 'city', 'memberCount', 'newAssignments']);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-|openid|phone|sealedVerification|photos/);
  assert.deepEqual(data, snapshot);
});

test('unknown assignment dates and conflicting display settings do not become exact zeros', async () => {
  const result = await buildCockpitMemberStatistics(input({ users: [user(1), user(2)],
    profiles: [profile(2, { displayEnabled: true }), profile(2, { displayEnabled: false })],
    members: [member(2, { matchmakerId: 11, createdAt: null })],
    matchmakers: [{ id: 11, userId: 1, status: 1, certificationStatus: 2 }] }), projections);
  assert.equal(result.members.publicCount, null);
  assert.equal(result.members.quality.unknownPublicDisplay, 1);
  assert.equal(result.members.quality.missingAssignmentCreatedAt, 1);
  assert.equal(result.matchmakers.ranking[0].newAssignments, null);
});

test('conflicting identities are excluded with explicit quality diagnostics rather than counted twice', async () => {
  const result = await buildCockpitMemberStatistics(input({ users: [user(1, { _id: 'first' }), user('1', { _id: 'second' }), user(2)],
    profiles: [profile(1)], matchmakers: [{ id: 21, userId: 2, status: 1, certificationStatus: 2 },
      { id: 22, userId: 2, status: 1, certificationStatus: 0 }] }), projections);
  assert.equal(result.members.total, 0);
  assert.equal(result.members.quality.ambiguousUsers, 1);
  assert.equal(result.members.quality.ambiguousMatchmakers, 1);
  assert.equal(result.matchmakers.approved, 0);
  assert.equal(result.matchmakers.pending, 0);
  const conflictingOwner = await buildCockpitMemberStatistics(input({ users: [user(1), user(2)],
    matchmakers: [{ id: 21, userId: 1, status: 1, certificationStatus: 2 },
      { id: '21', userId: 2, status: 1, certificationStatus: 2 }] }), projections);
  assert.equal(conflictingOwner.matchmakers.approved, 0);
  assert.equal(conflictingOwner.members.quality.ambiguousMatchmakers, 2);
});

test('bad periods and malformed snapshots are rejected, and projection failures remain failures', async () => {
  for (const days of [0, 1, 31, '30', null]) {
    await assert.rejects(buildCockpitMemberStatistics(input({ days })), /days must be/);
  }
  await assert.rejects(buildCockpitMemberStatistics(input({ now: null })), /now must be/);
  await assert.rejects(buildCockpitMemberStatistics(input({ users: {} })), /users must be/);
  const data = input({ users: [user(1)], profiles: [profile(1)] });
  await assert.rejects(buildCockpitMemberStatistics(data), /projections are required/);
  await assert.rejects(buildCockpitMemberStatistics(data, { ...projections,
    getEntitlement() { throw new Error('upstream entitlement unavailable'); } }), /upstream entitlement unavailable/);
});
