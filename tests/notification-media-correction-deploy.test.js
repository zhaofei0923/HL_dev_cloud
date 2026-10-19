'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const deployment = import('../scripts/deploy-notification-media-correction.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');

test('notification correction accepts only one uniquely anchored messages.list block', async () => {
  const { patchCloudIndex } = await deployment;
  const before = '  async list(userId, filters = {}) { return "old"; },';
  const after = '  async list(userId, filters = {}) { return "corrected"; },';
  const source = `const unrelated = "KEEP";\nconst messages = {\n${before}\n};\n`;
  const document = { source: 'cloudfunctions/hlApi/index.js', scopeOnly: true,
    patches: [{ id: 'messages.list', before, after, beforeSha256: sha(before), afterSha256: sha(after) }] };
  assert.equal(patchCloudIndex(Buffer.from(source), document).toString(), source.replace(before, after));
  for (const patches of [[], [...document.patches, ...document.patches],
    [{ ...document.patches[0], id: 'membership.overview' }]]) {
    assert.throws(() => patchCloudIndex(Buffer.from(source), { ...document, patches }), /FUNCTION_PATCH_SCOPE_INVALID/);
  }
  assert.throws(() => patchCloudIndex(Buffer.from(source + before), document), /FUNCTION_PATCH_ANCHOR_INVALID/);
  assert.throws(() => patchCloudIndex(Buffer.from(source), { ...document,
    patches: [{ ...document.patches[0], afterSha256: '0'.repeat(64) }] }), /FUNCTION_PATCH_DIGEST_INVALID/);
});

test('notification correction locks the verified first deployment rather than the pre-optimization baseline', async () => {
  const { assertLocks } = await deployment;
  const target = { envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai', functionName: 'hlApi' };
  const locks = { manifestSha256: 'manifest', candidateZipSha256: 'candidate', inputsSha256: 'inputs' };
  const artifacts = { manifest: { candidateZipSha256: 'candidate' }, locks };
  const record = { target, locks, baselineCodeSha256: 'e08b12b405291b39653e4c4a1f1c3f63ae96b2c1630182692d856bff560fb487', candidateZipSha256: 'candidate' };
  assert.doesNotThrow(() => assertLocks(artifacts, record));
  assert.throws(() => assertLocks(artifacts, { ...record,
    baselineCodeSha256: '813475890e68cc1f5a40db66a9848165223bb1d2fdd8649f46753d999263b730' }), /DEPLOYMENT_LOCK_MISMATCH/);
  const source = fs.readFileSync(path.join(__dirname, '../scripts/deploy-notification-media-correction.mjs'), 'utf8');
  assert.equal([...source.matchAll(/\.updateFunctionCode\(/g)].length, 1);
  assert.doesNotMatch(source, /\.updateFunctionConfig\(|PaymentMcpClient|getFunctionUploadUrl|CosBucketName/);
  assert.match(source, /VERIFIED_PARENT_BASELINE_REQUIRED/);
  assert.match(source, /parent-verification\.json/);
});
