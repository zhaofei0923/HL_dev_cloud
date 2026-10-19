'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiPath = process.env.HL_ADMIN_ENTRY_TEST_API_PATH ? path.resolve(process.env.HL_ADMIN_ENTRY_TEST_API_PATH)
  : path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const { miniprogramAdminEntry } = require(path.join(path.dirname(apiPath), 'admin-entry-policy'));
const requireFromApi = createRequire(apiPath);
const ADMIN_URL = 'https://admin.fixture.invalid/hl-admin/';
const DENIED = { allowed: false, ready: false };
const userFixture = () => ({ _id: 'user_17', id: 17, status: 1, authVersion: 3,
  currentRole: 'user', openid: 'PRIVATE_OPENID', phone: 'PRIVATE_PHONE' });
const sessionFixture = () => ({ userId: 17, authVersion: 3 });
const validEnv = () => ({ MINIPROGRAM_ADMIN_USER_IDS: '17', WEDA_ADMIN_URL: ADMIN_URL });

function runtime(options = {}) {
  const env = { NODE_ENV: 'test', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false', DEMO_MEMBERS: 'false',
    ...(options.env || {}) };
  let user = options.user === undefined ? userFixture() : structuredClone(options.user);
  let readCount = 0;
  const logs = [], reads = [];
  const db = { command: {}, collection(name) {
    assert.equal(name, 'hl_users', 'the entrance must not read other business collections');
    let query;
    return { where(value) { query = value; return this; }, limit(value) { assert.equal(value, 1); return this; },
      async get() {
        readCount += 1;
        reads.push({ name, query: structuredClone(query) });
        if (options.beforeRead) user = options.beforeRead(readCount, user);
        if (options.readErrorAt === readCount) throw options.readFailure || new Error('PRIVATE_DATABASE_DIAGNOSTIC');
        return { data: user && Number(user.id) === query.id ? [structuredClone(user)] : [] };
      } };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test={tokenService};', {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    process: { env }, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args) },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture',
        callFunction() { throw new Error('No network or privileged function invocation is permitted'); } };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({
          secret: 'admin-entrance-fixture-secret-32-characters' }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  const sign = (payload = sessionFixture(), type = 'access') => module.exports.__test.tokenService.sign(payload, { type });
  const call = async (token = sign(), data = {}, method = 'GET', route = '/user/admin-entry') => JSON.parse(JSON.stringify(await module.exports.main({
    path: route, method, data, token
  })));
  return { call, sign, env, reads, logs, setUser: value => { user = value; } };
}

test('only a server-authorized user receives the configured entrance without identity or credentials', async () => {
  const r = runtime({ env: validEnv() });
  const result = await r.call();
  assert.deepEqual(result, { code: 0, message: 'success', data: { allowed: true, ready: true, mode: 'native' } });
  assert.equal(r.reads.length, 2, 'the active user is reread after access-token validation');
  assert.ok(r.reads.every(read => read.query.id === 17));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|openid|phone|token|userId|authVersion/);
  assert.deepEqual(r.logs, []);
});

test('default configuration and unauthorized user deny entry without revealing the configured destination', async () => {
  for (const env of [{}, { WEDA_ADMIN_URL: ADMIN_URL }, { ...validEnv(), MINIPROGRAM_ADMIN_USER_IDS: '18,19' }]) {
    const r = runtime({ env });
    assert.deepEqual((await r.call()).data, DENIED);
  }
});

test('caller-controlled roles, identities and destinations cannot authorize a normal user', async () => {
  const r = runtime({ env: { ...validEnv(), MINIPROGRAM_ADMIN_USER_IDS: '18' },
    user: { ...userFixture(), currentRole: 'admin', role: 'admin' } });
  const token = r.sign({ ...sessionFixture(), role: 'admin', currentRole: 'admin' });
  assert.deepEqual((await r.call(token, { role: 'admin', currentRole: 'admin', userId: 18, allowed: true,
    MINIPROGRAM_ADMIN_USER_IDS: '17', url: ADMIN_URL, WEDA_ADMIN_URL: ADMIN_URL })).data, DENIED);
});

test('request business data is ignored even when its properties cannot be read safely', async () => {
  const r = runtime({ env: validEnv() });
  const data = Object.defineProperty({}, 'role', { enumerable: true, get() { throw new Error('untrusted getter'); } });
  assert.deepEqual((await r.call(undefined, data)).data, { allowed: true, ready: true, mode: 'native' });
});

test('a missing or malformed list closes all entrance access instead of retaining a valid partial list', async () => {
  for (const value of [undefined, null, '', ' ', [], 17, '17,', ',17', '17,,18', '17,nope', '17,0',
    '17,-1', '17,1.5', '17,1e2', '17,+18', '17,018', '17,9007199254740992', '17\n18', '1'.repeat(16385)]) {
    const r = runtime({ env: { ...validEnv(), MINIPROGRAM_ADMIN_USER_IDS: value } });
    assert.deepEqual((await r.call()).data, DENIED, `Invalid list: ${String(value).slice(0, 60)}`);
  }
});

test('comma-separated positive safe integers allow surrounding spaces and harmless duplicates', async () => {
  const r = runtime({ env: { ...validEnv(), MINIPROGRAM_ADMIN_USER_IDS: ' 18, 17 ,17,9007199254740991 ' } });
  assert.equal((await r.call()).data.allowed, true);
  assert.deepEqual(miniprogramAdminEntry({ ...userFixture(), id: Number.MAX_SAFE_INTEGER },
    { ...sessionFixture(), userId: Number.MAX_SAFE_INTEGER }, {
      MINIPROGRAM_ADMIN_USER_IDS: String(Number.MAX_SAFE_INTEGER), WEDA_ADMIN_URL: ADMIN_URL
    }), { allowed: true, ready: true, mode: 'native' });
});

test('native administrators require no domain and never echo legacy destination configuration', async () => {
  for (const url of [undefined, null, '', 5, 'http://admin.fixture.invalid/', 'javascript:alert(1)', '//admin.fixture.invalid/',
    'https:///admin.fixture.invalid/', 'https://', ' https://admin.fixture.invalid/', 'https://admin.fixture.invalid/ ',
    'https://admin.fixture.invalid/\n', 'https://admin.fixture.invalid/has space', 'https://admin.fixture.invalid/\\redirect',
    'https://user@admin.fixture.invalid/', 'https://user:password@admin.fixture.invalid/', 'https://@admin.fixture.invalid/',
    'https://admin.fixture.invalid/?token=PRIVATE_TOKEN', 'https://admin.fixture.invalid/?',
    'https://admin.fixture.invalid/#route', 'https://admin.fixture.invalid/#', 'https://admin.fixture.invalid/' + 'a'.repeat(2048)]) {
    const r = runtime({ env: { ...validEnv(), WEDA_ADMIN_URL: url } });
    const result = await r.call();
    assert.deepEqual(result.data, { allowed: true, ready: true, mode: 'native' }, `Ignored legacy destination: ${String(url).slice(0, 100)}`);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|password/);
  }
});

test('native entry never takes a destination from server legacy settings or a request', async () => {
  const r = runtime({ env: { ...validEnv(), WEDA_ADMIN_URL: 'HTTPS://ADMIN.FIXTURE.INVALID:443' } });
  assert.deepEqual((await r.call(undefined, { url: 'https://attacker.fixture.invalid/' })).data,
    { allowed: true, ready: true, mode: 'native' });
});

test('access-token, account activation, merge and authVersion boundaries are enforced', async () => {
  const r = runtime({ env: validEnv() });
  for (const token of ['', 'forged', r.sign(sessionFixture(), 'refresh'), r.sign({ role: 'admin' }, 'admin'),
    r.sign({ userId: 17, authVersion: 2 }), r.sign({ userId: 0, authVersion: 3 }), r.sign({ userId: Number.MAX_SAFE_INTEGER + 1 })]) {
    assert.equal((await r.call(token)).code, 40100);
  }
  for (const user of [null, { ...userFixture(), status: 0 }, { ...userFixture(), mergedIntoUserId: 18 }]) {
    const inactive = runtime({ env: validEnv(), user });
    assert.equal((await inactive.call()).code, 40100);
  }
});

test('server administrator revocation takes effect independently of legacy destination settings', async () => {
  const r = runtime({ env: validEnv() });
  const token = r.sign();
  assert.equal((await r.call(token)).data.ready, true);
  r.env.MINIPROGRAM_ADMIN_USER_IDS = '18';
  assert.deepEqual((await r.call(token)).data, DENIED);
  r.env.MINIPROGRAM_ADMIN_USER_IDS = '17';
  delete r.env.WEDA_ADMIN_URL;
  assert.deepEqual((await r.call(token)).data, { allowed: true, ready: true, mode: 'native' });
  r.setUser({ ...userFixture(), authVersion: 4 });
  assert.equal((await r.call(token)).code, 40100);
});

test('a user deleted, disabled, merged or reauthenticated after token validation loses the entrance', async () => {
  for (const replacement of [null, { ...userFixture(), status: 0 }, { ...userFixture(), mergedIntoUserId: 18 },
    { ...userFixture(), authVersion: 4 }]) {
    const r = runtime({ env: validEnv(), beforeRead: (count, user) => count === 2 ? replacement : user });
    assert.deepEqual((await r.call()).data, DENIED);
  }
});

test('the read-only endpoint rejects mutation methods and never grants legacy administrator APIs', async () => {
  const r = runtime({ env: validEnv() });
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await r.call(undefined, {}, method)).code, 40400);
  const result = await r.call();
  assert.equal(result.data.allowed, true);
  assert.equal(Object.hasOwn(result.data, 'token'), false);
  assert.equal((await r.call(r.sign(), {}, 'GET', '/admin/dashboard')).code, 40100);
});

test('database errors are sanitized in responses and logs for both identity reads', async () => {
  for (const readErrorAt of [1, 2]) {
    const r = runtime({ env: validEnv(), readErrorAt });
    const result = await r.call();
    assert.equal(result.code, 50340);
    assert.equal(result.message, '管理入口暂不可用，请稍后重试');
    assert.doesNotMatch(JSON.stringify({ result, logs: r.logs }), /PRIVATE_DATABASE_DIAGNOSTIC|PRIVATE_OPENID|PRIVATE_PHONE/);
    assert.deepEqual(r.logs, [['admin entry request failed', 50340]]);
  }
});

test('numeric infrastructure error codes cannot bypass response and log sanitization', async () => {
  const r = runtime({ env: validEnv(), readErrorAt: 1,
    readFailure: Object.assign(new Error('PRIVATE_DATABASE_DIAGNOSTIC'), { status: 500, code: 11000 }) });
  const result = await r.call();
  assert.equal(result.code, 50340);
  assert.doesNotMatch(JSON.stringify({ result, logs: r.logs }), /PRIVATE_DATABASE_DIAGNOSTIC|11000/);
});
