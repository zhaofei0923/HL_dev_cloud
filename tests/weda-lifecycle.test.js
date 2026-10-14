const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'weda-admin', 'operations-runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const app = JSON.parse(fs.readFileSync(path.join(root, 'weda-admin', 'app.cals.json'), 'utf8'));
const pageIds = ['matchmakers', 'certifications', 'salons', 'plans', 'orders'];
const version = 'v1_' + 'a'.repeat(64);
let moduleNumber = 0;
const reply = data => ({ result: { code: 0, data } });
const list = (rows = []) => ({ list: rows, total: rows.length, page: 1, pageSize: 10 });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createPage(id, initialState = {}) {
  const state = { ...initialState };
  const updates = [];
  const page = {
    id,
    __internal__: { active: true },
    dataset: { state },
    setState(patch) { updates.push(patch); Object.assign(state, patch); },
  };
  return { page, state, updates };
}

function lifecycleResource(pageId) {
  const page = app.items.find(item => item.id === pageId);
  assert.ok(page, `Missing CALS page ${pageId}`);
  const lifecycle = page.resources.filter(item => item.codeType === 'lifecycle');
  const handler = page.resources.filter(item => item.codeType === 'handler-fn' && item.name === 'operations');
  assert.equal(lifecycle.length, 1);
  assert.equal(handler.length, 1);
  assert.equal(lifecycle[0].path, `${pageId}/lifecycle`);
  assert.equal(handler[0].path, `${pageId}/handler/operations`);
  assert.ok(handler[0].code.endsWith(runtimeSource), 'CALS must embed the current real operations runtime');
  return lifecycle[0].code;
}

function executeLifecycle(pageId, runtime, page) {
  const source = lifecycleResource(pageId);
  const fixedImport = /^\s*import operations from (['"])\.\/handler\/operations\1;\s*$/gm;
  assert.equal([...source.matchAll(fixedImport)].length, 1, 'Use the handler default export at its exact relative path');
  // Only the fixed ESM import/export wrapper is adapted for this dependency-free
  // Node VM test. Relative loading and shared exports were checked separately
  // against the official CMD loader; this is not an editor or cloud test.
  const executable = source
    .replace(fixedImport, 'const operations = __operations;')
    .replace(/\bexport default\s+/, 'globalThis.__lifecycle = ');
  const scope = vm.createContext({ $page: page, __operations: runtime.default });
  new vm.Script(executable, { filename: `${pageId}/lifecycle` }).runInContext(scope);
  return { lifecycle: scope.__lifecycle, scope };
}

async function withLifecycle(pageId, fixture, run) {
  const runtime = await import('data:text/javascript;base64,' + Buffer.from(runtimeSource).toString('base64') + '#lifecycle-' + ++moduleNumber);
  assert.equal(typeof runtime.default, 'function');
  assert.equal(runtime.operations, undefined, 'operations is a default export, not a named export');
  const current = createPage(pageId);
  const requests = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, '$w');
  const api = {
    page: current.page,
    cloud: {
      async callFunction(request) {
        assert.equal(request.name, 'hlAdminOperations');
        assert.match(request.data.action, /\.(?:list|detail|evidence|material)$/,
          'Lifecycle tests must never issue a business write');
        requests.push(structuredClone(request));
        return fixture(request.data, requests.length);
      },
    },
  };
  Object.defineProperty(globalThis, '$w', { configurable: true, writable: true, value: api });
  const { lifecycle, scope } = executeLifecycle(pageId, runtime, current.page);
  const command = (command, target = {}, value) => runtime.default({
    data: { target: { command, ...target } },
    ...(value === undefined ? {} : { event: { detail: { value } } }),
  });
  try {
    return await run({ ...current, runtime, lifecycle, scope, api, requests, command });
  } finally {
    if (previous) Object.defineProperty(globalThis, '$w', previous);
    else delete globalThis.$w;
  }
}

test('the legacy lifecycle reproduces the editor error when this differs from the page API', async () => {
  await withLifecycle('salons', () => reply(list()), async ({ runtime, page, requests }) => {
    page.handler = { operations: runtime.default };
    const scope = vm.createContext({ $page: page });
    const legacy = new vm.Script(`({ onPageHide() {
      return this.handler.operations({ cleanupPage: this, data: { target: { command: 'clear' } } });
    } })`).runInContext(scope);
    assert.throws(() => legacy.onPageHide.call({ handler: { operations: {} } }),
      error => error.name === 'TypeError' && /operations.*not a function/.test(error.message));
    assert.equal(requests.length, 0);
  });
});

test('all five real CALS lifecycles initialize without this.handler and share one controller across load/show', async () => {
  for (const pageId of pageIds) {
    await withLifecycle(pageId, () => reply(list()), async ({ lifecycle, page, state, requests }) => {
      assert.equal(page.handler, undefined);
      await lifecycle.onPageLoad.call({});
      await lifecycle.onPageShow.call({ handler: { operations: {} } });
      assert.equal(state.ops.pageId, pageId);
      assert.equal(state.ops.total, 0);
      assert.equal(state.ops.error, '');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].data.action, `${pageId}.list`);
      await lifecycle.onPageHide.call({});
      await lifecycle.onPageUnload.call({ handler: { operations: {} } });
      assert.equal(state.ops.detail, null);
      assert.deepEqual(state.ops.rows, []);
    });
  }
});

test('hide/unload before initialization do nothing, and show can initialize the captured page', async () => {
  await withLifecycle('plans', () => reply(list()), async ({ lifecycle, state, requests }) => {
    assert.equal(lifecycle.onPageHide.call({}), undefined);
    assert.equal(lifecycle.onPageUnload.call({}), undefined);
    assert.equal(state.ops, undefined);
    assert.equal(requests.length, 0);
    await lifecycle.onPageShow.call({});
    assert.equal(state.ops.pageId, 'plans');
    assert.equal(state.ops.total, 0);
    assert.equal(requests.length, 1);
    await lifecycle.onPageUnload.call({});
  });
});

test('leaving clears the old page private state and a late evidence response cannot restore it or touch the next page', async () => {
  const evidence = deferred();
  const row = { userId: 1, kind: 'identity', applicationId: 'fixture-application', canView: true };
  await withLifecycle('certifications', ({ action }) => {
    if (action === 'certifications.list') return reply(list([row]));
    if (action === 'certifications.detail') return reply({
      ...row, version, canReview: true, user: { nickname: 'fixture-private-name' },
      materials: [{ id: 'fixture-material', mimeType: 'image/png' }],
    });
    if (action === 'certifications.material') return reply({
      id: 'fixture-material', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=',
    });
    if (action === 'certifications.evidence') return evidence.promise;
    throw new Error('Unexpected lifecycle test action');
  }, async ({ lifecycle, scope, api, state, command, requests }) => {
    await lifecycle.onPageLoad.call({});
    await command('select', { index: 0 });
    await command('material', { index: 0 });
    assert.ok(state.ops.material.src.startsWith('data:image/png;base64,'));
    await command('edit', { field: 'remark' }, 'fixture-private-review-note');
    await command('edit', { field: 'feedback' }, 'fixture-private-applicant-feedback');
    await command('prepare', { operation: 'reject' });
    assert.match(state.ops.detailText, /fixture-private-name/);
    assert.equal(state.ops.material, null, 'Opening confirmation closes the visible material');
    assert.ok(state.ops.confirmation);
    const reading = command('evidence');
    assert.equal(state.ops.evidenceLoading, true);
    const next = createPage('orders', { ops: { detailText: 'fixture-next-page-sentinel' } });
    const nextSnapshot = structuredClone(next.state);
    api.page = next.page;
    scope.$page = next.page;
    await lifecycle.onPageHide.call({ handler: { operations: {} } });
    await lifecycle.onPageUnload.call({});
    evidence.resolve(reply({ verificationCode: 'fixture-late-private-code' }));
    await reading;
    assert.equal(state.ops.detail, null);
    assert.equal(state.ops.selected, null);
    assert.equal(state.ops.detailText, '');
    assert.equal(state.ops.material, null);
    assert.equal(state.ops.evidenceText, '');
    assert.equal(state.ops.evidenceLoading, false);
    assert.equal(state.ops.remark, '');
    assert.equal(state.ops.feedback, '');
    assert.equal(state.ops.confirmation, null);
    assert.deepEqual(state.ops.rows, []);
    assert.doesNotMatch(JSON.stringify(state), /fixture-private|fixture-late-private/);
    assert.deepEqual(next.state, nextSnapshot);
    assert.equal(next.updates.length, 0);
    assert.equal(requests.length, 4);
  });
});

test('a pending initialization response cannot revive a page after its actual lifecycle clears it', async () => {
  const pending = deferred();
  await withLifecycle('matchmakers', () => pending.promise, async ({ lifecycle, scope, api, state, requests }) => {
    const initializing = lifecycle.onPageLoad.call({});
    assert.equal(state.ops.loading, true);
    const next = createPage('plans', { ops: { detailText: 'fixture-next-page-sentinel' } });
    api.page = next.page;
    scope.$page = next.page;
    await lifecycle.onPageHide.call({});
    pending.resolve(reply(list([{ id: 1, user: { nickname: 'fixture-late-private-name' } }])));
    await initializing;
    assert.equal(requests.length, 1);
    assert.equal(state.ops.loading, false);
    assert.equal(state.ops.total, null);
    assert.deepEqual(state.ops.rows, []);
    assert.doesNotMatch(JSON.stringify(state), /fixture-late-private-name/);
    assert.equal(next.state.ops.detailText, 'fixture-next-page-sentinel');
    assert.equal(next.updates.length, 0);
  });
});

test('initialization uses lifecyclePage even when the global active page already points elsewhere', async () => {
  await withLifecycle('salons', () => reply(list()), async ({ lifecycle, api, state, requests }) => {
    const next = createPage('orders', { ops: { detailText: 'fixture-next-page-sentinel' } });
    api.page = next.page;
    await lifecycle.onPageLoad.call({ handler: { operations: {} } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].data.action, 'salons.list');
    assert.equal(state.ops.pageId, 'salons');
    assert.equal(next.state.ops.detailText, 'fixture-next-page-sentinel');
    assert.equal(next.updates.length, 0);
    await lifecycle.onPageHide.call({});
    assert.equal(state.ops.loading, false);
    assert.equal(state.ops.total, null);
    assert.deepEqual(state.ops.rows, []);
  });
});
