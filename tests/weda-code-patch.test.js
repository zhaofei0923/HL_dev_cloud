const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'weda-admin/app.cals.json'), 'utf8'));
const runtime = fs.readFileSync(path.join(root, 'weda-admin/operations-runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const connector = import(pathToFileURL(path.join(root, 'scripts/connect-weda-operations.mjs')).href);
const pages = ['matchmakers', 'certifications', 'salons', 'plans', 'orders'];

test('code-only repair preserves all editor additions and changes only the ten reviewed resource bodies', async () => {
  const { connectOperationsCode } = await connector;
  const before = structuredClone(source);
  before.description = 'fixture console description';
  before.extra = { fixtureEditorRevision: 7 };
  before.items[0].extra = { fixtureMetadata: ['keep', 'exactly'] };
  for (const id of pages) {
    const page = before.items.find(item => item.id === id);
    page.extra = { fixturePage: id };
    for (const resource of page.resources) resource.extra = { fixtureResource: resource.path };
  }
  const snapshot = structuredClone(before);
  const after = connectOperationsCode(before, runtime);
  assert.deepEqual(before, snapshot, 'No mutation of the backed-up source');
  for (const id of pages) {
    const oldPage = before.items.find(item => item.id === id);
    const newPage = after.items.find(item => item.id === id);
    for (const target of [`${id}/handler/operations`, `${id}/lifecycle`]) {
      const oldResource = oldPage.resources.find(resource => resource.path === target);
      const newResource = newPage.resources.find(resource => resource.path === target);
      assert.equal(typeof newResource.code, 'string');
      // Remove only the permitted replacement to compare the complete document.
      newResource.code = oldResource.code;
    }
  }
  assert.deepEqual(after, snapshot, 'All non-code values, ordering and editor metadata must survive');
});

test('code-only repair refuses missing, duplicate, unreviewed or differently typed resources', async () => {
  const { connectOperationsCode } = await connector;
  for (const change of [
    page => { page.resources = page.resources.filter(resource => resource.path !== 'plans/lifecycle'); },
    page => { page.resources.push(structuredClone(page.resources.find(resource => resource.path === 'plans/lifecycle'))); },
    page => { page.resources.find(resource => resource.path === 'plans/lifecycle').code = 'export default {};'; },
    page => { page.resources.find(resource => resource.path === 'plans/lifecycle').codeType = 'handler-fn'; },
  ]) {
    const app = structuredClone(source);
    change(app.items.find(page => page.id === 'plans'));
    assert.throws(() => connectOperationsCode(app, runtime), /Refuse to overwrite/);
  }
});

test('lifecycle generation has no module dependencies and includes only the reviewed normalized runtime', async () => {
  const { operationsLifecycle } = await connector;
  const embedded = runtime.replace(/^export function /gm, 'function ')
    .replace(/^export default async function operations\(/m, 'async function operations(');
  for (const id of pages) {
    const code = operationsLifecycle(id, runtime);
    assert.ok(code.includes(embedded));
    assert.doesNotMatch(code, /^\s*import\b/m);
    assert.doesNotMatch(code, /this\.handler/);
    assert.equal((code.match(/^export default /gm) || []).length, 1);
    assert.doesNotMatch(code, /^export function /m);
    assert.match(code, /controller = operationsOwnerController/);
    assert.match(code, /cleanupController: controller/);
  }
  assert.throws(() => operationsLifecycle('unknown', runtime), /Unknown operations page/);
  assert.throws(() => operationsLifecycle('plans'), /runtime is required/);
  assert.throws(() => operationsLifecycle('plans', runtime + '\nimport unsafe from "other";'), /module dependency/);
});
