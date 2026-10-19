'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sealMaterial, openMaterial, sealVerification, openVerification } = require('../cloudfunctions/hlApi/certification-material-policy');
const keyPolicy = import('../scripts/admin-operations-key-policy.mjs');
const rebuild = import('../scripts/prepare-admin-entry-rebuild.mjs');
const OLD = 'legacy-fixture-login-secret-at-least-32-characters';
const NEW = 'new-fixture-login-secret-at-least-32-characters';
const KEY = 'hex:' + createHmac('sha256', OLD).update('hl.member-certification.encryption.jwt-derived.v1').digest('hex');
const context = { userId: 17, kind: 'education', id: 'compatibility_fixture' };
const pdf = Buffer.from('%PDF-private-fixture');
const verification = { verificationCode: 'private-fixture', certificateNumber: 'private-number' };

test('retained legacy key opens real old-JWT material and verification envelopes after login-key rotation', () => {
  const binary = sealMaterial(pdf, context, { jwtSecret: OLD });
  const sealed = sealVerification(verification, context, { jwtSecret: OLD });
  const current = { jwtSecret: NEW, jwtDerivedKey: KEY };
  assert.deepEqual(openMaterial(binary, context, current), pdf);
  assert.deepEqual(openVerification(sealed, context, current), verification);
  assert.equal(JSON.parse(binary).keySource, 'jwt-derived-v1');
  const next = sealVerification(verification, context, current);
  assert.equal(next.keySource, 'jwt-derived-v1');
  assert.deepEqual(openVerification(next, context, { jwtDerivedKey: KEY }), verification);
});

test('retained-key compatibility does not bypass source authentication, context or an incorrect domain key', () => {
  const binary = sealMaterial(pdf, context, { jwtSecret: OLD });
  const envelope = JSON.parse(binary);
  const sameBytesDedicated = { jwtDerivedKey: KEY, encryptionKey: KEY, jwtSecret: NEW };
  assert.throws(() => openMaterial(Buffer.from(JSON.stringify({ ...envelope, keySource: 'dedicated' })), context, sameBytesDedicated), error => error.code === 42240);
  assert.throws(() => openMaterial(binary, context, { jwtSecret: NEW, jwtDerivedKey: 'hex:' + '00'.repeat(32) }), error => error.code === 42240);
  assert.throws(() => openMaterial(binary, { ...context, userId: 18 }, sameBytesDedicated), error => error.code === 42240);
  assert.throws(() => openMaterial(binary, context, { jwtSecret: NEW, jwtDerivedKey: '[REDACTED]' }), error => error.code === 50340);
});

test('administrative deployments prefer the explicit legacy key over a replacement JWT and never copy signing secrets', async () => {
  const { certificationEnvironment } = await keyPolicy;
  const current = { JWT_SECRET: NEW, MEMBER_CERTIFICATION_JWT_DERIVED_KEY: KEY };
  assert.deepEqual(certificationEnvironment(current), { MEMBER_CERTIFICATION_JWT_DERIVED_KEY: KEY });
  assert.equal(Object.hasOwn(certificationEnvironment(current), 'JWT_SECRET'), false);
  assert.deepEqual(certificationEnvironment({ JWT_SECRET: OLD }), { MEMBER_CERTIFICATION_JWT_DERIVED_KEY: KEY });
  for (const invalid of ['[REDACTED]', '***', 'hex:short', 'base64:broken']) {
    assert.throws(() => certificationEnvironment({ JWT_SECRET: NEW, MEMBER_CERTIFICATION_JWT_DERIVED_KEY: invalid }));
  }
});

function fixtureFiles(newline = '\n') {
  return [
    { name: 'index.js', bytes: Buffer.from(['function certificationSecrets() {',
      '  return { encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY, jwtSecret: process.env.JWT_SECRET };', '}', 'exports.fixture = certificationSecrets;'].join(newline)) },
    { name: 'certification-material-policy.js', bytes: Buffer.from(fs.readFileSync(path.join(__dirname,
      '../cloudfunctions/hlApi/certification-material-policy.js'), 'utf8').replace(
      "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey)\r\n    : secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret), keySource: source };",
      "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey) : derivedKey(secrets.jwtSecret), keySource: source };").replace(
      "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey)\n    : secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret), keySource: source };",
      "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey) : derivedKey(secrets.jwtSecret), keySource: source };")) },
    { name: 'package.json', bytes: Buffer.from('{"name":"immutable-fixture"}') },
    { name: 'node_modules/fixture/binary.dat', bytes: Buffer.from([0, 1, 255, 127]) }
  ];
}

test('cloud-package compatibility patch changes only the two approved files and leaves its input immutable', async () => {
  const { patchCompatibility, inventory } = await rebuild;
  const files = fixtureFiles(), before = inventory(files), patched = patchCompatibility(files), after = inventory(patched);
  assert.deepEqual(inventory(files), before);
  assert.equal(patched.length, files.length);
  assert.deepEqual(after.filter(file => before.find(old => old.name === file.name).sha256 !== file.sha256).map(file => file.name),
    ['certification-material-policy.js', 'index.js']);
  assert.ok(patched.find(file => file.name.endsWith('binary.dat')).bytes.equals(files.find(file => file.name.endsWith('binary.dat')).bytes));
  const module = { exports: {} };
  vm.runInNewContext(patched.find(file => file.name === 'index.js').bytes.toString(), { exports: module.exports,
    process: { env: { JWT_SECRET: NEW, MEMBER_CERTIFICATION_JWT_DERIVED_KEY: KEY } } });
  assert.equal(module.exports.fixture().jwtDerivedKey, KEY);
  const policyModule = { exports: {} };
  vm.runInNewContext(patched.find(file => file.name === 'certification-material-policy.js').bytes.toString(),
    { require, Buffer, module: policyModule, exports: policyModule.exports });
  const old = sealMaterial(pdf, context, { jwtSecret: OLD });
  assert.deepEqual(policyModule.exports.openMaterial(old, context, { jwtSecret: NEW, jwtDerivedKey: KEY }), pdf);
});

test('patch anchors reject drift, duplicate matches and a second application while preserving CRLF', async () => {
  const { patchCompatibility } = await rebuild;
  const files = fixtureFiles('\r\n'), patched = patchCompatibility(files);
  assert.ok(patched[0].bytes.toString().includes('\r\n    jwtDerivedKey:'));
  assert.throws(() => patchCompatibility(patched), /PATCH_ANCHOR_MISMATCH/);
  for (const replacement of [Buffer.from('changed getter'), Buffer.concat([files[0].bytes, files[0].bytes])]) {
    assert.throws(() => patchCompatibility([{ ...files[0], bytes: replacement }, ...files.slice(1)]), /PATCH_ANCHOR_MISMATCH/);
  }
});

test('root ZIP preserves every dependency byte and accepts a single hlApi wrapper directory', async () => {
  const { readZip, rootZip, inventory } = await rebuild;
  const files = fixtureFiles();
  assert.deepEqual(inventory(readZip(rootZip(files))), inventory(files));
  assert.deepEqual(inventory(readZip(rootZip(files.map(file => ({ ...file, name: 'hlApi/' + file.name }))))), inventory(files));
  assert.throws(() => rootZip([...files, { name: '../outside', bytes: Buffer.from('bad') }]), /ZIP_PATH_INVALID/);
  assert.throws(() => rootZip([...files, { name: 'C:outside', bytes: Buffer.from('bad') }]), /ZIP_PATH_INVALID/);
  assert.throws(() => rootZip([...files, { name: 'INDEX.js', bytes: Buffer.from('bad') }]), /ZIP_INVALID/);
  const corrupted = Buffer.from(rootZip(files));
  corrupted[14] ^= 1;
  assert.throws(() => readZip(corrupted), /ZIP_INVALID/);
  const corruptedData = Buffer.from(rootZip(files)); corruptedData[50] ^= 0xff;
  assert.throws(() => readZip(corruptedData));
  const symlink = { name: 'node_modules/.bin/fixture', bytes: Buffer.from('../fixture/cli.js'),
    externalAttributes: (0xa1ff << 16) >>> 0, madeBy: 0x0314 };
  assert.deepEqual(inventory(readZip(rootZip([...files, symlink]))), inventory([...files, symlink]));
  assert.throws(() => rootZip([...files, { ...symlink, bytes: Buffer.from('../../../outside') }]), /ZIP_LINK_INVALID/);
});
