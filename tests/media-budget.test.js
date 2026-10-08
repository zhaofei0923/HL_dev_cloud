const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('media budget counts images, audio and video together and enforces the strict 200 KiB boundary', async t => {
  const { mediaBudget, MEDIA_BUDGET_BYTES } = await import('../scripts/check-media-budget.mjs');
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'hl-media-budget-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'image.PNG'), Buffer.alloc(100 * 1024));
  fs.writeFileSync(path.join(directory, 'nested', 'voice.mp3'), Buffer.alloc(60 * 1024));
  fs.writeFileSync(path.join(directory, 'nested', 'video.mp4'), Buffer.alloc(40 * 1024 - 1));
  fs.writeFileSync(path.join(directory, 'code.js'), Buffer.alloc(1024 * 1024));
  const below = mediaBudget(directory);
  assert.equal(below.files.length, 3);
  assert.equal(below.bytes, MEDIA_BUDGET_BYTES - 1);
  assert.equal(below.passed, true);
  fs.appendFileSync(path.join(directory, 'nested', 'video.mp4'), Buffer.alloc(1));
  assert.equal(mediaBudget(directory).passed, false);
});
