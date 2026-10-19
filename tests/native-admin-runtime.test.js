'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Script } = require('node:vm');
const native = require('../cloudfunctions/hlApi/native-admin-service');

function fixture() {
  const calls = [], module = { exports: {} };
  const db = { collection() { calls.push('read'); return { orderBy() { return this; }, field() { return this; },
    skip() { return this; }, limit() { return this; }, async get() { return { data: [] }; } }; } };
  new Script(readFileSync(resolve(__dirname, '../cloudfunctions/hlApi/native-admin-runtime.js'), 'utf8')).runInNewContext({
    module, process: { env: {} }, require(name) {
      if (name === './native-admin-service') return native;
      assert.equal(name, '@cloudbase/node-sdk');
      return { init(options) { calls.push(['init', options.env]); return {
        database(options) { calls.push(['database', options.throwOnCode]); return db; },
        downloadFile() { throw new Error('unexpected storage access'); }
      }; } };
    }
  });
  const actor = module.exports.authorizeNativeAdmin({ id: 1, status: 1 }, { userId: 1, type: 'access' }, { MINIPROGRAM_ADMIN_USER_IDS: '1' });
  return { api: module.exports, actor, calls };
}

test('preparing retry identifiers performs no SDK initialization, database read or storage call', async () => {
  const r = fixture();
  const first = await r.api.executeNativeAdmin({ action: 'operations.prepare', args: {} }, r.actor);
  const next = await r.api.executeNativeAdmin({ action: 'operations.prepare' }, r.actor);
  assert.match(first.data.requestId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.data.requestId, next.data.requestId);
  assert.deepEqual(r.calls, []);
  await assert.rejects(r.api.executeNativeAdmin({ action: 'operations.prepare' }, { uid: r.actor.uid }), { code: 40360 });
  await assert.rejects(r.api.executeNativeAdmin({ action: 'operations.prepare', args: { role: 'admin' } }, r.actor), { code: 42260 });
  assert.deepEqual(r.calls, []);
});

test('business reads initialize a separate SDK lazily and reuse it without touching existing SDKs', async () => {
  const r = fixture();
  const result = await r.api.executeNativeAdmin({ action: 'plans.list' }, r.actor);
  assert.equal(result.data.list.length, 6);
  await r.api.executeNativeAdmin({ action: 'plans.list' }, r.actor);
  assert.deepEqual(r.calls, [['init', 'cloud1-d2gza7q9c8d69c721'], ['database', true], 'read', 'read']);
});
