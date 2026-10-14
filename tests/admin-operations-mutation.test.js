'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMutationService, COLLECTIONS: C } = require('../cloudfunctions/hlAdminOperations/mutation-service');
const { versionFor } = require('../cloudfunctions/hlAdminOperations/contracts');
const { DEFAULT_MEMBERSHIP_PLANS } = require('../cloudfunctions/hlApi/vip-membership-service');
const { createReadService } = require('../cloudfunctions/hlAdminOperations/read-service');
const NOW = '2026-10-14T03:00:00.000Z';
const BEFORE = '2026-10-13T03:00:00.000Z';
const actor = { uid: 'trusted-admin-1', requestId: 'operation-00001', serverRequestId: 'server-request-001' };
const clone = value => structuredClone(value);
function fixture() {
  const kinds = ['identity', 'education', 'vehicle', 'property', 'assets'];
  const sources = ['identity_document', 'chsi', 'vehicle_license', 'property_certificate', 'combined_financial_statement'];
  return { [C.audit]: [], [C.matchmakers]: [{ _id: 'mm-31', id: 31, userId: 1, status: 1, certificationStatus: 0, updatedAt: BEFORE }],
    [C.users]: [{ _id: 'user-1', id: 1, status: 1 }],
    [C.profiles]: [{ _id: 'profile-1', userId: 1, assetCategoryConsent: true, privateNotes: 'private-profile-value', updatedAt: BEFORE }],
    [C.salons]: [{ _id: 'salon-41', id: 41, organizerId: 1, status: 'pending', eventDate: '2026-11-01T03:00:00.000Z', updatedAt: BEFORE }],
    [C.plans]: [{ ...DEFAULT_MEMBERSHIP_PLANS[0], _id: 'persisted-plan', active: true, updatedAt: BEFORE }],
    [C.certifications]: [{ _id: 'user_1', userId: 1, current: {}, applications: Object.fromEntries(kinds.map((kind, i) => [kind,
      { requestId: `application-${kind}`, status: 'pending', source: sources[i], materialIds: [`material-${kind}`],
        sealedVerification: { opaque: `encrypted-private-${kind}` }, submittedAt: BEFORE }])),
    materials: Object.fromEntries(kinds.map(kind => [`material-${kind}`, { id: `material-${kind}`, kind, status: 'bound',
      applicationId: `application-${kind}`, fileID: `cloud://fixture/private-${kind}`, mimeType: 'image/jpeg', size: 100, createdAt: BEFORE }])),
    reviews: [], updatedAt: BEFORE }] };
}
function runtime(options = {}) {
  const rows = clone(options.rows || fixture()), writes = [];
  let tail = Promise.resolve(), inTransaction = false;
  function collection(name) {
    let query;
    let maximum = 100, skipped = 0;
    return { where(value) { query = value; return this; }, limit(value) { maximum = value; return this; },
      orderBy() { return this; }, field() { return this; }, skip(value) { skipped = value; return this; },
      async get() { return { data: clone((rows[name] || []).filter(row => !query || Object.entries(query).every(([key, value]) => row[key] === value))
        .sort((a, b) => a._id.localeCompare(b._id)).slice(skipped, skipped + maximum)) }; },
      doc(id) { return {
        async get() {
          if (options.failAuditRead && name === C.audit) throw Object.assign(new Error('collection permissions denied'), { errCode: 'PERMISSION_DENIED' });
          const row = (rows[name] || []).find(row => row._id === id);
          if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
          return { data: clone(row) };
        },
        async set(data) {
          assert.equal(inTransaction, true, 'all writes require transaction');
          assert.equal(Object.hasOwn(data, 'data'), false, 'Node SDK accepts direct data, not a wx-server-sdk envelope');
          assert.equal(Object.hasOwn(data, '_id'), false, 'SDK forbids _id in document.set data');
          if (options.failAuditWrite && name === C.audit) throw new Error('isolated audit write failure');
          const list = rows[name] ||= [], index = list.findIndex(row => row._id === id);
          const saved = { ...clone(data), _id: id };
          if (index < 0) list.push(saved); else list[index] = saved;
          writes.push({ name, id, data: clone(data) });
          if (options.returnAuditError && name === C.audit) return { code: 'DATABASE_REQUEST_FAILED', message: 'isolated returned audit error' };
          return { updated: 1, upserted: [{ _id: id }] };
        },
        async update(data) {
          assert.equal(inTransaction, true);
          assert.equal(Object.hasOwn(data, 'data'), false, 'Node SDK update accepts direct data');
          if (options.failProfileWrite && name === C.profiles) throw new Error('isolated profile write failure');
          const row = (rows[name] || []).find(row => row._id === id);
          if (!row) throw new Error('fixture missing update');
          Object.assign(row, clone(data)); writes.push({ name, id, data: clone(data) });
          return { updated: 1 };
        }
      }; }
    };
  }
  const db = { collection, runTransaction(callback) {
    const run = tail.then(async () => {
      if (options.beforeTransaction) options.beforeTransaction(rows);
      const saved = clone(rows), writeCount = writes.length;
      inTransaction = true;
      // Deliberately no query APIs inside transactions, matching CloudBase.
      try { return await callback({ collection: name => ({ doc: id => collection(name).doc(id) }) }); }
      catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); writes.splice(writeCount); throw error; }
      finally { inTransaction = false; }
    });
    tail = run.catch(() => {}); return run;
  } };
  const service = createMutationService({ db, now: () => new Date(NOW) });
  return { rows, writes, db, service };
}
function mmArgs(rt, patch = {}) { return { id: 31, certificationStatus: 2, expectedVersion: versionFor('matchmakers', rt.rows[C.matchmakers][0]), ...patch }; }
function salonArgs(rt, patch = {}) { return { id: 41, status: 'upcoming', expectedVersion: versionFor('salons', rt.rows[C.salons][0]), ...patch }; }
function planArgs(rt, patch = {}) { return { planCode: 'vip_week', active: false, expectedVersion: versionFor('plans', rt.rows[C.plans][0] || { ...DEFAULT_MEMBERSHIP_PLANS[0], active: true }), ...patch }; }
function certArgs(rt, kind = 'identity', patch = {}) {
  return { userId: 1, kind, applicationId: `application-${kind}`, status: 'approved', source: rt.rows[C.certifications][0].applications[kind].source,
    evidenceReference: 'offline-reference-private', remark: 'internal-private-note', feedback: '本人可见反馈',
    ...(kind === 'education' ? { educationLevel: '硕士' } : {}), ...(kind === 'assets' ? { financialAssetRange: '2m_5m' } : {}),
    expectedVersion: versionFor('certifications', rt.rows[C.certifications][0], kind), ...patch };
}
const code = expected => error => error.code === expected;

test('a review atomically updates its fixed fields and an actor-bound safe audit', async () => {
  const rt = runtime(); const result = await rt.service.execute('matchmakers.review', mmArgs(rt, { remark: 'private reviewer remark' }), actor);
  assert.equal(rt.rows[C.matchmakers][0].certificationStatus, 2);
  assert.equal(result.version, versionFor('matchmakers', rt.rows[C.matchmakers][0]));
  assert.deepEqual(result.target, { id: 31 });
  const audit = rt.rows[C.audit][0];
  assert.equal(audit.actor.uid, actor.uid); assert.equal(audit.requestId, actor.requestId); assert.equal(audit.serverRequestId, actor.serverRequestId);
  assert.equal(audit.beforeStatus, 0); assert.equal(audit.afterStatus, 2);
  assert.equal(JSON.stringify(audit).includes('private reviewer remark'), false);
});
test('same operation retry is exactly once even concurrently; changed payload conflicts', async () => {
  const rt = runtime(), args = mmArgs(rt);
  const results = await Promise.all([rt.service.execute('matchmakers.review', args, actor), rt.service.execute('matchmakers.review', args, actor)]);
  assert.deepEqual(results[0], results[1]); assert.equal(rt.rows[C.audit].length, 1); assert.equal(rt.writes.length, 2);
  await assert.rejects(rt.service.execute('matchmakers.review', { ...args, certificationStatus: 1 }, actor), code(40960));
});
test('idempotency keys are scoped to the trusted administrator and not client-supplied identity', async () => {
  const rt = runtime(); await rt.service.execute('matchmakers.review', mmArgs(rt), actor);
  rt.rows[C.matchmakers].push({ _id: 'mm-32', id: 32, userId: 1, status: 1, certificationStatus: 0, updatedAt: BEFORE });
  await rt.service.execute('matchmakers.review', { id: 32, certificationStatus: 1, expectedVersion: versionFor('matchmakers', rt.rows[C.matchmakers][1]) }, { ...actor, uid: 'trusted-admin-2' });
  assert.equal(rt.rows[C.audit].length, 2);
});
test('a stale snapshot is checked again inside the transaction', async () => {
  const rt = runtime({ beforeTransaction: rows => { rows[C.matchmakers][0].certificationStatus = 1; } });
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), code(40960));
  assert.equal(rt.writes.length, 0); assert.equal(rt.rows[C.audit].length, 0);
});
test('an audit failure rolls back every business write and cannot claim success', async () => {
  const rt = runtime({ failAuditWrite: true }); const before = clone(rt.rows);
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), /audit write failure/);
  assert.deepEqual(rt.rows, before); assert.equal(rt.writes.length, 0);
});
test('audit read permission failures are not interpreted as missing idempotency records', async () => {
  const rt = runtime({ failAuditRead: true });
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), /permissions denied/);
  assert.equal(rt.writes.length, 0);
});
test('a Node SDK error response without a thrown exception also rolls back the audit and mutation', async () => {
  const rt = runtime({ returnAuditError: true }), before = clone(rt.rows);
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), error => error.code === 'DATABASE_REQUEST_FAILED');
  assert.deepEqual(rt.rows, before); assert.equal(rt.writes.length, 0);
});
for (const field of ['uid', 'role', 'token', 'code', 'path', 'functionName', 'data', 'update', 'collection']) {
  test(`mutation rejects caller-controlled ${field} instead of forwarding arbitrary writes`, async () => {
    const rt = runtime(); await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt, { [field]: 'spoof' }), actor), code(42260));
    assert.equal(rt.writes.length, 0);
  });
}
test('missing trusted actor, stable request id or expectedVersion fails closed', async () => {
  const rt = runtime();
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), {}), code(40360));
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), { uid: actor.uid }), code(42260));
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt, { expectedVersion: undefined }), actor), code(42260));
  await assert.rejects(rt.service.execute('orders.refund', {}, actor), code(42260));
  assert.equal(rt.writes.length, 0);
});
test('duplicate business keys and inactive matchmakers cannot be reviewed', async () => {
  const rt = runtime(); rt.rows[C.matchmakers].push({ ...rt.rows[C.matchmakers][0], _id: 'duplicate' });
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), code(40960));
  rt.rows[C.matchmakers].pop(); rt.rows[C.matchmakers][0].status = 0;
  await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), code(40960));
});
test('a completed matchmaker review or disabled owner cannot be reviewed under a fresh request id', async () => {
  for (const corrupt of [rows => { rows[C.matchmakers][0].certificationStatus = 2; }, rows => { rows[C.matchmakers][0].certificationStatus = 1; },
    rows => { rows[C.users][0].status = 0; }, rows => { rows[C.users][0].mergedIntoUserId = 2; }]) {
    const rt = runtime(); corrupt(rt.rows);
    await assert.rejects(rt.service.execute('matchmakers.review', mmArgs(rt), actor), code(40960)); assert.equal(rt.writes.length, 0);
  }
});
for (const kind of ['identity', 'education', 'vehicle', 'property', 'assets']) {
  test(`${kind} approval binds the current application and updates only the controlled public summary`, async () => {
    const rt = runtime(); const result = await rt.service.execute('certifications.review', certArgs(rt, kind), actor);
    const record = rt.rows[C.certifications][0], profile = rt.rows[C.profiles][0];
    assert.equal(record.current[kind].status, 'approved'); assert.equal(record.applications[kind].status, 'approved');
    assert.equal(record.current[kind].reviewedBy.uid, actor.uid); assert.equal(record.current[kind].applicationId, `application-${kind}`);
    assert.equal(profile.showcaseCertification[kind].status, 'approved'); assert.equal(profile.assetCategoryConsent, true);
    assert.equal(profile.privateNotes, 'private-profile-value'); assert.equal(Object.hasOwn(profile.showcaseCertification[kind], 'evidenceReference'), false);
    assert.equal(result.version, versionFor('certifications', record, kind));
    const audit = JSON.stringify(rt.rows[C.audit]);
    for (const secret of ['offline-reference-private', 'internal-private-note', '本人可见反馈', 'cloud://fixture', 'encrypted-private', 'private-profile-value']) assert.equal(audit.includes(secret), false);
    if (kind === 'assets') assert.equal(record.current[kind].expiresAt, '2027-04-14T03:00:00.000Z');
  });
}
test('certification application id is mandatory and cannot approve an archived or another current application', async () => {
  const rt = runtime();
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt, 'identity', { applicationId: undefined }), actor), code(42260));
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt, 'identity', { applicationId: 'old-application' }), actor), code(40960));
  rt.rows[C.certifications][0].applications.identity.status = 'approved';
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt), actor), code(40960));
  assert.equal(rt.writes.length, 0);
});
test('certification material-owner binding and canonical owner are rechecked in the transaction', async () => {
  for (const corrupt of [row => { row.materials['material-identity'].applicationId = 'another-application'; },
    row => { row.materials['material-identity'].kind = 'assets'; }, row => { row.userId = 2; }]) {
    const rt = runtime(); corrupt(rt.rows[C.certifications][0]);
    await assert.rejects(rt.service.execute('certifications.review', certArgs(rt), actor), code(40960)); assert.equal(rt.writes.length, 0);
  }
});
test('changed materials after detail fetch invalidate the certification version', async () => {
  const rt = runtime({ beforeTransaction: rows => { rows[C.certifications][0].materials['material-identity'].fileID = 'cloud://another'; } });
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt), actor), code(40960));
});
test('rejecting a renewal keeps the previous effective approval and its public summary', async () => {
  const rt = runtime(); const current = { status: 'approved', source: 'identity_document', reviewedAt: BEFORE, evidenceReference: 'prior-private-reference' };
  rt.rows[C.certifications][0].current.identity = current;
  await rt.service.execute('certifications.review', certArgs(rt, 'identity', { status: 'rejected', source: '', evidenceReference: '' }), actor);
  assert.deepEqual(rt.rows[C.certifications][0].current.identity, current);
  assert.equal(rt.rows[C.certifications][0].applications.identity.status, 'rejected');
  assert.equal(rt.rows[C.profiles][0].showcaseCertification.identity.status, 'approved');
});
test('revocation of the current bound application removes approval without deleting evidence', async () => {
  const rt = runtime(); rt.rows[C.certifications][0].applications.identity.status = 'approved';
  rt.rows[C.certifications][0].current.identity = { status: 'approved', source: 'identity_document' };
  await rt.service.execute('certifications.review', certArgs(rt, 'identity', { status: 'revoked', evidenceReference: '' }), actor);
  assert.equal(rt.rows[C.profiles][0].showcaseCertification.identity.status, 'revoked');
  assert.equal(rt.rows[C.certifications][0].materials['material-identity'].status, 'bound');
});
test('rejecting a renewal cannot resurrect a revoked canonical certification from a stale profile', async () => {
  const rt = runtime();
  rt.rows[C.certifications][0].current.identity = { status: 'revoked', source: 'identity_document' };
  rt.rows[C.profiles][0].showcaseCertification = { policyVersion: 1, identity: { status: 'approved', source: 'identity_document' } };
  await rt.service.execute('certifications.review', certArgs(rt, 'identity', { status: 'rejected', evidenceReference: '' }), actor);
  assert.equal(rt.rows[C.certifications][0].current.identity.status, 'rejected');
  assert.equal(rt.rows[C.profiles][0].showcaseCertification.identity.status, 'rejected');
});
test('invalid certification conclusions and cross-kind fields cannot bypass existing policy', async () => {
  const rt = runtime();
  for (const patch of [{ evidenceReference: '' }, { source: 'bank_statement' }, { feedback: 'x'.repeat(501) }, { educationLevel: '硕士' }, { remark: {} }]) {
    await assert.rejects(rt.service.execute('certifications.review', certArgs(rt, 'identity', patch), actor), code(42260));
  }
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt, 'education', { educationLevel: '高中' }), actor), code(42260));
  await assert.rejects(rt.service.execute('certifications.review', certArgs(rt, 'assets', { financialAssetRange: 'unknown' }), actor), code(42260));
});
test('certification and profile writes roll back together on a profile or audit failure', async () => {
  for (const options of [{ failProfileWrite: true }, { failAuditWrite: true }]) {
    const rt = runtime(options), before = clone(rt.rows);
    await assert.rejects(rt.service.execute('certifications.review', certArgs(rt), actor)); assert.deepEqual(rt.rows, before);
  }
});
test('inactive, merged or ambiguous member profiles cannot receive certification', async () => {
  for (const corrupt of [rows => { rows[C.users][0].status = 0; }, rows => { rows[C.users][0].mergedIntoUserId = 9; },
    rows => { rows[C.profiles].push({ ...rows[C.profiles][0], _id: 'duplicate-profile' }); }]) {
    const rt = runtime(); corrupt(rt.rows);
    await assert.rejects(rt.service.execute('certifications.review', certArgs(rt), actor), code(40960));
  }
});
test('salon opening and rejection honor existing state and date rules', async () => {
  const rt = runtime(); await rt.service.execute('salons.review', salonArgs(rt), actor);
  assert.equal(rt.rows[C.salons][0].status, 'upcoming');
  await rt.service.execute('salons.review', salonArgs(rt, { status: 'rejected' }), { ...actor, requestId: 'operation-00002' });
  assert.equal(rt.rows[C.salons][0].status, 'rejected');
  for (const patch of [{ status: 'cancelled' }, { status: 'ended' }, { eventDate: NOW }, { eventDate: 'invalid' }]) {
    const other = runtime(); Object.assign(other.rows[C.salons][0], patch);
    await assert.rejects(other.service.execute('salons.review', salonArgs(other), actor), code(40960));
  }
});
test('salon cancellation is atomic and does not perform refunds, attendance rewrites or unrelated writes', async () => {
  const rt = runtime(); const { status, ...args } = salonArgs(rt);
  await rt.service.execute('salons.cancel', { ...args, reason: 'private cancellation reason' }, actor);
  assert.equal(rt.rows[C.salons][0].status, 'cancelled');
  assert.deepEqual(rt.writes.map(row => row.name), [C.salons, C.audit]);
  assert.equal(JSON.stringify(rt.rows[C.audit]).includes('private cancellation reason'), false);
  await assert.rejects(rt.service.execute('salons.cancel', { ...args, expectedVersion: versionFor('salons', rt.rows[C.salons][0]) }, { ...actor, requestId: 'operation-00002' }), code(40960));
});
test('a legacy row without updatedAt is still protected by its canonical state version', async () => {
  const rt = runtime(); delete rt.rows[C.matchmakers][0].updatedAt;
  const args = mmArgs(rt); rt.rows[C.matchmakers][0].certificationRemark = 'edited after read';
  await assert.rejects(rt.service.execute('matchmakers.review', args, actor), code(40960));
});
test('canonical plan switches change active only and never touch fixed product or payment configuration', async () => {
  const rt = runtime(), before = clone(rt.rows[C.plans][0]);
  const result = await rt.service.execute('plans.update', planArgs(rt), actor);
  assert.equal(result.active, false); assert.equal(result.version, versionFor('plans', rt.rows[C.plans][0]));
  for (const field of ['planCode', 'title', 'amountFen', 'durationDays', 'productType', 'serviceCount']) assert.deepEqual(rt.rows[C.plans][0][field], before[field]);
  assert.deepEqual(rt.writes.map(row => row.name), [C.plans, C.audit]);
});
test('unpersisted default plans are created atomically at their fixed canonical document key', async () => {
  const rt = runtime(); rt.rows[C.plans] = [];
  await rt.service.execute('plans.update', planArgs(rt), actor);
  const row = rt.rows[C.plans][0];
  assert.equal(row._id, 'plan_vip_week'); assert.equal(row.active, false); assert.equal(row.amountFen, 6160);
  assert.equal(row.durationDays, 7); assert.equal(row.productType, 'vip');
});
test('a plan created concurrently after detail fetch cannot overwrite the other change', async () => {
  const rt = runtime({ beforeTransaction: rows => { rows[C.plans].push({ ...DEFAULT_MEMBERSHIP_PLANS[0], _id: 'plan_vip_week', active: false, updatedAt: NOW }); } });
  rt.rows[C.plans] = [];
  await assert.rejects(rt.service.execute('plans.update', planArgs(rt), actor), code(40960)); assert.equal(rt.writes.length, 0);
});
test('retired, test and arbitrary plan codes, price changes and coerced boolean flags are rejected', async () => {
  const rt = runtime();
  for (const patch of [{ planCode: 'matchmaking_month' }, { planCode: 'payment_probe' }, { planCode: 'custom' }, { active: 'false' }, { active: 1 },
    { amountFen: 1 }, { amountFen: -1 }, { amountFen: Number.MAX_SAFE_INTEGER + 1 }, { title: 'changed' }, { durationDays: 999 }, { paymentReady: true }]) {
    await assert.rejects(rt.service.execute('plans.update', planArgs(rt, patch), actor), code(42260));
  }
  assert.equal(rt.writes.length, 0);
});
test('first plan creation also rolls back if the required audit collection cannot be written', async () => {
  const rt = runtime({ failAuditWrite: true }); rt.rows[C.plans] = [];
  await assert.rejects(rt.service.execute('plans.update', planArgs(rt), actor));
  assert.equal(rt.rows[C.plans].length, 0); assert.equal(rt.writes.length, 0);
});
test('a read-detail version for legacy string matchmaker and owner ids is accepted without changing identity fields', async () => {
  const rt = runtime(); Object.assign(rt.rows[C.matchmakers][0], { id: '31', userId: '1' }); rt.rows[C.users][0].id = '1';
  const detail = await createReadService({ db: rt.db, now: () => Date.parse(NOW) }).detailMatchmaker({ id: 31 });
  assert.equal(detail.version, versionFor('matchmakers', rt.rows[C.matchmakers][0]));
  await rt.service.execute('matchmakers.review', { id: detail.id, certificationStatus: 2, expectedVersion: detail.version }, actor);
  assert.equal(rt.rows[C.matchmakers][0].certificationStatus, 2); assert.equal(rt.rows[C.matchmakers][0].id, '31');
});
test('a read-detail version for a legacy string salon id resolves the same document in the mutation', async () => {
  const rt = runtime(); Object.assign(rt.rows[C.salons][0], { id: '41', organizerId: '1' }); rt.rows[C.users][0].id = '1';
  const detail = await createReadService({ db: rt.db, now: () => Date.parse(NOW) }).detailSalon({ id: 41 });
  const result = await rt.service.execute('salons.review', { id: detail.id, status: 'upcoming', expectedVersion: detail.version }, actor);
  assert.equal(result.version, versionFor('salons', rt.rows[C.salons][0])); assert.equal(rt.rows[C.salons][0].status, 'upcoming');
});
test('a certification detail version remains valid for string canonical owner, user and profile references', async () => {
  const rt = runtime(); rt.rows[C.users][0].id = '1'; rt.rows[C.profiles][0].userId = '1'; rt.rows[C.certifications][0].userId = '1';
  const detail = await createReadService({ db: rt.db, now: () => Date.parse(NOW) }).detailCertification({ userId: 1, kind: 'identity', applicationId: 'application-identity' });
  const result = await rt.service.execute('certifications.review', certArgs(rt, 'identity', { expectedVersion: detail.version }), actor);
  assert.equal(result.version, versionFor('certifications', rt.rows[C.certifications][0], 'identity'));
  assert.equal(rt.rows[C.profiles][0].showcaseCertification.identity.status, 'approved');
});
for (const table of [C.matchmakers, C.users, C.profiles, C.salons]) {
  test(`numeric/string duplicate primary keys in ${table} cannot evade mutation lookup`, async () => {
    const rt = runtime(), original = rt.rows[table][0];
    const field = table === C.profiles ? 'userId' : 'id';
    rt.rows[table].push({ ...clone(original), _id: `${original._id}-duplicate`, [field]: String(original[field]) });
    const action = table === C.profiles ? 'certifications.review' : table === C.salons ? 'salons.review' : 'matchmakers.review';
    const args = table === C.profiles ? certArgs(rt) : table === C.salons ? salonArgs(rt) : mmArgs(rt);
    await assert.rejects(rt.service.execute(action, args, actor), code(40960)); assert.equal(rt.writes.length, 0);
  });
}
test('a code-only plan uses its read version and normalizes only the equivalent planCode so activation reaches hlApi', async () => {
  const rt = runtime(), plan = rt.rows[C.plans][0];
  delete plan.planCode; delete plan.active; plan.code = 'vip_week';
  const detail = await createReadService({ db: rt.db, now: () => Date.parse(NOW) }).detailPlan({ planCode: 'vip_week' });
  assert.equal(detail.active, true); assert.equal(detail.version, versionFor('plans', plan));
  const result = await rt.service.execute('plans.update', { planCode: detail.planCode, active: false, expectedVersion: detail.version }, actor);
  assert.equal(rt.rows[C.plans].length, 1); assert.equal(plan._id, 'persisted-plan');
  assert.equal(plan.code, 'vip_week'); assert.equal(plan.planCode, 'vip_week'); assert.equal(plan.active, false); assert.equal(plan.amountFen, 6160);
  assert.deepEqual(result.changedFields, ['active', 'planCode']);
  assert.equal(rt.rows[C.audit][0].beforeStatus, 'active'); assert.equal(rt.rows[C.audit][0].afterStatus, 'inactive');
  assert.equal(result.version, versionFor('plans', plan));
});
test('the same plan document matched by both identity aliases is counted once', async () => {
  const rt = runtime(); rt.rows[C.plans][0].code = 'vip_week';
  await rt.service.execute('plans.update', planArgs(rt), actor);
  assert.equal(rt.rows[C.plans].length, 1); assert.equal(rt.rows[C.audit].length, 1);
  assert.deepEqual(rt.rows[C.audit][0].changedFields, ['active']);
});
test('a separate alias duplicate or contradictory plan identity is rejected before creating any plan', async () => {
  for (const corrupt of [rows => { rows[C.plans].push({ _id: 'alias-duplicate', code: 'vip_week', active: true }); },
    rows => { rows[C.plans][0].code = 'vip_month'; }]) {
    const rt = runtime(); corrupt(rt.rows);
    await assert.rejects(rt.service.execute('plans.update', planArgs(rt), actor), code(40960)); assert.equal(rt.writes.length, 0);
  }
});
test('persisted canonical plans without active are audited as enabled while the version stays based on the raw row', async () => {
  const rt = runtime(); delete rt.rows[C.plans][0].active;
  const detail = await createReadService({ db: rt.db }).detailPlan({ planCode: 'vip_week' });
  assert.equal(detail.version, versionFor('plans', rt.rows[C.plans][0]));
  await rt.service.execute('plans.update', { planCode: detail.planCode, active: false, expectedVersion: detail.version }, actor);
  assert.equal(rt.rows[C.audit][0].beforeStatus, 'active'); assert.equal(rt.rows[C.audit][0].afterStatus, 'inactive');
});
test('trusted UID syntax matches the authorizer while unsupported characters still fail closed', async () => {
  const rt = runtime(); const uid = 'admin_01@example.com:role-id';
  await rt.service.execute('matchmakers.review', mmArgs(rt), { ...actor, uid });
  assert.equal(rt.rows[C.audit][0].actor.uid, uid);
  for (const invalid of ['admin/user', 'admin user', '管理员', 'admin\n', '<admin>', 'a'.repeat(129)]) {
    const other = runtime(); await assert.rejects(other.service.execute('matchmakers.review', mmArgs(other), { ...actor, uid: invalid }), code(40360));
  }
});
