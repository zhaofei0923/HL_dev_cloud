const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const userTabs = [
  ['members', '/pages/user/members'],
  ['salon', '/pages/user/salon'],
  ['messages', '/pages/user/messages'],
  ['mine', '/pages/user/profile']
];

function tap(component, key, destination) {
  component.switchTab({ currentTarget: { dataset: { key, path: destination } } });
}

test('all four user destinations are native custom tabs and use switchTab', () => {
  const config = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, 'app.json'), 'utf8'));
  assert.equal(config.tabBar.custom, true);
  assert.deepEqual(config.tabBar.list.map(tab => `/${tab.pagePath}`).sort(), userTabs.map(([, route]) => route).sort());
  for (const [key, destination] of userTabs) {
    assert.ok(config.pages.includes(destination.slice(1)));
    const { component, calls } = runtime('components/bottom-nav/bottom-nav.js', { role: 'user', manualNavigation: true });
    tap(component, key, destination);
    assert.equal(calls.navigation.length, 1);
    assert.equal(calls.navigation[0].method, 'switchTab');
    assert.equal(calls.navigation[0].url, destination);
  }
});

test('active tab taps and rapid repeated switches do not issue duplicate navigation', () => {
  const { component, calls } = runtime('components/bottom-nav/bottom-nav.js', {
    role: 'user', active: 'members', manualNavigation: true
  });
  tap(component, 'members', '/pages/user/members');
  assert.equal(calls.navigation.length, 0);
  tap(component, 'salon', '/pages/user/salon');
  tap(component, 'salon', '/pages/user/salon');
  tap(component, 'messages', '/pages/user/messages');
  assert.equal(calls.navigation.length, 1);
  assert.equal(component.data.navigating, true);
  calls.navigation[0].options.complete({});
  component.setData({ active: 'salon' });
  tap(component, 'salon', '/pages/user/salon');
  assert.equal(calls.navigation.length, 1);
  tap(component, 'messages', '/pages/user/messages');
  assert.equal(calls.navigation.length, 2);
});

test('navigation failure clears the guard and permits retry while invalid routes are ignored', () => {
  const { component, calls } = runtime('components/bottom-nav/bottom-nav.js', {
    role: 'user', active: 'members', manualNavigation: true
  });
  for (const [key, destination] of [
    ['', ''], ['unknown', '/pages/user/salon'], ['salon', '/pages/user/profile'],
    ['salon', '/pages/user/member-detail?id=1']
  ]) tap(component, key, destination);
  assert.equal(calls.navigation.length, 0);
  tap(component, 'salon', '/pages/user/salon');
  calls.navigation[0].options.fail({ errMsg: 'navigation failed' });
  calls.navigation[0].options.complete({});
  assert.equal(component.data.navigating, false);
  assert.ok(calls.toasts.length > 0);
  tap(component, 'salon', '/pages/user/salon');
  assert.equal(calls.navigation.length, 2);
});

test('matchmaker navigation keeps its ordinary page routes and redirect behavior', () => {
  for (const [key, destination] of [
    ['dashboard', '/pages/matchmaker/dashboard'], ['members', '/pages/matchmaker/members'],
    ['messages', '/pages/matchmaker/messages'], ['salon', '/pages/matchmaker/salon'],
    ['mine', '/pages/matchmaker/mine']
  ]) {
    const { component, calls } = runtime('components/bottom-nav/bottom-nav.js', { role: 'matchmaker', manualNavigation: true });
    tap(component, key, destination);
    assert.equal(calls.navigation.length, 1);
    assert.equal(calls.navigation[0].method, 'redirectTo');
    assert.equal(calls.navigation[0].url, destination);
  }
});

test('login and detail entry actions use switchTab for retained user pages', async () => {
  for (const [file, method, destination] of [
    ['pages/index/index.js', 'onShow', '/pages/user/members'],
    ['pages/index/index.js', 'login', '/pages/user/members'],
    ['pages/user/member-claim.js', 'goProfile', '/pages/user/profile'],
    ['pages/user/member-claim.js', 'goMembers', '/pages/user/members'],
    ['pages/user/member-detail.js', 'goProfile', '/pages/user/profile'],
    ['pages/user/members.js', 'goProfile', '/pages/user/profile'],
    ['pages/user/messages.js', 'goMembers', '/pages/user/members'],
    ['pages/user/matchmaker-invite.js', 'goProfile', '/pages/user/profile'],
    ['pages/matchmaker/dashboard.js', 'goUserProfile', '/pages/user/profile']
  ]) {
    const { page, calls } = runtime(file);
    await page[method]();
    assert.equal(calls.navigation.length, 1, `${file}.${method} must navigate once`);
    assert.equal(calls.navigation[0].method, 'switchTab', `${file}.${method} must use a tab API`);
    assert.equal(calls.navigation[0].url, destination);
  }
  const { page, calls } = runtime('pages/user/membership.js');
  await page.contactMatchmaker();
  assert.equal(calls.navigation[0].method, 'switchTab');
  assert.equal(calls.navigation[0].url, '/pages/user/profile');
});

test('every retained user page synchronizes the native bar selection on show', async () => {
  for (const [key, destination] of userTabs) {
    const { page, calls } = runtime(`${destination.slice(1)}.js`);
    await page.onShow();
    assert.ok(calls.tabUpdates.length > 0, `${destination} must synchronize the tab bar`);
    assert.equal(calls.tabUpdates.at(-1).active, key);
  }
});
