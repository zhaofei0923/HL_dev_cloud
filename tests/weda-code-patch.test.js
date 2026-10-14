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

test('list feedback patch changes only the two status text attributes and preserves editor content', async () => {
  const { connectOperationsFeedback } = await connector;
  const before = structuredClone(source);
  const find = (page, id) => { let found; function walk(node) { if (node.id === id) found = node; for (const child of node.items || []) walk(child); } walk(page); return found; };
  for (const id of pages) {
    const page = before.items.find(item => item.id === id);
    for (const name of ['emptyTitle', 'emptyDescription']) {
      const node = find(page, name);
      delete node.attributes[':text']; node.attributes.text = 'fixture old placeholder';
      node.extra = { fixtureEditorMetadata: name };
    }
  }
  const snapshot = structuredClone(before), after = connectOperationsFeedback(before);
  assert.deepEqual(before, snapshot);
  for (const id of pages) for (const name of ['emptyTitle', 'emptyDescription']) {
    const original = find(before.items.find(page => page.id === id), name);
    const changed = find(after.items.find(page => page.id === id), name);
    assert.equal(changed.attributes.text, undefined); assert.equal(typeof changed.attributes[':text'], 'string');
    delete changed.attributes[':text']; changed.attributes.text = original.attributes.text;
  }
  assert.deepEqual(after, snapshot, 'Layout, styles, events, roles and unrelated resources remain exact');
});

test('saved list feedback distinguishes not initialized, loading, failure and confirmed zero records', () => {
  const states = [
    [null, '列表尚未加载', '刷新'],
    [{ rows: [], total: null, loading: false, error: '' }, '列表尚未加载', '刷新'],
    [{ rows: [], total: null, loading: true, error: '' }, '正在加载…', '正在读取'],
    [{ rows: [], total: null, loading: false, error: 'fixture error' }, '记录未取得', '上方提示'],
    [{ rows: [], total: 0, loading: false, error: '' }, '暂无符合条件的记录', '筛选'],
  ];
  for (const id of pages) {
    const nodes = new Map();
    function walk(node) { nodes.set(node.id, node); for (const child of node.items || []) walk(child); }
    walk(source.items.find(page => page.id === id));
    const title = new Function('$page', 'return (' + nodes.get('emptyTitle').attributes[':text'] + ');');
    const description = new Function('$page', 'return (' + nodes.get('emptyDescription').attributes[':text'] + ');');
    for (const [ops, expected, help] of states) {
      const page = { dataset: { state: { ops } } };
      assert.equal(title(page), expected, id); assert.ok(description(page).includes(help), id);
    }
  }
});
