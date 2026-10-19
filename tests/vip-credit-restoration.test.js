const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createVipMembershipService, VIP_COLLECTIONS: C } = require('../cloudfunctions/hlApi/vip-membership-service');

const NOW = '2026-10-12T00:00:00.000Z';
const REQUEST_ID = `request_${'a'.repeat(32)}`;
const ORDER_NO = 'MATCH_RESTORE_FIXTURE_001';
const packageId = orderNo => `package_${crypto.createHash('sha256').update(orderNo).digest('hex').slice(0, 32)}`;
const PACKAGE_ID = packageId(ORDER_NO);
const OTHER_PACKAGE_ID = packageId('MATCH_OTHER_FIXTURE_001');
const caseData = { caseId: 'SUPPORT-2026-001', reason: '双方建联后确认本次服务无效，恢复原套餐一次' };

function fixture(options = {}) {
  const request = { _id: REQUEST_ID, id: REQUEST_ID, memberUserId: 1, targetUserId: 2,
    memberRecordId: 11, matchmakerId: 21, matchmakerUserId: 4, requestedByUserId: 4,
    status: 'connected', serviceConfirmed: true, serviceConfirmedAt: NOW,
    memberConsent: true, targetConsent: true, packageId: PACKAGE_ID,
    connectedAt: NOW, createdAt: NOW, updatedAt: NOW, conversationId: 600, matchRecordId: 500 };
  const purchasedPackage = { _id: PACKAGE_ID, id: PACKAGE_ID, userId: 1, orderNo: ORDER_NO,
    planTitle: '人工牵线1个月', planCode: 'matchmaking_month', startAt: NOW,
    expireAt: '2026-11-11T00:00:00.000Z', totalCount: 2, originalTotalCount: 2,
    usedCount: 1, status: 'active', createdAt: NOW, updatedAt: NOW };
  const rows = {
    hl_users: [1, 2, 4].map(id => ({ _id: `user_${id}`, id, status: 1, authVersion: 1 })),
    hl_members: [{ _id: 'member_11', id: 11, userId: 1, matchmakerId: 21, status: 1, memberType: 'free' }],
    [C.matchmakingRequests]: [request, { _id: 'pair_1_2', requestId: REQUEST_ID, updatedAt: NOW }],
    [C.matchmakingPackages]: [purchasedPackage,
      { ...purchasedPackage, _id: OTHER_PACKAGE_ID, id: OTHER_PACKAGE_ID, orderNo: 'MATCH_OTHER_FIXTURE_001',
        planTitle: '另一独立套餐', totalCount: 8, originalTotalCount: 8, usedCount: 3,
        expireAt: '2027-01-10T00:00:00.000Z' },
      { _id: 'matchmaking_user_1', userId: 1, packageIds: [PACKAGE_ID, OTHER_PACKAGE_ID],
        lastRequestId: REQUEST_ID, updatedAt: NOW }],
    [C.entitlements]: [{ _id: 'vip_user_1', userId: 1, legacyLifetime: true, legacyExpireAt: null,
      grants: [{ orderNo: 'VIP_EXISTING', durationDays: 30, grantedAt: NOW, status: 'active' }] }],
    hl_match_records: [{ _id: `connected_${REQUEST_ID}`, id: 500, userAId: 1, userBId: 2, requestId: REQUEST_ID }],
    hl_conversations: [{ _id: 'formal_conversation_1_2', id: 600, userAId: 1, userBId: 2, matchRecordId: 500 }],
    ...(options.rows || {})
  };
  let time = NOW, tail = Promise.resolve(), writes = 0;
  const operation = (kind, value) => ({ $operation: kind, value });
  const matches = (row, query) => !query || Object.entries(query).every(([field, expected]) => {
    if (!expected || typeof expected !== 'object' || !expected.$operation) return row[field] === expected;
    if (expected.$operation === 'in') return expected.value.includes(row[field]);
    if (expected.$operation === 'neq') return row[field] !== expected.value;
    throw new Error(`Unexpected restoration fixture query ${expected.$operation}`);
  });
  const getAll = async (name, query = null, limit = 1000) => structuredClone((rows[name] || []).filter(row => matches(row, query)).slice(0, limit));
  const getOne = async (name, query) => (await getAll(name, query, 1))[0] || null;
  const getById = (name, id) => getOne(name, { id: Number(id) });
  const doc = (name, id) => ({
    async get() {
      if (options.readError && name === C.matchmakingPackages) throw Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' });
      const row = (rows[name] || []).find(row => row._id === id);
      if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
      return { data: structuredClone(row) };
    },
    async set({ data }) {
      assert.equal(Object.hasOwn(data, '_id'), false, 'CloudBase system _id is not writable');
      writes++;
      if (options.failWrite === name) throw new Error('fixture write failure');
      const list = rows[name] ||= [], index = list.findIndex(row => row._id === id);
      const saved = { ...structuredClone(data), _id: id };
      if (index < 0) list.push(saved); else list[index] = saved;
    }
  });
  const collection = name => {
    let query = null, skip = 0, limit = 1000;
    const ref = { doc: id => doc(name, String(id)),
      where(value) { query = value; return ref; }, skip(value) { skip = value; return ref; },
      limit(value) { limit = value; return ref; }, field() { return ref; }, orderBy() { return ref; },
      async get() { return { data: (await getAll(name, query)).slice(skip, skip + limit) }; },
      async count() { return { total: (await getAll(name, query)).length }; } };
    return ref;
  };
  const db = { collection, command: Object.fromEntries(['in', 'neq', 'inc', 'or', 'and'].map(kind => [kind, value => operation(kind, value)])),
    async createCollection() {},
    runTransaction(callback) {
      const run = tail.then(async () => {
        const saved = structuredClone(rows);
        try { return await callback({ collection: name => ({ doc: id => doc(name, String(id)) }) }); }
        catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); throw error; }
      });
      tail = run.catch(() => {}); return run;
    } };
  const service = createVipMembershipService({ db, getAll, getOne, getById, now: () => time });
  return { rows, db, service, setTime(value) { time = value; }, get writes() { return writes; },
    request: () => rows[C.matchmakingRequests].find(row => row.id === REQUEST_ID),
    package: () => rows[C.matchmakingPackages].find(row => row.id === PACKAGE_ID),
    owner: () => rows[C.matchmakingPackages].find(row => row._id === 'matchmaking_user_1'),
    restore: (data = caseData, reviewer = 'admin') => service.restoreCredit(REQUEST_ID, data, reviewer) };
}

function apiRuntime(options = {}) {
  const runtime = fixture(options);
  const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
  const requireFromApi = createRequire(apiPath), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__restorationTest = { tokenService };', {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => runtime.db,
        getWXContext: () => ({ OPENID: 'fixture-openid-1' }), callFunction() { throw new Error('network is forbidden in restoration tests'); } };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'isolated-restoration-jwt-fixture-not-a-real-secret' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const sign = (payload, type) => module.exports.__restorationTest.tokenService.sign(payload, { type });
  return { ...runtime, sign,
    call: (token, data = caseData, route = `/admin/matchmaking/requests/${REQUEST_ID}/restore`, method = 'POST') =>
      module.exports.main({ path: route, method, data, token }) };
}

test('administrator correction restores one original-package credit and preserves connection and VIP history', async () => {
  const r = fixture(), before = structuredClone(r.rows);
  r.setTime('2026-10-15T03:00:00.000Z');
  const result = await r.restore();
  assert.equal(result.idempotent, false);
  assert.equal(result.package.usedCount, 0); assert.equal(result.package.remainingCount, 2);
  assert.equal(result.package.expireAt, before[C.matchmakingPackages][0].expireAt);
  assert.equal(result.request.status, 'connected'); assert.equal(result.request.conversationId, 600);
  assert.deepEqual(result.creditRestoration, { ...caseData, reviewer: 'admin', restoredAt: '2026-10-15T03:00:00.000Z' });
  assert.deepEqual(r.request().creditRestoration, result.creditRestoration);
  assert.equal(r.owner().creditRestorationSequence, 1);
  assert.equal(r.owner().lastCreditRestorationCaseId, caseData.caseId);
  for (const name of ['hl_match_records', 'hl_conversations', C.entitlements, 'hl_members']) assert.deepEqual(r.rows[name], before[name]);
  for (const field of ['memberConsent', 'targetConsent', 'serviceConfirmed', 'connectedAt', 'matchRecordId', 'conversationId', 'packageId']) {
    assert.equal(r.request()[field], before[C.matchmakingRequests][0][field]);
  }
  assert.deepEqual(r.rows[C.matchmakingPackages].find(row => row.id === OTHER_PACKAGE_ID), before[C.matchmakingPackages][1]);
});

test('same support case is concurrent-safe and retains the first immutable audit', async () => {
  const r = fixture();
  const results = await Promise.all([r.restore(), r.restore(), r.restore()]);
  assert.equal(results.filter(result => !result.idempotent).length, 1);
  assert.equal(r.package().usedCount, 0); assert.equal(r.owner().creditRestorationSequence, 1);
  const originalAudit = structuredClone(r.request().creditRestoration), before = structuredClone(r.rows);
  r.setTime('2026-10-16T03:00:00.000Z');
  const replay = await r.restore({ ...caseData, reason: '重复提交的新理由不得覆盖原审计' }, 'another-reviewer');
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.creditRestoration, originalAudit); assert.deepEqual(r.rows, before);
});

test('a second support case cannot restore the same connection a second time', async () => {
  const r = fixture();
  const settled = await Promise.allSettled([r.restore(), r.restore({ ...caseData, caseId: 'SUPPORT-2026-002' })]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = settled.find(item => item.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(r.package().usedCount, 0); assert.equal(r.owner().creditRestorationSequence, 1);
});

test('expired package credits may be corrected without extending validity or allowing new service', async () => {
  const r = fixture(); r.setTime('2026-12-01T00:00:00.000Z');
  const expiry = r.package().expireAt;
  const result = await r.restore();
  assert.equal(result.package.status, 'expired'); assert.equal(result.package.usedCount, 0);
  assert.equal(result.package.expireAt, expiry); assert.equal(r.package().expireAt, expiry);
  assert.equal((await r.service.packages(1)).list.find(row => row.id === PACKAGE_ID).status, 'expired');
});

test('refunded packages and connections that never completed cannot receive restored credits', async t => {
  for (const status of ['pending', 'rejected', 'cancelled']) await t.test(status, async () => {
    const r = fixture(); r.request().status = status;
    const before = structuredClone(r.rows);
    await assert.rejects(r.restore(), error => error.status === 409);
    assert.deepEqual(r.rows, before);
  });
  const refunded = fixture(); refunded.package().status = 'refunded';
  refunded.package().totalCount = refunded.package().usedCount;
  const before = structuredClone(refunded.rows);
  await assert.rejects(refunded.restore(), error => error.status === 409);
  assert.deepEqual(refunded.rows, before);
});

test('missing or mismatched package ownership and corrupted debit counts fail closed', async t => {
  const changes = [
    ['missing request', r => { r.rows[C.matchmakingRequests] = []; }],
    ['missing package reference', r => { delete r.request().packageId; }],
    ['missing package', r => { r.rows[C.matchmakingPackages] = r.rows[C.matchmakingPackages].filter(row => row.id !== PACKAGE_ID); }],
    ['wrong package id', r => { r.package().id = 'package_wrong'; }],
    ['wrong owner', r => { r.package().userId = 2; }],
    ['missing owner index', r => { r.rows[C.matchmakingPackages] = r.rows[C.matchmakingPackages].filter(row => row._id !== 'matchmaking_user_1'); }],
    ['wrong index owner', r => { r.owner().userId = 2; }],
    ['missing owner package association', r => { r.owner().packageIds = [OTHER_PACKAGE_ID]; }],
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3].map(value => [`invalid debit ${value}`, r => { r.package().usedCount = value; }]),
    ...[0, 1.5, Infinity].map(value => [`invalid purchased count ${value}`, r => { r.package().totalCount = value; }]),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER].map(value => [`invalid restoration sequence ${value}`, r => { r.owner().creditRestorationSequence = value; }]),
    ['refund audit despite active status', r => { r.package().refundedAt = '2026-10-13T00:00:00.000Z'; }]
  ];
  for (const [label, mutate] of changes) await t.test(label, async () => {
    const r = fixture(); mutate(r); const before = structuredClone(r.rows);
    await assert.rejects(r.restore(), error => [400, 404, 409].includes(error.status));
    assert.deepEqual(r.rows, before);
  });
});

test('support correction requires bounded clean audit strings and stores trimmed values', async t => {
  const invalid = [
    [{ ...caseData, caseId: '' }, 'admin'], [{ ...caseData, caseId: 123 }, 'admin'],
    [{ ...caseData, caseId: 'x'.repeat(129) }, 'admin'], [{ ...caseData, caseId: 'CASE\n001' }, 'admin'],
    [{ ...caseData, reason: '  ' }, 'admin'], [{ ...caseData, reason: null }, 'admin'],
    [{ ...caseData, reason: 'x'.repeat(501) }, 'admin'], [{ ...caseData, reason: 'reason\x00' }, 'admin'],
    [caseData, ''], [caseData, false], [caseData, 'x'.repeat(121)], [caseData, 'reviewer\tlabel']
  ];
  for (const [data, reviewer] of invalid) await t.test(JSON.stringify([data, reviewer]), async () => {
    const r = fixture(), before = structuredClone(r.rows);
    await assert.rejects(r.restore(data, reviewer), error => error.status === 400);
    assert.deepEqual(r.rows, before);
  });
  const r = fixture();
  assert.deepEqual((await r.restore({ caseId: ` ${caseData.caseId} `, reason: ` ${caseData.reason} ` }, ' admin ')).creditRestoration,
    { ...caseData, reviewer: 'admin', restoredAt: NOW });
});

test('correction rolls back package balance when saving its request audit fails', async () => {
  const r = fixture({ failWrite: C.matchmakingRequests }), before = structuredClone(r.rows);
  await assert.rejects(r.restore(), /fixture write failure/);
  assert.deepEqual(r.rows, before);
  const denied = fixture({ readError: true }), deniedBefore = structuredClone(denied.rows);
  await assert.rejects(denied.restore(), /permission denied/);
  assert.deepEqual(denied.rows, deniedBefore);
});

test('ordinary order refund after correction revokes only that package without altering another package or connection', async () => {
  const r = fixture(); await r.restore(); const before = structuredClone(r.rows);
  const order = { userId: 1, outTradeNo: ORDER_NO, productType: 'matchmaking', durationDays: 30, serviceCount: 2 };
  const result = await r.db.runTransaction(transaction => r.service.refundOrder(transaction, order, '2026-10-16T00:00:00.000Z'));
  assert.equal(result.revoked, true); assert.equal(result.package.status, 'refunded');
  assert.equal(result.package.remainingCount, 0); assert.equal(r.package().refundedCount, 2);
  const originalAudit = structuredClone(r.request().creditRestoration);
  const repeated = await r.db.runTransaction(transaction => r.service.refundOrder(transaction, order, '2026-10-16T00:00:00.000Z'));
  assert.equal(repeated.idempotent, true); assert.deepEqual(r.request().creditRestoration, originalAudit);
  for (const name of ['hl_match_records', 'hl_conversations', C.entitlements]) assert.deepEqual(r.rows[name], before[name]);
  assert.deepEqual(r.rows[C.matchmakingPackages].find(row => row.id === OTHER_PACKAGE_ID), before[C.matchmakingPackages][1]);
  const refundedSnapshot = structuredClone(r.rows), correctionReplay = await r.restore();
  assert.equal(correctionReplay.idempotent, true); assert.equal(correctionReplay.package.status, 'refunded');
  assert.deepEqual(r.rows, refundedSnapshot);
});

test('actual API rejects ordinary, refresh, forged-role and absent tokens before restoring any credit', async t => {
  const r = apiRuntime(), before = structuredClone(r.rows);
  const tokens = [
    ['ordinary owner', r.sign({ userId: 1, authVersion: 1 }, 'access')],
    ['recipient', r.sign({ userId: 2, authVersion: 1 }, 'access')],
    ['serving matchmaker', r.sign({ userId: 4, authVersion: 1 }, 'access')],
    ['access token with admin role claim', r.sign({ userId: 1, role: 'admin', authVersion: 1 }, 'access')],
    ['refresh token with admin role claim', r.sign({ userId: 1, role: 'admin', authVersion: 1 }, 'refresh')],
    ['admin token with ordinary role', r.sign({ role: 'user' }, 'admin')],
    ['no token', ''], ['invalid token', 'not-a-signed-token']
  ];
  for (const [label, token] of tokens) await t.test(label, async () => {
    const result = await r.call(token);
    assert.notEqual(result.code, 0, `${label} must not have admin correction permission`);
    assert.deepEqual(r.rows, before);
  });
});

test('actual administrator endpoint uses a server-chosen reviewer and the same restoration ledger', async () => {
  const r = apiRuntime(), token = r.sign({ role: 'admin', adminSessionId: 'restoration-review-fixture' }, 'admin');
  const result = await r.call(token, { ...caseData, reviewer: 'spoofed-reviewer', usedCount: -100, expireAt: '2099-01-01' });
  assert.equal(result.code, 0, result.message);
  assert.equal(result.data.idempotent, false); assert.equal(result.data.request.status, 'connected');
  assert.equal(result.data.package.usedCount, 0); assert.equal(result.data.creditRestoration.reviewer, 'admin');
  assert.equal(r.package().expireAt, '2026-11-11T00:00:00.000Z');
  const before = structuredClone(r.rows), replay = await r.call(token);
  assert.equal(replay.code, 0, replay.message); assert.equal(replay.data.idempotent, true);
  assert.deepEqual(r.rows, before);
});

test('member routes and incorrect administrator methods cannot bypass the correction endpoint', async () => {
  const r = apiRuntime(), before = structuredClone(r.rows);
  const access = r.sign({ userId: 1, authVersion: 1 }, 'access'), admin = r.sign({ role: 'admin' }, 'admin');
  const memberAttempt = await r.call(access, caseData, `/member/matchmaking/requests/${REQUEST_ID}/restore`);
  assert.notEqual(memberAttempt.code, 0);
  const wrongMethod = await r.call(admin, caseData, `/admin/matchmaking/requests/${REQUEST_ID}/restore`, 'GET');
  assert.notEqual(wrongMethod.code, 0);
  assert.deepEqual(r.rows, before);
});

test('ordinary participants can still read connection history without receiving the administrative audit', async () => {
  const r = apiRuntime(), admin = r.sign({ role: 'admin' }, 'admin');
  assert.equal((await r.call(admin)).code, 0);
  for (const userId of [1, 2]) {
    const token = r.sign({ userId, authVersion: 1 }, 'access');
    const result = await r.call(token, {}, '/member/matchmaking/requests', 'GET');
    assert.equal(result.code, 0, result.message);
    const request = result.data.list.find(row => row.id === REQUEST_ID);
    assert.equal(request.status, 'connected'); assert.equal(request.conversationId, 600);
    assert.equal(Object.hasOwn(request, 'creditRestoration'), false);
    assert.equal(JSON.stringify(result.data).includes(caseData.caseId), false);
    assert.equal(JSON.stringify(result.data).includes(caseData.reason), false);
  }
});
