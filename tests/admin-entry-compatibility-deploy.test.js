'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const deployment = import('../scripts/deploy-admin-entry-compatibility.mjs');

const detail = () => ({ FunctionName: 'hlApi', Namespace: 'cloud1-d2gza7q9c8d69c721', Type: 'Event', Runtime: 'Nodejs16.13',
  Handler: 'index.main', InstallDependency: 'TRUE', Timeout: 20, Role: 'fixture-role',
  Environment: { Variables: [{ Key: 'JWT_SECRET', Value: '[REDACTED]' }, { Key: 'PAYMENT_INTEGRATION_READY', Value: 'false' }] } });

test('code-only request fixes the function target and disables installation without passing any environment/configuration fields', async () => {
  const { codeUpdateArguments } = await deployment;
  const result = codeUpdateArguments({ cosBucketName: 'fixture-bucket', cosBucketRegion: 'ap-shanghai', cosObjectName: 'fixture.zip' });
  assert.deepEqual(result, { func: { name: 'hlApi', handler: 'index.main', installDependency: false },
    code: { CosBucketName: 'fixture-bucket', CosBucketRegion: 'ap-shanghai', CosObjectName: 'fixture.zip' }, deployMode: 'cos' });
  assert.doesNotMatch(JSON.stringify(result), /JWT_SECRET|Environment|envVariables|updateFunctionConfig/);
  assert.throws(() => codeUpdateArguments({ cosBucketName: 'fixture', cosBucketRegion: 'ap-guangzhou', cosObjectName: 'fixture.zip' }), /UPLOAD_SLOT_INVALID/);
});

test('protected digest checks allow only the explicit dependency flag change and reject environment or other configuration changes', async () => {
  const { protectedDigests, assertProtectedUnchanged } = await deployment;
  const original = detail(), before = protectedDigests(original);
  const after = { ...original, InstallDependency: 'FALSE', ModTime: 'new', CodeInfo: 'new source', Status: 'Active' };
  assert.doesNotThrow(() => assertProtectedUnchanged(before, protectedDigests(after)));
  assert.throws(() => assertProtectedUnchanged(before, protectedDigests(original)), /DEPENDENCY_INSTALL_NOT_DISABLED/);
  for (const patch of [{ Timeout: 21 }, { Role: 'different' },
    { Environment: { Variables: [{ Key: 'JWT_SECRET', Value: 'different' }] } }]) {
    assert.throws(() => assertProtectedUnchanged(before, protectedDigests({ ...after, ...patch })), /PROTECTED_CONFIGURATION_CHANGED/);
  }
});

test('configuration snapshots reject wrong targets and malformed duplicate environment entries', async () => {
  const { protectedDigests } = await deployment;
  for (const patch of [{ FunctionName: 'other' }, { Namespace: 'other' }, { Runtime: 'Nodejs20.19' }, { Handler: 'other.main' }]) {
    assert.throws(() => protectedDigests({ ...detail(), ...patch }), /FUNCTION_TARGET_MISMATCH/);
  }
  const value = detail(); value.Environment.Variables.push(value.Environment.Variables[0]);
  assert.throws(() => protectedDigests(value), /ENVIRONMENT_UNCONFIRMED/);
});

test('official upload-header arrays become fetch-compatible header records without altering their values', async () => {
  const { normalizedUploadHeaders } = await deployment;
  const expected = { 'x-cos-security-token': 'fixture-not-a-real-token' };
  assert.deepEqual(normalizedUploadHeaders([{ Key: 'x-cos-security-token', Value: 'fixture-not-a-real-token' }]), expected);
  assert.deepEqual(normalizedUploadHeaders([{ key: 'x-cos-security-token', value: 'fixture-not-a-real-token' }]), expected);
  assert.deepEqual(normalizedUploadHeaders([['x-cos-security-token', 'fixture-not-a-real-token']]), expected);
  assert.deepEqual(normalizedUploadHeaders(expected), expected);
  assert.deepEqual(normalizedUploadHeaders(undefined), {});
  assert.throws(() => normalizedUploadHeaders([{ Key: 'bad\nname', Value: 'fixture' }]), /UPLOAD_HEADERS_INVALID/);
});

test('deployment module has no function configuration writer and does not invoke business or health APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/deploy-admin-entry-compatibility.mjs'), 'utf8');
  assert.doesNotMatch(source, /\.updateFunctionConfig\(|\.invokeFunction\(/);
  assert.deepEqual([...source.matchAll(/client\.call\('([^']+)'/g)].map(match => match[1]), ['queryFunctions']);
});
