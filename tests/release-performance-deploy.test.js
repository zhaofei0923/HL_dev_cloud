'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const deployment = import('../scripts/deploy-release-performance.mjs');
const zipTools = import('../scripts/prepare-admin-entry-rebuild.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const before = ['async function notificationMessageView(row) { return "old sender"; }',
    '  async list(userId, filters = {}) { return "old list"; },',
    '  async overview(userId) { return "old overview"; },'];
  const after = before.map(value => value.replace('old ', 'new '));
  const source = `const preserved = "UNRELATED_CLOUD_CODE";\n${before[0]}\nconst messages = {\n${before[1]}\n};\nconst membership = {\n${before[2]}\n};\n`;
  const patches = ['notificationMessageView', 'messages.list', 'membership.overview'].map((id, index) => ({
    id, before: before[index], after: after[index], beforeSha256: sha(before[index]), afterSha256: sha(after[index])
  }));
  return { source, document: { source: 'cloudfunctions/hlApi/index.js', scopeOnly: true, patches } };
}

test('performance patch changes exactly three complete functions and preserves unrelated cloud bytes', async () => {
  const { patchCloudIndex } = await deployment;
  const f = fixture();
  const result = patchCloudIndex(Buffer.from(f.source), f.document).toString();
  assert.equal(result, f.document.patches.reduce((source, patch) => source.replace(patch.before, patch.after), f.source));
  assert.ok(result.includes('UNRELATED_CLOUD_CODE'));
  assert.throws(() => patchCloudIndex(Buffer.from(result), f.document), /FUNCTION_PATCH_ANCHOR_INVALID/);
});

test('performance patch rejects changed or ambiguous source, altered patch locks and other scopes', async () => {
  const { patchCloudIndex } = await deployment;
  const f = fixture();
  assert.throws(() => patchCloudIndex(Buffer.from(f.source + f.document.patches[0].before), f.document), /ANCHOR_INVALID/);
  for (const alter of [
    doc => { doc.patches.reverse(); }, doc => { doc.patches.pop(); },
    doc => { doc.patches[0].id = 'unrelated'; }, doc => { doc.scopeOnly = false; },
    doc => { doc.patches[0].beforeSha256 = '0'.repeat(64); },
    doc => { doc.patches[1].after += '\nconst unrelated = true;'; }
  ]) {
    const changed = structuredClone(f.document); alter(changed);
    assert.throws(() => patchCloudIndex(Buffer.from(f.source), changed));
  }
  const invalid = structuredClone(f.document);
  invalid.patches[0].after += '\n!invalid-javascript('; invalid.patches[0].afterSha256 = sha(invalid.patches[0].after);
  assert.throws(() => patchCloudIndex(Buffer.from(f.source), invalid), /CANDIDATE_SYNTAX_INVALID/);
});

test('candidate inventory preserves dependency, Apple policy and file attributes through the ZIP round trip', async () => {
  const { packageScope } = await deployment;
  const { readZip, rootZip } = await zipTools;
  const files = [
    { name: 'index.js', bytes: Buffer.from('exports.main=()=>1;'), externalAttributes: 2176188448, madeBy: 813 },
    { name: 'package.json', bytes: Buffer.from('{}'), externalAttributes: 2176188448, madeBy: 813 },
    { name: 'virtual-payment-policy.js', bytes: Buffer.from('APPLE_POLICY_UNCHANGED') },
    { name: 'native-admin.bundle.js', bytes: Buffer.from('ADMIN_BUNDLE_UNCHANGED') },
    { name: 'node_modules/.bin/example', bytes: Buffer.from('../dependency/main.js'), externalAttributes: 0xa1ff0000, madeBy: 798 }
  ];
  const candidate = files.map(file => ({ ...file, bytes: file.name === 'index.js' ? Buffer.from('exports.main=()=>2;') : file.bytes }));
  const scope = packageScope(files, readZip(rootZip(candidate)));
  assert.deepEqual(scope.changedFiles, ['index.js']);
  assert.equal(scope.unchangedFiles, 4);
  for (const name of ['virtual-payment-policy.js', 'native-admin.bundle.js', 'node_modules/.bin/example']) {
    const tampered = candidate.map(file => ({ ...file, bytes: file.name === name ? Buffer.from('changed') : file.bytes }));
    assert.throws(() => packageScope(files, tampered), /PACKAGE_CHANGED_OUTSIDE_INDEX/);
  }
  assert.throws(() => packageScope(files, candidate.slice(1)), /PACKAGE_FILE_LIST_CHANGED/);
  assert.throws(() => packageScope(files, candidate.map(file => ({ ...file,
    externalAttributes: file.name === 'index.js' ? 0 : file.externalAttributes }))), /INDEX_FILE_ATTRIBUTES_CHANGED/);
});

test('deployment locks bind target, baseline, candidate, script inputs and the prepared manifest', async () => {
  const { assertLocks } = await deployment;
  const { TARGET } = await zipTools;
  const artifacts = { manifest: { candidateZipSha256: 'candidate' }, locks: {
    manifestSha256: 'manifest', candidateZipSha256: 'candidate', inputsSha256: 'script-and-inputs' } };
  const record = { target: TARGET, locks: artifacts.locks,
    baselineCodeSha256: '813475890e68cc1f5a40db66a9848165223bb1d2fdd8649f46753d999263b730', candidateZipSha256: 'candidate' };
  assert.doesNotThrow(() => assertLocks(artifacts, record));
  for (const changed of [null, {}, { ...record, target: { ...TARGET, functionName: 'other' } },
    { ...record, baselineCodeSha256: 'different' }, { ...record, candidateZipSha256: 'different' },
    { ...record, locks: { ...record.locks, inputsSha256: 'script-changed' } }]) {
    assert.throws(() => assertLocks(artifacts, changed), /DEPLOYMENT_LOCK_MISMATCH/);
  }
});

test('performance deployment has one native TempCos code update, rejects other modes and invokes only GET health', async () => {
  const { main } = await deployment;
  await assert.rejects(main('inspect'), /MODE_REQUIRED/);
  const source = fs.readFileSync(path.join(__dirname, '../scripts/deploy-release-performance.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal([...source.matchAll(/\.updateFunctionCode\(/g)].length, 1);
  assert.doesNotMatch(source, /\.updateFunctionConfig\(|PaymentMcpClient|getFunctionUploadUrl|CosBucketName/);
  assert.deepEqual([...source.matchAll(/\.invokeFunction\([^\n]+/g)].map(match => match[0]),
    [".invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });"]);
});
