const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'weda-admin', 'operations-runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const VERSION = 'hl-admin-operations-runtime-v3';
const detailVersion = 'v1_' + 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const reply = data => ({ result: { code: 0, data } });
const list = (rows = []) => ({ list: rows, total: rows.length, page: 1, pageSize: 10 });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function page(id = 'matchmakers') {
  const state = {}, updates = [], control = { rejectSetState: false };
  const target = { id, handler: {}, dataset: { state }, __internal__: { active: true }, setState(patch) {
    if (control.rejectSetState) throw new Error('fixture-state-setter-no-longer-available');
    updates.push(patch); Object.assign(state, patch);
  } };
  const proxy = () => new Proxy(target, { get(target, key, receiver) {
    return key === '$page' ? target : Reflect.get(target, key, receiver);
  } });
  return { target, page: proxy(), second: proxy(), state, updates, control };
}
function harness(fixture = () => reply(list()), initial = page(), { allowWrites = false, crypto = webcrypto } = {}) {
  const requests = [], revoked = [], opened = [], created = [];
  const api = { page: initial.page, cloud: { async callFunction(request) {
    assert.equal(request.name, 'hlAdminOperations');
    assert.match(request.data.action, allowWrites ? /\.(?:list|detail|evidence|material|review|cancel|update)$/ : /\.(?:list|detail|evidence|material)$/);
    requests.push(plain(request)); return fixture(request.data, requests.length);
  } } };
  const pdfControl = { throwOnClose: false, throwOnRevoke: false };
  const environment = { $w: api, crypto, Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) { const url = 'blob:fixture-' + (created.length + 1); created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); if (pdfControl.throwOnRevoke) throw new Error('fixture-revoke-unavailable'); } },
    window: { open(url) { const entry = { url, opener: {}, closed: false, close() {
      entry.closed = true; if (pdfControl.throwOnClose) throw new Error('fixture-window-close-unavailable');
    } }; opened.push(entry); return entry; } } };
  function module(owner = initial.page) {
    const scope = vm.createContext({ ...environment, $page: owner });
    const executable = source.replace(/^export function /gm, 'function ')
      .replace(/^export default async function operations\b/m, 'async function operations')
      + '\nglobalThis.__module = { operations, getOperationsController };';
    new vm.Script(executable, { filename: 'independent-native-handler-module' }).runInContext(scope);
    const exports = scope.__module;
    let bound;
    const command = (command, target = {}, value, extra = {}) => {
      assert.equal(typeof bound, 'function', 'Tests call the actual registered bound handler');
      return bound({ ...extra, data: { target: { command, ...target } },
        ...(value === undefined ? {} : { event: { detail: { value } } }) });
    };
    const module = { ...exports, scope, command, register(target = owner) {
      bound = exports.operations.bind(target); target.handler.operations = bound; return module;
    }, get registered() { return bound; } };
    return module;
  }
  async function lifecycle(owner = initial.page) {
    const connector = await import(pathToFileURL(path.join(root, 'scripts', 'connect-weda-operations.mjs')).href);
    const scope = vm.createContext({ ...environment, $page: owner });
    const code = connector.operationsLifecycle(owner.id, source);
    assert.doesNotMatch(code, /^\s*import\s|async function operations\(|new WeakMap|Symbol\.for/m);
    new vm.Script(code.replace(/\bexport default\s+/, 'globalThis.__hooks = '), { filename: 'independent-native-lifecycle-bridge' }).runInContext(scope);
    return { hooks: scope.__hooks, scope };
  }
  return { ...initial, api, requests, revoked, opened, created, pdfControl, module, lifecycle };
}
function scrubbed(model) {
  assert.equal(model.detail, null); assert.equal(model.selected, null); assert.equal(model.detailText, '');
  assert.equal(model.material, null); assert.equal(model.evidenceText, ''); assert.equal(model.evidenceLoading, false);
  assert.equal(model.remark, ''); assert.equal(model.feedback, ''); assert.equal(model.confirmation, null);
  assert.equal(model.evidenceReference, ''); assert.deepEqual(plain(model.rows), []);
  assert.equal(model.canApprove, false); assert.equal(model.canReject, false); assert.equal(model.canToggle, false);
  assert.doesNotMatch(JSON.stringify(model), /fixture-private|fixture-late-private/);
}
function privateFixture({ action, args }) {
  if (action.endsWith('.list')) return reply(list([{ id: 1 }]));
  if (action.endsWith('.detail')) return reply({ id: args.id, version: detailVersion, canReview: true,
    user: { nickname: 'fixture-private-name', phone: 'fixture-private-phone' } });
  throw new Error('Unexpected fixture read');
}
function certificationFixture(options = {}) {
  const row = { userId: 1, kind: 'identity', applicationId: 'fixture-app', canView: true };
  return ({ action }) => {
    if (action.endsWith('.list')) return reply(list([row]));
    if (action.endsWith('.detail')) return reply({ ...row, version: detailVersion, canReview: true,
      user: { nickname: 'fixture-private-name' }, materials: [{ id: 'fixture-material', mimeType: 'application/pdf' }] });
    if (action.endsWith('.material')) return options.material || reply({ id: 'fixture-material', mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjQK' });
    if (action.endsWith('.evidence')) return options.evidence || reply({ verificationCode: 'fixture-private-evidence-code' });
    throw new Error('Unexpected fixture read');
  };
}

test('native lifecycle and rematch call one registered handler with private state keyed by the canonical raw page owner', async () => {
  const h = harness(privateFixture), handler = h.module().register(), unusedModule = h.module(h.second), lifecycle = await h.lifecycle();
  await lifecycle.hooks.onPageLoad(); const controller = handler.getOperationsController(h.page);
  assert.ok(controller); assert.equal(controller.version, VERSION); assert.equal(controller.owner, h.target);
  assert.equal(handler.getOperationsController(h.second), controller); assert.equal(unusedModule.getOperationsController(h.page), null);
  h.api.page = h.second; await lifecycle.hooks.onPageShow(); await handler.command('select', { index: 0 });
  assert.equal(h.requests.filter(request => request.data.action.endsWith('.list')).length, 1);
  assert.match(h.state.ops.detailText, /fixture-private-phone/); assert.equal(typeof controller.token, 'object');
  assert.equal(Object.getOwnPropertySymbols(h.target).length, 0); assert.doesNotMatch(JSON.stringify(h.state), /WeakMap|capsule|hl-admin-operations-runtime/);
  await lifecycle.hooks.onPageUnload(); scrubbed(h.state.ops); assert.equal(handler.getOperationsController(h.page), null);
});

test('concurrent load/show through different proxies of one owner and rematch init issue one initial list', async () => {
  const pending = deferred(), h = harness(() => pending.promise), handler = h.module().register(), lifecycle = await h.lifecycle();
  const loading = lifecycle.hooks.onPageLoad(); const controller = handler.getOperationsController(h.page), token = controller.token;
  h.api.page = h.second; await lifecycle.hooks.onPageShow(); await handler.command('init');
  assert.equal(h.requests.length, 1); assert.equal(handler.getOperationsController(h.second), controller); assert.equal(controller.token, token);
  pending.resolve(reply(list([{ id: 1 }]))); await loading; assert.equal(h.state.ops.total, 1); assert.equal(h.state.ops.loading, false);
});

test('different raw page owners with the same id never share controller data or accept each other late response', async () => {
  const late = deferred(), h = harness((input, count) => count === 1 ? late.promise : privateFixture(input));
  const old = h.module().register(), oldLifecycle = await h.lifecycle(), pending = oldLifecycle.hooks.onPageLoad();
  const other = page('matchmakers'); h.api.page = other.page; const active = h.module(other.page).register(), currentLifecycle = await h.lifecycle(other.page);
  await currentLifecycle.hooks.onPageLoad(); await active.command('select', { index: 0 }); const before = plain(other.state);
  assert.notEqual(old.getOperationsController(h.page).owner, active.getOperationsController(other.page).owner);
  late.resolve(reply(list([{ id: 999, user: { nickname: 'fixture-late-private-other-owner' } }]))); await pending;
  await oldLifecycle.hooks.onPageHide(); await oldLifecycle.hooks.onPageUnload();
  assert.deepEqual(plain(other.state), before); scrubbed(h.state.ops); assert.ok(active.getOperationsController(other.page));
});

test('cold query and reset bootstrap only read state and a later no-token init does not duplicate the list', async () => {
  for (const command of ['query', 'reset']) {
    const h = harness(privateFixture), handler = h.module().register(); await handler.command(command);
    assert.equal(h.state.ops.total, 1); assert.equal(h.state.ops.totalText, '共 1 条记录'); assert.equal(h.requests.length, 1);
    await handler.command('init'); assert.equal(h.requests.length, 1); assert.ok(handler.getOperationsController(h.page));
  }
});

test('non-read commands cannot initialize a missing controller or make a request', async () => {
  const h = harness(privateFixture), handler = h.module().register();
  for (const command of ['clear', 'select', 'submit', 'prepare', 'material', 'evidence']) await handler.command(command, { index: 0, operation: 'approve' });
  assert.equal(handler.getOperationsController(h.page), null); assert.equal(h.requests.length, 0); assert.ok(h.state.ops.error);
});

test('canonical owner conflicts, primitive owners and throwing raw-owner getters fail closed', async () => {
  for (const kind of ['different-id', 'primitive', 'throwing']) {
    const current = page(), h = harness(privateFixture, current);
    const wrong = new Proxy(current.target, { get(target, key, receiver) {
      if (key !== '$page') return Reflect.get(target, key, receiver);
      if (kind === 'throwing') throw new Error('fixture-unavailable-native-owner');
      return kind === 'primitive' ? 1 : { id: 'orders' };
    } });
    h.api.page = wrong; const handler = h.module(wrong).register(); await handler.command('init'); await handler.command('query');
    assert.equal(handler.getOperationsController(wrong), null); assert.equal(h.requests.length, 0); assert.ok(h.state.ops.error);
  }
});

test('a frozen native-style page owner needs no property or Symbol anchor to initialize and read', async () => {
  const h = harness(privateFixture), handler = h.module().register(), lifecycle = await h.lifecycle();
  Object.freeze(h.target); await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 });
  const controller = handler.getOperationsController(h.page); assert.equal(controller.owner, h.target);
  assert.equal(h.requests.length, 2); assert.equal(Object.getOwnPropertySymbols(h.target).length, 0);
  assert.match(h.state.ops.detailText, /fixture-private-phone/); await lifecycle.hooks.onPageUnload(); scrubbed(h.state.ops);
});

test('all five lifecycle reads work without crypto and do not send a write request id', async () => {
  for (const id of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
    const h = harness(() => reply(list()), page(id), { crypto: null }), handler = h.module().register(), lifecycle = await h.lifecycle();
    await lifecycle.hooks.onPageLoad(); await lifecycle.hooks.onPageShow();
    assert.equal(h.requests.length, 1); assert.equal(h.state.ops.total, 0); assert.equal(h.state.ops.error, '');
    assert.deepEqual(Object.keys(h.requests[0].data).sort(), ['action', 'args']); assert.ok(handler.getOperationsController(h.page));
  }
});

test('missing secure UUID prevents a write confirmation even after an authorized detail read', async () => {
  const h = harness(privateFixture, page(), { crypto: null }), handler = h.module().register();
  await handler.command('init'); await handler.command('select', { index: 0 }); await handler.command('prepare', { operation: 'approve' });
  assert.equal(h.requests.length, 2); assert.equal(h.state.ops.confirmation, null); assert.ok(h.state.ops.error);
  await handler.command('submit'); assert.equal(h.requests.length, 2);
});

test('late detail after captured lifecycle hide/unload cannot restore private rows or selection', async () => {
  const pending = deferred(), h = harness(({ action }) => action.endsWith('.list') ? reply(list([{ id: 1 }])) : pending.promise);
  const handler = h.module().register(), lifecycle = await h.lifecycle(); await lifecycle.hooks.onPageLoad();
  const detail = handler.command('select', { index: 0 }); await lifecycle.hooks.onPageHide(); await lifecycle.hooks.onPageUnload();
  pending.resolve(reply({ id: 1, version: detailVersion, canReview: true, user: { nickname: 'fixture-late-private-name' } })); await detail;
  scrubbed(h.state.ops); assert.equal(handler.getOperationsController(h.page), null); assert.equal(h.requests.length, 2);
});

test('PDF windows and object URLs opened by the registered handler are disposed by the tiny lifecycle', async () => {
  const h = harness(certificationFixture(), page('certifications')), handler = h.module().register(), lifecycle = await h.lifecycle();
  await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 }); await handler.command('material', { index: 0 }); await handler.command('openPdf');
  const controller = handler.getOperationsController(h.page); assert.equal(controller.ctx.pdfUrl, 'blob:fixture-1'); assert.equal(h.opened[0].opener, null);
  await lifecycle.hooks.onPageHide(); await lifecycle.hooks.onPageUnload();
  assert.deepEqual(h.revoked, ['blob:fixture-1']); assert.equal(h.opened[0].closed, true); assert.equal(controller.ctx.pdfUrl, null);
  assert.deepEqual(plain(controller.ctx.pdfWindows), []); scrubbed(h.state.ops);
});

test('late PDF and evidence after unload cannot create a URL or restore a private proof', async () => {
  const material = deferred(), evidence = deferred(), h = harness(certificationFixture({ material: material.promise, evidence: evidence.promise }), page('certifications'));
  const handler = h.module().register(), lifecycle = await h.lifecycle(); await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 });
  const image = handler.command('material', { index: 0 }), proof = handler.command('evidence'); await lifecycle.hooks.onPageUnload();
  material.resolve(reply({ mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjQK' })); evidence.resolve(reply({ verificationCode: 'fixture-late-private-proof' }));
  await Promise.all([image, proof]); assert.equal(h.created.length, 0); scrubbed(h.state.ops); assert.equal(handler.getOperationsController(h.page), null);
});

test('a new lifecycle token replaces the same-module controller and an old token cannot clear current data', async () => {
  const h = harness(privateFixture), handler = h.module().register(), oldLifecycle = await h.lifecycle();
  await oldLifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 });
  const old = handler.getOperationsController(h.page), held = h.state.ops, freshLifecycle = await h.lifecycle();
  await freshLifecycle.hooks.onPageLoad(); const fresh = handler.getOperationsController(h.page); assert.notEqual(fresh, old); assert.notEqual(fresh.token, old.token);
  scrubbed(held); scrubbed(old.ctx.model); await handler.command('select', { index: 0 }); const before = plain(h.state);
  await oldLifecycle.hooks.onPageHide(); await oldLifecycle.hooks.onPageUnload();
  await handler.command('clear', {}, undefined, { cleanupPage: h.page, cleanupToken: old.token, disposeController: true });
  assert.equal(handler.getOperationsController(h.page), fresh); assert.deepEqual(plain(h.state), before);
});

test('hot-replaced registered modules isolate old cleanup and late responses from the new module dataset', async () => {
  const pending = deferred(), h = harness((input, count) => count === 2 ? pending.promise : privateFixture(input));
  const old = h.module().register(), oldLifecycle = await h.lifecycle(); await oldLifecycle.hooks.onPageLoad();
  const late = old.command('select', { index: 0 }), oldController = old.getOperationsController(h.page), held = h.state.ops;
  const current = h.module(h.second).register(), currentLifecycle = await h.lifecycle(h.second);
  h.api.page = h.second; await currentLifecycle.hooks.onPageLoad(); await current.command('select', { index: 0 }); const before = plain(h.state), updateCount = h.updates.length;
  assert.notEqual(old.registered, current.registered); assert.notEqual(oldController, current.getOperationsController(h.page));
  pending.resolve(reply({ id: 1, version: detailVersion, user: { nickname: 'fixture-late-private-old-module' } })); await late;
  await oldLifecycle.hooks.onPageHide(); await oldLifecycle.hooks.onPageUnload(); oldController.dispose();
  assert.deepEqual(plain(h.state), before); assert.equal(h.updates.length, updateCount); scrubbed(held); scrubbed(oldController.ctx.model);
  assert.ok(current.getOperationsController(h.page)); const requests = h.requests.length; await old.command('query'); assert.equal(h.requests.length, requests);
});

test('removing the registered handler slot also prevents its deferred private detail from publishing', async () => {
  const pending = deferred(), h = harness(({ action }) => action.endsWith('.list') ? reply(list([{ id: 1 }])) : pending.promise);
  const handler = h.module().register(); await handler.command('init'); const detail = handler.command('select', { index: 0 });
  delete h.target.handler.operations; const before = plain(h.state), updateCount = h.updates.length;
  pending.resolve(reply({ id: 1, version: detailVersion, user: { nickname: 'fixture-late-private-deleted-handler' } })); await detail;
  assert.deepEqual(plain(h.state), before); assert.equal(h.updates.length, updateCount); assert.equal(h.state.ops.detail, null);
});

test('registered-handler writes require explicit confirmation and retries preserve the secure operation id', async () => {
  let writes = 0;
  const h = harness(input => {
    if (input.action.endsWith('.review')) { if (++writes === 1) throw new Error('fixture-unknown-write-result'); return reply({ version: detailVersion }); }
    return privateFixture(input);
  }, page(), { allowWrites: true });
  const handler = h.module().register(), lifecycle = await h.lifecycle(); await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 });
  await handler.command('edit', { field: 'remark' }, 'fixture-checked-review'); await handler.command('prepare', { operation: 'approve' });
  assert.equal(writes, 0); assert.equal(h.state.ops.confirmation.args.expectedVersion, detailVersion);
  await handler.command('submit'); assert.ok(h.state.ops.confirmation); await handler.command('submit');
  const requests = h.requests.filter(request => request.data.action.endsWith('.review'));
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.match(requests[0].data.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(h.state.ops.confirmation, null); assert.equal(h.state.ops.detail, null);
});

test('permission and stale-version errors clear private state across the registered lifecycle boundary', async () => {
  for (const code of [40360, 40960]) {
    const h = harness(input => input.action.endsWith('.review') ? { result: { code } } : privateFixture(input), page(), { allowWrites: true });
    const handler = h.module().register(), lifecycle = await h.lifecycle(); await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 });
    await handler.command('prepare', { operation: 'approve' }); await handler.command('submit');
    assert.equal(h.state.ops.detail, null); assert.equal(h.state.ops.confirmation, null); assert.equal(h.state.ops.canApprove, false);
    const count = h.requests.length; await handler.command('submit'); assert.equal(h.requests.length, count); await lifecycle.hooks.onPageUnload(); scrubbed(h.state.ops);
  }
});

test('cleanup erases published and cloned private models when setState, PDF close and revoke all throw', async () => {
  const h = harness(certificationFixture(), page('certifications')), handler = h.module().register(), lifecycle = await h.lifecycle();
  await lifecycle.hooks.onPageLoad(); await handler.command('select', { index: 0 }); await handler.command('material', { index: 0 }); await handler.command('openPdf');
  await handler.command('evidence'); await handler.command('edit', { field: 'remark' }, 'fixture-private-note');
  await handler.command('edit', { field: 'feedback' }, 'fixture-private-feedback');
  const controller = handler.getOperationsController(h.page), held = h.state.ops, clone = plain(h.state.ops);
  h.state.ops = clone; h.control.rejectSetState = true; h.pdfControl.throwOnClose = true; h.pdfControl.throwOnRevoke = true;
  await assert.doesNotReject(lifecycle.hooks.onPageHide()); scrubbed(held); scrubbed(clone); scrubbed(controller.ctx.model);
  assert.equal(controller.ctx.pdfUrl, null); assert.deepEqual(plain(controller.ctx.pdfWindows), []);
  assert.equal(h.opened[0].closed, true); assert.deepEqual(h.revoked, ['blob:fixture-1']);
  await assert.doesNotReject(lifecycle.hooks.onPageUnload()); assert.equal(handler.getOperationsController(h.page), null);
});
