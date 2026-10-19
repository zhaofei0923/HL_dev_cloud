'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServiceIntakeService, SERVICE_INTAKE_COLLECTIONS: C } = require('../cloudfunctions/hlAdminOperations/service-intake-service');
const { DIRECT_PURCHASE_CONTRACT } = require('../cloudfunctions/hlApi/purchase-contract-policy');
const NOW = '2026-10-19T08:00:00.000Z', EXPIRY = '2026-11-01T08:00:00.000Z';
const actor = () => ({ uid: 'miniprogram:user:1', requestId: randomUUID(), serverRequestId: randomUUID() });
const code = expected => error => error.code === expected;
const clone = value => structuredClone(value);
function runtime(options = {}) {
  const rows = { [C.users]: [{ _id: 'user2', id: 2, nickname: '会员', status: 1, phone: 'private-phone' },
    { _id: 'user3', id: 3, nickname: '主理人甲', status: 1 }, { _id: 'user4', id: 4, nickname: '主理人乙', status: 1 }],
  [C.profiles]: [{ _id: 'profile2', userId: 2, updatedAt: NOW, privateNotes: 'private-notes' }],
  [C.members]: [], [C.matchmakers]: [{ _id: 'mm3', id: 30, userId: 3, status: 1, certificationStatus: 2 },
    { _id: 'mm4', id: 40, userId: 4, status: 1, certificationStatus: 2 }],
  [C.readiness]: [{ _id: 'intake_user_2', kind: 'service_intake', userId: 2, orderNos: ['order2'], requestedAt: NOW, createdAt: NOW, updatedAt: NOW }],
  [C.orders]: [{ _id: 'orderdoc2', outTradeNo: 'order2', userId: 2, status: 'paid', fulfillmentStatus: 'fulfilled',
    productType: 'matchmaking', fulfillmentContract: DIRECT_PURCHASE_CONTRACT, amountFen: 298000 }],
  [C.packages]: [{ _id: 'matchmaking_user_2', userId: 2, packageIds: ['package_order2'] },
    { _id: 'package_order2', id: 'package_order2', userId: 2, orderNo: 'order2', fulfillmentContract: DIRECT_PURCHASE_CONTRACT,
      status: 'active', planTitle: '人工牵线2次', totalCount: 2, originalTotalCount: 2, usedCount: 0, expireAt: EXPIRY }],
  [C.audit]: [], [C.counters]: [], ...clone(options.rows || {}) };
  const writes = [];
  let inTransaction = false, tail = Promise.resolve();
  function collection(name) {
    let condition = {}, skip = 0, limit = 100, projection;
    return { where(value) { condition = value; return this; }, orderBy() { return this; },
      skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, field(value) { projection = value; return this; },
      async get() {
        const found = clone((rows[name] || []).filter(row => Object.entries(condition).every(([key, value]) => row[key] === value))
          .sort((a, b) => a._id.localeCompare(b._id)).slice(skip, skip + limit));
        return { data: projection ? found.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => projection[key]))) : found };
      }, doc(id) { return {
        async get() { const row = (rows[name] || []).find(row => row._id === id); return { data: row ? clone(row) : null }; },
        async set(data) {
          assert.equal(inTransaction, true); assert.equal(Object.hasOwn(data, 'data'), false); assert.equal(Object.hasOwn(data, '_id'), false);
          if (name === C.audit && options.failAudit) throw new Error('audit write failed');
          const list = rows[name] ||= [], index = list.findIndex(row => row._id === id), saved = { ...clone(data), _id: id };
          if (index < 0) list.push(saved); else list[index] = saved;
          writes.push({ name, id, data: clone(data) }); return { updated: 1 };
        }, async update(data) {
          assert.equal(inTransaction, true); assert.equal(Object.hasOwn(data, 'data'), false);
          const row = (rows[name] || []).find(row => row._id === id); if (!row) throw new Error('missing document');
          Object.assign(row, clone(data)); writes.push({ name, id, data: clone(data) }); return { updated: 1 };
        }
      }; }
    };
  }
  const db = { collection, runTransaction(callback) {
    const run = tail.then(async () => {
      if (options.beforeTransaction) options.beforeTransaction(rows);
      const saved = clone(rows), writeCount = writes.length; inTransaction = true;
      try { return await callback({ collection: name => ({ doc: id => collection(name).doc(id) }) }); }
      catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); writes.splice(writeCount); throw error; }
      finally { inTransaction = false; }
    }); tail = run.catch(() => {}); return run;
  } };
  return { rows, writes, db, service: createServiceIntakeService({ db, now: () => NOW }) };
}
async function assign(rt, patch = {}, identity = actor()) {
  const row = await rt.service.detail({ userId: 2 });
  return rt.service.execute('services.assign', { userId: 2, matchmakerId: 30, expectedVersion: row.version,
    reason: '平台安排主理人联系', confirmReassign: false, ...patch }, identity);
}
async function extend(rt, patch = {}, identity = actor()) {
  const row = await rt.service.detail({ userId: 2 });
  return rt.service.execute('services.extend', { userId: 2, packageId: 'package_order2', days: 3,
    reason: '平台联系延误补偿', expectedVersion: row.version, ...patch }, identity);
}
test('central queue includes unassigned paid users, contact progress, terminal rows and minimal fields', async () => {
  const rt = runtime();
  const list = await rt.service.list({ page: 1, pageSize: 10 });
  assert.equal(list.total, 1); assert.equal(list.list[0].status, 'pending_assignment');
  assert.equal(list.list[0].contactProgress, '待平台分配主理人');
  assert.equal(JSON.stringify(list).includes('private-'), false);
  await assign(rt);
  const assigned = await rt.service.detail({ userId: 2 });
  assert.equal(assigned.status, 'pending_contact'); assert.equal(assigned.assignment.matchmakerId, 30);
  assert.equal(rt.rows[C.members][0].memberType, 'free'); assert.equal(rt.rows[C.members][0].serviceLevel, '');
  const member = rt.rows[C.members][0];
  Object.assign(rt.rows[C.readiness].find(row => row._id === 'readiness_user_2'), { userId: 2, confirmed: true, memberRecordId: member.id, matchmakerId: 30, profileVersion: NOW });
  assert.equal((await rt.service.detail({ userId: 2 })).status, 'in_progress');
  rt.rows[C.packages][1].usedCount = 2;
  assert.equal((await rt.service.list()).list[0].status, 'exhausted');
});
test('assignment requires current active approved principal, explicit reassign and audited reasons', async () => {
  const rt = runtime(); await assign(rt);
  const readiness = rt.rows[C.readiness].find(row => row._id === 'readiness_user_2'); readiness.confirmed = true;
  await assert.rejects(assign(rt, { matchmakerId: 40 }), code(40960));
  const result = await assign(rt, { matchmakerId: 40, confirmReassign: true });
  assert.equal(result.target.matchmakerId, 40); assert.equal(rt.rows[C.members].length, 1);
  assert.equal(rt.rows[C.members][0].matchmakerId, 40);
  assert.equal(rt.rows[C.audit][1].before.assignment.matchmakerId, 30);
  assert.equal(rt.rows[C.audit][1].after.assignment.matchmakerId, 40);
  assert.equal(rt.rows[C.readiness].find(row => row._id === 'readiness_user_2').confirmed, false);
  await assign(rt, { matchmakerId: 30, confirmReassign: true });
  assert.equal((await rt.service.detail({ userId: 2 })).status, 'pending_contact');
  rt.rows[C.users][1].status = 0;
  await assert.rejects(assign(rt, { confirmReassign: true }), code(40960));
  await assert.rejects(assign(rt, { reason: '' }), code(42260));
});
test('extension preserves purchase/count snapshots, adds from old expiry, audits original expiry and is idempotent', async () => {
  const rt = runtime(), who = actor(), detail = await rt.service.detail({ userId: 2 });
  const args = { userId: 2, packageId: 'package_order2', days: 3, reason: '平台联系延误', expectedVersion: detail.version };
  const beforeOrder = clone(rt.rows[C.orders]);
  const first = await rt.service.execute('services.extend', args, who), second = await rt.service.execute('services.extend', args, who);
  assert.deepEqual(first, second); assert.equal(rt.rows[C.audit].length, 1);
  assert.equal(rt.rows[C.packages][1].expireAt, '2026-11-04T08:00:00.000Z');
  assert.equal(rt.rows[C.packages][1].originalExpireAt, EXPIRY);
  assert.equal(rt.rows[C.packages][1].totalCount, 2); assert.equal(rt.rows[C.packages][1].originalTotalCount, 2);
  assert.equal(rt.rows[C.packages][1].usedCount, 0); assert.deepEqual(rt.rows[C.orders], beforeOrder);
  await assert.rejects(rt.service.execute('services.extend', { ...args, days: 4 }, who), code(40960));
  rt.rows[C.packages][1].expireAt = '2026-10-01T08:00:00.000Z';
  await extend(rt, { days: 1 }); assert.equal(rt.rows[C.packages][1].expireAt, '2026-10-02T08:00:00.000Z');
});
test('extension refuses refunded, exhausted, unpaid, wrong owner, malformed bounds and stale snapshots', async () => {
  for (const change of [rt => { rt.rows[C.packages][1].status = 'refunded'; }, rt => { rt.rows[C.packages][1].usedCount = 2; },
    rt => { rt.rows[C.orders][0].status = 'pending'; }, rt => { rt.rows[C.orders][0].userId = 3; }]) {
    const rt = runtime(); change(rt); await assert.rejects(extend(rt), code(40960)); assert.equal(rt.writes.length, 0);
  }
  for (const days of [0, 31, 1.5, '2']) { const rt = runtime(); await assert.rejects(extend(rt, { days }), code(42260)); }
  const rt = runtime(), row = await rt.service.detail({ userId: 2 }); rt.rows[C.orders][0].amountFen += 1;
  await assert.rejects(extend(rt, { expectedVersion: row.version }), code(40960));
});
test('current dependency changes and duplicate active assignments fail closed, audit failure rolls back all writes', async () => {
  const rt = runtime({ beforeTransaction(rows) { rows[C.matchmakers][0].certificationStatus = 1; } });
  await assert.rejects(assign(rt), code(40960)); assert.equal(rt.writes.length, 0);
  const duplicate = runtime();
  duplicate.rows[C.members].push({ _id: 'a', id: 5, userId: 2, matchmakerId: 30, status: 1 }, { _id: 'b', id: 6, userId: 2, matchmakerId: 40, status: 1 });
  await assert.rejects(assign(duplicate), code(40960));
  const broken = runtime({ failAudit: true }); await assert.rejects(assign(broken), /audit/);
  assert.equal(broken.rows[C.members].length, 0); assert.equal(broken.rows[C.counters].length, 0); assert.equal(broken.writes.length, 0);
});
test('competing administrators serialize assignment through the intake version', async () => {
  const rt = runtime(), detail = await rt.service.detail({ userId: 2 });
  const inputs = [30, 40].map(matchmakerId => ({ userId: 2, matchmakerId, expectedVersion: detail.version, reason: '平台分配', confirmReassign: false }));
  const results = await Promise.allSettled(inputs.map(args => rt.service.execute('services.assign', args, actor())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(rt.rows[C.members].length, 1); assert.equal(rt.rows[C.audit].length, 1);
});
test('legacy member allocation locking rejects a newly inserted relation and audits invalid former principals', async () => {
  const race = runtime({ beforeTransaction(rows) {
    rows[C.members].push({ _id: 'legacy-new', id: 21, userId: 2, matchmakerId: 40, status: 1 });
    rows[C.counters].push({ _id: 'memberAssignmentUser_2', userId: 2, memberDocumentId: 'legacy-new', memberRecordId: 21, matchmakerId: 40, revision: 1 });
  } });
  await assert.rejects(assign(race), code(40960)); assert.equal(race.rows[C.members].length, 1); assert.equal(race.rows[C.audit].length, 0);
  const rt = runtime(); await assign(rt); rt.rows[C.matchmakers][0].status = 0;
  assert.equal((await rt.service.detail({ userId: 2 })).assignment, null);
  await assign(rt, { matchmakerId: 40, confirmReassign: true });
  assert.deepEqual(rt.rows[C.audit][1].before.assignment, { memberRecordId: rt.rows[C.members][0].id, matchmakerId: 30 });
  const lock = rt.rows[C.counters].find(row => row._id === 'memberAssignmentUser_2');
  assert.equal(lock.revision, 2); assert.equal(lock.matchmakerId, 40); assert.equal(lock.memberDocumentId, rt.rows[C.members][0]._id);
  const corrupt = runtime(); corrupt.rows[C.counters].push({ _id: 'memberAssignmentUser_2', userId: 2,
    memberDocumentId: 'foreign-member', memberRecordId: 9, matchmakerId: 40, revision: 1 });
  await assert.rejects(assign(corrupt), code(40960)); assert.equal(corrupt.rows[C.members].length, 0);
  const retired = runtime(); retired.rows[C.members].push({ _id: 'retired-member', id: 8, userId: 2, matchmakerId: 40, status: 0 });
  retired.rows[C.counters].push({ _id: 'memberAssignmentUser_2', userId: 2, memberDocumentId: 'retired-member', memberRecordId: 8, matchmakerId: 40, revision: 1 });
  await assign(retired); assert.equal(retired.rows[C.members].filter(row => row.status === 1).length, 1);
});
