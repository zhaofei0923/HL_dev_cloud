'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const apiPath = path.resolve(process.env.HL_API_TEST_PATH || path.join(__dirname, '../cloudfunctions/hlApi/index.js'));
const requireApi = createRequire(apiPath);
const { createMemberAssignmentService } = requireApi('./member-assignment-policy');
const { createServiceIntakeService } = require('../cloudfunctions/hlAdminOperations/service-intake-service');
const { DIRECT_PURCHASE_CONTRACT } = requireApi('./purchase-contract-policy');
const NOW = '2026-10-19T08:00:00.000Z';
const clone = value => structuredClone(value);
const conflict = error => error.status === 409 || [40901, 40960].includes(error.code);
const actor = () => ({ uid: 'miniprogram:user:99', requestId: randomUUID(), serverRequestId: randomUUID() });

function fixture(settings = {}) {
  const rows = { hl_users: [2, 3, 4].map(id => ({ _id: `u${id}`, id, nickname: `用户${id}`, status: 1,
    phone: id === 2 ? '13800138000' : `1380000000${id}`, openid: `wx${id}`, gender: 2 })),
  hl_profiles: [{ _id: 'p2', id: 2, userId: 2, updatedAt: NOW, displayEnabled: false }],
  hl_matchmakers: [3, 4].map(id => ({ _id: `mm${id}`, id: id * 10, userId: id, status: 1, certificationStatus: 2,
    matchmakerNo: `MM${id}`, inviteCode: `INVITE${id}`, inviteCodeStatus: 'active', inviteCodeUpdatedAt: NOW })),
  hl_members: [], hl_counters: [], hl_member_private_archives: [], hl_messages: [], hl_conversations: [],
  hl_member_matchmaker_requests: [{ _id: 'request2', id: 2, userId: 2, matchmakerId: 30, status: 'pending' }],
  hl_matchmaking_readiness: [{ _id: 'intake_user_2', kind: 'service_intake', userId: 2, orderNos: ['order2'], requestedAt: NOW, createdAt: NOW, updatedAt: NOW }],
  hl_payment_orders: [{ _id: 'order2', outTradeNo: 'order2', userId: 2, status: 'paid', fulfillmentStatus: 'fulfilled',
    productType: 'matchmaking', fulfillmentContract: DIRECT_PURCHASE_CONTRACT, amountFen: 298000 }],
  hl_matchmaking_packages: [{ _id: 'matchmaking_user_2', userId: 2, packageIds: ['package_order2'] },
    { _id: 'package_order2', id: 'package_order2', userId: 2, orderNo: 'order2', fulfillmentContract: DIRECT_PURCHASE_CONTRACT,
      status: 'active', totalCount: 2, usedCount: 0, expireAt: '2026-11-20T00:00:00.000Z' }], hl_admin_audit_logs: [],
  ...clone(settings.rows || {}) };
  const versions = new Map(), writes = [], reads = [];
  let serial = 0, retries = 0, gateReads = 0, releaseGate;
  let beforeTransactionCalled = false;
  const gate = settings.race ? new Promise(resolve => { releaseGate = resolve; }) : null;
  const key = (name, id) => `${name}/${id}`;
  const matches = (row, query) => Object.entries(query || {}).every(([field, expected]) => expected && expected.kind === 'in'
    ? expected.value.includes(row[field]) : row[field] === expected);
  function apply(store, name, id, data, method, log) {
    const list = store[name] ||= [], previous = list.find(row => row._id === id);
    if (method === 'update' && !previous) throw Object.assign(new Error('DOCUMENT_NOT_EXIST'), { code: 'DOCUMENT_NOT_EXIST' });
    const resolved = Object.fromEntries(Object.entries(data).map(([field, value]) => [field,
      value && value.kind === 'inc' ? Number(previous?.[field] || 0) + value.value : clone(value)]));
    const saved = { ...(method === 'update' ? previous : {}), ...resolved, _id: id };
    if (previous) list.splice(list.indexOf(previous), 1, saved); else list.push(saved);
    if (log) { versions.set(key(name, id), (versions.get(key(name, id)) || 0) + 1); writes.push({ name, id, data: clone(data), method }); }
  }
  function document(store, name, id, tx) {
    return { async get() {
      if (tx) {
        tx.readVersions.set(key(name, id), tx.versions.get(key(name, id)) || 0);
        if (gate && name === 'hl_counters' && id === 'memberAssignmentUser_2' && ++gateReads <= 2) {
          if (gateReads === 2) releaseGate();
          await gate;
        }
      }
      reads.push({ name, id, transaction: !!tx });
      return { data: clone((store[name] || []).find(row => row._id === id) || null) };
    }, async set(input) { return change(input, 'set'); }, async update(input) { return change(input, 'update'); } };
    async function change(input, method) {
      const data = Object.hasOwn(input, 'data') ? input.data : input;
      if (settings.failArchive && name === 'hl_member_private_archives') throw new Error('archive write failed');
      if (settings.returnedErrorCollection === name && (!settings.returnedErrorDocument || settings.returnedErrorDocument === id)) return { errCode: -501000 };
      apply(store, name, id, data, method, !tx);
      if (tx) tx.pending.push({ name, id, data: clone(data), method });
      return { updated: 1 };
    }
  }
  function collection(name) {
    let condition = {}, skip = 0, limit = 100, projection;
    return { where(query) { condition = query; return this; }, skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; }, orderBy() { return this; }, field(value) { projection = value; return this; },
      doc(id) { return document(rows, name, id); }, async add({ data }) { const id = `generated${++serial}`; apply(rows, name, id, data, 'set', true); return { _id: id }; },
      async get() {
        const found = clone((rows[name] || []).filter(row => matches(row, condition)).slice(skip, skip + limit));
        return { data: projection ? found.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => field === '_id' || projection[field]))) : found };
      }
    };
  }
  const db = { collection, command: { in: value => ({ kind: 'in', value }), inc: value => ({ kind: 'inc', value }) },
    async createCollection(name) { rows[name] ||= []; },
    async runTransaction(callback) {
      if (!beforeTransactionCalled && settings.beforeTransaction) { beforeTransactionCalled = true; settings.beforeTransaction(rows); }
      for (let attempt = 0; attempt < 10; attempt++) {
        const store = clone(rows), tx = { versions: new Map(versions), readVersions: new Map(), pending: [] };
        // Both SDKs may use document operations; transactional collection queries are intentionally absent.
        const result = await callback({ collection: name => ({ doc: id => document(store, name, id, tx) }) });
        if ([...tx.readVersions].some(([id, version]) => (versions.get(id) || 0) !== version)) { retries++; continue; }
        for (const change of tx.pending) apply(rows, change.name, change.id, change.data, change.method, true);
        return result;
      }
      throw new Error('transaction retries exceeded');
    } };
  const cloud = { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'test-env',
    openapi: { security: { async msgSecCheck() { return { errCode: 0, result: { suggest: 'pass', label: 100 } }; } } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(process.env.HL_API_TEST_PATH || apiPath, 'utf8') + '\nexports.hooks={member,approveMemberMatchmakerRequest,acceptMemberMatchmakerInvite,memberAssignments};', {
    module, exports: module.exports, require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === './auth-policy') { const actual = requireApi(name); return { ...actual,
        createTokenService: () => actual.createTokenService({ secret: 'assignment-fixture-secret-32-characters-long' }) }; }
      return requireApi(name);
    }, process: { env: { NODE_ENV: 'test', TCB_ENV: 'test-env', DEMO_MEMBERS: 'false', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    Buffer, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }
  }, { filename: apiPath });
  return { rows, db, writes, reads, hooks: module.exports.hooks, retries: () => retries,
    admin: createServiceIntakeService({ db, now: () => NOW }) };
}
async function adminInput(rt, matchmakerId = 40) {
  return { userId: 2, matchmakerId, expectedVersion: (await rt.admin.detail({ userId: 2 })).version,
    reason: '并发分配验证', confirmReassign: false };
}
const active = rt => rt.rows.hl_members.filter(row => Number(row.userId) === 2 && Number(row.status) === 1);

for (const legacy of ['invite', 'request', 'approval']) test(`admin assignment versus legacy ${legacy} commits only one active relation under real overlap`, async () => {
  const rt = fixture({ race: true }), input = await adminInput(rt);
  const results = await Promise.allSettled([
    legacy === 'invite' ? rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' })
      : legacy === 'request' ? rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3', source: 'inviteCode' })
        : rt.hooks.approveMemberMatchmakerRequest(3, 2),
    rt.admin.execute('services.assign', input, actor())
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(active(rt).length, 1);
  assert.ok(results.some(result => result.status === 'rejected' && conflict(result.reason)));
  const anchor = rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2');
  assert.equal(anchor.memberDocumentId, active(rt)[0]._id); assert.equal(anchor.revision, 1);
  assert.ok(rt.retries() >= 1);
  assert.equal(rt.writes.filter(row => row.name === 'hl_members').length, 1);
});

test('legacy competitors, stale snapshots and duplicated active rows fail closed', async () => {
  const rt = fixture({ race: true });
  const results = await Promise.allSettled([30, 40].map(matchmakerId => rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId, source: 'share' })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(active(rt).length, 1);
  const stale = await rt.hooks.memberAssignments.prepare(2);
  await rt.hooks.memberAssignments.mutate(stale, { matchmakerId: active(rt)[0].matchmakerId, patch: { status: 0 } });
  await assert.rejects(rt.hooks.memberAssignments.mutate(stale, { matchmakerId: stale.members[0].matchmakerId, patch: { status: 1 } }), conflict);
  assert.equal(active(rt).length, 0);
  rt.rows.hl_members.push({ _id: 'duplicateA', id: 50, userId: 2, matchmakerId: 30, status: 1 },
    { _id: 'duplicateB', id: 51, userId: 2, matchmakerId: 40, status: 1 });
  const count = rt.writes.length;
  await assert.rejects(rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' }), conflict);
  assert.equal(rt.writes.length, count);
});

test('remove advances a complete inactive anchor and invalidates an administrator snapshot', async () => {
  const rt = fixture();
  await rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' });
  const input = await adminInput(rt, 40), before = active(rt)[0];
  await rt.hooks.member.remove(3, before.id);
  assert.equal(active(rt).length, 0);
  const anchor = rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2');
  assert.deepEqual([anchor.userId, anchor.memberDocumentId, anchor.memberRecordId, anchor.matchmakerId, anchor.revision], [2, before._id, before.id, 30, 2]);
  await assert.rejects(rt.admin.execute('services.assign', input, actor()), conflict);
  await rt.admin.execute('services.assign', await adminInput(rt, 40), actor());
  assert.equal(active(rt).length, 1); assert.equal(active(rt)[0].matchmakerId, 40);
});

test('pending manual reservation cannot activate after an administrator changes its anchor', async () => {
  const rt = fixture(), snapshot = await rt.hooks.memberAssignments.prepare(2);
  const reserved = await rt.hooks.memberAssignments.mutate(snapshot, { matchmakerId: 30,
    create: id => ({ memberNo: `HL${id}`, memberType: 'paid', intakeStatus: 'pending', status: 0 }) });
  await rt.admin.execute('services.assign', await adminInput(rt), actor());
  await assert.rejects(rt.hooks.memberAssignments.mutate(reserved.snapshot, { matchmakerId: 30,
    memberDocumentId: reserved.member._id, patch: { status: 1, intakeStatus: 'complete' } }), conflict);
  assert.equal(active(rt).length, 1); assert.equal(active(rt)[0].matchmakerId, 40);
  assert.equal(rt.rows.hl_members.find(row => row._id === reserved.member._id).status, 0);
});

test('malformed anchors and changed principal documents reject mutation before relationship writes', async () => {
  const rt = fixture(), snapshot = await rt.hooks.memberAssignments.prepare(2, [{ collection: 'hl_matchmakers', row: clone(rt.rows.hl_matchmakers[0]) }]);
  rt.rows.hl_matchmakers[0].certificationStatus = 0;
  await assert.rejects(rt.hooks.memberAssignments.mutate(snapshot, { matchmakerId: 30, create: () => ({ status: 1 }) }), conflict);
  assert.equal(rt.rows.hl_members.length, 0);
  rt.rows.hl_counters.push({ _id: 'memberAssignmentUser_2', userId: 2, revision: 1, memberDocumentId: 'missing', memberRecordId: 8, matchmakerId: 30 });
  await assert.rejects(rt.hooks.memberAssignments.prepare(2), conflict);
});

test('manual non-strict creation uses a stable member ID and does not grant VIP from paid bookkeeping', async () => {
  const rt = fixture();
  const result = await rt.hooks.member.addManual(3, { phone: '13800138000', realName: '资料会员', memberType: 'paid' });
  assert.equal(active(rt).length, 1); assert.equal(active(rt)[0].id, result.id);
  assert.equal(active(rt)[0].memberType, 'paid');
  assert.equal((rt.rows.hl_vip_entitlements || []).some(row => row.tier === 'vip'), false);
  assert.ok(rt.rows.hl_counters.some(row => row._id === 'memberAdminAtomic' && row.value === result.id));
  const again = await rt.hooks.member.addManual(3, { phone: '13800138000', remark: '更新' });
  assert.equal(again.id, result.id); assert.equal(active(rt).length, 1);
});

test('archive write failure rolls back final activation and leaves only a pending inactive reservation', async () => {
  const rt = fixture({ failArchive: true }), snapshot = await rt.hooks.memberAssignments.prepare(2);
  const reserved = await rt.hooks.memberAssignments.mutate(snapshot, { matchmakerId: 30,
    create: () => ({ memberType: 'paid', intakeStatus: 'pending', status: 0 }) });
  await assert.rejects(rt.hooks.memberAssignments.mutate(reserved.snapshot, { matchmakerId: 30, memberDocumentId: reserved.member._id,
    extraDocuments: [{ collection: 'hl_member_private_archives', documentId: 'private', expected: null }],
    beforeSave: transaction => transaction.collection('hl_member_private_archives').doc('private').set({ data: { memberId: reserved.member.id } }),
    patch: { intakeStatus: 'complete', status: 1 } }), /archive write failed/);
  assert.equal(active(rt).length, 0); assert.equal(rt.rows.hl_members[0].intakeStatus, 'pending');
  assert.equal(rt.rows.hl_member_private_archives.length, 0);
  assert.equal(rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2').revision, 1);
});

function strictIntake() {
  return { realName: '内部档案会员', gender: 2, age: new Date().getFullYear() - 1995, birthDate: '1995-01-01', phone: '13800138000',
    city: '成都武侯区', height: 165, weightKg: 52, education: '本科', graduateSchool: '示例大学', maritalStatus: '未婚', hasChildren: false,
    occupation: '运营', companyName: '示例公司', jobTitle: '主管', annualIncomePreTax: 30, incomeSources: ['salary'],
    verificationEvidenceTypes: ['salary_statement'], verificationCredentialLocation: '内部档案柜',
    assetVerification: { propertyCount: 0, vehicleCount: 0, financialAssetRange: 'under_500k' },
    personalProfile: { personalitySummary: '平和', hobbies: '阅读', dailyRoutine: '规律', smokingStatus: 'no', drinkingStatus: 'never',
      lifePhotos: [1, 2, 3].map(id => `cloud://test-env/hl_uploads/member-private/3/${id}.jpg`) },
    partnerPreferences: { ageMin: 28, ageMax: 38, heightRequirement: '175以上', educationMinimum: '本科', maritalStatuses: ['未婚'],
      incomeAssetExpectation: '稳定', regionRequirement: '成都', dealBreakers: '赌博', relationshipMode: '共同成长' },
    businessRegistration: { customerSource: 'friend_referral', packageType: '9980_3m', responsibleMatchmaker: '主理人甲',
      joinDate: '2026-10-19', expiryDate: '2027-01-19', tags: [] },
    compliance: { partialVerificationConfirmed: true, voluntarySubmissionConfirmed: true } };
}

test('strict addManual commits private archive and final active state atomically without turning paid bookkeeping into VIP', async () => {
  for (const failArchive of [false, true]) {
    const rt = fixture({ failArchive });
    const operation = rt.hooks.member.addManual(3, strictIntake(), { requireCompleteIntake: true });
    if (failArchive) await assert.rejects(operation, /archive write failed/); else await operation;
    assert.equal(active(rt).length, failArchive ? 0 : 1);
    assert.equal(rt.rows.hl_member_private_archives.length, failArchive ? 0 : 1);
    const stored = rt.rows.hl_members[0];
    assert.equal(stored.intakeStatus, failArchive ? 'pending' : 'complete');
    assert.equal(stored.memberType, 'paid');
    const entitlement = (rt.rows.hl_vip_entitlements || []).find(row => row.userId === 2);
    assert.ok(!entitlement || !entitlement.lifetime && !entitlement.expireAt);
    const anchor = rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2');
    assert.equal(anchor.revision, failArchive ? 1 : 2);
    assert.equal(anchor.memberDocumentId, stored._id);
  }
});

test('read-only hosts may construct the service while real assignment writes without transactions fail closed', async () => {
  let writes = 0;
  const service = createMemberAssignmentService({ db: { collection() { writes++; throw new Error('unexpected database access'); } }, listMembers: async () => [] });
  await assert.rejects(service.mutate({ userId: 2 }, { matchmakerId: 30, create: () => ({ status: 1 }) }),
    error => error.status === 503 && /transactions unavailable/.test(error.message));
  assert.equal(writes, 0);
});

test('removal and same-row invite or approval reactivation atomically clear old service readiness', async () => {
  for (const restore of ['invite', 'approval']) {
    const rt = fixture();
    await rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' });
    const assigned = active(rt)[0], ready = rt.rows.hl_matchmaking_readiness.find(row => row._id === 'readiness_user_2');
    assert.ok(ready); ready.confirmed = true;
    await rt.hooks.member.remove(3, assigned.id);
    assert.equal(rt.rows.hl_matchmaking_readiness.find(row => row._id === 'readiness_user_2').confirmed, false);
    // Even an old imported confirmation cannot resurrect after reactivation.
    rt.rows.hl_matchmaking_readiness.find(row => row._id === 'readiness_user_2').confirmed = true;
    if (restore === 'invite') await rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' });
    else {
      rt.rows.hl_member_matchmaker_requests[0].status = 'pending';
      await rt.hooks.approveMemberMatchmakerRequest(3, 2);
    }
    assert.equal(active(rt).length, 1); assert.equal(active(rt)[0]._id, assigned._id);
    const current = rt.rows.hl_matchmaking_readiness.find(row => row._id === 'readiness_user_2');
    assert.equal(current.confirmed, false); assert.equal(current.memberRecordId, assigned.id);
    assert.equal(current.matchmakerId, 30); assert.equal(current.userId, 2);
    assert.equal(rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2').revision, 3);
  }
});

test('SDK returned errors on sequence, member, readiness, request or anchor writes abort the whole assignment transaction', async () => {
  for (const [returnedErrorCollection, returnedErrorDocument] of [
    ['hl_counters', 'memberAdminAtomic'], ['hl_members'], ['hl_matchmaking_readiness'],
    ['hl_member_matchmaker_requests'], ['hl_counters', 'memberAssignmentUser_2']
  ]) {
    const rt = fixture({ returnedErrorCollection, returnedErrorDocument });
    await assert.rejects(rt.hooks.approveMemberMatchmakerRequest(3, 2), error => error.code === 50301);
    assert.equal(rt.rows.hl_members.length, 0);
    assert.equal(rt.rows.hl_counters.length, 0);
    assert.equal(rt.rows.hl_member_matchmaker_requests[0].status, 'pending');
    assert.equal(rt.rows.hl_matchmaking_readiness.some(row => row._id === 'readiness_user_2'), false);
    assert.equal(rt.rows.hl_messages.length, 0);
  }
});

test('a returned archive write error cannot mark strict manual intake active or complete', async () => {
  const rt = fixture({ returnedErrorCollection: 'hl_member_private_archives' });
  await assert.rejects(rt.hooks.member.addManual(3, strictIntake(), { requireCompleteIntake: true }), error => error.code === 50301);
  assert.equal(active(rt).length, 0);
  assert.equal(rt.rows.hl_members[0].intakeStatus, 'pending');
  assert.equal(rt.rows.hl_member_private_archives.length, 0);
  assert.equal(rt.rows.hl_counters.find(row => row._id === 'memberAssignmentUser_2').revision, 1);
});

test('principal account revocation between initial authorization and transaction prevents every legacy creation path', async () => {
  for (const entry of ['invite', 'approval', 'manual']) for (const patch of [{ status: 0 }, { mergedIntoUserId: 4 }]) {
    const rt = fixture({ beforeTransaction(rows) { Object.assign(rows.hl_users.find(row => row.id === 3), patch); } });
    const operation = entry === 'invite' ? rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' })
      : entry === 'approval' ? rt.hooks.approveMemberMatchmakerRequest(3, 2)
        : rt.hooks.member.addManual(3, { phone: '13800138000', memberType: 'paid' });
    await assert.rejects(operation, conflict);
    assert.equal(active(rt).length, 0); assert.equal(rt.rows.hl_members.length, 0);
    assert.equal(rt.rows.hl_counters.some(row => row._id === 'memberAssignmentUser_2'), false);
  }
});

test('inactive or merged assignment participants are rejected before creating a relationship', async () => {
  for (const id of [2, 3]) for (const patch of [{ status: '0' }, { mergedIntoUserId: 4 }]) {
    const rt = fixture(); Object.assign(rt.rows.hl_users.find(row => row.id === id), patch);
    await assert.rejects(rt.hooks.acceptMemberMatchmakerInvite(2, { matchmakerId: 30, source: 'share' }), conflict);
    assert.equal(active(rt).length, 0); assert.equal(rt.rows.hl_members.length, 0);
  }
});

test('entered and scanned invite codes directly assign and settle old pending requests without approval', async () => {
  for (const source of ['inviteCode', 'scan', 'manual']) {
    const rt = fixture();
    rt.rows.hl_member_matchmaker_requests.push({ _id: 'older-pending', id: 1, userId: 2, matchmakerId: 30, status: 'pending' });
    const result = await rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3', source });
    assert.equal(result.status, 'approved'); assert.equal(result.alreadyAssigned, false);
    assert.equal(result.member.matchmakerId, 30); assert.equal(active(rt).length, 1);
    assert.ok(rt.rows.hl_member_matchmaker_requests.every(row => row.status === 'approved'));
    assert.equal(rt.rows.hl_member_matchmaker_requests.length, 2, 'existing pending records are reused');
    assert.equal(rt.rows.hl_messages.length, 1);
    assert.equal(rt.rows.hl_conversations.length, 1);
    assert.ok(rt.rows.hl_member_matchmaker_requests.every(row => row.applySource === source));
    const again = await rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3', source });
    assert.equal(again.status, 'approved'); assert.equal(again.alreadyAssigned, true);
    assert.equal(again.member.id, result.member.id); assert.equal(active(rt).length, 1);
    assert.equal(rt.rows.hl_messages.length, 1); assert.equal(rt.rows.hl_conversations.length, 1);
    assert.equal(rt.rows.hl_member_matchmaker_requests.length, 2);
  }
});

test('direct code joining preserves existing premium membership fields and cannot take over another assignment', async () => {
  const premium = { _id: 'premium2', id: 22, userId: 2, matchmakerId: 30, status: 1,
    memberNo: 'HL-PREMIUM', memberType: 'vip', serviceLevel: 'priority', expireAt: '2099-12-31', remark: 'existing premium' };
  const rt = fixture({ rows: { hl_members: [premium] } });
  const result = await rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3' });
  assert.equal(result.alreadyAssigned, true);
  for (const field of ['id', 'memberNo', 'memberType', 'serviceLevel', 'expireAt', 'remark']) assert.equal(active(rt)[0][field], premium[field]);
  assert.ok(rt.writes.every(row => !['hl_vip_entitlements', 'hl_payment_orders', 'hl_matchmaking_packages'].includes(row.name)));
  const writes = rt.writes.length;
  await assert.rejects(rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE4' }), conflict);
  assert.equal(rt.writes.length, writes); assert.equal(active(rt)[0].matchmakerId, 30);
});

test('direct code joining rejects invalid, disabled, uncertified or revoked inviters and inactive invitees', async () => {
  for (const alter of [
    rows => { rows.hl_matchmakers[0].inviteCodeStatus = 'disabled'; },
    rows => { rows.hl_matchmakers[0].status = 0; },
    rows => { rows.hl_matchmakers[0].certificationStatus = 0; },
    rows => { rows.hl_users.find(row => row.id === 3).status = 0; },
    rows => { rows.hl_users.find(row => row.id === 2).mergedIntoUserId = 4; }
  ]) {
    const rt = fixture(); alter(rt.rows);
    await assert.rejects(rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3' }));
    assert.equal(active(rt).length, 0); assert.equal(rt.writes.length, 0);
  }
  const rt = fixture();
  await assert.rejects(rt.hooks.member.requestMatchmaker(2, { inviteCode: 'UNKNOWN' }));
  await assert.rejects(rt.hooks.acceptMemberMatchmakerInvite(2, { inviteCode: 'INVITE3', source: 'manual' }), /share invite source/);
  assert.equal(rt.writes.length, 0);
});

test('manual code joining revalidates inviter eligibility in the assignment transaction', async () => {
  for (const alter of [
    rows => { rows.hl_matchmakers[0].certificationStatus = 0; },
    rows => { rows.hl_matchmakers[0].inviteCodeStatus = 'disabled'; },
    rows => { rows.hl_users.find(row => row.id === 3).status = 0; }
  ]) {
    const rt = fixture({ beforeTransaction: alter });
    await assert.rejects(rt.hooks.member.requestMatchmaker(2, { inviteCode: 'INVITE3', source: 'scan' }), conflict);
    assert.equal(rt.writes.length, 0); assert.equal(active(rt).length, 0);
    assert.equal(rt.rows.hl_member_matchmaker_requests[0].status, 'pending');
  }
});

test('simultaneous entered invitations to different principals commit one relation and no pending request', async () => {
  const rt = fixture({ race: true });
  const results = await Promise.allSettled(['INVITE3', 'INVITE4'].map(inviteCode => rt.hooks.member.requestMatchmaker(2, { inviteCode })));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(results.some(row => row.status === 'rejected' && conflict(row.reason)));
  assert.equal(active(rt).length, 1);
  const winner = active(rt)[0].matchmakerId;
  assert.ok(rt.rows.hl_member_matchmaker_requests.filter(row => row.matchmakerId === winner).every(row => row.status === 'approved'));
});
