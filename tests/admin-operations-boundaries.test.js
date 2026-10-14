'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { versionFor } = require('../cloudfunctions/hlAdminOperations/contracts');
const { createMaterialService } = require('../cloudfunctions/hlAdminOperations/material-service');
const { sealMaterial, sealVerification, openMaterial, openVerification } = require('../cloudfunctions/hlApi/certification-material-policy');

const JWT = 'fixture-signing-key-do-not-use-in-production-42';
const derived = 'hex:' + createHmac('sha256', Buffer.from(JWT)).update('hl.member-certification.encryption.jwt-derived.v1').digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 10]);
const ctx = { userId: 2, kind: 'identity', id: 'material_fixture' };

function fixture() {
  let record = { _id: 'user_2', userId: 2, updatedAt: '2026-10-14T00:00:00Z',
    applications: { identity: { requestId: 'app_fixture', status: 'pending', materialIds: ['material_fixture'],
      sealedVerification: sealVerification({ verificationCode: 'private-code' }, { ...ctx, id: 'app_fixture' }, { jwtSecret: JWT }) } },
    current: {}, materials: { material_fixture: { id: 'material_fixture', kind: 'identity', applicationId: 'app_fixture',
      status: 'bound', mimeType: 'image/png', size: png.length, fileID: 'cloud://fixture/secret.enc', createdAt: '2026-10-14T00:00:00Z' } } };
  const state = { audits: [], downloads: [], active: true, auditFails: false, mutateOnDownload: false,
    users: [{ _id: 'owner_fixture', id: 2, status: 1 }], ownerReads: [] };
  const db = { collection(name) {
    let query, maximum = 100;
    return { where(value) { query = value; return this; }, field() { return this; }, limit(value) { maximum = value; return this; }, async get() {
      assert.equal(name, 'hl_users'); state.ownerReads.push(query);
      return { data: state.active ? structuredClone(state.users.filter(user => user.id === query.id).slice(0, maximum)) : [] };
    },
      doc(id) { return { field() { return this; }, async get() { assert.equal(id, 'user_2'); return { data: [structuredClone(record)] }; }, async set(data) {
        assert.equal(name, 'hl_admin_audit_logs'); if (state.auditFails) throw new Error('audit unavailable'); assert.equal(data.data, undefined); state.audits.push(data); return {};
      } }; } };
  } };
  const args = () => ({ userId: 2, kind: 'identity', applicationId: 'app_fixture', expectedVersion: versionFor('certifications', record, 'identity'), materialId: 'material_fixture' });
  const service = createMaterialService({ db, secrets: { jwtDerivedKey: derived }, async downloadFile(value) {
    state.downloads.push(value); if (state.mutateOnDownload) record.updatedAt = '2026-10-14T00:01:00Z';
    return { fileContent: sealMaterial(png, ctx, { jwtSecret: JWT }) };
  } });
  return { state, service, args, get record() { return record; } };
}
const actor = { uid: 'platform-admin', serverRequestId: 'server-generated-fixture' };

test('version tokens are deterministic, resource-bound and ignore unrelated profile data', () => {
  const row = { id: 1, status: 1, certificationStatus: 0, updatedAt: 'timestamp' };
  assert.equal(versionFor('matchmakers', row), versionFor('matchmakers', { unrelated: 'ignored', ...row }));
  assert.notEqual(versionFor('matchmakers', row), versionFor('matchmakers', { ...row, certificationStatus: 2 }));
  assert.notEqual(versionFor('matchmakers', row), versionFor('salons', row));
  assert.equal(versionFor('plans', { code: 'vip_week' }), versionFor('plans', { planCode: 'vip_week' }));
});

test('derived decryption key opens legacy envelopes without giving the service a JWT signing secret', () => {
  const encrypted = sealMaterial(png, ctx, { jwtSecret: JWT });
  assert.deepEqual(openMaterial(encrypted, ctx, { jwtDerivedKey: derived }), png);
  const verification = sealVerification({ verificationCode: 'private' }, ctx, { jwtSecret: JWT });
  assert.deepEqual(openVerification(verification, ctx, { jwtDerivedKey: derived }), { verificationCode: 'private' });
  assert.throws(() => openMaterial(encrypted, { ...ctx, id: 'different' }, { jwtDerivedKey: derived }));
  assert.throws(() => openMaterial(encrypted, ctx, { jwtDerivedKey: 'hex:' + '00'.repeat(32) }));
});

test('selected bound material is decrypted only after version, owner and binding checks and has a metadata-only audit', async () => {
  const f = fixture(); const response = await f.service.material(f.args(), actor);
  assert.equal(response.contentBase64, png.toString('base64'));
  assert.equal(response.mimeType, 'image/png'); assert.equal(response.fileID, undefined);
  assert.equal(f.state.downloads.length, 1); assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].actor.uid, actor.uid);
  const audit = JSON.stringify(f.state.audits[0]);
  assert.ok(!audit.includes('cloud://') && !audit.includes('private-code') && !audit.includes(response.contentBase64));
});

test('unbound, foreign-application and stale materials never reach cloud storage', async () => {
  for (const patch of [{ applicationId: 'different' }, { status: 'staging' }, { kind: 'assets' }]) {
    const f = fixture(); Object.assign(f.record.materials.material_fixture, patch);
    await assert.rejects(f.service.material(f.args(), actor), e => e.code === 40960); assert.equal(f.state.downloads.length, 0);
  }
  const f = fixture(); const args = f.args(); f.record.updatedAt = 'changed';
  await assert.rejects(f.service.material(args, actor), e => e.code === 40960); assert.equal(f.state.downloads.length, 0);
});

test('account changes, evidence races and audit failures cannot return plaintext', async () => {
  const inactive = fixture(); inactive.state.active = false;
  await assert.rejects(inactive.service.material(inactive.args(), actor), e => e.code === 40960);
  const raced = fixture(); raced.state.mutateOnDownload = true;
  await assert.rejects(raced.service.material(raced.args(), actor), e => e.code === 40960); assert.equal(raced.state.audits.length, 0);
  const failed = fixture(); failed.state.auditFails = true;
  await assert.rejects(failed.service.material(failed.args(), actor));
});

test('sensitive verification is explicit, allowlisted and audited independently of images', async () => {
  const f = fixture(); const { materialId, ...args } = f.args();
  const result = await f.service.evidence(args, actor);
  assert.equal(result.verificationCode, 'private-code'); assert.equal(f.state.downloads.length, 0);
  assert.equal(result.sealedVerification, undefined); assert.equal(f.state.audits[0].action, 'certifications.evidence');
  await assert.rejects(f.service.evidence({ ...args, arbitrary: true }, actor), e => e.code === 42260);
});

test('a unique active string owner id can read current bound materials and verification with the original record version', async () => {
  for (const method of ['material', 'evidence']) {
    const f = fixture(); f.state.users[0].id = '2';
    const input = f.args(); if (method === 'evidence') delete input.materialId;
    const result = await f.service[method](input, actor);
    assert.equal(method === 'material' ? result.contentBase64 : result.verificationCode,
      method === 'material' ? png.toString('base64') : 'private-code');
    assert.equal(f.state.audits.length, 1);
    assert.deepEqual(f.state.ownerReads, [{ id: 2 }, { id: '2' }, { id: 2 }, { id: '2' }]);
  }
});

test('numeric and string duplicate owner ids are rejected before materials or verification can leave the service', async () => {
  for (const method of ['material', 'evidence']) {
    for (const duplicateStatus of [0, 1]) {
      const f = fixture(); f.state.users.push({ _id: 'owner_string_duplicate', id: '2', status: duplicateStatus });
      const input = f.args(); if (method === 'evidence') delete input.materialId;
      await assert.rejects(f.service[method](input, actor), failure => failure.code === 40960);
      assert.equal(f.state.downloads.length, 0); assert.equal(f.state.audits.length, 0);
    }
  }
});
