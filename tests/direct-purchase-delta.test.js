'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('reviewed source delta preserves unrelated deployed code and rejects missing or ambiguous context', async () => {
  const { reviewedDelta, applyExactHunks, parseHunks } = await import('../scripts/direct-purchase-delta.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'hl-direct-purchase-delta-'));
  try {
    const lines = ['local-only-before', '', '// divider a', '// divider b', '// divider c', 'function service() {',
      '  const value = 1;', '  return value;', '}', '// divider d', '// divider e', '// divider f', '', 'local-only-after', ''];
    const before = Buffer.from(lines.join('\n'));
    const after = Buffer.from(before.toString().replace('const value = 1;', 'const value = 2;'));
    const cloud = Buffer.from(before.toString().replace('local-only-before', 'protected-cloud-before').replace('local-only-after', 'protected-cloud-after'));
    const result = reviewedDelta(before, after, cloud, directory, 'fixture.js');
    assert.equal(result.bytes.toString(), cloud.toString().replace('const value = 1;', 'const value = 2;'));
    assert.equal(result.proof.hunkCount, 1); assert.equal(result.proof.exactContextOnly, true);
    const hunks = [{ before: 'a\nb\n', after: 'a\nc\n' }];
    assert.throws(() => applyExactHunks('none\n', hunks), /SOURCE_CONTEXT_NOT_EXACTLY_UNIQUE/);
    assert.throws(() => applyExactHunks('a\nb\na\nb\n', hunks), /SOURCE_CONTEXT_NOT_EXACTLY_UNIQUE/);
    assert.throws(() => parseHunks('not a source patch'), /EMPTY_SOURCE_DELTA/);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('hl-direct-purchase-delta-'));
    rmSync(directory, { recursive: true });
  }
});

test('delta parser keeps exact blank lines and never applies a replacement as a dollar expression', async () => {
  const { parseHunks, applyExactHunks } = await import('../scripts/direct-purchase-delta.mjs');
  const hunks = parseHunks('--- a\n+++ b\n@@ -1,3 +1,3 @@\n context\n-old\n+new $& $1\n \n');
  assert.equal(applyExactHunks('context\nold\n\n', hunks).toString(), 'context\nnew $& $1\n\n');
});
