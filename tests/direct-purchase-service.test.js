const test = require('node:test');
const assert = require('node:assert/strict');
const { createVipMembershipService, VIP_COLLECTIONS: C } = require('../cloudfunctions/hlApi/vip-membership-service');
const { DIRECT_PURCHASE_CONTRACT } = require('../cloudfunctions/hlApi/purchase-contract-policy');

const paidAt = '2026-10-19T02:00:00.000Z';
function fixture() {
  const rows = {
    hl_users: [1, 2, 4].map(id => ({ _id: `user_${id}`, id, status: 1, nickname: `用户${id}` })),
    hl_profiles: [], hl_members: [],
    hl_matchmakers: [{ _id: 'matchmaker_21', id: 21, userId: 4, status: 1, certificationStatus: 2 }]
  };
  let time = paidAt, tail = Promise.resolve(), failedCollection = null;
  const getAll = async (name, query = {}) => structuredClone((rows[name] || [])
    .filter(row => Object.entries(query).every(([key, value]) => row[key] === value)));
  const getOne = async (name, query) => (await getAll(name, query))[0] || null;
  const getById = (name, id) => getOne(name, { id: Number(id) });
  const doc = (name, id) => ({
    async get() { return { data: structuredClone((rows[name] || []).find(row => row._id === id) || null) }; },
    async set({ data }) {
      if (failedCollection === name) { failedCollection = null; throw new Error('injected write failure'); }
      const list = rows[name] ||= [], index = list.findIndex(row => row._id === id);
      const next = { ...structuredClone(data), _id: id };
      if (index === -1) list.push(next); else list[index] = next;
    }
  });
  const db = { collection: name => ({ doc: id => doc(name, String(id)) }), runTransaction(callback) {
    const run = tail.then(async () => {
      const before = structuredClone(rows);
      try { return await callback(db); }
      catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, before); throw error; }
    });
    tail = run.catch(() => {}); return run;
  } };
  const service = createVipMembershipService({ db, getAll, getOne, getById, now: () => time,
    getProfileCompletion: (_user, profile) => profile.complete ? 100 : 0,
    async assertMatchmaker(actorId, ownerId) {
      const member = await getOne('hl_members', { userId: ownerId, status: 1 });
      const mm = member && await getById('hl_matchmakers', member.matchmakerId);
      if (!mm || mm.userId !== actorId || mm.status !== 1 || mm.certificationStatus !== 2) {
        throw Object.assign(new Error('not assigned'), { status: 403 });
      }
      return mm;
    } });
  return { rows, service, setTime(value) { time = value; }, failNextWrite(name) { failedCollection = name; },
    fulfill: (order, timestamp = time) => db.runTransaction(tx => service.fulfillOrder(tx, order, timestamp)),
    refund: (order, timestamp = time) => db.runTransaction(tx => service.refundOrder(tx, order, timestamp)),
    async confirm() { return service.handleRoute(4, 'POST', '/member/matchmaking/readiness', { memberUserId: 1, confirmed: true }); },
    completeProfile() { rows.hl_profiles = [{ _id: 'profile_1', id: 1, userId: 1, complete: true, updatedAt: paidAt }]; },
    assign() { rows.hl_members = [{ _id: 'member_11', id: 11, userId: 1, matchmakerId: 21, status: 1, memberType: 'free' }]; }
  };
}
const manualOrder = (outTradeNo = 'DIRECT_MANUAL', extra = {}) => ({ userId: 1, outTradeNo, productType: 'matchmaking',
  durationDays: 30, serviceCount: 2, planCode: 'matchmaking_double', planTitle: '人工牵线2次',
  fulfillmentContract: DIRECT_PURCHASE_CONTRACT, ...extra });
const vipOrder = () => ({ userId: 1, outTradeNo: 'DIRECT_VIP', productType: 'vip', durationDays: 30,
  planCode: 'vip_month', planTitle: 'VIP月卡', fulfillmentContract: DIRECT_PURCHASE_CONTRACT });

test('direct VIP payment grants user rights before a dossier or principal exists', async () => {
  const r = fixture();
  assert.equal((await r.fulfill(vipOrder())).isPremiumMember, true);
  assert.equal((await r.service.getEntitlement(1)).expireAt, '2026-11-18T02:00:00.000Z');
  assert.deepEqual(r.rows.hl_members, []);
  assert.deepEqual(r.rows.hl_profiles, []);
  assert.equal((r.rows[C.matchmakingReadiness] || []).length, 0);
  r.assign(); r.rows.hl_members[0].status = 0;
  assert.equal((await r.service.getEntitlement(1)).isPremiumMember, true);
  assert.equal((await r.fulfill(vipOrder())).idempotent, true);
});

test('direct manual payment atomically grants an owned package and an intake while readiness stays a service gate', async () => {
  const r = fixture();
  const result = await r.fulfill(manualOrder());
  assert.equal(result.package.remainingCount, 2);
  const stored = r.rows[C.matchmakingPackages].find(row => row.orderNo === 'DIRECT_MANUAL');
  assert.equal(stored.fulfillmentContract, DIRECT_PURCHASE_CONTRACT);
  assert.equal(stored.productType, 'matchmaking');
  assert.deepEqual(r.rows[C.matchmakingReadiness], [{ _id: 'intake_user_1', kind: 'service_intake', userId: 1,
    orderNos: ['DIRECT_MANUAL'], createdAt: paidAt, updatedAt: paidAt, requestedAt: paidAt }]);
  assert.deepEqual(r.rows.hl_members, []);
  const overview = await r.service.overview(1);
  assert.equal(overview.isPremiumMember, false);
  assert.equal(overview.matchmakingProgress.status, 'needs_profile');
  assert.equal(overview.matchmakingProgress.purchased, true);
  assert.equal(overview.matchmakingReadiness.ready, false);
  await assert.rejects(r.service.handleRoute(1, 'POST', '/member/matchmaking/requests', { targetUserId: 2 }), /完善档案/);
  assert.equal((await r.service.packages(1)).list[0].usedCount, 0);
});

test('duplicate payment callbacks and later purchases keep one intake and its first confirmed timestamp', async () => {
  const r = fixture();
  const first = manualOrder();
  const firstInput = structuredClone(first);
  await Promise.all([r.fulfill(first), r.fulfill(first)]);
  const stored = structuredClone(r.rows[C.matchmakingPackages].find(row => row.orderNo === first.outTradeNo));
  r.setTime('2026-10-20T02:00:00.000Z');
  await r.fulfill(first);
  assert.deepEqual(r.rows[C.matchmakingPackages].find(row => row.orderNo === first.outTradeNo), stored);
  await r.fulfill(manualOrder('DIRECT_SECOND'));
  assert.equal(r.rows[C.matchmakingReadiness].length, 1);
  assert.deepEqual(r.rows[C.matchmakingReadiness][0].orderNos, ['DIRECT_MANUAL', 'DIRECT_SECOND']);
  assert.equal(r.rows[C.matchmakingReadiness][0].requestedAt, paidAt);
  assert.equal(r.rows[C.matchmakingReadiness][0].createdAt, paidAt);
  assert.equal((await r.service.getMatchmakingProgress(1)).remainingCount, 4);
  assert.deepEqual(first, firstInput);
});

test('intake storage failure rolls back the package, package index and frozen baseline together', async () => {
  const r = fixture();
  r.failNextWrite(C.matchmakingReadiness);
  await assert.rejects(r.fulfill(manualOrder()), /injected write failure/);
  assert.equal((r.rows[C.matchmakingPackages] || []).length, 0);
  assert.equal((r.rows[C.vipEntitlements] || []).length, 0);
  assert.equal((r.rows[C.matchmakingReadiness] || []).length, 0);
  assert.equal((await r.fulfill(manualOrder())).package.remainingCount, 2);
});

test('historical packages keep their original snapshots and never acquire a new intake through replay', async () => {
  const r = fixture();
  const historical = manualOrder('HISTORICAL_ONE', { fulfillmentContract: undefined, serviceCount: 1,
    planCode: 'matchmaking_single', planTitle: '历史人工牵线单次' });
  await r.fulfill(historical);
  const stored = structuredClone(r.rows[C.matchmakingPackages]);
  assert.equal((r.rows[C.matchmakingReadiness] || []).length, 0);
  await r.fulfill({ ...historical, fulfillmentContract: DIRECT_PURCHASE_CONTRACT });
  assert.deepEqual(r.rows[C.matchmakingPackages], stored);
  assert.equal((r.rows[C.matchmakingReadiness] || []).length, 0);
  assert.equal((await r.service.getMatchmakingProgress(1)).remainingCount, 1);
});

test('progress reflects profile, principal and current service confirmation without modifying purchased rights', async () => {
  const r = fixture();
  assert.deepEqual(await r.service.getMatchmakingProgress(1), { status: 'not_purchased', purchased: false,
    profileComplete: false, assigned: false, matchmakerConfirmed: false, matchmakerId: null,
    matchmakerUserId: null, matchmakerName: '', requestedAt: null, remainingCount: 0, earliestExpireAt: null });
  await r.fulfill(manualOrder());
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'needs_profile');
  r.completeProfile();
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'awaiting_assignment');
  r.assign();
  const awaiting = await r.service.getMatchmakingProgress(1);
  assert.equal(awaiting.status, 'awaiting_contact');
  assert.equal(awaiting.matchmakerId, 21);
  assert.equal(awaiting.matchmakerUserId, 4);
  assert.equal(awaiting.matchmakerName, '用户4');
  const packagesBefore = structuredClone(r.rows[C.matchmakingPackages]);
  await r.confirm();
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'ready');
  assert.equal((await r.service.assertMatchmakingReady(1)).ready, true);
  r.rows.hl_profiles[0].updatedAt = '2026-10-20T03:00:00.000Z';
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'awaiting_contact');
  r.rows.hl_members[0].status = 0;
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'awaiting_assignment');
  assert.deepEqual(r.rows[C.matchmakingPackages], packagesBefore);
  assert.equal((await r.service.getMatchmakingProgress(1)).remainingCount, 2);
});

test('inactive or uncertified principals do not become a valid assignment in progress', async () => {
  for (const disable of [r => { r.rows.hl_matchmakers[0].certificationStatus = 0; },
    r => { r.rows.hl_matchmakers[0].status = 0; }, r => { r.rows.hl_users.find(row => row.id === 4).status = 0; }]) {
    const r = fixture(); r.completeProfile(); r.assign(); await r.fulfill(manualOrder()); await r.confirm();
    disable(r);
    const result = await r.service.getMatchmakingProgress(1);
    assert.equal(result.status, 'awaiting_assignment');
    assert.equal(result.assigned, false);
    assert.equal(result.matchmakerConfirmed, false);
    assert.equal(result.matchmakerId, null);
    assert.equal(result.matchmakerUserId, null);
    assert.equal(result.matchmakerName, '');
    assert.equal(result.remainingCount, 2);
  }
});

test('progress counts usable credits and reports exhausted, expired and refunded packages without rewriting them', async () => {
  const r = fixture();
  await r.fulfill(manualOrder('EXHAUSTED'));
  const exhausted = r.rows[C.matchmakingPackages].find(row => row.orderNo === 'EXHAUSTED');
  exhausted.usedCount = 2;
  let before = structuredClone(r.rows[C.matchmakingPackages]);
  let progress = await r.service.getMatchmakingProgress(1);
  assert.equal(progress.status, 'exhausted');
  assert.equal(progress.remainingCount, 0);
  assert.equal(progress.earliestExpireAt, null);
  assert.deepEqual(r.rows[C.matchmakingPackages], before);
  r.setTime('2026-11-18T02:00:00.000Z');
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'expired');
  await r.fulfill(manualOrder('NEW_ACTIVE', { durationDays: 60, serviceCount: 6 }));
  progress = await r.service.getMatchmakingProgress(1);
  assert.equal(progress.status, 'needs_profile');
  assert.equal(progress.remainingCount, 6);
  assert.equal(progress.earliestExpireAt, '2027-01-17T02:00:00.000Z');
  await r.refund(manualOrder('NEW_ACTIVE', { durationDays: 60, serviceCount: 6 }));
  assert.equal((await r.service.getMatchmakingProgress(1)).status, 'expired');
  await r.refund(manualOrder('EXHAUSTED'));
  before = structuredClone(r.rows[C.matchmakingPackages]);
  progress = await r.service.getMatchmakingProgress(1);
  assert.equal(progress.status, 'refunded');
  assert.equal(progress.purchased, true);
  assert.equal(progress.requestedAt, paidAt);
  assert.equal(progress.remainingCount, 0);
  assert.deepEqual(r.rows[C.matchmakingPackages], before);
});
