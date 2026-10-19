'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const preparation = import('../scripts/prepare-miniprogram-admin-entry-deployment.mjs');
const zip = import('../scripts/prepare-admin-entry-rebuild.mjs');
// Keep only the historical patch and its exact policy. The full deployment
// archive also contains unrelated business code and SDK files.
const historical = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/admin-entry-historical-patch.json'), 'utf8'));
assert.equal(historical.schemaVersion, 1);
assert.equal(historical.sourceArchiveSha256, '73e5e3a4f7a36841047a1985f7d31a89d86634fcc68a8c09a39f6674cc33df42');
const historicalFiles = new Map([['index.js', Buffer.from(historical.indexSource)],
  ['admin-entry-policy.js', Buffer.from(historical.policySource)]]);
const lockedHashes = { 'index.js': '762d07b1ae8b00410c05d299400fae5bec72850909274704f5aed2ff49f0096c',
  'admin-entry-policy.js': 'bfe3e6f8fb9e5456f864fd0721e9b43285ee516b5a1537ab458e57b3886a25d0' };
for (const [name, bytes] of historicalFiles) assert.equal(createHash('sha256').update(bytes).digest('hex'), lockedHashes[name]);
const source = name => Buffer.from(historicalFiles.get(name));
async function patch() {
  return (await preparation).checkedLocalPatch(source('index.js'), source('admin-entry-policy.js'));
}
function fixture(newline = '\n') {
  return [
    { name: 'index.js', bytes: Buffer.from([
      "const crypto = require('node:crypto');", 'async function main(event) {',
      '  try {', '    const session = await requireUser(apiToken);',
      "    return 'fixture';", '  } catch (err) {', "    const failedPath = String(event.path || '/');",
      '    throw err;', '  }', '}',
      'function certificationSecrets() { return { jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY }; }'
    ].join(newline)), externalAttributes: 0, madeBy: 20 },
    { name: 'certification-material-policy.js', bytes: Buffer.from('immutable compatibility policy'), externalAttributes: 0, madeBy: 20 },
    { name: 'package.json', bytes: Buffer.from('{"name":"deployment-fixture"}'), externalAttributes: 0, madeBy: 20 },
    { name: 'node_modules/fixture/bytes.bin', bytes: Buffer.from([0, 255, 1, 17]), externalAttributes: 0x81a40000, madeBy: 0x0314 }
  ];
}

test('entry patch preserves every unrelated compatibility and dependency byte without mutating its input', async () => {
  const { patchAdminEntry } = await preparation, { inventory, rootZip, readZip } = await zip;
  const input = fixture(), before = inventory(input), result = patchAdminEntry(input, await patch());
  assert.deepEqual(inventory(input), before);
  assert.equal(result.length, input.length + 1);
  for (const file of input.filter(file => file.name !== 'index.js')) {
    const after = result.find(item => item.name === file.name);
    assert.ok(after.bytes.equals(file.bytes));
    assert.equal(after.externalAttributes, file.externalAttributes);
    assert.equal(after.madeBy, file.madeBy);
  }
  assert.ok(result.find(file => file.name === 'admin-entry-policy.js').bytes.equals(source('admin-entry-policy.js')));
  assert.deepEqual(inventory(readZip(rootZip(result))), inventory(result));
});

test('entry route and error sanitization retain the locked historical implementation', async () => {
  const { patchAdminEntry } = await preparation;
  const result = patchAdminEntry(fixture(), await patch()).find(file => file.name === 'index.js').bytes.toString();
  const local = source('index.js').toString().replace(/\r\n/g, '\n');
  const blocks = [
    "const { miniprogramAdminEntry } = require('./admin-entry-policy');",
    /    if \(method === 'GET' && path === '\/user\/admin-entry'\) \{[\s\S]*?\n    \}/.exec(local)[0],
    /    if \(failedPath === '\/user\/admin-entry'\) \{[\s\S]*?\n    \}/.exec(local)[0]
  ];
  for (const block of blocks) assert.equal(result.split(block).length, 2);
  assert.ok(result.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY'));
});

test('missing or duplicate insertion anchors, an existing route and a noncompatibility base are rejected', async () => {
  const { patchAdminEntry } = await preparation, checked = await patch();
  const original = fixture(), text = original[0].bytes.toString();
  for (const replacement of [text.replace("const crypto = require('node:crypto');", ''),
    text + "\nconst crypto = require('node:crypto');", text.replace('    const session = await requireUser(apiToken);', ''),
    text.replace("    const failedPath = String(event.path || '/');", ''),
    text.replace('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY', 'legacyMissing: null'),
    text + "\nconst driftedRoute = '/user/admin-entry';"]) {
    assert.throws(() => patchAdminEntry([{ ...original[0], bytes: Buffer.from(replacement) }, ...original.slice(1)], checked));
  }
  assert.throws(() => patchAdminEntry(patchAdminEntry(original, checked), checked));
});

test('local policy or tested error-block drift blocks preparation', async () => {
  const { checkedLocalPatch } = await preparation;
  assert.throws(() => checkedLocalPatch(source('index.js'), Buffer.concat([source('admin-entry-policy.js'), Buffer.from('\n')])));
  const changed = source('index.js').toString().replace("console.error('admin entry request failed', safeError.code);",
    "console.error('unsafe fixture', err);");
  assert.throws(() => checkedLocalPatch(Buffer.from(changed), source('admin-entry-policy.js')));
});

test('CRLF and nontext dependency bytes survive while invalid index encoding is rejected', async () => {
  const { patchAdminEntry } = await preparation, checked = await patch();
  const files = fixture('\r\n'), result = patchAdminEntry(files, checked);
  const index = result.find(file => file.name === 'index.js').bytes.toString();
  assert.equal(index.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(index.includes("\r\n    if (failedPath === '/user/admin-entry')"));
  assert.throws(() => patchAdminEntry([{ ...files[0], bytes: Buffer.concat([files[0].bytes, Buffer.from([255])]) }, ...files.slice(1)], checked));
});
