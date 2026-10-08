const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-generated-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('hl-generated-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const generator = await import('../scripts/sync-matchmaker-workspace.mjs');
  const checker = await import('../scripts/check-generated.mjs');
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true };
  function write(relativePath, content) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'CommonJS', target: 'ES2020', strict: true }, include: ['miniprogram/**/*.ts'] }));
  for (const tab of generator.workspaceTabs) {
    const source = `export const ${tab}Controller = { data: {}, tapAction() { return 'ok'; } };\n`;
    write(`miniprogram/controllers/matchmaker/${tab}.ts`, source);
    write(`miniprogram/controllers/matchmaker/${tab}.js`, ts.transpileModule(source, { compilerOptions }).outputText);
    write(`miniprogram/pages/matchmaker/${tab}.wxml`, '<view><button data-id="{{item.id}}" catchtap="tapAction">点击</button><bottom-nav role="matchmaker"></bottom-nav></view>');
    write(`miniprogram/pages/matchmaker/${tab}.less`, '.card { color: red; }\n');
    write(`miniprogram/pages/matchmaker/${tab}.wxss`, '.card { color: red; }\n');
    write(`miniprogram/pages/matchmaker/${tab}.json`, JSON.stringify({ usingComponents: {} }));
  }
  function writeWorkspace() {
    const rendered = generator.renderWorkspace(root);
    for (const [file, content] of Object.entries(rendered.files)) write(file, content);
    write('miniprogram/pages/matchmaker/workspace.wxss', rendered.files['miniprogram/pages/matchmaker/workspace.less']);
  }
  writeWorkspace();
  return { root, write, writeWorkspace, generator, check: () => checker.checkGenerated(root) };
}

test('generated consistency checker accepts synchronized source outputs and real controller event mappings', async t => {
  const project = await fixture(t);
  const result = project.check();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.counts, { javascript: 5, styles: 6, workspace: 3, bindings: 5 });
});

test('generated consistency checker reports stale JavaScript, style and workspace files without repairing them', async t => {
  const project = await fixture(t);
  const changed = [
    'miniprogram/controllers/matchmaker/members.js',
    'miniprogram/pages/matchmaker/salon.wxss',
    'miniprogram/pages/matchmaker/workspace.wxml'
  ];
  changed.forEach(file => project.write(file, 'deliberately stale output\n'));
  const before = changed.map(file => fs.readFileSync(path.join(project.root, file)));
  const result = project.check();
  changed.forEach((file, index) => {
    assert.ok(result.failures.some(failure => failure.includes(path.normalize(file))));
    assert.deepEqual(fs.readFileSync(path.join(project.root, file)), before[index], 'checking must not repair stale artifacts');
  });
  const missing = 'miniprogram/controllers/matchmaker/mine.js';
  fs.unlinkSync(path.join(project.root, missing));
  assert.ok(project.check().failures.some(failure => failure.includes(path.normalize(missing))));
  assert.equal(fs.existsSync(path.join(project.root, missing)), false);
});

test('generated event mapping rejects a template binding whose controller method does not exist', async t => {
  const project = await fixture(t);
  project.write('miniprogram/pages/matchmaker/members.wxml', '<button bindtap="missingAction">失效按钮</button>');
  project.writeWorkspace();
  assert.ok(project.check().failures.some(failure => failure.includes('members.missingAction')));
});

test('workspace generator retains dataset and catch bindings and scopes nested CSS groups safely', async t => {
  const { generator } = await fixture(t);
  const bindings = [];
  const markup = generator.workspaceMarkup('<!-- <button bindtap="commentOnly"> -->\n<view data-label="a > b" catchtap="tapAction"><bottom-nav role="matchmaker"></bottom-nav></view>', 'members', binding => bindings.push(binding));
  assert.ok(markup.includes('data-label="a > b" catchtap="workspace_members_tapAction"'));
  assert.ok(!markup.includes('<bottom-nav'));
  assert.deepEqual(bindings, [{ tab: 'members', event: 'catchtap', handler: 'tapAction' }]);
  const styles = generator.scopedCss('@media (min-width: 10px) { .a, [data-label="a,b"] { color: red; } } @keyframes spin { from { opacity: 0; } to { opacity: 1; } }', '.workspace-members');
  assert.ok(styles.includes('.workspace-members .a,\n.workspace-members [data-label="a,b"]'));
  assert.ok(styles.includes('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }'));
});
