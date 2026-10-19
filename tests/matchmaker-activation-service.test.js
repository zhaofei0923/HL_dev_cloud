'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const apiPath = path.resolve(process.env.HL_API_TEST_PATH || path.join(__dirname, '../cloudfunctions/hlApi/index.js'));
const requireApi = createRequire(apiPath);
const { createMatchmakerActivationService, matchmakerActivationSnapshot, matchmakerActivationEligibility,
  MAX_ACTIVATION_GRANTS } = requireApi('./matchmaker-activation-service');
const { MATCHMAKER_LIFETIME_PLAN } = requireApi('./membership-payment-policy');
const { DIRECT_PURCHASE_CONTRACT } = requireApi('./purchase-contract-policy');
const NOW = '2026-10-19T12:00:00.000Z';
const LATER = '2026-10-20T12:00:00.000Z';
const clone = value => structuredClone(value);

function fixture(settings = {}) {
  const rows = { hl_users: { u7: { _id: 'u7', id: 7, status: 1, openid: 'openid-seven', phone: '13800138000',
    isVerified: false, currentRole: 'member', authVersion: 4 } },
  hl_matchmakers: { mm9: { _id: 'mm9', id: 9, userId: 7, status: 1, certificationStatus: 0,
    certificationRemark: '', level: 3, parentId: 17, teamId: 81, hasStore: 1, totalPerformance: 198000,
    inviteCode: 'INVITE7', updatedAt: '2026-10-19T11:00:00.000Z' } },
  hl_members: { member7: { id: 18, userId: 7, matchmakerId: 19, memberType: 'vip', expireAt: null } },
  hl_member_certifications: { certification7: { userId: 7, current: null, applications: [] } },
  ...(settings.rows ? clone(settings.rows) : {}) };
  const versions = new Map(), writes = [], reads = [];
  let retries = 0, gateReads = 0, releaseGate, beforeCommitCalled = false;
  const gate = settings.race ? new Promise(resolve => { releaseGate = resolve; }) : null;
  const key = (collection, id) => `${collection}/${id}`;
  const replace = (collection, id, patch) => {
    rows[collection][id] = { ...rows[collection][id], ...clone(patch) };
    versions.set(key(collection, id), (versions.get(key(collection, id)) || 0) + 1);
  };
  const db = { collection() { throw new Error('nontransactional reads are forbidden'); }, async runTransaction(callback) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const store = clone(rows), readVersions = new Map(), staged = [], originalVersions = new Map(versions);
      const transaction = { collection: collection => ({ doc: id => ({ async get() {
        reads.push({ collection, id });
        readVersions.set(key(collection, id), originalVersions.get(key(collection, id)) || 0);
        if (settings.readError) throw settings.readError;
        if (settings.readResultError) return { errCode: -501000 };
        if (gate && collection === 'hl_matchmakers' && ++gateReads <= 2) {
          if (gateReads === 2) releaseGate();
          await gate;
        }
        return { data: clone(store[collection]?.[id] || null) };
      }, async update({ data }) {
        if (settings.writeResultError) return { errCode: -501000 };
        if (!store[collection]?.[id]) throw new Error('document does not exist');
        store[collection][id] = { ...store[collection][id], ...clone(data) };
        staged.push({ collection, id, data: clone(data) });
        return { updated: 1 };
      } }) }) };
      const result = await callback(transaction);
      if (settings.beforeCommit && !beforeCommitCalled) {
        beforeCommitCalled = true;
        settings.beforeCommit({ rows, replace });
      }
      if ([...readVersions].some(([id, version]) => (versions.get(id) || 0) !== version)) { retries++; continue; }
      staged.forEach(change => { replace(change.collection, change.id, change.data); writes.push(change); });
      return result;
    }
    throw new Error('transaction retry limit');
  } };
  const order = (number = 'matchmaker_order_01') => ({ ...MATCHMAKER_LIFETIME_PLAN,
    outTradeNo: number, userId: 7, matchmakerId: 9, userDocumentId: 'u7', matchmakerDocumentId: 'mm9',
    matchmakerAuthorizationSnapshot: matchmakerActivationSnapshot(rows.hl_matchmakers.mm9),
    payerOpenid: 'openid-seven', fulfillmentContract: DIRECT_PURCHASE_CONTRACT, status: 'confirming' });
  const service = createMatchmakerActivationService({ db });
  return { rows, writes, reads, replace, order, service, retries: () => retries,
    fulfill: (input = order(), timestamp = NOW) => db.runTransaction(tx => service.fulfill(tx, input, timestamp)),
    refund: (input, timestamp = LATER) => db.runTransaction(tx => service.refund(tx, input, timestamp)) };
}

test('verified lifetime purchase approves only its role, preserves all member and organization data', async () => {
  const rt = fixture(), before = clone(rt.rows), result = await rt.fulfill();
  assert.equal(result.fulfilled, true); assert.equal(result.requiresReview, false);
  const row = rt.rows.hl_matchmakers.mm9;
  assert.equal(row.certificationStatus, 2); assert.equal(row.activationSource, 'paid');
  assert.equal(row.activationStatus, 'active'); assert.equal(row.activationLifetime, true); assert.equal(row.activationExpireAt, null);
  for (const field of ['level', 'parentId', 'teamId', 'hasStore', 'totalPerformance', 'inviteCode']) {
    assert.equal(row[field], before.hl_matchmakers.mm9[field]);
  }
  assert.deepEqual(rt.rows.hl_users, before.hl_users);
  assert.deepEqual(rt.rows.hl_members, before.hl_members);
  assert.deepEqual(rt.rows.hl_member_certifications, before.hl_member_certifications);
  assert.deepEqual(rt.writes.map(write => write.collection), ['hl_matchmakers']);
  assert.equal(row.activationGrants.length, 1);
});

test('same callback never extends or duplicates the lifetime grant', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order);
  const row = clone(rt.rows.hl_matchmakers.mm9), result = await rt.fulfill(order, LATER);
  assert.equal(result.idempotent, true); assert.equal(result.fulfilled, true);
  assert.deepEqual(rt.rows.hl_matchmakers.mm9, row); assert.equal(rt.writes.length, 1);
});

test('different simultaneous paid orders cannot overwrite or double grant a role', async () => {
  const rt = fixture({ race: true }), first = rt.order('matchmaker_order_01'), second = rt.order('matchmaker_order_02');
  const results = await Promise.all([rt.fulfill(first), rt.fulfill(second)]);
  assert.equal(results.filter(result => result.fulfilled).length, 1);
  assert.equal(results.filter(result => result.requiresReview).length, 1);
  assert.equal(rt.rows.hl_matchmakers.mm9.activationGrants.length, 1);
  assert.equal(rt.writes.length, 1); assert.ok(rt.retries() >= 1);
});

for (const [label, patch] of [
  ['administrator rejection', { certificationStatus: 1, certificationRemark: '拒绝' }],
  ['administrator revocation', { certificationStatus: 0, activationStatus: 'revoked', activationSource: 'manual' }],
  ['administrator approval', { certificationStatus: 2, certificationRemark: '人工通过' }],
  ['disabled application', { status: 0 }],
  ['changed application ownership', { userId: 8 }],
  ['changed application version', { updatedAt: LATER }]
]) test(`delayed payment preserves ${label} instead of approving stale application`, async () => {
  const rt = fixture(), order = rt.order();
  rt.replace('hl_matchmakers', 'mm9', patch);
  const before = clone(rt.rows.hl_matchmakers.mm9), result = await rt.fulfill(order);
  assert.equal(result.requiresReview, true); assert.equal(result.fulfilled, false);
  assert.deepEqual(rt.rows.hl_matchmakers.mm9, before); assert.equal(rt.writes.length, 0);
});

test('administrator revocation concurrent with payment wins after transaction conflict retry', async () => {
  const rt = fixture({ beforeCommit: ({ replace }) => replace('hl_matchmakers', 'mm9', {
    certificationStatus: 1, certificationRemark: '停用', updatedAt: LATER }) });
  const result = await rt.fulfill();
  assert.equal(result.requiresReview, true); assert.equal(rt.rows.hl_matchmakers.mm9.certificationStatus, 1);
  assert.equal(rt.writes.length, 0); assert.equal(rt.retries(), 1);
});

for (const patch of [{ status: 0 }, { mergedIntoUserId: 9 }, { openid: 'other-openid' }, { id: 8 }]) {
  test(`inactive, merged, replaced or different payer account does not obtain role ${JSON.stringify(patch)}`, async () => {
    const rt = fixture(), order = rt.order();
    rt.replace('hl_users', 'u7', patch);
    const result = await rt.fulfill(order);
    assert.equal(result.requiresReview, true); assert.equal(result.reviewReason, 'account_changed');
    assert.equal(rt.writes.length, 0);
  });
}

test('a callback after administrator revoked an already paid role never restores it', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order);
  rt.replace('hl_matchmakers', 'mm9', { certificationStatus: 0, activationStatus: 'revoked', activationSource: 'manual' });
  const result = await rt.fulfill(order, LATER);
  assert.equal(result.idempotent, true); assert.equal(result.requiresReview, true);
  assert.equal(rt.rows.hl_matchmakers.mm9.certificationStatus, 0); assert.equal(rt.writes.length, 1);
});

test('full refund removes only the paid role and returns pending approval without touching member rights', async () => {
  const rt = fixture(), order = rt.order(), before = clone(rt.rows);
  await rt.fulfill(order);
  const result = await rt.refund(order), row = rt.rows.hl_matchmakers.mm9;
  assert.equal(result.revoked, true); assert.equal(result.requiresReview, false);
  assert.equal(row.certificationStatus, 0); assert.equal(row.certificationRemark, '');
  assert.equal(row.activationStatus, 'refunded'); assert.equal(row.activationLifetime, false); assert.equal(row.activationExpireAt, null);
  assert.equal(row.activationGrants[0].status, 'refunded');
  assert.deepEqual(rt.rows.hl_users, before.hl_users); assert.deepEqual(rt.rows.hl_members, before.hl_members);
  assert.deepEqual(rt.rows.hl_member_certifications, before.hl_member_certifications);
});

test('refunded tombstone blocks delayed callback and duplicate refund from changing a later manual role', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order); await rt.refund(order);
  rt.replace('hl_matchmakers', 'mm9', { certificationStatus: 2, certificationRemark: '人工批准', activationSource: 'manual', activationStatus: 'manual' });
  const before = clone(rt.rows.hl_matchmakers.mm9), callback = await rt.fulfill(order, LATER), refund = await rt.refund(order);
  assert.equal(callback.requiresReview, true); assert.equal(refund.idempotent, true); assert.equal(refund.revoked, false);
  assert.deepEqual(rt.rows.hl_matchmakers.mm9, before); assert.equal(rt.writes.length, 2);
});

test('first refund preserves independent manual approval and organization data', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order);
  rt.replace('hl_matchmakers', 'mm9', { certificationStatus: 2, certificationRemark: '手工授权', activationSource: 'manual', activationStatus: 'manual', level: 5 });
  const result = await rt.refund(order), row = rt.rows.hl_matchmakers.mm9;
  assert.equal(result.revoked, false); assert.equal(row.certificationStatus, 2);
  assert.equal(row.certificationRemark, '手工授权'); assert.equal(row.activationSource, 'manual'); assert.equal(row.level, 5);
  assert.equal(row.activationGrants[0].status, 'refunded');
});

test('refund after administrator rejection keeps rejection and removes the paid grant', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order);
  rt.replace('hl_matchmakers', 'mm9', { certificationStatus: 1, certificationRemark: '人工拒绝' });
  const result = await rt.refund(order), row = rt.rows.hl_matchmakers.mm9;
  assert.equal(result.revoked, false); assert.equal(row.certificationStatus, 1); assert.equal(row.certificationRemark, '人工拒绝');
  assert.equal(row.activationGrants[0].status, 'refunded');
});

test('refund of an unfulfilled payment has no role or VIP grant to remove', async () => {
  const rt = fixture(), order = rt.order(), before = clone(rt.rows);
  const result = await rt.refund(order);
  assert.equal(result.idempotent, true); assert.equal(result.revoked, false); assert.equal(result.requiresReview, false);
  assert.deepEqual(rt.rows, before); assert.equal(rt.writes.length, 0);
});

test('another order refund cannot revoke the current paid role', async () => {
  const rt = fixture(), first = rt.order(), other = rt.order('matchmaker_order_99');
  await rt.fulfill(first);
  const before = clone(rt.rows.hl_matchmakers.mm9), result = await rt.refund(other);
  assert.equal(result.revoked, false); assert.deepEqual(rt.rows.hl_matchmakers.mm9, before);
});

for (const patch of [{ amountFen: 6980 }, { durationDays: 36500 }, { lifetime: 'true' }, { productType: 'vip' },
  { fulfillmentContract: undefined }, { matchmakerId: 0 }, { userDocumentId: '' }, { matchmakerAuthorizationSnapshot: '' }]) {
  test(`invalid immutable payment contract is rejected ${JSON.stringify(patch)}`, async () => {
    const rt = fixture(), order = { ...rt.order(), ...patch };
    await assert.rejects(rt.fulfill(order), error => [40001, 40907].includes(error.code));
    assert.equal(rt.writes.length, 0);
  });
}

test('legacy manually approved role remains eligible for use and cannot be charged again', async () => {
  const rt = fixture();
  rt.replace('hl_matchmakers', 'mm9', { certificationStatus: 2 });
  const eligibility = matchmakerActivationEligibility(rt.rows.hl_users.u7, rt.rows.hl_matchmakers.mm9), result = await rt.fulfill();
  assert.equal(eligibility.eligible, false); assert.equal(eligibility.reason, 'matchmaker_already_active');
  assert.equal(result.requiresReview, true); assert.equal(rt.writes.length, 0);
});

test('bounded grant ledger fails closed instead of dropping refund and revocation tombstones', async () => {
  const rt = fixture();
  rt.replace('hl_matchmakers', 'mm9', { activationGrants: Array.from({ length: MAX_ACTIVATION_GRANTS }, (_, i) => ({
    orderNo: `matchmaker_old_${String(i).padStart(2, '0')}`, status: 'refunded', previousCertificationStatus: 0,
    previousCertificationRemark: '', grantedAt: NOW, refundedAt: LATER })) });
  const result = await rt.fulfill();
  assert.equal(result.requiresReview, true); assert.equal(result.reviewReason, 'matchmaker_activation_ledger_limit');
  assert.equal(rt.rows.hl_matchmakers.mm9.activationGrants.length, MAX_ACTIVATION_GRANTS); assert.equal(rt.writes.length, 0);
});

test('storage failures abort instead of being treated as a missing application or successful activation', async () => {
  for (const settings of [{ readError: Object.assign(new Error('document not found'), { code: 'DATABASE_PERMISSION_DENIED' }) },
    { readResultError: true }, { writeResultError: true }]) {
    const rt = fixture(settings);
    await assert.rejects(rt.fulfill());
    assert.equal(rt.rows.hl_matchmakers.mm9.certificationStatus, 0); assert.equal(rt.writes.length, 0);
  }
});

test('a missing ledger for a currently owned paid grant requires refund review', async () => {
  const rt = fixture(), order = rt.order();
  await rt.fulfill(order); delete rt.rows.hl_matchmakers.mm9.activationGrants;
  const result = await rt.refund(order);
  assert.equal(result.requiresReview, true); assert.equal(result.revoked, false);
  assert.equal(rt.rows.hl_matchmakers.mm9.certificationStatus, 2);
});
