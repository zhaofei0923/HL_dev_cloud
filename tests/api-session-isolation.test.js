const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiPath = path.join(__dirname, '..', 'miniprogram', 'services', 'api.js');

function runtime() {
  const session = { token: 'original-fixture-token', env: 'fixture-environment-a', user: { id: 1 } };
  const storage = new Map([['token', session.token], ['user', session.user]]);
  const calls = { functions: [], removed: [], redirects: [] };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8'), {
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, '../config/cloud');
      return { CLOUD_ENV_ID: 'fixture-default-environment', CLOUD_FUNCTION_NAME: 'fixture-api' };
    },
    getApp: () => ({ globalData: session }),
    wx: {
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => { calls.removed.push(key); storage.delete(key); },
      redirectTo: options => calls.redirects.push(options.url),
      showToast() {},
      cloud: { callFunction: options => calls.functions.push(options) }
    }
  }, { filename: apiPath });
  return { api: module.exports, session, storage, calls };
}

function unauthorized(request) {
  request.success({ result: { code: 40100, message: 'invalid token', data: null } });
}

test('an unauthorized response for the current session clears it and returns to login', async () => {
  const { api, session, calls, storage } = runtime();
  const pending = api.request('/matchmaker/dashboard');
  const rejected = assert.rejects(pending, error => error.code === 40100);
  unauthorized(calls.functions[0]);
  await rejected;
  assert.equal(session.token, '');
  assert.equal(session.user, null);
  assert.equal(storage.has('token'), false);
  assert.equal(storage.has('user'), false);
  assert.deepEqual(calls.redirects, ['/pages/index/index']);
});

test('a late unauthorized response cannot clear a newer token or cloud environment session', async () => {
  for (const change of ['token', 'environment', 'both']) {
    const { api, session, calls, storage } = runtime();
    const pending = api.request('/matchmaker/dashboard');
    const rejected = assert.rejects(pending, error => error.code === 40100);
    if (change !== 'environment') session.token = 'new-fixture-token';
    if (change !== 'token') session.env = 'fixture-environment-b';
    session.user = { id: 2 };
    storage.set('token', session.token);
    storage.set('user', session.user);
    const currentToken = session.token;
    unauthorized(calls.functions[0]);
    await rejected;
    assert.equal(session.token, currentToken, `${change} must preserve the current token`);
    assert.equal(session.user.id, 2);
    assert.equal(storage.get('user').id, 2);
    assert.deepEqual(calls.removed, []);
    assert.deepEqual(calls.redirects, []);
  }
});

test('explicit preserveSessionOnUnauthorized remains effective for the current session', async () => {
  const { api, session, calls } = runtime();
  const pending = api.request('/auth/member-claim/preview', { preserveSessionOnUnauthorized: true });
  const rejected = assert.rejects(pending, error => error.code === 40100);
  unauthorized(calls.functions[0]);
  await rejected;
  assert.equal(session.token, 'original-fixture-token');
  assert.equal(session.user.id, 1);
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.redirects, []);
});
