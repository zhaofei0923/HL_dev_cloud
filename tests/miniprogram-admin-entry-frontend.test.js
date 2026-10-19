const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const ADMIN_URL = 'https://admin.example.com/operations/';
const allowed = () => ({ allowed: true, ready: true, mode: 'native' });
const denied = () => ({ allowed: false, ready: false });
const entryReads = r => r.calls.requests.filter(row => row.path === '/user/admin-entry');

function profileRuntime(readEntry = denied) {
  const r = runtime('pages/user/profile.js', {
    source: true,
    memberApi: {
      certifications: async () => ({ entries: ['identity', 'education', 'vehicle', 'property', 'assets']
        .map(kind => ({ kind, status: 'unsubmitted', verified: false })) })
    },
    request: async (requestPath, options) => {
      if (requestPath === '/user/admin-entry') return readEntry(options);
      assert.equal(requestPath, '/user/profile');
      return { profile: { realName: '已保存姓名', city: '上海', photos: [] } };
    }
  });
  // The service imports ./api, which does not match the helper's page-level
  // services/api stub. Replace only that transport; keep readAdminEntry real.
  r.load(path.join(miniprogramRoot, 'services/api.ts')).request = r.services.api.request;
  return r;
}

function portalRuntime(readEntry = denied, readOverview) {
  const shareCalls = [];
  const r = runtime('pages/admin/portal.js', {
    source: true,
    wx: { hideShareMenu: options => shareCalls.push(options) },
    request: async (requestPath, options) => {
      if (requestPath === '/user/admin/operations') {
        assert.equal(options.data.action, 'overview');
        if (readOverview) return readOverview(options);
        return { members: { total: 0, newCount: 0 }, matchmakers: { approved: 0, pending: 0 },
          revenue: { paidFen: 0, refundFen: 0, netFen: 0 } };
      }
      assert.equal(requestPath, '/user/admin-entry');
      return readEntry(options);
    }
  });
  r.load(path.join(miniprogramRoot, 'services/api.ts')).request = r.services.api.request;
  return { ...r, shareCalls };
}

test('ordinary members and locally forged administrator roles cannot reveal the management entry', async () => {
  for (const role of [undefined, 'admin', 'administrator']) {
    const r = profileRuntime(denied);
    r.session.user = { ...r.session.user, role, isAdmin: true, admin: true };
    assert.equal(r.page.data.adminEntryVisible, false);
    await r.page.onShow();
    await flush();
    assert.equal(r.page.data.adminEntryVisible, false);
    assert.equal(r.page.data.adminEntryReady, false);
    assert.equal(entryReads(r).length, 1);
    await r.page.goAdminBackend();
    assert.equal(r.calls.navigation.filter(row => row.url === '/pages/admin/portal').length, 0);
  }
});

test('the profile waits for the server before showing the entry and preserves an unsaved profile draft', async () => {
  const pending = deferred();
  const r = profileRuntime(() => pending.promise);
  await r.page.onShow();
  assert.equal(r.page.data.profileReady, true, 'entry authorization must not block profile use');
  assert.equal(r.page.data.adminEntryVisible, false);
  r.page.updateForm('realName', '尚未保存的新姓名');
  pending.resolve(allowed());
  await flush();
  assert.equal(r.page.data.adminEntryVisible, true);
  assert.equal(r.page.data.adminEntryReady, true);
  assert.equal(r.page.data.form.realName, '尚未保存的新姓名');
  assert.equal(r.page.data.formDirty, true);
  assert.equal(entryReads(r)[0].options.showError, false);
});

test('every profile appearance refreshes authorization and immediately hides a revoked entry', async () => {
  let result = allowed();
  const r = profileRuntime(() => result);
  await r.page.onShow();
  await flush();
  assert.equal(r.page.data.adminEntryVisible, true);
  r.page.onHide();
  assert.equal(r.page.data.adminEntryVisible, false);
  const pending = deferred();
  result = pending.promise;
  await r.page.onShow();
  assert.equal(entryReads(r).length, 2, 'the profile cache cannot cache administrator permission');
  assert.equal(r.page.data.adminEntryVisible, false, 'previous permission cannot remain visible while rechecking');
  pending.resolve(denied());
  await flush();
  assert.equal(r.page.data.adminEntryVisible, false);
});

test('clicking the entry rechecks permission and cannot open a revoked administrator session', async () => {
  let reads = 0;
  const r = profileRuntime(() => ++reads === 1 ? allowed() : denied());
  await r.page.onShow();
  await flush();
  assert.equal(r.page.data.adminEntryVisible, true);
  await r.page.goAdminBackend();
  assert.equal(entryReads(r).length, 2);
  assert.equal(r.page.data.adminEntryVisible, false);
  assert.equal(r.page.data.adminEntryOpening, false);
  assert.equal(r.calls.navigation.length, 0);
  assert.match(r.calls.toasts.at(-1), /管理权限/);
});

test('authorized entry navigation carries neither backend URL nor member credentials and ignores duplicate taps', async () => {
  const pending = deferred();
  let reads = 0;
  const r = profileRuntime(() => ++reads === 1 ? allowed() : pending.promise);
  r.session.token = 'private-member-token';
  await r.page.onShow();
  await flush();
  const opening = r.page.goAdminBackend();
  await r.page.goAdminBackend();
  assert.equal(entryReads(r).length, 2);
  assert.equal(r.page.data.adminEntryOpening, true);
  pending.resolve(allowed());
  await opening;
  assert.equal(r.calls.navigation.length, 1);
  assert.equal(r.calls.navigation[0].url, '/pages/admin/portal');
  assert.ok(!r.calls.navigation[0].url.includes(r.session.token));
  assert.ok(!r.calls.navigation[0].url.includes(ADMIN_URL));
  assert.equal(r.page.data.adminEntryOpening, false);
});

test('an authorized administrator can reach the unopened status page without a configured backend URL', async () => {
  const r = profileRuntime(() => ({ allowed: true, ready: false }));
  await r.page.onShow();
  await flush();
  assert.equal(r.page.data.adminEntryVisible, true);
  assert.equal(r.page.data.adminEntryReady, false);
  await r.page.goAdminBackend();
  assert.equal(r.calls.navigation.at(-1).url, '/pages/admin/portal');
});

test('profile authorization failures hide a previously allowed entry and recover on the next appearance', async () => {
  let fail = false;
  const r = profileRuntime(() => {
    if (fail) throw new Error('offline');
    return allowed();
  });
  await r.page.onShow();
  await flush();
  fail = true;
  await r.page.loadAdminEntry();
  assert.equal(r.page.data.adminEntryVisible, false);
  assert.equal(r.page.data.adminEntryReady, false);
  fail = false;
  await r.page.onShow();
  await flush();
  assert.equal(r.page.data.adminEntryVisible, true);
});

test('a late old-account profile permission cannot reveal the entry for a replacement account', async () => {
  const pending = deferred();
  let reads = 0;
  const r = profileRuntime(() => ++reads === 1 ? pending.promise : denied());
  await r.page.onShow();
  r.session.user = { id: 2 };
  r.session.token = 'replacement-session';
  await r.page.onShow();
  pending.resolve(allowed());
  await flush();
  assert.equal(r.page.data.user.id, 2);
  assert.equal(r.page.data.adminEntryVisible, false);
  assert.equal(r.page.data.adminEntryReady, false);
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`a late profile authorization response after ${lifecycle} cannot restore or open the entry`, async () => {
    const pending = deferred();
    const r = profileRuntime(() => pending.promise);
    await r.page.onShow();
    const opening = r.page.goAdminBackend();
    r.page[lifecycle]();
    pending.resolve(allowed());
    await opening;
    await flush();
    assert.equal(r.page.data.adminEntryVisible, false);
    assert.equal(r.page.data.adminEntryReady, false);
    assert.equal(r.page.data.adminEntryOpening, false);
    assert.equal(r.calls.navigation.length, 0);
  });
}

test('an account change during entry click cannot navigate the replacement session', async () => {
  const pending = deferred();
  let reads = 0;
  const r = profileRuntime(() => ++reads === 1 ? allowed() : pending.promise);
  await r.page.onShow();
  await flush();
  const opening = r.page.goAdminBackend();
  r.session.user = { id: 2 };
  r.session.token = 'replacement-session';
  pending.resolve(allowed());
  await opening;
  assert.equal(r.calls.navigation.length, 0);
});

test('direct native portal ignores injected URL and permissions and independently checks the server', async () => {
  const pending = deferred();
  const r = portalRuntime(() => pending.promise);
  r.page.onLoad({ url: 'https://untrusted.example/collect', token: 'injected-token', allowed: 'true' });
  assert.equal(r.page.data.ready, false);
  const loading = r.page.onShow();
  assert.equal(r.page.data.ready, false);
  assert.equal(entryReads(r).length, 1);
  pending.resolve(allowed());
  await loading;
  assert.equal(r.page.data.ready, true);
  assert.equal(r.page.data.metrics.length, 6);
  assert.equal(r.page.data.url, undefined);
  assert.ok(!JSON.stringify(r.page.data).includes('injected-token'));
  assert.ok(!JSON.stringify(r.page.data).includes('untrusted.example'));
});

test('the portal refuses to load a backend for an unauthenticated session without making a request', async () => {
  const r = portalRuntime(allowed);
  r.session.token = '';
  r.session.user = null;
  r.page.onLoad();
  await r.page.onShow();
  assert.equal(entryReads(r).length, 0);
  assert.equal(r.page.data.ready, false);
  assert.equal(r.page.data.checking, false);
  assert.equal(r.page.data.canRetry, false);
  assert.match(r.page.data.title, /登录/);
});

test('denied, unopened, malformed and failed native authorization never load management records', async () => {
  const cases = [
    { read: denied, title: /没有管理权限/, retry: false },
    { read: () => ({ allowed: true, ready: false, url: ADMIN_URL }), title: /尚未开放/, retry: true },
    { read: () => ({ allowed: true, ready: true }), title: /尚未开放/, retry: true },
    { read: () => ({ allowed: 'true', ready: true, url: ADMIN_URL }), title: /没有管理权限/, retry: false },
    { read: () => ({ allowed: true, ready: 'true', url: ADMIN_URL }), title: /尚未开放/, retry: true },
    { read: () => null, title: /没有管理权限/, retry: false },
    { read: () => [], title: /没有管理权限/, retry: false },
    { read: () => { throw new Error('offline'); }, title: /无法确认/, retry: true }
  ];
  for (const fixture of cases) {
    const r = portalRuntime(fixture.read);
    await r.page.onShow();
    assert.equal(r.page.data.ready, false);
    assert.equal(r.calls.requests.some(row => row.path === '/user/admin/operations'), false);
    assert.equal(r.page.data.checking, false);
    assert.equal(r.page.data.canRetry, fixture.retry);
    assert.match(r.page.data.title, fixture.title);
  }
});

test('legacy URL responses cannot enable the native management capability', async () => {
  for (const url of [
    'http://admin.example.com/',
    '//admin.example.com/',
    'javascript:alert(1)',
    'https://admin.example.com/?token=member-token',
    'https://admin.example.com/#access_token=member-token',
    'https://user:password@admin.example.com/',
    'https://admin.example.com:8080/',
    'https://admin.example.com/%0Aredirect',
    'https://admin.example.com/%5cother',
    'https://admin.example.com/\nother'
  ]) {
    const r = portalRuntime(() => ({ allowed: true, ready: true, url }));
    await r.page.onShow();
    assert.equal(r.page.data.ready, false, url);
    assert.match(r.page.data.title, /尚未开放/, url);
  }
});

test('native capability loads overview without backend URLs, user credentials or private caches', async () => {
  const r = portalRuntime(allowed);
  r.session.token = 'private-member-token';
  await r.page.onShow();
  assert.equal(r.page.data.ready, true);
  assert.equal(r.page.data.url, undefined);
  assert.equal(r.page.data.checking, false);
  assert.ok(!JSON.stringify(r.page.data).includes(r.session.token));
  assert.equal(r.calls.storage.length, 0, 'backend access cannot copy a member credential into storage');
  assert.equal(r.calls.requests.filter(row => row.path === '/user/admin/operations').length, 1);
});

test('portal sharing is disabled and management is rendered using native markup without web-view', () => {
  const r = portalRuntime(allowed);
  r.page.onLoad();
  assert.equal(r.shareCalls.length, 1);
  assert.deepEqual(Array.from(r.shareCalls[0].menus), ['shareAppMessage', 'shareTimeline']);
  assert.equal(r.page.onShareAppMessage, undefined);
  assert.equal(r.page.onShareTimeline, undefined);
  const markup = fs.readFileSync(path.join(miniprogramRoot, 'pages/admin/portal.wxml'), 'utf8');
  assert.doesNotMatch(markup, /<web-view\b/);
  assert.match(markup, /bindtap="openModule"/);
  assert.match(markup, /bindtap="loadEntry"/);
  const config = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, 'app.json'), 'utf8'));
  assert.ok(config.pages.includes('pages/admin/portal'));
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(`native portal ${lifecycle} clears records and discards late statistics`, async () => {
    const pending = deferred();
    let reads = 0;
    const overview = { members: { total: 0, newCount: 0 }, matchmakers: { approved: 0, pending: 0 },
      revenue: { paidFen: 0, refundFen: 0, netFen: 0 } };
    const r = portalRuntime(allowed, () => ++reads === 1 ? overview : pending.promise);
    await r.page.onShow();
    assert.equal(r.page.data.ready, true);
    const loading = r.page.loadEntry();
    r.page[lifecycle]();
    assert.equal(r.page.data.ready, false);
    assert.equal(r.page.data.metrics.length, 0);
    assert.equal(r.page.data.checking, false);
    pending.resolve(overview);
    await loading;
    assert.equal(r.page.data.ready, false);
    assert.equal(r.page.data.metrics.length, 0);
    assert.equal(r.page.onBackendLoad, undefined);
    assert.equal(r.page.onBackendError, undefined);
  });
}

test('returning to the portal refreshes permission and removes access after administrator revocation', async () => {
  let result = allowed();
  const r = portalRuntime(() => result);
  await r.page.onShow();
  assert.equal(r.page.data.ready, true);
  r.page.onHide();
  result = denied();
  await r.page.onShow();
  assert.equal(entryReads(r).length, 2);
  assert.equal(r.page.data.ready, false);
  assert.match(r.page.data.title, /没有管理权限/);
});

test('a late old-account portal response cannot replace a new account permission result', async () => {
  const pending = deferred();
  let reads = 0;
  const r = portalRuntime(() => ++reads === 1 ? pending.promise : denied());
  const oldLoading = r.page.onShow();
  r.page.onHide();
  r.session.token = 'replacement-session';
  r.session.user = { id: 2 };
  await r.page.onShow();
  pending.resolve(allowed());
  await oldLoading;
  assert.equal(r.page.data.ready, false);
  assert.equal(r.page.data.checking, false);
  assert.match(r.page.data.title, /没有管理权限/);
});

test('portal appearance after an account change rechecks even while an old account request is pending', async () => {
  const pending = deferred();
  let reads = 0;
  const r = portalRuntime(() => ++reads === 1 ? pending.promise : denied());
  const oldLoading = r.page.onShow();
  r.session.token = 'replacement-session';
  r.session.user = { id: 2 };
  await r.page.onShow();
  assert.equal(entryReads(r).length, 2);
  pending.resolve(allowed());
  await oldLoading;
  assert.equal(r.page.data.ready, false);
  assert.equal(r.page.data.checking, false);
  assert.match(r.page.data.title, /没有管理权限/);
});

test('native portal retry recovers entry failures then uses the authorized overview directly for refresh', async () => {
  let reads = 0;
  const r = portalRuntime(() => {
    if (++reads === 1) throw new Error('offline');
    return allowed();
  });
  await r.page.onShow();
  assert.equal(r.page.data.canRetry, true);
  await r.page.loadEntry();
  assert.equal(r.page.data.ready, true);
  assert.equal(r.page.data.checking, false);
  assert.equal(r.page.data.canRetry, true);
  await r.page.loadEntry();
  assert.equal(entryReads(r).length, 2);
  assert.equal(r.page.data.ready, true);
  assert.equal(r.page.data.canRetry, true);
  assert.equal(r.page.data.checking, false);
  r.page.returnToProfile();
  assert.equal(r.calls.navigation.at(-1).method, 'switchTab');
  assert.equal(r.calls.navigation.at(-1).url, '/pages/user/profile');
});

test('portal retry while checking coalesces duplicate clicks into a single server read', async () => {
  const pending = deferred();
  const r = portalRuntime(() => pending.promise);
  const loading = r.page.onShow();
  await r.page.loadEntry();
  await r.page.loadEntry();
  assert.equal(entryReads(r).length, 1);
  pending.resolve(allowed());
  await loading;
  assert.equal(r.page.data.ready, true);
});

test('module navigation is available while initial statistics and later period refreshes are pending', async () => {
  const initial = deferred(), refresh = deferred(); let reads = 0;
  const overview = { members: { total: 7, newCount: 2 }, matchmakers: { approved: 1, pending: 0 },
    revenue: { paidFen: 0, refundFen: 0, netFen: 0 } };
  const r = portalRuntime(allowed, () => ++reads === 1 ? initial.promise : refresh.promise);
  const loading = r.page.onShow(); await flush();
  assert.equal(r.page.data.ready, true); assert.equal(r.page.data.checking, true);
  r.page.openModule({ currentTarget: { dataset: { resource: 'plans' } } });
  assert.match(r.calls.navigation.at(-1).url, /resource=plans$/);
  initial.resolve(overview); await loading;
  const refreshing = r.page.setPeriod({ currentTarget: { dataset: { days: 7 } } });
  assert.equal(entryReads(r).length, 1, 'statistics refresh must not repeat entry permission request');
  assert.equal(r.page.data.ready, true); assert.equal(r.page.data.metrics.length, 0);
  assert.equal(r.page.data.checking, true);
  r.page.openModule({ currentTarget: { dataset: { resource: 'orders' } } });
  assert.match(r.calls.navigation.at(-1).url, /resource=orders$/);
  assert.equal(r.calls.requests.at(-1).options.data.args.periodDays, 7);
  refresh.resolve(overview); await refreshing;
  assert.equal(r.page.data.ready, true); assert.equal(r.page.data.metrics.length, 6);
  assert.equal(r.page.data.checking, false);
});

test('permission revocation during overview refresh removes all statistics and disables module navigation', async () => {
  for (const code of [401, 40102, 403, 40360]) {
    let reads = 0;
    const r = portalRuntime(allowed, () => {
      if (++reads > 1) throw Object.assign(new Error('access revoked'), { code });
      return { members: { total: 7, newCount: 2 }, matchmakers: { approved: 1, pending: 0 },
        revenue: { paidFen: 0, refundFen: 0, netFen: 0 } };
    });
    await r.page.onShow(); assert.equal(r.page.data.metrics.length, 6);
    await r.page.loadEntry();
    assert.equal(entryReads(r).length, 1);
    assert.equal(r.page.data.ready, false); assert.equal(r.page.data.metrics.length, 0);
    assert.equal(r.page.data.checking, false); assert.equal(r.page.data.canRetry, false);
    r.page.openModule({ currentTarget: { dataset: { resource: 'orders' } } });
    assert.equal(r.calls.navigation.length, 0);
  }
});
