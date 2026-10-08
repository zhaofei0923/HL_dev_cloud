const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const pagePath = 'pages/user/members.js';
const quota = (used = 2, remaining = 6) => ({ dateKey: '2026-10-06', limit: 8, used, remaining });
function member(id, userId, isFavorite = false) {
  return { id, userId, realName: `会员${userId}`, gender: 2, age: 30, city: '上海',
    viewerState: { isFavorite, isHidden: false } };
}

function setup(options = {}) {
  const interactions = [];
  let showcases = 0;
  let giftReads = 0;
  const rows = options.rows || [member(501, 77), member('profile_602', 88), member(503, 99)];
  const instance = runtime(pagePath, { memberApi: {
    showcase: async query => {
      showcases += 1;
      return options.showcase ? options.showcase(query, showcases, instance.session)
        : { list: rows, total: rows.length, favoriteQuota: options.quota || quota() };
    },
    interact: async payload => {
      interactions.push(structuredClone(payload));
      return options.interact ? options.interact(payload, interactions.length)
        : { viewerState: { isFavorite: payload.active }, favoriteQuota: quota() };
    },
    gifts: async () => { giftReads += 1; return [{ id: 'rose', name: '玫瑰' }]; }
  } });
  return { ...instance, interactions, showcaseReads: () => showcases, giftReads: () => giftReads };
}

async function show(instance) {
  await instance.page.onShow();
  await flush();
}

function swipeDown(page) {
  page.onCardTouchStart({ touches: [{ clientX: 120, clientY: 180 }] });
  page.onCardTouchEnd({ changedTouches: [{ clientX: 125, clientY: 310 }] });
  page.onCardTap();
}

function expectFavorite(page, expected) {
  assert.equal(page.data.currentMember.isFavorite, expected);
  assert.equal(page.data.list[page.data.currentIndex].isFavorite, expected);
}

test('sending a heart fills the current card, finishes its animation after 460ms and never advances automatically', async () => {
  const instance = setup();
  await show(instance);
  instance.page.nextMember();
  await instance.page.toggleFavorite();
  assert.deepEqual(instance.interactions, [{ targetUserId: 88, targetMemberId: 'profile_602', actionType: 'favorite', active: true }]);
  expectFavorite(instance.page, true);
  assert.equal(instance.page.data.currentMember.id, 'profile_602');
  assert.equal(instance.page.data.positionText, '2/3');
  assert.equal(instance.page.data.actionEffect, 'heart');
  assert.equal(instance.page.data.actionAnimating, true);
  instance.page.nextMember();
  instance.page.goMemberDetail();
  instance.advance(459);
  assert.equal(instance.page.data.actionAnimating, true);
  assert.equal(instance.page.data.currentMember.id, 'profile_602');
  instance.advance(1);
  assert.equal(instance.page.data.actionAnimating, false);
  assert.equal(instance.page.data.actionEffect, '');
  assert.equal(instance.page.data.currentMember.id, 'profile_602');
  assert.equal(instance.page.data.positionText, '2/3');
  assert.equal(instance.calls.navigation.length, 0);
  instance.page.nextMember();
  assert.equal(instance.page.data.currentMember.id, 503, 'an explicit swipe can still browse after the animation');
});

test('withdrawal sends active false, stays on the current card without a heart animation and persists through warm reconstruction', async () => {
  const instance = setup({ rows: [member(501, 77), member('profile_602', 88, true), member(503, 99)] });
  await show(instance);
  instance.page.nextMember();
  const loadedAt = instance.page._showcaseLoadedAt;
  await instance.page.toggleFavorite();
  assert.deepEqual(instance.interactions, [{ targetUserId: 88, targetMemberId: 'profile_602', actionType: 'favorite', active: false }]);
  expectFavorite(instance.page, false);
  assert.equal(instance.page.data.actionAnimating, false);
  assert.equal(instance.page.data.actionEffect, '');
  instance.advance(460);
  assert.equal(instance.page.data.currentMember.id, 'profile_602');
  assert.equal(instance.page._showcaseLoadedAt, loadedAt, 'a mutation does not extend profile freshness');
  await instance.page.onShow();
  expectFavorite(instance.page, false);
  assert.equal(instance.showcaseReads(), 1);
  instance.page.onUnload();
  const rebuilt = instance.recreatePage(pagePath);
  await rebuilt.onShow();
  expectFavorite(rebuilt, false);
  assert.equal(rebuilt.data.currentMember.id, 'profile_602');
  assert.equal(rebuilt.data.positionText, '2/3');
  assert.equal(instance.showcaseReads(), 1, 'warm cache must keep the withdrawal despite the original API fixture remaining favored');
  assert.equal(instance.calls.storage.length, 0);
});

test('the server favorite state takes precedence over the requested value; missing or nonboolean state falls back to the request', async () => {
  for (const initial of [false, true]) {
    for (const reply of ['opposite', 'missing', 'nonboolean']) {
      const requested = !initial;
      const expected = reply === 'opposite' ? initial : requested;
      const response = reply === 'opposite' ? { viewerState: { isFavorite: initial } }
        : reply === 'nonboolean' ? { viewerState: { isFavorite: 'invalid' } } : {};
      const instance = setup({ rows: [member('profile_602', 88, initial)], interact: async () => response });
      await show(instance);
      await instance.page.toggleFavorite();
      assert.equal(instance.interactions[0].active, requested);
      expectFavorite(instance.page, expected);
      if (reply === 'opposite') {
        assert.equal(instance.page.data.actionAnimating, false);
        assert.equal(instance.page.data.actionEffect, '');
        assert.ok(instance.calls.toasts.some(value => /未撤回|未送出/.test(value)));
      }
      instance.advance(460);
      await instance.page.onShow();
      expectFavorite(instance.page, expected);
      assert.equal(instance.showcaseReads(), 1);
    }
  }
});

test('withdrawal remains available at zero quota and uses only the returned quota instead of computing a refill', async () => {
  for (const returnedQuota of [quota(8, 0), quota(6, 2), null]) {
    const instance = setup({ rows: [member(501, 77, true)], quota: quota(8, 0),
      interact: async () => ({ viewerState: { isFavorite: false }, ...(returnedQuota ? { favoriteQuota: returnedQuota } : {}) }) });
    await show(instance);
    assert.equal(instance.page.data.favoriteQuota.remaining, 0);
    await instance.page.toggleFavorite();
    assert.equal(instance.interactions.length, 1);
    assert.equal(instance.interactions[0].active, false);
    expectFavorite(instance.page, false);
    assert.deepEqual(instance.page.data.favoriteQuota, returnedQuota || quota(8, 0));
    await instance.page.onShow();
    assert.deepEqual(instance.page.data.favoriteQuota, returnedQuota || quota(8, 0));
    assert.equal(instance.showcaseReads(), 1);
  }
});

test('failed send and withdrawal preserve the initial heart state, clear progress and permit a retry on the same member', async () => {
  for (const initial of [false, true]) {
    const instance = setup({ rows: [member('profile_602', 88, initial), member(503, 99)], interact: async (payload, count) => {
      if (count === 1) throw new Error('temporary favorite failure');
      return { viewerState: { isFavorite: payload.active }, favoriteQuota: quota(3, 5) };
    } });
    await show(instance);
    await instance.page.toggleFavorite();
    expectFavorite(instance.page, initial);
    assert.equal(instance.page.data.favoriteLoading, false);
    assert.equal(instance.page.data.actionAnimating, false);
    assert.equal(instance.page.data.currentMember.id, 'profile_602');
    assert.ok(instance.calls.toasts.some(value => /temporary favorite failure/.test(value)));
    await instance.page.toggleFavorite();
    assert.equal(instance.interactions.length, 2);
    assert.equal(instance.interactions[0].active, !initial);
    assert.equal(instance.interactions[1].active, !initial);
    expectFavorite(instance.page, !initial);
    instance.advance(460);
    assert.equal(instance.page.data.currentMember.id, 'profile_602');
    assert.equal(instance.page.data.favoriteLoading, false);
  }
});

test('a pending withdrawal blocks repeated clicks, card browsing, details, gifts and hide without switching its target', async () => {
  const pending = deferred();
  const instance = setup({ rows: [member('profile_602', 88, true), member(503, 99)], interact: () => pending.promise });
  await show(instance);
  const operation = instance.page.toggleFavorite();
  assert.equal(instance.page.data.favoriteLoading, true);
  await instance.page.toggleFavorite();
  instance.page.nextMember();
  instance.page.previousMember();
  instance.page.goMemberDetail();
  swipeDown(instance.page);
  await instance.page.openGiftPanel();
  await instance.page.hideCurrent();
  assert.equal(instance.interactions.length, 1);
  assert.equal(instance.interactions[0].targetUserId, 88);
  assert.equal(instance.interactions[0].active, false);
  assert.equal(instance.page.data.currentMember.id, 'profile_602');
  expectFavorite(instance.page, true);
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.calls.storage.length, 0);
  assert.equal(instance.giftReads(), 0);
  pending.resolve({ viewerState: { isFavorite: false }, favoriteQuota: quota() });
  await operation;
  assert.equal(instance.page.data.favoriteLoading, false);
  expectFavorite(instance.page, false);
});

test('numeric and profile member IDs withdraw using their distinct positive user IDs and never infer an absent user ID', async () => {
  for (const row of [member(501, 77, true), member('profile_602', 88, true)]) {
    const instance = setup({ rows: [row] });
    await show(instance);
    await instance.page.toggleFavorite();
    assert.deepEqual(instance.interactions[0], { targetUserId: row.userId, targetMemberId: row.id, actionType: 'favorite', active: false });
  }
  for (const userId of [undefined, 0, -1, 'not-a-user']) {
    const instance = setup({ rows: [member('profile_602', userId, true)] });
    await show(instance);
    await instance.page.toggleFavorite();
    assert.equal(instance.interactions.length, 0);
    expectFavorite(instance.page, true);
    assert.equal(instance.page.data.favoriteLoading, false);
    assert.ok(instance.calls.toasts.length > 0);
  }
});

test('old-session favorite success or failure cannot change a new account card, quota, feedback or pending progress', async () => {
  for (const outcome of ['success', 'failure']) {
    const old = deferred();
    const latest = deferred();
    const instance = setup({
      showcase: (_query, _count, session) => ({ list: [member(501, 77, session.user.id === 2)], total: 1, favoriteQuota: quota(8, 0) }),
      interact: (_payload, count) => count === 1 ? old.promise : latest.promise
    });
    await show(instance);
    const previous = instance.page.toggleFavorite();
    instance.session.token = 'new-account-fixture-token';
    instance.session.user = { id: 2 };
    await instance.page.onShow();
    assert.equal(instance.page.data.favoriteLoading, false);
    const current = instance.page.toggleFavorite();
    assert.equal(instance.interactions[1].active, false);
    assert.equal(instance.page.data.favoriteLoading, true);
    const feedback = instance.calls.toasts.length;
    if (outcome === 'success') old.resolve({ viewerState: { isFavorite: true }, favoriteQuota: quota(1, 7) });
    else old.reject(new Error('old account failure'));
    await previous;
    expectFavorite(instance.page, true);
    assert.equal(instance.page.data.actionAnimating, false);
    assert.equal(instance.page.data.favoriteLoading, true, 'an old finalizer must not hide the new operation progress');
    assert.deepEqual(instance.page.data.favoriteQuota, quota(8, 0));
    assert.equal(instance.calls.toasts.length, feedback);
    latest.resolve({ viewerState: { isFavorite: false }, favoriteQuota: quota(8, 0) });
    await current;
    expectFavorite(instance.page, false);
    assert.equal(instance.page.data.favoriteLoading, false);
    await instance.page.onShow();
    expectFavorite(instance.page, false);
    assert.equal(instance.showcaseReads(), 2);
  }
});

test('unloaded favorite responses do not mutate the old page or affect a reconstructed page operation', async () => {
  for (const outcome of ['success', 'failure']) {
    const old = deferred();
    const latest = deferred();
    const instance = setup({ interact: (_payload, count) => count === 1 ? old.promise : latest.promise });
    await show(instance);
    const previous = instance.page.toggleFavorite();
    instance.page.onUnload();
    const oldData = JSON.stringify(instance.page.data);
    const rebuilt = instance.recreatePage(pagePath);
    await rebuilt.onShow();
    const current = rebuilt.toggleFavorite();
    assert.equal(rebuilt.data.favoriteLoading, true);
    const feedback = instance.calls.toasts.length;
    if (outcome === 'success') old.resolve({ viewerState: { isFavorite: true }, favoriteQuota: quota(1, 7) });
    else old.reject(new Error('unloaded favorite failure'));
    await previous;
    assert.equal(JSON.stringify(instance.page.data), oldData);
    expectFavorite(rebuilt, false);
    assert.equal(rebuilt.data.favoriteLoading, true);
    assert.equal(instance.calls.toasts.length, feedback);
    latest.resolve({ viewerState: { isFavorite: true }, favoriteQuota: quota(3, 5) });
    await current;
    instance.advance(460);
    expectFavorite(rebuilt, true);
    assert.equal(rebuilt.data.currentMember.id, 501);
    assert.equal(rebuilt.data.favoriteLoading, false);
  }
});

test('unloading a successful send cancels its visual timer while retaining the saved favorite in the warm cache', async () => {
  const instance = setup();
  await show(instance);
  await instance.page.toggleFavorite();
  assert.equal(instance.page.data.actionAnimating, true);
  instance.page.onUnload();
  const oldData = JSON.stringify(instance.page.data);
  const rebuilt = instance.recreatePage(pagePath);
  await rebuilt.onShow();
  instance.advance(1000);
  assert.equal(JSON.stringify(instance.page.data), oldData);
  expectFavorite(rebuilt, true);
  assert.equal(rebuilt.data.currentMember.id, 501);
  assert.equal(rebuilt.data.actionAnimating, false);
  assert.equal(rebuilt.data.actionEffect, '');
  assert.equal(instance.showcaseReads(), 1);
});
