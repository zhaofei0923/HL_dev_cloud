'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { authorizeNativeAdmin, createNativeAdminService, NATIVE_ADMIN_ACTIONS } = require('../cloudfunctions/hlApi/native-admin-service');

const NOW = Date.parse('2026-10-15T08:00:00.000Z');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const READS = { 'matchmakers.list': 'listMatchmakers', 'matchmakers.detail': 'detailMatchmaker',
  'certifications.list': 'listCertifications', 'certifications.detail': 'detailCertification',
  'salons.list': 'listSalons', 'salons.detail': 'detailSalon', 'plans.list': 'listPlans', 'plans.detail': 'detailPlan',
  'orders.list': 'listOrders', 'orders.detail': 'detailOrder' };
const WRITES = ['matchmakers.review', 'certifications.review', 'salons.review', 'salons.cancel', 'plans.update'];
function identity(patch = {}) {
  return authorizeNativeAdmin({ id: 1, status: 1, authVersion: 2, ...patch },
    { type: 'access', userId: 1, authVersion: 2 }, { MINIPROGRAM_ADMIN_USER_IDS: '1' });
}
function fixture() {
  const calls = [], db = Object.freeze({ fixture: 'node-sdk-database' }), materialOptions = [];
  const record = (kind, action, args, actor) => { calls.push({ kind, action, args, actor }); return { kind, action }; };
  const services = {
    buildCockpit(supplied, options) { assert.equal(supplied, db); return record('overview', 'overview', options); },
    createReadService(options) { assert.equal(options.db, db); assert.equal(options.now(), NOW);
      return Object.fromEntries(Object.values(READS).map(method => [method, args => record('read', method, args)])); },
    createMutationService(options) { assert.equal(options.db, db); assert.equal(options.now().getTime(), NOW);
      return { execute: (action, args, actor) => record('write', action, args, actor) }; },
    createMaterialService(options) { assert.equal(options.db, db); materialOptions.push(options);
      return { evidence: (args, actor) => record('material', 'evidence', args, actor),
        material: (args, actor) => record('material', 'material', args, actor) }; },
    createServiceIntakeService(options) { assert.equal(options.db, db); assert.equal(options.now(), NOW);
      return { list: args => record('service', 'services.list', args), detail: args => record('service', 'services.detail', args),
        execute: (action, args, actor) => record('service', action, args, actor) }; }
  };
  const service = createNativeAdminService({ db, downloadFile: async () => { throw new Error('not a live storage test'); },
    secrets: { encryptionKey: 'fixture-material-key', jwtDerivedKey: 'fixture-derived-key', jwtSecret: 'never-forward-signing-key', ADMIN_CODE: 'never-forward-code' },
    now: () => NOW, services });
  return { service, calls, materialOptions, services, db };
}
const code = expected => error => error.code === expected;

test('authorization uses the verified ACCESS business session and server whitelist without Weda identity or URL', () => {
  const actor = identity();
  assert.deepEqual(actor, { uid: 'miniprogram:user:1' }); assert.equal(Object.isFrozen(actor), true);
  assert.deepEqual(authorizeNativeAdmin({ id: '1', status: '1' }, { type: 'access', userId: 1 },
    { MINIPROGRAM_ADMIN_USER_IDS: ' 1,2 ', WEDA_ADMIN_URL: '' }), actor);
  const mixed = authorizeNativeAdmin({ id: 1, status: 1, currentRole: 'user', Roles: [] },
    { type: 'access', userId: 1, role: 'administrator', currentRole: 'matchmaker', uid: 'forged-internal' }, { MINIPROGRAM_ADMIN_USER_IDS: '1' });
  assert.deepEqual(mixed, actor);
});
test('revocation, stale versions, wrong account or token type and malformed whitelist fail closed before business access', async () => {
  const rt = fixture();
  const user = { id: 1, status: 1, authVersion: 2 }, session = { type: 'access', userId: 1, authVersion: 2 }, env = { MINIPROGRAM_ADMIN_USER_IDS: '1' };
  const cases = [
    [null, session, env], [user, null, env], [[], session, env],
    [{ ...user, id: 2 }, session, env], [{ ...user, status: 0 }, session, env], [{ ...user, mergedIntoUserId: 2 }, session, env],
    [{ ...user, authVersion: 3 }, session, env], [{ ...user, authVersion: 0 }, session, env],
    [user, { ...session, authVersion: 1 }, env], [user, { ...session, authVersion: 'bad' }, env],
    [user, { ...session, userId: '1' }, env], [user, { ...session, userId: 0 }, env],
    [user, { ...session, type: 'admin', role: 'admin' }, env], [user, { ...session, type: 'refresh' }, env],
    [user, { ...session, type: undefined }, env], [user, session, {}], [user, session, { MINIPROGRAM_ADMIN_USER_IDS: '2' }],
    ...['', '1,', '1,no', '0,1', '-1,1', '1.0', '9007199254740992', '1'.repeat(16385)].map(value => [user, session, { MINIPROGRAM_ADMIN_USER_IDS: value }])
  ];
  for (const args of cases) assert.throws(() => authorizeNativeAdmin(...args), code(40360));
  assert.equal(rt.calls.length, 0);
  const actor = authorizeNativeAdmin(user, session, env);
  await rt.service.execute({ action: 'plans.list' }, actor);
  env.MINIPROGRAM_ADMIN_USER_IDS = '2';
  assert.throws(() => authorizeNativeAdmin(user, session, env), code(40360));
  assert.equal(rt.calls.length, 1, 'route must refresh user/session/authorization for each invocation');
});
test('authorization never reads caller role getters and rejects identity-field accessors', () => {
  const user = { id: 1, status: 1 }, session = { type: 'access', userId: 1 };
  Object.defineProperty(session, 'role', { get() { throw new Error('role must not authorize'); } });
  assert.deepEqual(authorizeNativeAdmin(user, session, { MINIPROGRAM_ADMIN_USER_IDS: '1' }), { uid: 'miniprogram:user:1' });
  const accessorUser = Object.defineProperty({ status: 1 }, 'id', { get() { throw new Error('identity accessor must not run'); } });
  assert.throws(() => authorizeNativeAdmin(accessorUser, session, { MINIPROGRAM_ADMIN_USER_IDS: '1' }), code(40360));
});
test('only the same server-authorized actor object can reach any service', async () => {
  const rt = fixture(), actor = identity();
  for (const forged of [undefined, null, { uid: actor.uid }, structuredClone(actor), { uid: 'internal-admin' }, 'miniprogram:user:1']) {
    await assert.rejects(rt.service.execute({ action: 'plans.list' }, forged), code(40360));
  }
  assert.equal(rt.calls.length, 0);
  await rt.service.execute({ action: 'plans.list' }, actor); assert.equal(rt.calls.length, 1);
});
test('action whitelist contains only reviewed native administrative actions', async () => {
  assert.deepEqual(NATIVE_ADMIN_ACTIONS, ['overview', ...Object.keys(READS), 'services.list', 'services.detail', ...WRITES,
    'services.assign', 'services.extend', 'certifications.evidence', 'certifications.material', 'operations.prepare']);
  const rt = fixture(), actor = identity();
  for (const action of ['constructor', '__proto__', 'toString', 'orders.refund', 'orders.fulfill', 'plans.delete', 'functions.invoke', '/admin/login', '']) {
    await assert.rejects(rt.service.execute({ action }, actor), code(40360));
  }
  assert.equal(rt.calls.length, 0);
});
test('native service queue and mutations use only their fixed authorized factory and secure retry UUID', async () => {
  const rt = fixture(), actor = identity();
  for (const action of ['services.list', 'services.detail']) {
    const args = { userId: 2 }; await rt.service.execute({ action, args }, actor);
    assert.deepEqual(rt.calls.at(-1), { kind: 'service', action, args, actor: undefined });
  }
  for (const action of ['services.assign', 'services.extend']) {
    await assert.rejects(rt.service.execute({ action, args: {} }, actor), code(42260));
    const requestId = randomUUID(); await rt.service.execute({ action, args: { userId: 2 }, requestId }, actor);
    const call = rt.calls.at(-1); assert.equal(call.kind, 'service'); assert.equal(call.action, action);
    assert.equal(call.actor.uid, actor.uid); assert.equal(call.actor.requestId, requestId); assert.match(call.actor.serverRequestId, UUID);
  }
});
test('request envelope rejects unknown fields, arrays, prototypes, symbols and getters before service creation', async () => {
  const rt = fixture(), actor = identity();
  const requests = [null, [], Object.create({ action: 'plans.list' }),
    ...['uid', 'actor', 'role', 'token', 'context', 'path', 'serverRequestId', 'services', 'db', 'env'].map(key => ({ action: 'plans.list', [key]: 'forged' })),
    Object.assign({ action: 'plans.list' }, { [Symbol('secret')]: true }),
    Object.defineProperty({}, 'action', { get() { throw new Error('must not run'); } }),
    { action: 'plans.list', args: [] }, { action: 'plans.list', args: Object.create({ page: 1 }) },
    { action: 'plans.list', args: Object.defineProperty({}, 'page', { get() { throw new Error('must not run'); } }) }];
  for (const request of requests) await assert.rejects(rt.service.execute(request, actor), code(42260));
  assert.equal(rt.calls.length, 0);
});
test('prepare generates an independent secure UUID with no business service, database or clock access', async () => {
  const rt = fixture(), actor = identity();
  const first = await rt.service.execute({ action: 'operations.prepare', args: {} }, actor);
  const second = await rt.service.execute({ action: 'operations.prepare' }, actor);
  for (const result of [first, second]) { assert.match(result.data.requestId, UUID); assert.match(result.requestId, UUID); assert.notEqual(result.data.requestId, result.requestId); }
  assert.notEqual(first.data.requestId, second.data.requestId); assert.equal(rt.calls.length, 0);
  await assert.rejects(rt.service.execute({ action: 'operations.prepare', args: { count: 1 } }, actor), code(42260));
});
test('overview passes only the validated period and server time to the shared cockpit service', async () => {
  const rt = fixture(), actor = identity();
  for (const days of [undefined, 7, 30, 90]) {
    const response = await rt.service.execute({ action: 'overview', ...(days === undefined ? {} : { args: { periodDays: days } }) }, actor);
    assert.equal(response.data.kind, 'overview');
    assert.deepEqual(rt.calls.at(-1).args, { periodDays: days || 30, now: NOW });
  }
  for (const periodDays of [0, '7', 14, null, true]) await assert.rejects(rt.service.execute({ action: 'overview', args: { periodDays } }, actor), code(42250));
  await assert.rejects(rt.service.execute({ action: 'overview', args: { periodDays: 7, uid: 'forged' } }, actor), code(42260));
  assert.equal(rt.calls.length, 4);
});
test('all ten reads dispatch to fixed methods with no writable actor or request id', async () => {
  const rt = fixture(), actor = identity();
  for (const [action, method] of Object.entries(READS)) {
    const args = { fixture: action };
    const response = await rt.service.execute({ action, args }, actor);
    assert.deepEqual(rt.calls.at(-1), { kind: 'read', action: method, args, actor: undefined });
    assert.equal(response.data.action, method); assert.match(response.requestId, UUID);
  }
});
test('five writes preserve the prepared id across retries and independently generate each server trace', async () => {
  const rt = fixture(), actor = identity(), prepared = await rt.service.execute({ action: 'operations.prepare' }, actor);
  for (const action of WRITES) {
    const request = { action, args: { expectedVersion: 'shared-service-validates-version' }, requestId: prepared.data.requestId };
    const first = await rt.service.execute(request, actor), second = await rt.service.execute(request, actor);
    const [left, right] = rt.calls.slice(-2);
    assert.equal(left.action, action); assert.equal(left.kind, 'write'); assert.equal(left.args, request.args);
    assert.equal(left.actor.uid, 'miniprogram:user:1'); assert.equal(left.actor.requestId, request.requestId);
    assert.equal(right.actor.requestId, request.requestId); assert.notEqual(left.actor.serverRequestId, right.actor.serverRequestId);
    assert.equal(left.actor.serverRequestId, first.requestId); assert.equal(right.actor.serverRequestId, second.requestId);
    assert.deepEqual(Object.keys(left.actor).sort(), ['requestId', 'serverRequestId', 'uid']);
  }
});
test('writes require a validated UUID and no invalid id reaches the mutation service', async () => {
  const rt = fixture(), actor = identity();
  for (const requestId of [undefined, null, '', 123, {}, 'client-not-a-uuid', 'x'.repeat(81), '11111111-1111-1111-1111-111111111111']) {
    await assert.rejects(rt.service.execute({ action: 'plans.update', args: {}, ...(requestId === undefined ? {} : { requestId }) }, actor), code(42260));
  }
  assert.equal(rt.calls.length, 0);
});
test('sensitive reads receive only the two material keys and a server-generated namespaced actor', async () => {
  const rt = fixture(), actor = identity();
  for (const action of ['certifications.evidence', 'certifications.material']) {
    const response = await rt.service.execute({ action, args: { fixture: action } }, actor);
    const options = rt.materialOptions.at(-1), call = rt.calls.at(-1);
    assert.deepEqual(options.secrets, { encryptionKey: 'fixture-material-key', jwtDerivedKey: 'fixture-derived-key' });
    assert.equal(options.now(), new Date(NOW).toISOString());
    assert.deepEqual(call.actor, { uid: 'miniprogram:user:1', serverRequestId: response.requestId });
    assert.equal(JSON.stringify(response).includes('key'), false);
  }
});
test('service failures expose only fixed safe messages and a new tracing UUID', async () => {
  const services = { createReadService() { return { listPlans() { throw Object.assign(new Error('private-key-and-business-contents'), { code: 50360 }); } }; } };
  const service = createNativeAdminService({ services });
  await assert.rejects(service.execute({ action: 'plans.list' }, identity()), error => {
    assert.equal(error.code, 50360); assert.equal(error.status, 503); assert.match(error.requestId, UUID);
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes('private-key-and-business-contents'), false); return true;
  });
});
test('real shared read service is used by default and retains business argument validation', async () => {
  let reads = 0;
  const db = { collection() { reads++; return { orderBy() { return this; }, field() { return this; }, skip() { return this; }, limit() { return this; }, async get() { return { data: [] }; } }; } };
  const service = createNativeAdminService({ db, now: () => NOW }), actor = identity();
  const result = await service.execute({ action: 'plans.list' }, actor);
  assert.equal(result.data.list.length, 6); assert.equal(reads, 1);
  await assert.rejects(service.execute({ action: 'plans.list', args: { uid: 'forged' } }, actor), code(42260));
  assert.equal(reads, 1, 'shared business whitelist fails before private reads');
});
