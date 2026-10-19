const test = require('node:test');
const assert = require('node:assert/strict');
const { createVipMembershipService, VIP_COLLECTIONS: C, DEFAULT_MEMBERSHIP_PLANS, RETIRED_MATCHMAKING_PLAN_CODES } = require('../cloudfunctions/hlApi/vip-membership-service');

const start = '2026-10-12T00:00:00.000Z';
const fullProfile = { realName: '测试会员', gender: 1, age: 30, height: 175, city: '杭州', nativePlace: '浙江',
  education: '本科', occupation: '职员', incomeRange: '10k', maritalStatus: '未婚', houseStatus: '有房',
  carStatus: '有车', selfIntro: '喜欢旅行', partnerRequirement: '诚恳', photos: ['fixture-photo'], updatedAt: start };
function fixture(options = {}) {
  const rows = {
    hl_users: [1, 2, 3, 4].map(id => ({ _id: `user_${id}`, id, status: 1, nickname: `测试${id}`, gender: 1 })),
    hl_members: [{ _id: 'member_11', id: 11, userId: 1, matchmakerId: 21, status: 1,
      memberType: 'free', expireAt: null }, { _id: 'member_12', id: 12, userId: 2, matchmakerId: 21,
      status: 1, memberType: 'free', expireAt: null }],
    hl_profiles: [1, 2, 3].map(id => ({ _id: `profile_${id}`, id, userId: id, ...fullProfile, displayEnabled: true })),
    hl_matchmakers: [{ _id: 'matchmaker_21', id: 21, userId: 4, status: 1, certificationStatus: 2 }],
    ...(options.rows || {})
  };
  let time = start, tail = Promise.resolve(), transactionAttempts = 0;
  const writeFailures = new Map();
  const hidden = new Set(), contacts = new Set();
  const matches = (row, query) => !query || Object.entries(query).every(([field, value]) => row[field] === value);
  const getAll = async (name, query = null, maxRows = 1000) => structuredClone((rows[name] || []).filter(row => matches(row, query)).slice(0, maxRows));
  const getOne = async (name, query) => (await getAll(name, query, 1))[0] || null;
  const getById = (name, id) => getOne(name, { id: Number(id) });
  const doc = (name, id) => ({
    async get() {
      if (options.readError && name === C.vipEntitlements) throw Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' });
      if (options.vipReadError && name === C.vipEntitlements) throw options.vipReadError;
      const row = (rows[name] || []).find(row => row._id === id);
      if (!row) {
        if (options.sdkMissingDocument) {
          const errMsg = `document.get:fail document with _id ${id} does not exist`;
          throw Object.assign(new Error(errMsg), { errMsg });
        }
        throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
      }
      return { data: structuredClone(row) };
    },
    async set({ data }) {
      assert.equal('_id' in data, false);
      const failure = writeFailures.get(name);
      if (failure && failure.remaining > 0) { failure.remaining -= 1; throw failure.error; }
      if (options.failConnection && name === 'hl_conversations') throw new Error('connection write failed');
      const list = rows[name] ||= [];
      const index = list.findIndex(row => row._id === id);
      const saved = { ...structuredClone(data), _id: id };
      if (index < 0) list.push(saved); else list[index] = saved;
    }
  });
  const db = {
    collection: name => ({ doc: id => doc(name, String(id)) }),
    runTransaction(callback) {
      const run = tail.then(async () => {
        // Match the installed CloudBase SDK contract: only the symbolic
        // transaction-conflict code retries, with three retries by default.
        for (let remaining = 3; ; remaining -= 1) {
          transactionAttempts += 1;
          const saved = structuredClone(rows);
          try { return await callback({ collection: name => ({ doc: id => doc(name, String(id)) }) }); }
          catch (error) {
            for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved);
            if (error?.code !== 'DATABASE_TRANSACTION_CONFLICT' || remaining === 0) throw error;
          }
        }
      });
      tail = run.catch(() => {});
      return run;
    }
  };
  const pair = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join('_');
  const deps = {
    db, getAll, getOne, getById, now: () => time,
    async assertPublicTarget(a, b) {
      if (hidden.has(pair(a, b))) throw Object.assign(new Error('hidden'), { status: 403, code: 40304 });
      const profile = await getOne('hl_profiles', { userId: Number(b) });
      if (!profile || !profile.displayEnabled) throw Object.assign(new Error('withdrawn'), { status: 404, code: 40400 });
      return profile;
    },
    async assertMatchmaker(actorId, ownerId) {
      const member = await getOne('hl_members', { userId: Number(ownerId), status: 1 });
      const mm = member && await getById('hl_matchmakers', member.matchmakerId);
      if (!mm || Number(mm.userId) !== Number(actorId) || mm.status !== 1 || mm.certificationStatus !== 2) {
        throw Object.assign(new Error('not serving matchmaker'), { status: 403, code: 40304 });
      }
      return mm;
    },
    canContact: async (a, b) => contacts.has(pair(a, b)) || !!(await getAll('hl_match_records')).find(row => pair(row.userAId, row.userBId) === pair(a, b)),
    hasFormalPair: async (a, b) => !!(await getAll('hl_match_records')).find(row => pair(row.userAId, row.userBId) === pair(a, b)),
    async connectPair({ userAId, userBId, requestId, transaction }) {
      const key = `connected_${requestId}`;
      await transaction.collection('hl_match_records').doc(key).set({ data: { id: 500, userAId, userBId, requestId } });
      await transaction.collection('hl_conversations').doc(key).set({ data: { id: 600, userAId, userBId, requestId } });
      return { matchRecordId: 500, conversationId: 600 };
    },
    async notify({ senderId, receiverId, messageType, content, transaction }) {
      const key = `notification_${senderId}_${receiverId}_${String(time).slice(0, 10)}`;
      await transaction.collection('hl_messages').doc(key).set({ data: { senderId, receiverId, messageType, content } });
    },
    ...(options.dependencies || {})
  };
  const service = createVipMembershipService(deps);
  return { service, rows, db, hidden, contacts, setTime(value) { time = value; },
    transactionAttempts: () => transactionAttempts,
    failWrites(name, error, count = 1) { writeFailures.set(name, { error, remaining: count }); },
    call: (path, method = 'GET', data = {}, user = 1) => service.handleRoute(user, method, path, data),
    fulfill: (order, timestamp = time) => db.runTransaction(tx => service.fulfillOrder(tx, order, timestamp)),
    refund: (order, timestamp = time) => db.runTransaction(tx => service.refundOrder(tx, order, timestamp)) };
}
const vipOrder = (orderNo = 'VIP001', days = 30, user = 1) => ({ userId: user, outTradeNo: orderNo, productType: 'vip', durationDays: days,
  planCode: 'vip_month', planTitle: 'VIP月卡' });
const matchOrder = (orderNo = 'MATCH001', days = 30, count = 2) => ({ userId: 1, outTradeNo: orderNo,
  productType: 'matchmaking', durationDays: days, serviceCount: count, planTitle: '人工牵线套餐' });
async function ready(runtime) {
  return runtime.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 4);
}
async function request(runtime, targetUserId = 2) {
  return runtime.call('/member/matchmaking/requests', 'POST', { memberUserId: 1, targetUserId }, 4);
}
const respond = (runtime, row, actor, accepted = true) => runtime.call(`/member/matchmaking/requests/${row.id}/respond`, 'POST', { accepted }, actor);

test('six default plans carry current prices and remain inactive until configured', () => {
  assert.deepEqual(DEFAULT_MEMBERSHIP_PLANS.map(plan => plan.amountFen), [6160, 19800, 39800, 69800, 298000, 698000]);
  assert.deepEqual(DEFAULT_MEMBERSHIP_PLANS.map(plan => plan.durationDays), [7, 30, 90, 365, 30, 30]);
  assert.deepEqual(DEFAULT_MEMBERSHIP_PLANS.filter(plan => plan.productType === 'matchmaking').map(plan => [plan.planCode, plan.serviceCount]),
    [['matchmaking_double', 2], ['matchmaking_month_6', 6]]);
  assert.deepEqual(DEFAULT_MEMBERSHIP_PLANS.filter(plan => plan.productType === 'matchmaking').map(plan => plan.title),
    ['人工牵线2次', '人工牵线1个月']);
  assert.deepEqual(RETIRED_MATCHMAKING_PLAN_CODES,
    ['matchmaking_month', 'matchmaking_quarter', 'matchmaking_halfyear', 'matchmaking_single', 'matchmaking_month_3']);
  assert.ok(DEFAULT_MEMBERSHIP_PLANS.every(plan => !plan.active));
  assert.equal(C.entitlements, 'hl_vip_entitlements');
});

test('new two and six credit packages preserve paid single and three credit package snapshots', async () => {
  for (const [planCode, planTitle, serviceCount, replacementCode] of [
    ['matchmaking_single', '人工牵线单次', 1, 'matchmaking_double'],
    ['matchmaking_month_3', '人工牵线1个月', 3, 'matchmaking_month_6']
  ]) {
    const r = fixture();
    const historicalOrder = { ...matchOrder('MATCH_HISTORICAL', 30, serviceCount), planCode, planTitle };
    const originalOrder = structuredClone(historicalOrder);
    await r.fulfill(historicalOrder);
    const originalPackage = structuredClone(r.rows[C.matchmakingPackages].find(row => row.orderNo === historicalOrder.outTradeNo));
    const replacementPlan = DEFAULT_MEMBERSHIP_PLANS.find(plan => plan.planCode === replacementCode);
    const replacementOrder = { ...matchOrder('MATCH_CURRENT', replacementPlan.durationDays, replacementPlan.serviceCount),
      planCode: replacementPlan.planCode, planTitle: replacementPlan.title };
    const replacement = await r.fulfill(replacementOrder);
    assert.equal(replacement.package.totalCount, replacementPlan.serviceCount);
    assert.equal(replacement.package.planTitle, replacementPlan.title);
    const overview = await r.service.packages(1);
    assert.equal(overview.list.find(row => row.id === originalPackage.id).totalCount, serviceCount);
    assert.equal((await r.fulfill(historicalOrder)).idempotent, true);
    assert.deepEqual(r.rows[C.matchmakingPackages].find(row => row.orderNo === historicalOrder.outTradeNo), originalPackage);
    assert.deepEqual(historicalOrder, originalOrder);
  }
});

test('legacy paid and vip map to unified VIP, using Shanghai end of day for date-only expiry', async () => {
  for (const memberType of ['paid', 'vip']) {
    const r = fixture();
    Object.assign(r.rows.hl_members[0], { memberType, expireAt: '2026-10-12' });
    r.setTime('2026-10-12T15:59:59.999Z');
    const entitlement = await r.service.getEntitlement(1);
    assert.equal(entitlement.membershipTier, 'vip');
    assert.equal(entitlement.expireAt, '2026-10-12T16:00:00.000Z');
    assert.ok(Object.values(entitlement.entitlements).every(Boolean));
    r.setTime('2026-10-12T16:00:00.000Z');
    assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  }
});

test('independent expired or revoked record cannot fall back to legacy rights', async () => {
  const r = fixture({ rows: { [C.vipEntitlements]: [{ _id: 'vip_user_1', userId: 1, legacyLifetime: false,
    legacyExpireAt: null, grants: [{ orderNo: 'OLD', durationDays: 1, grantedAt: '2026-09-01T00:00:00Z', status: 'active' }] }] } });
  r.rows.hl_members[0].memberType = 'vip';
  const entitlement = await r.service.getEntitlement(1);
  assert.equal(entitlement.isPremiumMember, false);
  assert.equal(entitlement.source, 'vip');
});

test('explicit preservation keeps old rights across later dossier edits or assignment removal', async () => {
  const r = fixture();
  Object.assign(r.rows.hl_members[0], { memberType: 'paid', expireAt: '2026-11-12' });
  assert.equal((await r.service.preserveLegacyEntitlement(1)).preserved, true);
  r.rows.hl_members[0].memberType = 'free';
  r.rows.hl_members[0].expireAt = null;
  r.rows.hl_members[0].status = 0;
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
  assert.equal((await r.service.getEntitlement(1)).expireAt, '2026-11-12T16:00:00.000Z');
  assert.equal((await r.service.preserveLegacyEntitlement(1)).existing, true);
  const free = fixture();
  assert.equal((await free.service.preserveLegacyEntitlement(1)).preserved, false);
  assert.equal((free.rows[C.vipEntitlements] || []).length, 0);
});

test('VIP fulfillment stacks time exactly once even for concurrent duplicate callbacks', async () => {
  const r = fixture();
  await Promise.all([r.fulfill(vipOrder()), r.fulfill(vipOrder()), r.fulfill(vipOrder('VIP002', 7))]);
  assert.equal((await r.service.getEntitlement(1)).expireAt, '2026-11-18T00:00:00.000Z');
  assert.equal(r.rows[C.vipEntitlements][0].grants.length, 2);
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.rows.hl_members[0].expireAt, null);
});

test('VIP refund retains elapsed service and all unused time belonging to other orders', async () => {
  const r = fixture();
  await r.fulfill(vipOrder('A', 30));
  await r.fulfill(vipOrder('B', 30));
  r.setTime('2026-10-22T00:00:00.000Z');
  await r.refund(vipOrder('A', 30));
  assert.equal((await r.service.getEntitlement(1)).expireAt, '2026-11-21T00:00:00.000Z');
  await r.refund(vipOrder('A', 30));
  assert.equal((await r.service.getEntitlement(1)).expireAt, '2026-11-21T00:00:00.000Z');
  await r.refund(vipOrder('B', 30));
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
});

test('refunding VIP preserves historical permanent membership baseline', async () => {
  const r = fixture();
  r.rows.hl_members[0].memberType = 'paid';
  await r.fulfill(vipOrder());
  await r.refund(vipOrder());
  assert.equal((await r.service.getEntitlement(1)).lifetime, true);
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
});

test('database permission errors fail closed and inactive users receive no rights', async () => {
  const r = fixture({ readError: true });
  r.rows.hl_members[0].memberType = 'vip';
  await assert.rejects(r.service.getEntitlement(1), /permission denied/);
  const stopped = fixture();
  stopped.rows.hl_users[0].status = 0;
  await assert.rejects(stopped.service.getEntitlement(1), error => error.status === 403);
});

test('real SDK missing-document errMsg without a missing-document code preserves free defaults and legacy VIP reads', async () => {
  const r = fixture({ sdkMissingDocument: true });
  const free = await r.service.overview(1);
  assert.equal(free.membershipTier, 'free');
  assert.equal(free.isPremiumMember, false);
  assert.equal(free.privacy.invisible, false);
  assert.deepEqual(free.matchmakingPackages, []);
  assert.equal(free.matchmakingReadiness.matchmakerConfirmed, false);
  r.rows.hl_members[0].memberType = 'paid';
  r.rows.hl_members[0].expireAt = '2026-11-12T00:00:00.000Z';
  const legacy = await r.service.overview(1);
  assert.equal(legacy.membershipTier, 'vip');
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.expireAt, '2026-11-12T00:00:00.000Z');
  assert.equal((r.rows[C.vipEntitlements] || []).length, 0);
});

test('permission database and transport failures never become a missing document or a legacy VIP fallback', async () => {
  const missingText = 'document.get:fail document with _id vip_user_1 does not exist';
  const errors = [
    Object.assign(new Error(missingText), { errCode: 'PERMISSION_DENIED', errMsg: missingText }),
    Object.assign(new Error(missingText), { errCode: 'DATABASE_ERROR', errMsg: missingText }),
    Object.assign(new Error(missingText), { code: 'ECONNRESET', errMsg: missingText }),
    Object.assign(new Error(missingText), { errCode: -1, code: 'DATABASE_REQUEST_FAILED', errMsg: missingText }),
    Object.assign(new Error('document.get:fail network request timed out'), { errMsg: 'document.get:fail network request timed out' }),
    Object.assign(new Error('collection vip_user_1 does not exist'), { errMsg: 'collection vip_user_1 does not exist' }),
    Object.assign(new Error('resource not found'), { errMsg: 'resource not found' })
  ];
  for (const expected of errors) {
    const r = fixture({ vipReadError: expected });
    r.rows.hl_members[0].memberType = 'paid';
    await assert.rejects(r.service.getEntitlement(1), actual => actual === expected);
  }
});

test('matchmaking requires complete profile and current certified matchmaker confirmation', async () => {
  const r = fixture();
  await assert.rejects(r.service.assertMatchmakingReady(1), /确认/);
  await assert.rejects(r.call('/member/matchmaking/readiness', 'POST', { memberUserId: 1, confirmed: true }, 3), error => error.status === 403);
  assert.equal((await ready(r)).ready, true);
  assert.equal((await r.service.assertMatchmakingReady(1)).ready, true);
  r.rows.hl_profiles[0].updatedAt = 'changed';
  assert.equal((await r.service.getMatchmakingReadiness(1)).ready, false);
  await ready(r);
  r.rows.hl_matchmakers[0].certificationStatus = 0;
  assert.equal((await r.service.getMatchmakingReadiness(1)).ready, false);
  r.rows.hl_profiles[0].photos = [];
  assert.equal((await r.service.getMatchmakingReadiness(1)).profileComplete, false);
});

test('profile completion dependency accepts the existing numeric percent helper', async () => {
  const r = fixture({ dependencies: { getProfileCompletion: () => 100 } });
  assert.equal((await ready(r)).ready, true);
});

test('artificial service remains separate from VIP and grants independent packages exactly once', async () => {
  const r = fixture();
  await Promise.all([r.fulfill(matchOrder()), r.fulfill(matchOrder())]);
  const overview = await r.service.overview(1);
  assert.equal(overview.isPremiumMember, false);
  assert.equal(overview.matchmakingPackages.length, 1);
  assert.equal(overview.matchmakingPackages[0].remainingCount, 2);
});

test('artificial service cannot gain VIP from a later legacy paid dossier label', async () => {
  const r = fixture();
  await r.fulfill(matchOrder());
  Object.assign(r.rows.hl_members[0], { memberType: 'paid', expireAt: '2099-01-01' });
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  await r.fulfill(vipOrder());
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
});

test('new dossier protection freezes empty baseline while preserving existing legacy paid rights', async () => {
  const r = fixture();
  await r.service.ensureIndependentEntitlement(1);
  Object.assign(r.rows.hl_members[0], { memberType: 'paid', expireAt: '2099-01-01' });
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, false);
  const historical = fixture();
  Object.assign(historical.rows.hl_members[0], { memberType: 'vip', expireAt: null });
  await historical.service.ensureIndependentEntitlement(1);
  historical.rows.hl_members[0].memberType = 'no_consumption';
  assert.equal((await historical.service.getEntitlement(1)).lifetime, true);
});

test('member self-request requires approval by the current assigned matchmaker before either consent can connect', async () => {
  const r = fixture();
  await ready(r); await r.fulfill(matchOrder());
  const row = await r.call('/member/matchmaking/requests', 'POST', { targetUserId: 2 });
  assert.equal(row.serviceConfirmed, false);
  await assert.rejects(respond(r, row, 1), /审核/);
  await assert.rejects(r.call(`/member/matchmaking/requests/${row.id}/approve`, 'POST', {}, 3), error => error.status === 404);
  assert.equal((await r.call('/member/matchmaking/requests', 'GET', {}, 4)).total, 1);
  const approved = await r.call(`/member/matchmaking/requests/${row.id}/approve`, 'POST', {}, 4);
  assert.equal(approved.serviceConfirmed, true);
  await respond(r, row, 1); await respond(r, row, 2);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 1);
});

test('former matchmaker cannot view or approve a request after assignment changes', async () => {
  const r = fixture();
  await ready(r); await r.fulfill(matchOrder());
  const row = await r.call('/member/matchmaking/requests', 'POST', { targetUserId: 2 });
  r.rows.hl_members[0].matchmakerId = 99;
  assert.equal((await r.call('/member/matchmaking/requests', 'GET', {}, 4)).total, 0);
  await assert.rejects(r.call(`/member/matchmaking/requests/${row.id}/approve`, 'POST', {}, 4), error => error.status === 403);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
});

test('both people must consent before connection; earliest expiring package loses exactly one credit', async () => {
  const r = fixture();
  await ready(r);
  await r.fulfill(matchOrder('LONG', 90, 8));
  await r.fulfill(matchOrder('SHORT', 30, 2));
  const row = await request(r);
  assert.equal((await respond(r, row, 1)).status, 'pending');
  assert.equal((r.rows.hl_match_records || []).length, 0);
  const outcomes = await Promise.all([respond(r, row, 2), respond(r, row, 2), respond(r, row, 1)]);
  assert.ok(outcomes.every(result => result.status === 'connected'));
  assert.equal(r.rows.hl_match_records.length, 1);
  const packages = await r.service.packages(1);
  assert.deepEqual(packages.list.map(item => item.usedCount), [1, 0]);
  assert.equal((await request(r)).id, row.id);
});

test('simultaneous different matches cannot overspend the final remaining service credit', async () => {
  const r = fixture();
  await ready(r);
  await r.fulfill(matchOrder('ONE', 30, 1));
  const first = await request(r, 2), second = await request(r, 3);
  await respond(r, first, 1);
  await respond(r, second, 1);
  const results = await Promise.allSettled([respond(r, first, 2), respond(r, second, 3)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await r.service.packages(1)).list[0].remainingCount, 0);
  assert.equal(r.rows.hl_match_records.length, 1);
});

test('failure to build a conversation rolls back both consent completion and package debit', async () => {
  const r = fixture({ failConnection: true });
  await ready(r);
  await r.fulfill(matchOrder());
  const row = await request(r);
  await respond(r, row, 1);
  await assert.rejects(respond(r, row, 2), /connection write failed/);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
  assert.equal((r.rows.hl_match_records || []).length, 0);
  assert.equal(r.rows[C.matchmakingRequests].find(item => item.id === row.id).targetConsent, false);
});

test('final mutual acceptance rechecks profile completeness and current readiness without consuming credits', async () => {
  for (const mutate of [r => { r.rows.hl_profiles[0].updatedAt = 'updated-after-approval'; },
    r => { r.rows.hl_profiles[0].partnerRequirement = ''; }]) {
    const r = fixture();
    await ready(r); await r.fulfill(matchOrder());
    const row = await request(r);
    await respond(r, row, 1);
    mutate(r);
    await assert.rejects(respond(r, row, 2), /完善档案/);
    assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
    assert.equal((r.rows.hl_match_records || []).length, 0);
    assert.equal(r.rows[C.matchmakingRequests].find(item => item.id === row.id).targetConsent, false);
  }
});

test('an existing formal connection created while a request is pending prevents a second credit debit', async () => {
  const r = fixture();
  await ready(r); await r.fulfill(matchOrder());
  const row = await request(r);
  await respond(r, row, 1);
  r.rows.hl_match_records = [{ _id: 'existing_formal_pair', id: 8, userAId: 1, userBId: 2 }];
  await assert.rejects(respond(r, row, 2), /已建立联系/);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
  assert.equal(r.rows.hl_match_records.length, 1);
});

test('a participant can reject or cancel a pending request after readiness or visibility changes', async () => {
  const r = fixture();
  await ready(r); await r.fulfill(matchOrder());
  const row = await request(r);
  r.rows.hl_profiles[0].partnerRequirement = '';
  r.hidden.add('1_2');
  assert.equal((await respond(r, row, 2, false)).status, 'rejected');
  const cancelRuntime = fixture();
  await ready(cancelRuntime); await cancelRuntime.fulfill(matchOrder());
  const pending = await request(cancelRuntime);
  cancelRuntime.rows.hl_profiles[0].partnerRequirement = '';
  cancelRuntime.hidden.add('1_2');
  assert.equal((await cancelRuntime.call(`/member/matchmaking/requests/${pending.id}/cancel`, 'POST', {}, 1)).status, 'cancelled');
  assert.equal((await cancelRuntime.service.packages(1)).list[0].usedCount, 0);
});

test('rejection, cancellation, hidden users, expiry, and existing formal pairs never debit', async () => {
  const r = fixture();
  await ready(r);
  await r.fulfill(matchOrder());
  const first = await request(r);
  await respond(r, first, 2, false);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
  const second = await request(r);
  await r.call(`/member/matchmaking/requests/${second.id}/cancel`, 'POST', {}, 4);
  assert.equal((await respond(r, second, 1)).status, 'cancelled');
  r.hidden.add('1_2');
  await assert.rejects(request(r), error => error.status === 403);
  r.hidden.clear();
  r.rows.hl_match_records = [{ userAId: 1, userBId: 2, id: 5 }];
  await assert.rejects(request(r), /已建立联系/);
  r.rows.hl_match_records = [];
  r.setTime('2026-11-12T00:00:00.000Z');
  await assert.rejects(request(r), /到期/);
  await assert.rejects(respond(r, first, 3), error => error.status === 404);
});

test('matchmaking refund removes unused credits only and leaves completed connection and other package intact', async () => {
  const r = fixture();
  await ready(r);
  await r.fulfill(matchOrder('FIRST', 30, 2));
  await r.fulfill(matchOrder('SECOND', 90, 8));
  const row = await request(r);
  await respond(r, row, 1); await respond(r, row, 2);
  const refund = await r.refund(matchOrder('FIRST', 30, 2));
  assert.equal(refund.package.usedCount, 1);
  assert.equal(refund.package.remainingCount, 0);
  assert.equal(refund.package.status, 'refunded');
  assert.equal((await r.service.packages(1)).list[1].remainingCount, 8);
  assert.equal(r.rows.hl_conversations.length, 1);
  assert.equal((await r.refund(matchOrder('FIRST', 30, 2))).idempotent, true);
});

test('微信号 remains undisclosed until recipient consent and is accessible only to current pair', async () => {
  const r = fixture();
  await r.fulfill(vipOrder());
  await assert.rejects(r.call('/member/vip/wechat-exchanges', 'POST', { targetUserId: 2, wechatId: 'fixture_one' }), /互相喜欢/);
  r.contacts.add('1_2');
  const created = await r.call('/member/vip/wechat-exchanges', 'POST', { targetUserId: 2, wechatId: 'fixture_one' });
  assert.equal('wechat' in created, false);
  const pending = await r.call(`/member/vip/wechat-exchanges/${created.id}`, 'GET', {}, 2);
  assert.equal(JSON.stringify(pending).includes('fixture_one'), false);
  await assert.rejects(r.call(`/member/vip/wechat-exchanges/${created.id}`, 'GET', {}, 3), error => error.status === 404);
  const accepted = await r.call(`/member/vip/wechat-exchanges/${created.id}/respond`, 'POST', { accepted: true, wechatId: 'fixture_two' }, 2);
  assert.deepEqual(accepted.wechat, { mine: 'fixture_two', peer: 'fixture_one' });
  assert.deepEqual((await r.call(`/member/vip/wechat-exchanges/${created.id}`)).wechat, { mine: 'fixture_one', peer: 'fixture_two' });
  r.hidden.add('1_2');
  await assert.rejects(r.call(`/member/vip/wechat-exchanges/${created.id}`), error => error.status === 403);
  assert.equal((await r.call('/member/vip/wechat-exchanges')).total, 0);
});

test('non-VIP cannot initiate exchanges or activate invisible visiting and reminder subscriptions', async () => {
  const r = fixture();
  for (const [path, body] of [
    ['/member/vip/wechat-exchanges', { targetUserId: 2, wechatId: 'fixture_one' }],
    ['/member/vip/privacy', { invisible: true }],
    ['/member/vip/online-subscriptions', { targetUserId: 2, active: true }]
  ]) await assert.rejects(r.call(path, 'POST', body), error => error.status === 403);
  await assert.rejects(r.call('/member/vip/visitors'), error => error.status === 403);
});

test('invisible visits create no trace; expired invisible entitlement cannot hide new visits', async () => {
  const r = fixture();
  await r.fulfill(vipOrder('ONE', 1));
  await r.fulfill(vipOrder('TWO', 30, 2));
  await r.call('/member/vip/privacy', 'POST', { invisible: true });
  assert.deepEqual(await r.service.recordVisit(1, 2), { recorded: false });
  assert.equal((r.rows[C.memberVisits] || []).length, 0);
  assert.equal((await r.call('/member/vip/visitors', 'GET', {}, 2)).total, 0);
  r.setTime('2026-10-13T00:00:00.000Z');
  await r.service.recordVisit(1, 2);
  const visitors = await r.call('/member/vip/visitors', 'GET', {}, 2);
  assert.equal(visitors.total, 1);
  assert.equal(visitors.list[0].visitorUserId, 1);
  assert.equal('invisible' in visitors.list[0], false);
  assert.equal('wechatId' in visitors.list[0], false);
});

test('visits deduplicate per viewer per Shanghai day and withdrawn visitor disappears', async () => {
  const r = fixture();
  await r.fulfill(vipOrder());
  await r.service.recordVisit(2, 1); await r.service.recordVisit(2, 1);
  assert.equal((await r.call('/member/vip/visitors')).total, 1);
  r.rows.hl_profiles[1].displayEnabled = false;
  assert.equal((await r.call('/member/vip/visitors')).total, 0);
});

test('上线 reminders use in-app messages once per pair per day and stop after VIP expiry or unsubscribe', async () => {
  const r = fixture();
  await r.fulfill(vipOrder('ONE', 2));
  r.contacts.add('1_2');
  await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  await Promise.all([r.service.touchPresence(2), r.service.touchPresence(2)]);
  assert.equal(r.rows.hl_messages.length, 1);
  assert.equal(r.rows.hl_messages[0].messageType, 'online_reminder');
  r.setTime('2026-10-12T00:10:00.000Z');
  await r.service.touchPresence(2);
  assert.equal(r.rows.hl_messages.length, 1);
  r.setTime('2026-10-13T00:10:00.000Z');
  await r.service.touchPresence(2);
  assert.equal(r.rows.hl_messages.length, 2);
  r.setTime('2026-10-14T00:10:00.000Z');
  await r.service.touchPresence(2);
  assert.equal(r.rows.hl_messages.length, 2);
  await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: false });
  assert.equal((await r.call('/member/vip/online-subscriptions')).total, 0);
});

test('stopped target and blocked pairs cannot generate online notifications', async () => {
  const r = fixture();
  await r.fulfill(vipOrder());
  r.contacts.add('1_2');
  await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  r.hidden.add('1_2');
  await r.service.touchPresence(2);
  assert.equal((r.rows.hl_messages || []).length, 0);
  r.rows.hl_users[1].status = 0;
  await assert.rejects(r.service.touchPresence(2), error => error.status === 403);
});

test('reminder activation rechecks contact eligibility inside the transaction before saving', async () => {
  let contactChecks = 0;
  const r = fixture({ dependencies: { canContact: async (_actor, _target, transaction) => {
    contactChecks += 1;
    return !transaction;
  } } });
  await r.fulfill(vipOrder());
  await assert.rejects(r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true }), error => error.code === 40300);
  assert.equal(contactChecks, 2);
  assert.equal((r.rows[C.onlineSubscriptions] || []).length, 0);
});

test('withdrawn contacts receive no reminder and expired VIP can still cancel their subscription', async () => {
  const r = fixture();
  await r.fulfill(vipOrder('ONE', 1));
  r.contacts.add('1_2');
  await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  r.contacts.delete('1_2');
  await r.service.touchPresence(2);
  assert.equal((r.rows.hl_messages || []).length, 0);
  r.setTime('2026-10-13T00:00:00.000Z');
  assert.equal((await r.service.getEntitlement(1)).active, false);
  assert.deepEqual(await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: false }), { targetUserId: 2, active: false });
  assert.equal((await r.call('/member/vip/online-subscriptions')).total, 0);
});

const wrappedTransactionConflict = () => Object.assign(new Error('document.set:fail -501001 SYS_ERR. [ResourceUnavailable.TransactionConflict] Transaction is conflict'), {
  errCode: -501001, errMsg: 'document.set:fail -501001 SYS_ERR. [ResourceUnavailable.TransactionConflict] Transaction is conflict'
});
async function subscribedFixture() {
  const r = fixture();
  await r.fulfill(vipOrder());
  r.contacts.add('1_2');
  await r.call('/member/vip/online-subscriptions', 'POST', { targetUserId: 2, active: true });
  return r;
}

test('real wx wrapped write conflict retries the transaction and commits one reminder only', async () => {
  const r = await subscribedFixture();
  const before = r.transactionAttempts();
  // Fail after the message write: rollback must discard that first reminder.
  r.failWrites(C.memberPresence, wrappedTransactionConflict());
  assert.deepEqual(await r.service.touchPresence(2), { online: true });
  assert.equal(r.transactionAttempts() - before, 2);
  assert.equal(r.rows.hl_messages.length, 1);
  assert.equal(r.rows[C.memberPresence].length, 1);
  await r.service.touchPresence(2);
  assert.equal(r.rows.hl_messages.length, 1);
});

test('raw CloudBase transaction conflict retains the existing bounded retry behavior', async () => {
  const r = await subscribedFixture();
  const before = r.transactionAttempts();
  r.failWrites(C.memberPresence, Object.assign(new Error('database transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' }));
  await r.service.touchPresence(2);
  assert.equal(r.transactionAttempts() - before, 2);
  assert.equal(r.rows.hl_messages.length, 1);
});

test('a wx wrapped final-consent conflict rolls back connection and debit then commits each exactly once', async () => {
  const r = fixture();
  await ready(r); await r.fulfill(matchOrder('RETRY_MATCH', 30, 2));
  const request = await r.call('/member/matchmaking/requests', 'POST', { memberUserId: 1, targetUserId: 2 }, 4);
  await r.call(`/member/matchmaking/requests/${request.id}/respond`, 'POST', { accepted: true }, 1);
  const before = r.transactionAttempts();
  // The final request save follows the connection and package debit.
  r.failWrites(C.matchmakingRequests, wrappedTransactionConflict());
  const connected = await r.call(`/member/matchmaking/requests/${request.id}/respond`, 'POST', { accepted: true }, 2);
  assert.equal(connected.status, 'connected');
  assert.equal(r.transactionAttempts() - before, 2);
  assert.equal(r.rows.hl_match_records.length, 1);
  assert.equal(r.rows.hl_conversations.length, 1);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 1);
  await r.call(`/member/matchmaking/requests/${request.id}/respond`, 'POST', { accepted: true }, 2);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 1);
});

test('wx transaction-conflict retries stop after the SDK default three retries without partial writes', async () => {
  const r = await subscribedFixture();
  const before = r.transactionAttempts();
  r.failWrites(C.memberPresence, wrappedTransactionConflict(), 10);
  await assert.rejects(r.service.touchPresence(2), error => error.code === 'DATABASE_TRANSACTION_CONFLICT');
  assert.equal(r.transactionAttempts() - before, 4);
  assert.equal((r.rows.hl_messages || []).length, 0);
  assert.equal((r.rows[C.memberPresence] || []).length, 0);
});

test('transaction expiry permission network and generic SDK errors remain original failures without retries', async () => {
  const errors = [
    Object.assign(new Error('document.set:fail [ResourceUnavailable.TransactionNotExist]'), { errCode: -501001 }),
    Object.assign(new Error('permission denied [ResourceUnavailable.TransactionConflict]'), { errCode: -502003 }),
    Object.assign(new Error('database request failed [ResourceUnavailable.TransactionConflict]'), { errCode: -502001 }),
    Object.assign(new Error('network request failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('network request timed out'), { errCode: -501001 }),
    Object.assign(new Error('transaction conflict without the authoritative marker'), { errCode: -501001 })
  ];
  for (const expected of errors) {
    const r = await subscribedFixture();
    const before = r.transactionAttempts();
    r.failWrites(C.memberPresence, expected, 10);
    await assert.rejects(r.service.touchPresence(2), actual => actual === expected);
    assert.equal(r.transactionAttempts() - before, 1);
    assert.equal((r.rows.hl_messages || []).length, 0);
  }
});

test('transaction diagnostics omit private SDK details and preserve the original failure without retrying', async t => {
  const r = await subscribedFixture();
  const privateDetails = 'user=openId_PRIVATE_791 contact=wechat_PRIVATE_483 transaction=tx_PRIVATE_629';
  const expected = Object.assign(new Error(`document.set:fail [ResourceUnavailable.TransactionNotExist] ${privateDetails}`), {
    errCode: -501001,
    errMsg: `DATABASE_REQUEST_FAILED ${privateDetails}`,
    name: `PrivateSdkError_${privateDetails}`,
    code: `PRIVATE_ERROR_CODE_${privateDetails}`,
    detail: { privateDetails }
  });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const before = r.transactionAttempts();
  r.failWrites(C.memberPresence, expected, 10);
  await assert.rejects(r.service.touchPresence(2), actual => actual === expected);
  assert.equal(r.transactionAttempts() - before, 1);
  assert.equal((r.rows.hl_messages || []).length, 0);
  assert.equal((r.rows[C.memberPresence] || []).length, 0);
  assert.deepEqual(warnings, ['callback', 'transaction'].map(phase => ['vip transaction failure', {
    phase, errCode: -501001, errorType: 'Error',
    markers: ['ResourceUnavailable.TransactionNotExist', 'DATABASE_REQUEST_FAILED'],
    providerCode: 'ResourceUnavailable.TransactionNotExist',
    transactionConflictText: false, transactionExpiredText: false, timeoutText: false
  }]));
  assert.equal(JSON.stringify(warnings).includes(privateDetails), false);
});

test('transaction diagnostics never emit private text shaped like an unknown provider error code', async t => {
  const r = await subscribedFixture();
  const expected = Object.assign(new Error('document.set:fail [InternalError.PrivateOpenid791] [ResourceUnavailable.PrivateWechat483]'), { errCode: -501001 });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  r.failWrites(C.memberPresence, expected);
  await assert.rejects(r.service.touchPresence(2), actual => actual === expected);
  assert.ok(warnings.length > 0);
  for (const [, diagnostic] of warnings) {
    assert.equal(Object.hasOwn(diagnostic, 'providerCode'), false);
    assert.deepEqual(diagnostic.markers, []);
  }
  assert.equal(JSON.stringify(warnings).includes('Private'), false);
});
