const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'weda-admin', 'operations-runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const app = JSON.parse(fs.readFileSync(path.join(root, 'weda-admin', 'app.cals.json'), 'utf8'));
const pageIds = ['matchmakers', 'certifications', 'salons', 'plans', 'orders'];
const key = Symbol.for('hl.admin.operations.controller');
const version = 'v1_' + 'a'.repeat(64);
const reply = data => ({ result: { code: 0, data } });
const list = (rows = []) => ({ list: rows, total: rows.length, page: 1, pageSize: 10 });
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function createPage(id, initialState = {}) {
  const state = { ...initialState }, updates = [];
  const target = { id, __internal__: { active: true }, dataset: { state },
    setState(patch) { updates.push(patch); Object.assign(state, patch); } };
  return { target, page: new Proxy(target, {}), second: new Proxy(target, {}), state, updates };
}
async function generatedLifecycle(pageId) {
  const connector = await import(pathToFileURL(path.join(root, 'scripts', 'connect-weda-operations.mjs')).href);
  return connector.operationsLifecycle(pageId, runtimeSource);
}
function calsResources(pageId) {
  const page = app.items.find(item => item.id === pageId);
  assert.ok(page, `Missing CALS page ${pageId}`);
  const lifecycles = page.resources.filter(item => item.codeType === 'lifecycle');
  const handlers = page.resources.filter(item => item.codeType === 'handler-fn' && item.name === 'operations');
  assert.equal(lifecycles.length, 1); assert.equal(handlers.length, 1);
  assert.equal(lifecycles[0].path, `${pageId}/lifecycle`);
  assert.equal(handlers[0].path, `${pageId}/handler/operations`);
  assert.ok(handlers[0].code.replace(/\r\n/g, '\n').endsWith(runtimeSource), 'CALS handler embeds the current real runtime');
  return { lifecycle: lifecycles[0], handler: handlers[0] };
}
function context(api, page) {
  return vm.createContext({ $page: page, $w: api, crypto: webcrypto, URL, Blob, Uint8Array, atob,
    window: { open() { throw new Error('Lifecycle tests never open a browser'); } } });
}
function evaluateHandler(api, page) {
  const scope = context(api, page);
  const executable = runtimeSource.replace(/^export function /gm, 'function ')
    .replace(/^export default async function operations\b/m, 'async function operations')
    + '\nglobalThis.__handler = operations;';
  new vm.Script(executable, { filename: 'independent-operations-handler' }).runInContext(scope);
  return { handler: scope.__handler, scope };
}
function evaluateLifecycle(source, api, page) {
  assert.doesNotMatch(source, /^\s*import\s/m, 'CALS lifecycle is self-contained and does not depend on a relative module loader');
  assert.equal([...source.matchAll(/\bexport default\b/g)].length, 1, 'The sole default export is the lifecycle hooks');
  const scope = context(api, page);
  new vm.Script(source.replace(/\bexport default\s+/, 'globalThis.__lifecycle = '), { filename: `${page.id}/lifecycle` }).runInContext(scope);
  return { lifecycle: scope.__lifecycle, scope };
}
async function withLifecycle(pageId, fixture, run, { persisted = false } = {}) {
  const current = createPage(pageId), requests = [];
  const api = { page: current.second, cloud: { async callFunction(request) {
    assert.equal(request.name, 'hlAdminOperations');
    assert.match(request.data.action, /\.(?:list|detail|evidence|material)$/, 'Only read calls may leave this isolated fixture');
    requests.push(plain(request)); return fixture(request.data, requests.length);
  } } };
  // Separate evaluations have independent module scopes and communicate only
  // through the real page target's Symbol capsule, as in the native editor.
  const lifecycleSource = persisted ? calsResources(pageId).lifecycle.code : await generatedLifecycle(pageId);
  const lifecycle = evaluateLifecycle(lifecycleSource, api, current.page);
  const handler = evaluateHandler(api, current.second);
  assert.notEqual(lifecycle.scope.operations, handler.handler);
  const command = (command, target = {}, value) => handler.handler({ data: { target: { command, ...target } },
    ...(value === undefined ? {} : { event: { detail: { value } } }) });
  return run({ ...current, ...lifecycle, handler: handler.handler, api, requests, command });
}
function assertPrivateCleared(state) {
  assert.equal(state.ops.detail, null); assert.equal(state.ops.selected, null);
  assert.equal(state.ops.detailText, ''); assert.equal(state.ops.material, null);
  assert.equal(state.ops.evidenceText, ''); assert.equal(state.ops.evidenceLoading, false);
  assert.equal(state.ops.remark, ''); assert.equal(state.ops.feedback, '');
  assert.equal(state.ops.confirmation, null); assert.deepEqual(plain(state.ops.rows), []);
  assert.doesNotMatch(JSON.stringify(state), /fixture-private|fixture-late-private/);
}

test('the old this.handler call reproduces the reported editor receiver error', () => {
  const legacy = new vm.Script(`({ onPageHide() {
    return this.handler.operations({ cleanupPage: this, data: { target: { command: 'clear' } } });
  } })`).runInNewContext();
  assert.throws(() => legacy.onPageHide.call({ handler: { operations: {} } }),
    error => error.name === 'TypeError' && /operations.*not a function/.test(error.message));
});

test('all five generated CALS lifecycles embed the real runtime and have no handler import or receiver dependency', async () => {
  for (const pageId of pageIds) {
    const source = await generatedLifecycle(pageId), saved = calsResources(pageId).lifecycle.code.replace(/\r\n/g, '\n');
    assert.equal(saved, source, `${pageId} saved lifecycle must match the current generator and runtime`);
    assert.doesNotMatch(source, /^\s*import\s|this\.handler/m);
    assert.match(source, /async function operations\(/); assert.match(source, /cleanupController/);
    assert.match(source, /disposeController:\s*unload/); assert.match(source, /cleanupOperationsPage\(true\)/);
    assert.match(source, /getOperationsController\(page\)/);
  }
});

test('all five lifecycles initialize once across load/show and share a controller with an independent handler and proxy', async () => {
  for (const pageId of pageIds) {
    await withLifecycle(pageId, ({ action }) => reply(action.endsWith('.list') ? list([{ id: 1 }]) : { id: 1, version }),
      async ({ lifecycle, target, state, requests, command }) => {
        assert.equal(target.handler, undefined); await lifecycle.onPageLoad.call({});
        const capsule = target[key]; await lifecycle.onPageShow.call({ handler: { operations: {} } });
        assert.equal(target[key], capsule); assert.equal(state.ops.pageId, pageId);
        assert.equal(state.ops.total, 1); assert.equal(state.ops.error, '');
        assert.equal(requests.length, 1); assert.equal(requests[0].data.action, `${pageId}.list`);
        await command('edit', { field: 'keyword' }, 'fixture-shared-keyword'); assert.equal(state.ops.keyword, 'fixture-shared-keyword');
        await command('query'); assert.equal(requests.length, 2); assert.equal(requests[1].data.args.keyword, 'fixture-shared-keyword');
        await lifecycle.onPageHide.call({}); assertPrivateCleared(state); assert.equal(target[key], capsule);
        await lifecycle.onPageUnload.call({ handler: { operations: {} } }); assertPrivateCleared(state);
        assert.equal(target[key], undefined, 'Unload disposes its captured capsule');
      });
  }
});

test('hide/unload before load have no side effects, and show initializes then reloads after a hide', async () => {
  await withLifecycle('plans', () => reply(list()), async ({ lifecycle, target, state, requests }) => {
    assert.equal(lifecycle.onPageHide.call({}), undefined); assert.equal(lifecycle.onPageUnload.call({}), undefined);
    assert.equal(state.ops, undefined); assert.equal(target[key], undefined); assert.equal(requests.length, 0);
    await lifecycle.onPageShow.call({}); assert.equal(state.ops.pageId, 'plans'); assert.equal(requests.length, 1);
    const capsule = target[key]; await lifecycle.onPageHide.call({}); await lifecycle.onPageShow.call({});
    assert.equal(requests.length, 2); assert.equal(target[key], capsule); await lifecycle.onPageUnload.call({});
  });
});

test('independent lifecycle cleanup clears private handler state and ignores late evidence without touching another page', async () => {
  const evidence = deferred(), row = { userId: 1, kind: 'identity', applicationId: 'fixture-application', canView: true };
  await withLifecycle('certifications', ({ action }) => {
    if (action.endsWith('.list')) return reply(list([row]));
    if (action.endsWith('.detail')) return reply({ ...row, version, canReview: true, user: { nickname: 'fixture-private-name' },
      materials: [{ id: 'fixture-material', mimeType: 'image/png' }] });
    if (action.endsWith('.material')) return reply({ id: 'fixture-material', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=' });
    if (action.endsWith('.evidence')) return evidence.promise;
    throw new Error('Unexpected fixture read');
  }, async ({ lifecycle, scope, api, state, command, requests }) => {
    await lifecycle.onPageLoad.call({}); await command('select', { index: 0 }); await command('material', { index: 0 });
    assert.ok(state.ops.material.src.startsWith('data:image/png;base64,'));
    await command('edit', { field: 'remark' }, 'fixture-private-review-note');
    await command('edit', { field: 'feedback' }, 'fixture-private-feedback'); await command('prepare', { operation: 'reject' });
    assert.match(state.ops.detailText, /fixture-private-name/); assert.ok(state.ops.confirmation);
    const reading = command('evidence'); assert.equal(state.ops.evidenceLoading, true);
    const next = createPage('orders', { ops: { detailText: 'fixture-next-page-sentinel' } }), before = plain(next.state);
    api.page = next.page; scope.$page = next.second;
    await lifecycle.onPageHide.call({ handler: { operations: {} } }); await lifecycle.onPageUnload.call({});
    evidence.resolve(reply({ verificationCode: 'fixture-late-private-code' })); await reading;
    assertPrivateCleared(state); assert.deepEqual(next.state, before); assert.equal(next.updates.length, 0); assert.equal(requests.length, 4);
  });
});

test('late initialization cannot restore rows after hide/unload from its independent lifecycle', async () => {
  const pending = deferred();
  await withLifecycle('matchmakers', () => pending.promise, async ({ lifecycle, scope, api, target, state, requests }) => {
    const initializing = lifecycle.onPageLoad.call({}); assert.equal(state.ops.loading, true);
    await lifecycle.onPageShow.call({}); assert.equal(requests.length, 1);
    const next = createPage('plans', { ops: { detailText: 'fixture-next-page-sentinel' } }); api.page = next.page; scope.$page = next.second;
    await lifecycle.onPageHide.call({}); await lifecycle.onPageUnload.call({});
    pending.resolve(reply(list([{ id: 1, user: { nickname: 'fixture-late-private-name' } }]))); await initializing;
    assert.equal(state.ops.loading, false); assert.equal(state.ops.total, null); assertPrivateCleared(state);
    assert.equal(target[key], undefined); assert.equal(next.state.ops.detailText, 'fixture-next-page-sentinel'); assert.equal(next.updates.length, 0);
  });
});

test('initialization uses the current active page target and cleanup keeps that captured owner after navigation', async () => {
  for (const persisted of [false, true]) {
    await withLifecycle('salons', ({ action }) => reply(action.endsWith('.list') ? list([{ id: 1 }])
      : { id: 1, version, title: 'fixture-private-current-salon', canApprove: true }),
    async ({ lifecycle, scope, api, state, requests, command }) => {
      // The free global still points at the first target; $w.page is already a
      // different live target with the same page id, as in the native loader.
      const active = createPage('salons'); api.page = active.page;
      await lifecycle.onPageLoad.call({ handler: { operations: {} } });
      assert.equal(requests.length, 1); assert.equal(requests[0].data.action, 'salons.list');
      assert.equal(active.state.ops.pageId, 'salons'); assert.equal(active.state.ops.total, 1);
      assert.equal(state.ops, undefined, 'The stale free global never receives initialization');
      await command('select', { index: 0 }); assert.match(active.state.ops.detailText, /fixture-private-current-salon/);
      const next = createPage('orders', { ops: { detailText: 'fixture-next-page-sentinel' } }), before = plain(next.state);
      api.page = next.page; scope.$page = next.second;
      await lifecycle.onPageHide.call({}); await lifecycle.onPageUnload.call({});
      assertPrivateCleared(active.state); assert.equal(active.target[key], undefined);
      assert.deepEqual(next.state, before); assert.equal(next.updates.length, 0); assert.equal(state.ops, undefined);
    }, { persisted });
  }
});

test('all five active management pages initialize when the unrelated free global remains on overview', async () => {
  for (const persisted of [false, true]) {
    for (const pageId of pageIds) {
      await withLifecycle(pageId, () => reply(list()), async ({ lifecycle, scope, state, target, requests }) => {
        const overview = createPage('overview', { sentinel: 'fixture-overview-unchanged' }), before = plain(overview.state);
        scope.$page = overview.page;
        await lifecycle.onPageLoad.call({}); await lifecycle.onPageShow.call({ handler: { operations: {} } });
        assert.equal(requests.length, 1); assert.equal(requests[0].data.action, `${pageId}.list`);
        assert.equal(state.ops.pageId, pageId); assert.equal(state.ops.total, 0); assert.equal(state.ops.error, '');
        assert.equal(state.ops.totalText, '共 0 条记录'); assert.ok(target[key]);
        assert.deepEqual(overview.state, before); assert.equal(overview.updates.length, 0); assert.equal(overview.target[key], undefined);
        await lifecycle.onPageUnload.call({}); assertPrivateCleared(state);
      }, { persisted });
    }
  }
});

test('active-page initialization never reads a missing or throwing free global page', async () => {
  for (const persisted of [false, true]) {
    for (const pageId of pageIds) {
      for (const mode of ['missing', 'throwing']) {
        await withLifecycle(pageId, () => reply(list()), async ({ lifecycle, scope, state, requests }) => {
          let globalReads = 0;
          if (mode === 'missing') delete scope.$page;
          else Object.defineProperty(scope, '$page', { configurable: true, get() {
            globalReads++; throw new Error('fixture-free-global-must-never-be-read');
          } });
          await lifecycle.onPageLoad.call({}); await lifecycle.onPageShow.call({});
          assert.equal(globalReads, 0); assert.equal(requests.length, 1);
          assert.equal(state.ops.pageId, pageId); assert.equal(state.ops.total, 0); assert.equal(state.ops.totalText, '共 0 条记录');
          await lifecycle.onPageHide.call({}); await lifecycle.onPageUnload.call({});
          assert.equal(globalReads, 0); assertPrivateCleared(state);
        }, { persisted });
      }
    }
  }
});

test('a stale matching free global cannot initialize when the actual active page is a different page', async () => {
  for (const persisted of [false, true]) {
    await withLifecycle('salons', () => reply(list()), async ({ lifecycle, api, state, requests }) => {
      const actual = createPage('overview', { sentinel: 'fixture-overview-unchanged' }); api.page = actual.page;
      assert.throws(() => lifecycle.onPageLoad.call({}), /管理页面上下文不匹配/);
      assert.equal(requests.length, 0); assert.equal(state.ops, undefined); assert.equal(actual.state.ops, undefined);
      assert.equal(actual.target[key], undefined); assert.equal(actual.updates.length, 0);
    }, { persisted });
  }
});
