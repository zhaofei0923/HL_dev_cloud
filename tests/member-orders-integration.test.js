const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { runtime, deferred } = require('./helpers/miniprogram-runtime');

test('order-center services use authenticated read routes, pagination and the order-center login return', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/services/member.ts'), 'utf8');
  const calls = [];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, require: name => {
      assert.equal(name, './api');
      return { request: async (route, options) => { calls.push({ route, ...options }); return {}; } };
    } });
  await exports.memberApi.orders(3, 20);
  await exports.memberApi.orderDetail('HLM/invalid?query=1');
  const plain = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(plain, [
    { route: '/member/orders', data: { page: 3, pageSize: 20 }, showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders' },
    { route: '/member/orders/HLM%2Finvalid%3Fquery%3D1', showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders' }
  ]);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
});

test('registered order-center path has no parameters and the actual profile action opens it', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/user/orders'));
  assert.ok(app.pages.includes('pages/user/order-detail'));
  const r = runtime('pages/user/profile.js', { source: true });
  r.page.goOrders();
  assert.deepEqual(r.calls.navigation.map(row => [row.method, row.url]), [['navigateTo', '/pages/user/orders']]);
  assert.match(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/user/profile.wxml'), 'utf8'), /bindtap="goOrders"/);
});

test('a signed-in order-center visitor returns to orders instead of the recommendation tab', async () => {
  const r = runtime('pages/index/index.js', { source: true });
  r.page.onLoad({ returnTo: 'orders' });
  await r.page.onShow();
  assert.deepEqual(r.calls.navigation.map(row => [row.method, row.url]), [['redirectTo', '/pages/user/orders']]);
});

test('order-center login waits for the ordinary WeChat login then returns to orders', async () => {
  const r = runtime('pages/index/index.js', { source: true });
  r.session.token = ''; r.session.user = null;
  r.page.onLoad({ returnTo: 'orders' });
  await r.page.onShow();
  assert.equal(r.calls.navigation.length, 0);
  r.services.auth.loginByWechat = async () => { r.session.token = 'new-session'; r.session.user = { id: 1 }; };
  await r.page.login();
  assert.deepEqual(r.calls.navigation.map(row => [row.method, row.url]), [['redirectTo', '/pages/user/orders']]);
});

test('failed or late login cannot navigate an unloaded order-center login page', async () => {
  for (const failed of [true, false]) {
    const r = runtime('pages/index/index.js', { source: true });
    const pending = deferred();
    r.session.token = ''; r.session.user = null;
    r.page.onLoad({ returnTo: 'orders' });
    r.services.auth.loginByWechat = () => pending.promise;
    const login = r.page.login();
    if (failed) pending.reject(new Error('网络暂不可用'));
    else { r.page.onUnload(); pending.resolve({}); }
    await login;
    assert.equal(r.calls.navigation.length, 0);
    if (failed) assert.match(r.page.data.errorText, /网络暂不可用/);
  }
});

test('login return accepts only the order-center identifier and keeps activity registration precedence', async () => {
  for (const returnTo of ['', '/pages/admin/portal', 'https://example.invalid', 'orders?extra=1']) {
    const r = runtime('pages/index/index.js', { source: true });
    r.page.onLoad({ returnTo });
    await r.page.onShow();
    assert.deepEqual(r.calls.navigation.map(row => [row.method, row.url]), [['switchTab', '/pages/user/members']]);
  }
  const r = runtime('pages/index/index.js', { source: true });
  r.page.onLoad({ returnTo: 'orders', register: '1', eventId: '5' });
  let registrations = 0;
  r.page.loadRegistration = async () => { registrations++; };
  await r.page.onShow();
  assert.equal(registrations, 1);
  assert.equal(r.page.data.returnToOrders, false);
  assert.equal(r.calls.navigation.length, 0);
});
