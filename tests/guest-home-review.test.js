const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function guest(overrides = {}) {
  const instance = runtime('pages/index/index.js', { source: true, ...overrides });
  instance.session.token = '';
  instance.session.user = null;
  const logins = [];
  instance.services.auth.loginByWechat = async role => {
    logins.push(role);
    if (overrides.login) return overrides.login(instance.session);
    instance.session.token = 'explicit-test-session';
    instance.session.user = { id: 7 };
  };
  return { ...instance, logins };
}

const fixture = (route) => route === '/public/service-plans'
  ? { plans: [{ planCode: 'vip_week', name: 'VIP周卡', priceFen: 6160, durationDays: 7, serviceTimes: 0, productType: 'vip' }] }
  : { list: [{ id: 12, title: '公开活动', eventDate: '2026-11-20T10:00:00+08:00', location: '活动地点', price: 0 }] };

test('cold guest home browses public activities and plans without login or personal requests', async () => {
  const app = guest({ request: fixture });
  app.page.onLoad({});
  await app.page.onShow();
  await app.page.onShow();
  assert.deepEqual(app.logins, []);
  assert.deepEqual(app.calls.navigation, []);
  assert.deepEqual(app.calls.requests.map(row => row.path).sort(), ['/public/salon/events', '/public/service-plans']);
  for (const row of app.calls.requests) {
    assert.equal(row.options.auth, false);
    assert.equal(row.options.showError, false);
    assert.equal(row.options.preserveSessionOnUnauthorized, true);
  }
  assert.equal(app.page.data.publicSalons[0].title, '公开活动');
  assert.equal(app.page.data.publicPlans[0].priceText, '¥61.60');
  assert.equal(app.page.data.loggedIn, false);
  assert.equal(app.page.data.publicLoading, false);
  app.page.openPublicSalon({ currentTarget: { dataset: { id: 12 } } });
  app.page.browseActivities();
  assert.equal(app.calls.navigation[0].url, '/pages/user/salon-detail?id=12');
  assert.equal(app.calls.navigation[1].url, '/pages/user/salon');
  assert.deepEqual(app.logins, []);
});

test('repeated visible guest lifecycle coalesces reads and partial failure leaves browsing available', async () => {
  const pending = deferred();
  const app = guest({ request: route => route === '/public/salon/events' ? pending.promise : Promise.reject(new Error('offline')) });
  app.page.onLoad({});
  const first = app.page.onShow();
  const second = app.page.onShow();
  assert.equal(app.calls.requests.length, 2);
  pending.resolve(fixture('/public/salon/events'));
  await Promise.all([first, second]);
  assert.equal(app.page.data.publicSalons.length, 1);
  assert.match(app.page.data.publicError, /重试/);
  assert.equal(app.calls.navigation.length, 0);
  assert.equal(app.logins.length, 0);
});

test('malformed public response and failed explicit login never force authorization or hide guest navigation', async () => {
  const app = guest({ request: () => ({}), login: async () => { throw new Error('取消登录'); } });
  app.page.onLoad({});
  await app.page.onShow();
  assert.match(app.page.data.publicError, /重试/);
  await app.page.login();
  assert.equal(app.logins.length, 1);
  assert.match(app.page.data.errorText, /取消登录/);
  assert.equal(app.page.data.loading, false);
  assert.equal(app.calls.navigation.length, 0);
  app.page.browseActivities();
  assert.equal(app.calls.navigation[0].url, '/pages/user/salon');
});

test('login intention is passive and explicit login returns to the selected personal context', async () => {
  for (const destination of ['members', 'salon', 'messages', 'profile', 'orders']) {
    const app = guest({ request: fixture });
    app.page.onLoad({ login: '1', returnTo: destination });
    await app.page.onShow();
    assert.equal(app.logins.length, 0);
    assert.equal(app.calls.requests.length, 0);
    assert.equal(app.calls.navigation.length, 0);
    await app.page.login();
    assert.deepEqual(app.logins, ['user']);
    assert.equal(app.calls.navigation.length, 1);
    assert.equal(app.calls.navigation[0].url, `/pages/user/${destination}`);
    assert.equal(app.calls.navigation[0].method, destination === 'orders' ? 'redirectTo' : 'switchTab');
  }
});

test('late public reads cannot overwrite a different session or an unloaded home', async () => {
  for (const transition of ['login', 'hide', 'unload', 'environment']) {
    const pending = deferred();
    const app = guest({ request: () => pending.promise });
    app.page.onLoad({});
    const read = app.page.onShow();
    if (transition === 'login') { app.session.token = 'new-session'; app.session.user = { id: 2 }; }
    if (transition === 'environment') app.session.env = 'new-environment';
    if (transition === 'hide') app.page.onHide();
    if (transition === 'unload') app.page.onUnload();
    const count = app.calls.updates.length;
    pending.resolve({ list: [], plans: [] });
    await read;
    assert.equal(app.calls.updates.length, count, transition);
    assert.equal(app.calls.navigation.length, 0);
  }
});

test('public home has real browse actions before the voluntary login and no first-open profile authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.ok(source.indexOf('bindtap="browseActivities"') < source.indexOf('bindtap="login"'));
  assert.match(source, /wx:if="\{\{!registrationMode && !loginIntent\}\}"/);
  assert.match(source, /wx:for="\{\{publicSalons\}\}"/);
  assert.doesNotMatch(source, /open-type="(?:getPhoneNumber|getUserInfo|chooseAvatar)"/);
});

test('leaving during a forced refresh does not leave a warm empty home stuck loading', async () => {
  const pending = deferred();
  let refreshing = false;
  const app = guest({ request: route => refreshing ? pending.promise : route === '/public/service-plans' ? { plans: [] } : { list: [] } });
  app.page.onLoad({});
  await app.page.onShow();
  refreshing = true;
  const refresh = app.page.retryPublicContent();
  assert.equal(app.page.data.publicLoading, true);
  app.page.onHide();
  await app.page.onShow();
  assert.equal(app.page.data.publicLoading, false);
  pending.resolve({ list: [], plans: [] });
  await refresh;
  assert.equal(app.page.data.publicLoading, false);
});
