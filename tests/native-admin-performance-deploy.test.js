'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('performance deployment replaces only the management bundle and preserves file attributes', async () => {
  const { replaceManagementBundle } = await import('../scripts/deploy-native-admin-performance.mjs');
  const files = [
    { name: 'index.js', bytes: Buffer.from('entry'), externalAttributes: 123 },
    { name: 'native-admin.bundle.js', bytes: Buffer.from('old'), externalAttributes: 456 },
    { name: 'node_modules/keep.js', bytes: Buffer.from('dependency'), externalAttributes: 789 }
  ];
  const result = replaceManagementBundle(files, Buffer.from('new'));
  assert.equal(result[1].bytes.toString(), 'new');
  assert.equal(result[1].externalAttributes, 456);
  assert.deepEqual(result[0], files[0]); assert.deepEqual(result[2], files[2]);
  assert.equal(files[1].bytes.toString(), 'old');
  assert.throws(() => replaceManagementBundle(files.concat(files[1]), Buffer.from('new')), /BUNDLE_LAYOUT_INVALID/);
});

test('performance deployment rejects unrelated business or dependency edits', async () => {
  const { assertInputScope } = await import('../scripts/deploy-native-admin-performance.mjs');
  const allowed = path.join(root, 'cloudfunctions/hlAdminOperations/read-service.js');
  const unrelated = path.join(root, 'cloudfunctions/hlAdminOperations/mutation-service.js');
  const before = [{ path: allowed, sha256: 'old' }, { path: unrelated, sha256: 'same' }];
  assert.deepEqual(assertInputScope(before, [{ path: allowed, sha256: 'new' }, before[1]]), [allowed]);
  assert.throws(() => assertInputScope(before, [{ path: allowed, sha256: 'new' }, { path: unrelated, sha256: 'new' }]), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  assert.throws(() => assertInputScope(before, [{ path: allowed, sha256: 'new' }]), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  assert.throws(() => assertInputScope(before, [...before, { path: 'injected.js', sha256: 'new' }]), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
});
