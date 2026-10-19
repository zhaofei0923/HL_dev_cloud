'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const native = require('../cloudfunctions/hlApi/native-admin-service');
const sourcePath = process.env.HL_NATIVE_ADMIN_TEST_API_PATH
  ? path.resolve(process.env.HL_NATIVE_ADMIN_TEST_API_PATH) : path.resolve(__dirname, '../cloudfunctions/hlApi/index.js');
const requireFromApi = createRequire(sourcePath);
const clone = value => JSON.parse(JSON.stringify(value));

function runtime(options = {}) {
  const user = { id: 1, status: 1, authVersion: 3, currentRole: 'user', ...options.user };
  const env = { NODE_ENV: 'test', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false', DEMO_MEMBERS: 'false',
    MINIPROGRAM_ADMIN_USER_IDS: '1', ...options.env };
  let currentUser = user, reads = 0, loads = 0;
  const business = [], logs = [];
  const service = native.createNativeAdminService({ services: {
    buildCockpit: async (_db, args) => { business.push(['overview', args]); return { fixtureOverview: true }; },
    createReadService: () => ({ listPlans: async args => { business.push(['plans.list', args]); return { list: [], total: 0 }; } }),
    createMutationService: () => ({ execute: async (action, args, actor) => {
      business.push([action, args, actor]);
      if (options.businessError) throw options.businessError;
      return { recorded: true, requestId: actor.requestId };
    } })
  } });
  const db = { command: {}, collection(name) {
    assert.equal(name, 'hl_users');
    let query;
    return { where(input) { query = input; return this; }, limit() { return this; }, async get() {
      reads += 1;
      if (options.beforeRead) currentUser = options.beforeRead(reads, currentUser);
      if (options.failRead === reads) throw Object.assign(new Error('PRIVATE_DATABASE_DIAGNOSTIC'), { code: 11000 });
      return { data: currentUser && Number(currentUser.id) === query.id ? [clone(currentUser)] : [] };
    } };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8') + '\nexports.__tokens = tokenService;', {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout, process: { env },
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'fixture', database: () => db };
      if (name === './auth-policy') {
        const policy = requireFromApi(name);
        return { ...policy, createTokenService: () => policy.createTokenService({ secret: 'native-admin-route-fixture-signing-secret' }) };
      }
      if (name === './native-admin.bundle') {
        loads += 1;
        return {
          // The production bundle and invocation share one Node realm. JSON cloning
          // models that boundary while this test loads the original API in a VM.
          authorizeNativeAdmin: (account, session, settings) => native.authorizeNativeAdmin(clone(account), clone(session), settings),
          executeNativeAdmin: (request, actor) => service.execute(request, actor)
        };
      }
      return requireFromApi(name);
    }
  }, { filename: sourcePath });
  const sign = (claims = { userId: 1, authVersion: 3 }, type = 'access') => module.exports.__tokens.sign(claims, { type });
  const call = async (data = {}, token = sign(), method = 'POST', route = '/user/admin/operations') => clone(await module.exports.main({ path: route, method, token, data }));
  return { call, sign, env, logs, business, get reads() { return reads; }, get loads() { return loads; } };
}

test('native action route composes ACCESS verification, fresh account authorization and standard API response', async () => {
  const r = runtime();
  const result = await r.call({ action: 'plans.list', args: {} });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, { list: [], total: 0 });
  assert.match(result.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(r.reads, 2);
  assert.deepEqual(r.business, [['plans.list', {}]]);
  assert.deepEqual(r.logs, []);
});

test('invalid, refresh, legacy admin and revoked ACCESS sessions never load the privileged native bundle', async () => {
  const r = runtime();
  for (const token of ['', 'forged', r.sign({ userId: 1, authVersion: 3 }, 'refresh'),
    r.sign({ role: 'admin' }, 'admin'), r.sign({ userId: 1, authVersion: 2 })]) {
    assert.equal((await r.call({ action: 'overview' }, token)).code, 40100);
  }
  assert.equal(r.loads, 0);
  assert.deepEqual(r.business, []);
});

test('a current normal user cannot grant themselves access through body or token roles', async () => {
  const r = runtime({ env: { MINIPROGRAM_ADMIN_USER_IDS: '2' }, user: { currentRole: 'admin' } });
  const result = await r.call({ action: 'overview', role: 'administrator', userId: 2, actor: { uid: 'internal-admin' } },
    r.sign({ userId: 1, authVersion: 3, role: 'admin' }));
  assert.equal(result.code, 40360);
  assert.deepEqual(r.business, []);
});

test('account or authorization revocation between requests and between identity reads denies the action', async () => {
  const r = runtime();
  const token = r.sign();
  assert.equal((await r.call({ action: 'operations.prepare' }, token)).code, 0);
  r.env.MINIPROGRAM_ADMIN_USER_IDS = '2';
  assert.equal((await r.call({ action: 'overview' }, token)).code, 40360);
  for (const replacement of [null, { id: 1, status: 0, authVersion: 3 },
    { id: 1, status: 1, authVersion: 4 }, { id: 1, status: 1, authVersion: 3, mergedIntoUserId: 2 }]) {
    const changed = runtime({ beforeRead: (count, account) => count === 2 ? replacement : account });
    assert.equal((await changed.call({ action: 'overview' })).code, 40360);
    assert.deepEqual(changed.business, []);
  }
});

test('prepared operation IDs survive a retry without authorizing legacy administrator APIs', async () => {
  const r = runtime();
  const prepared = await r.call({ action: 'operations.prepare', args: {} });
  assert.equal(prepared.code, 0);
  const payload = { action: 'plans.update', args: { planCode: 'vip_week', active: true, expectedVersion: 'fixture' }, requestId: prepared.data.requestId };
  const first = await r.call(payload), second = await r.call(payload);
  assert.equal(first.code, 0); assert.equal(second.code, 0);
  assert.equal(first.data.requestId, prepared.data.requestId);
  assert.equal(r.business[0][2].uid, 'miniprogram:user:1');
  assert.equal(r.business[1][2].requestId, prepared.data.requestId);
  assert.notEqual(r.business[0][2].serverRequestId, r.business[1][2].serverRequestId);
  assert.equal((await r.call({}, undefined, 'GET', '/admin/dashboard')).code, 40100);
});

test('unknown fields and actions stop before management reads; infrastructure errors never leak', async () => {
  const r = runtime();
  for (const data of [{ action: 'plans.list', uid: 'forged' }, { action: 'database.query' }, { action: 'plans.update' }]) {
    assert.notEqual((await r.call(data)).code, 0);
  }
  assert.deepEqual(r.business, []);
  const failed = runtime({ failRead: 1 });
  const result = await failed.call({ action: 'overview' });
  assert.equal(result.code, 50360);
  assert.doesNotMatch(JSON.stringify({ result, logs: failed.logs }), /PRIVATE_|11000/);
});
