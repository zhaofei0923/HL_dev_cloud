const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'weda-admin', 'operations-runtime.js'), 'utf8').replace(/\r\n/g, '\n');
const KEY = Symbol.for('hl.admin.operations.controller');
const VERSION = 'hl-admin-operations-runtime-v2';
const detailVersion = 'v1_' + 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const reply = data => ({ result: { code: 0, data } });
const list = (rows = []) => ({ list: rows, total: rows.length, page: 1, pageSize: 10 });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function page(id = 'matchmakers') {
  const state = {}, updates = [];
  const control = { rejectSetState: false };
  const target = { id, dataset: { state }, __internal__: { active: true }, setState(patch) {
    if (control.rejectSetState) throw new Error('fixture-state-setter-no-longer-available');
    updates.push(patch); Object.assign(state, patch);
  } };
  return { target, page: new Proxy(target, {}), second: new Proxy(target, {}), state, updates, control };
}
function harness(fixture = () => reply(list()), initial = page()) {
  const requests = [], revoked = [], opened = [], created = [];
  const api = { page: initial.page, cloud: { async callFunction(request) {
    assert.equal(request.name, 'hlAdminOperations');
    assert.match(request.data.action, /\.(?:list|detail|evidence|material)$/, 'No business write is allowed by this harness');
    requests.push(plain(request)); return fixture(request.data, requests.length);
  } } };
  const pdfControl = { throwOnClose: false, throwOnRevoke: false };
  const environment = { $w: api, crypto: webcrypto, Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) { const url = 'blob:fixture-' + (created.length + 1); created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); if (pdfControl.throwOnRevoke) throw new Error('fixture-revoke-unavailable'); } },
    window: { open(url) { const entry = { url, opener: {}, closed: false, close() {
      entry.closed = true; if (pdfControl.throwOnClose) throw new Error('fixture-window-close-unavailable');
    } }; opened.push(entry); return entry; } } };
  function module(runtime = source, owner = initial.page) {
    const scope = vm.createContext({ ...environment, $page: owner });
    const executable = runtime.replace(/^export function /gm, 'function ')
      .replace(/^export default async function operations\b/m, 'async function operations')
      + '\nglobalThis.__module = { operations, getOperationsController };';
    new vm.Script(executable, { filename: 'separate-native-handler-copy' }).runInContext(scope);
    const exports = scope.__module;
    const command = (command, target = {}, value, extra = {}) => exports.operations({ ...extra,
      data: { target: { command, ...target } }, ...(value === undefined ? {} : { event: { detail: { value } } }) });
    return { ...exports, scope, command };
  }
  async function lifecycle(owner = initial.page, runtime = source) {
    const connector = await import(pathToFileURL(path.join(root, 'scripts', 'connect-weda-operations.mjs')).href);
    const scope = vm.createContext({ ...environment, $page: owner });
    const code = connector.operationsLifecycle(owner.id, runtime);
    assert.doesNotMatch(code, /^\s*import\s/m);
    new vm.Script(code.replace(/\bexport default\s+/, 'globalThis.__hooks = '), { filename: 'separate-native-lifecycle-copy' }).runInContext(scope);
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

test('two independently evaluated handlers share a nonserialized capsule through two proxies of one page target', async () => {
  const h = harness(privateFixture), a = h.module(), b = h.module(source, h.second);
  assert.notEqual(a.operations, b.operations); await a.command('init');
  const capsule = a.getOperationsController(h.page);
  assert.equal(capsule, b.getOperationsController(h.second)); assert.equal(h.target[KEY], capsule);
  assert.equal(capsule.version, VERSION); assert.equal(capsule.pageId, 'matchmakers'); assert.equal(typeof capsule.token, 'symbol');
  const descriptor = Object.getOwnPropertyDescriptor(h.target, KEY);
  assert.equal(descriptor.enumerable, false); assert.equal(descriptor.configurable, true); assert.equal(descriptor.writable, false);
  assert.equal(Object.values(h.state).includes(capsule), false); assert.doesNotMatch(JSON.stringify(h.state), /controller|capsule|hl-admin-operations-runtime/);
  h.api.page = h.second; await b.command('init'); await b.command('select', { index: 0 });
  assert.equal(h.requests.filter(request => request.data.action.endsWith('.list')).length, 1);
  assert.match(h.state.ops.detailText, /fixture-private-phone/);
  await a.command('clear', {}, undefined, { cleanupPage: h.page, cleanupController: capsule }); scrubbed(h.state.ops);
});

test('overlapping lifecycle load/show and a separate handler init issue one initial list request', async () => {
  const pending = deferred(), h = harness(() => pending.promise), lifecycle = await h.lifecycle(), handler = h.module(source, h.second);
  const loading = lifecycle.hooks.onPageLoad.call({ handler: { operations: {} } });
  const capsule = h.target[KEY]; assert.ok(capsule); assert.equal(h.requests.length, 1);
  await lifecycle.hooks.onPageShow.call({}); h.api.page = h.second; await handler.command('init');
  assert.equal(h.requests.length, 1); assert.equal(h.target[KEY], capsule);
  pending.resolve(reply(list([{ id: 1, user: { nickname: 'fixture-ready' } }]))); await loading;
  assert.equal(h.state.ops.total, 1); assert.equal(h.state.ops.loading, false);
});

test('different page targets with the same id never share state or accept the other target response', async () => {
  const late = deferred(), h = harness(({ action }, count) => count === 1 ? late.promise : privateFixture({ action, args: { id: 1 } }));
  const oldLifecycle = await h.lifecycle(), pending = oldLifecycle.hooks.onPageLoad.call({});
  const oldCapsule = h.target[KEY], other = page('matchmakers'); h.api.page = other.page;
  const handler = h.module(source, other.second); await handler.command('init'); await handler.command('select', { index: 0 });
  const newCapsule = other.target[KEY], before = plain(other.state); assert.notEqual(oldCapsule, newCapsule);
  late.resolve(reply(list([{ id: 999, user: { nickname: 'fixture-late-private-other-target' } }]))); await pending;
  assert.deepEqual(plain(h.state.ops.rows), []); assert.deepEqual(plain(other.state), before);
  oldLifecycle.scope.$page = other.second; await oldLifecycle.hooks.onPageHide.call({}); await oldLifecycle.hooks.onPageUnload.call({});
  assert.equal(other.target[KEY], newCapsule); assert.deepEqual(plain(other.state), before); scrubbed(h.state.ops);
});

test('no event command can construct a controller or request data before a successful init', async () => {
  const h = harness(privateFixture), handler = h.module();
  for (const command of ['clear', 'query', 'reset', 'select', 'submit', 'material', 'evidence']) await handler.command(command, { index: 0 });
  assert.equal(h.target[KEY], undefined); assert.equal(h.requests.length, 0); assert.ok(h.state.ops.error);
});

test('refused, hidden, or unverifiable page anchors fail closed without any cloud read', async () => {
  const cases = [
    target => { Object.preventExtensions(target); return target; },
    target => new Proxy(target, { defineProperty() { return false; } }),
    target => new Proxy(target, { get(target, key, receiver) { return key === KEY ? undefined : Reflect.get(target, key, receiver); } }),
    target => new Proxy(target, { getOwnPropertyDescriptor(target, key) { return key === KEY ? undefined : Reflect.getOwnPropertyDescriptor(target, key); } })
  ];
  for (const wrap of cases) {
    const current = page(), rejected = wrap(current.target), h = harness(privateFixture, current); h.api.page = rejected;
    const handler = h.module(source, rejected); await handler.command('init'); await handler.command('query');
    assert.equal(handler.getOperationsController(rejected), null); assert.equal(h.requests.length, 0); assert.ok(h.state.ops.error);
  }
});

test('a malformed existing anchor cannot be replaced by a fallback global or id-based controller', async () => {
  const current = page(); Object.defineProperty(current.target, KEY, { value: { version: VERSION, pageId: 'matchmakers' }, configurable: true });
  const h = harness(privateFixture, current), handler = h.module(); await handler.command('init'); await handler.command('query');
  assert.equal(handler.getOperationsController(h.page), null); assert.equal(h.requests.length, 0);
});

test('late detail after captured lifecycle hide/unload cannot restore private rows or selection', async () => {
  const pending = deferred(), h = harness(({ action }) => action.endsWith('.list') ? reply(list([{ id: 1 }])) : pending.promise);
  const lifecycle = await h.lifecycle(), handler = h.module(source, h.second); await lifecycle.hooks.onPageLoad.call({});
  h.api.page = h.second; const detail = handler.command('select', { index: 0 });
  await lifecycle.hooks.onPageHide.call({}); await lifecycle.hooks.onPageUnload.call({});
  pending.resolve(reply({ id: 1, version: detailVersion, canReview: true, user: { nickname: 'fixture-late-private-name' } })); await detail;
  scrubbed(h.state.ops); assert.equal(h.target[KEY], undefined); assert.equal(h.requests.length, 2);
});

test('PDF windows and object URLs opened by a separate handler are disposed by lifecycle cleanup', async () => {
  const h = harness(certificationFixture(), page('certifications')), lifecycle = await h.lifecycle(), handler = h.module(source, h.second);
  await lifecycle.hooks.onPageLoad.call({}); h.api.page = h.second; await handler.command('select', { index: 0 });
  await handler.command('material', { index: 0 }); await handler.command('openPdf');
  assert.equal(h.created.length, 1); assert.equal(h.opened.length, 1); assert.equal(h.opened[0].opener, null);
  const capsule = h.target[KEY]; assert.equal(capsule.ctx.pdfUrl, 'blob:fixture-1');
  await lifecycle.hooks.onPageHide.call({}); await lifecycle.hooks.onPageUnload.call({});
  assert.deepEqual(h.revoked, ['blob:fixture-1']); assert.equal(h.opened[0].closed, true);
  assert.equal(capsule.ctx.pdfUrl, null); assert.deepEqual(plain(capsule.ctx.pdfWindows), []); scrubbed(h.state.ops);
});

test('late PDF and evidence responses after unload cannot create an object URL or restore a private proof', async () => {
  const material = deferred(), evidence = deferred(), h = harness(certificationFixture({ material: material.promise, evidence: evidence.promise }), page('certifications'));
  const lifecycle = await h.lifecycle(), handler = h.module(source, h.second); await lifecycle.hooks.onPageLoad.call({});
  h.api.page = h.second; await handler.command('select', { index: 0 }); const image = handler.command('material', { index: 0 }), proof = handler.command('evidence');
  await lifecycle.hooks.onPageUnload.call({});
  material.resolve(reply({ mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjQK' }));
  evidence.resolve(reply({ verificationCode: 'fixture-late-private-verification' })); await Promise.all([image, proof]);
  assert.equal(h.created.length, 0); scrubbed(h.state.ops); assert.equal(h.target[KEY], undefined);
});

test('hot reload disposes old private refs and an old lifecycle cleanup token cannot erase the new controller', async () => {
  const oldSource = source.replaceAll(VERSION, 'hl-admin-operations-runtime-v1'); assert.notEqual(oldSource, source);
  const h = harness(privateFixture), oldLifecycle = await h.lifecycle(h.page, oldSource), oldHandler = h.module(oldSource, h.second);
  await oldLifecycle.hooks.onPageLoad.call({}); h.api.page = h.second; await oldHandler.command('select', { index: 0 });
  const oldCapsule = h.target[KEY], oldModel = h.state.ops; assert.match(oldModel.detailText, /fixture-private-phone/);
  const fresh = h.module(); await fresh.command('init'); const newCapsule = h.target[KEY]; assert.notEqual(newCapsule, oldCapsule);
  scrubbed(oldCapsule.ctx.model); scrubbed(oldModel); assert.equal(oldCapsule.ctx.active, false);
  await fresh.command('select', { index: 0 }); const before = plain(h.state), updateCount = h.updates.length;
  await oldLifecycle.hooks.onPageHide.call({}); await oldLifecycle.hooks.onPageUnload.call({}); oldCapsule.dispose();
  assert.equal(h.target[KEY], newCapsule); assert.equal(h.updates.length, updateCount); assert.deepEqual(plain(h.state), before);
  assert.equal(fresh.getOperationsController(h.second), newCapsule); assert.equal(newCapsule.ctx.active, true);
});

test('a captured old token cannot clear a new same-version controller after unload and reinitialization', async () => {
  const h = harness(privateFixture), lifecycle = await h.lifecycle(), handler = h.module();
  await lifecycle.hooks.onPageLoad.call({}); const oldCapsule = h.target[KEY]; await lifecycle.hooks.onPageUnload.call({});
  await handler.command('init'); const fresh = h.target[KEY]; await handler.command('select', { index: 0 }); const before = plain(h.state);
  assert.notEqual(fresh, oldCapsule);
  await handler.command('clear', {}, undefined, { cleanupPage: h.second, cleanupController: oldCapsule, disposeController: true });
  await lifecycle.hooks.onPageHide.call({}); await lifecycle.hooks.onPageUnload.call({});
  assert.equal(h.target[KEY], fresh); assert.deepEqual(plain(h.state), before);
});

test('a pending old-version response cannot replace the new controller data after a hot reload', async () => {
  const pending = deferred(), oldSource = source.replaceAll(VERSION, 'hl-admin-operations-runtime-v1');
  const h = harness(({ action, args }, count) => count === 2 ? pending.promise : privateFixture({ action, args }));
  const old = h.module(oldSource), current = h.module(source, h.second);
  await old.command('init'); const reading = old.command('select', { index: 0 }); const oldCapsule = h.target[KEY];
  h.api.page = h.second; await current.command('init'); await current.command('select', { index: 0 });
  const newCapsule = h.target[KEY], before = plain(h.state); assert.notEqual(oldCapsule, newCapsule);
  pending.resolve(reply({ id: 1, version: detailVersion, user: { nickname: 'fixture-late-private-old-version' } })); await reading;
  assert.deepEqual(plain(h.state), before); assert.equal(current.getOperationsController(h.page), newCapsule);
  assert.equal(oldCapsule.ctx.active, false); scrubbed(oldCapsule.ctx.model); assert.equal(h.requests.length, 4);
});

test('cleanup erases published and cloned private models even when setState, PDF close and revoke all throw', async () => {
  const h = harness(certificationFixture(), page('certifications')), lifecycle = await h.lifecycle(), handler = h.module(source, h.second);
  await lifecycle.hooks.onPageLoad.call({}); h.api.page = h.second; await handler.command('select', { index: 0 });
  await handler.command('material', { index: 0 }); await handler.command('openPdf'); await handler.command('evidence');
  await handler.command('edit', { field: 'remark' }, 'fixture-private-note'); await handler.command('edit', { field: 'feedback' }, 'fixture-private-feedback');
  const capsule = h.target[KEY], heldModel = h.state.ops, publishedClone = plain(h.state.ops);
  h.state.ops = publishedClone; h.control.rejectSetState = true; h.pdfControl.throwOnClose = true; h.pdfControl.throwOnRevoke = true;
  await assert.doesNotReject(lifecycle.hooks.onPageHide.call({}));
  scrubbed(heldModel); scrubbed(publishedClone); scrubbed(capsule.ctx.model);
  assert.equal(capsule.ctx.pdfUrl, null); assert.deepEqual(plain(capsule.ctx.pdfWindows), []);
  assert.equal(h.opened[0].closed, true); assert.deepEqual(h.revoked, ['blob:fixture-1']);
  await assert.doesNotReject(lifecycle.hooks.onPageUnload.call({})); assert.equal(h.target[KEY], undefined);
});
