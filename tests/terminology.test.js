const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const legacyRole = String.fromCodePoint(0x7ea2, 0x5a18);
const legacySeedSynonym = String.fromCodePoint(0x6708, 0x8001);
const principal = String.fromCodePoint(0x4e3b, 0x7406, 0x4eba);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('tracked product text uses the principal terminology', () => {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).split('\0').filter(Boolean);
  const hits = [];

  files.forEach(relativePath => {
    const absolutePath = path.join(repoRoot, relativePath);
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.includes(0)) return;
    const source = buffer.toString('utf8');
    if (source.includes(legacyRole) || source.includes(legacySeedSynonym)) {
      hits.push(relativePath);
    }
  });

  assert.deepEqual(hits, []);
  assert.match(read('miniprogram/services/auth.ts'), new RegExp(principal));
});

test('legacy matchmaker technical contracts remain stable', () => {
  const backend = read('cloudfunctions/hlApi/index.js');
  const auth = read('miniprogram/services/auth.ts');
  const appConfig = read('miniprogram/app.json');

  assert.match(backend, /matchmakers:\s*'hl_matchmakers'/);
  assert.match(backend, /path === '\/matchmaker\/apply'/);
  assert.match(backend, /matchmakerId/);
  assert.match(auth, /role:\s*'user' \| 'matchmaker'/);
  assert.match(appConfig, /pages\/matchmaker\/dashboard/);
});
