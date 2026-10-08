const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'user', 'members.js');
const cachePath = path.join(__dirname, '..', 'miniprogram', 'utils', 'showcase-cache.js');
const requireFromPage = createRequire(pagePath);

function member(id) {
  return {
    id: { a: 501, b: 'profile_602', c: 503 }[id],
    userId: { a: 77, b: 88, c: 99 }[id],
    realName: `${id}女士`,
    gender: 2,
    age: 30,
    city: '上海',
    height: 168,
    education: '本科',
    houseStatus: '有房',
    carStatus: '有车',
    isVerified: 1
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function runtime(rows = [member('a'), member('b'), member('c')], overrides = {}) {
  const calls = {
    interactions: [], gifts: [], navigations: [], storage: [], toasts: [],
    showcases: [], giftCatalog: 0, loading: [], loadingHidden: 0, loadingVisible: false
  };
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  let definition;
  let cacheModule;
  const session = { token: 'test-session', user: { id: 7001 }, env: 'test-environment' };
  class RuntimeDate extends Date {
    constructor(...arguments_) {
      if (arguments_.length) super(...arguments_);
      else super(Date.UTC(2026, 9, 6, 0, 0, 0) + now);
    }
    static now() { return Date.UTC(2026, 9, 6, 0, 0, 0) + now; }
  }
  const memberApi = {
    showcase: async query => {
      calls.showcases.push(structuredClone(query));
      return overrides.showcase ? overrides.showcase(query) : { list: rows, total: rows.length };
    },
    gifts: async () => {
      calls.giftCatalog += 1;
      return overrides.gifts ? overrides.gifts() : [{ id: 'rose', name: '玫瑰' }];
    },
    interact: async payload => {
      calls.interactions.push(payload);
      return overrides.interact ? overrides.interact(payload) : {};
    },
    sendGift: async payload => {
      calls.gifts.push(payload);
      return overrides.sendGift ? overrides.sendGift(payload) : {};
    }
  };
  const pageModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    module: pageModule,
    exports: pageModule.exports,
    require(name) {
      if (name === '../../services/member') return { memberApi };
      if (name === '../../services/api') return {
        apiErrorMessage: error => String(error && (error.errMsg || error.message) || error || '')
      };
      if (name === '../../utils/showcase-cache') {
        if (!cacheModule) {
          cacheModule = { exports: {} };
          vm.runInNewContext(fs.readFileSync(cachePath, 'utf8'), {
            module: cacheModule,
            exports: cacheModule.exports,
            require: createRequire(cachePath),
            Date: RuntimeDate
          }, { filename: cachePath });
        }
        return cacheModule.exports;
      }
      return requireFromPage(name);
    },
    Page(options) { definition = options; },
    getApp: () => ({ globalData: session }),
    Date: RuntimeDate,
    wx: {
      getStorageSync: key => key === 'token' ? session.token : key === 'user' ? session.user : undefined,
      setStorageSync: (key, value) => calls.storage.push({ key, value }),
      navigateTo: options => calls.navigations.push(options.url),
      redirectTo: options => calls.navigations.push(options.url),
      showToast: options => calls.toasts.push(options.title),
      showLoading: options => {
        calls.loading.push(options);
        calls.loadingVisible = true;
      },
      hideLoading: () => {
        calls.loadingHidden += 1;
        calls.loadingVisible = false;
      }
    },
    console: { warn() {} },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(state) { Object.assign(this.data, state); }
  };
  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  }
  return { page, calls, advance, timers, session };
}

function touch(page, start, end) {
  page.onCardTouchStart({ touches: [{ clientX: start[0], clientY: start[1] }] });
  page.onCardTouchEnd({ changedTouches: [{ clientX: end[0], clientY: end[1] }] });
}

const giftEvent = { currentTarget: { dataset: { giftId: 'rose' } } };

test('downward card swipes advance continuously, wrap to the first member and suppress accidental navigation', async () => {
  const { page, calls } = runtime();
  await page.load();
  for (const [id, position] of [['profile_602', '2/3'], [503, '3/3'], [501, '1/3']]) {
    touch(page, [120, 180], [125, 236]);
    page.onCardTap();
    assert.equal(page.data.currentMember.id, id);
    assert.equal(page.data.positionText, position);
    assert.equal(calls.navigations.length, 0);
    assert.equal(calls.storage.length, 0);
  }

  touch(page, [120, 180], [124, 185]);
  page.onCardTap();
  assert.deepEqual(calls.navigations, ['/pages/user/member-detail?id=501']);
  assert.equal(calls.storage[0].key, 'selectedUserMember');
  assert.equal(calls.storage[0].value.id, 501);
});

test('short vertical and diagonal drags neither change the member nor open details', async () => {
  const { page, calls } = runtime();
  await page.load();
  for (const end of [[120, 235], [160, 230], [128, 191]]) {
    touch(page, [120, 180], end);
    page.onCardTap();
    assert.equal(page.data.currentMember.id, 501);
    assert.equal(calls.navigations.length, 0);
  }
  touch(page, [120, 180], [121, 181]);
  page.onCardTap();
  assert.deepEqual(calls.navigations, ['/pages/user/member-detail?id=501']);
});

test('upward and horizontal card swipes remain compatible without opening details', async () => {
  const { page, calls } = runtime();
  await page.load();
  touch(page, [180, 200], [70, 210]);
  page.onCardTap();
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(calls.navigations.length, 0);

  touch(page, [70, 210], [180, 200]);
  page.onCardTap();
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.navigations.length, 0);
  touch(page, [120, 310], [125, 180]);
  page.onCardTap();
  assert.equal(page.data.currentMember.id, 503);
  assert.equal(calls.navigations.length, 0);
});

test('favorite and gift stay on the target after the success animation', async () => {
  for (const action of ['favorite', 'gift']) {
    const pending = deferred();
    const { page, calls, advance } = runtime(undefined, {
      interact: () => pending.promise,
      sendGift: () => pending.promise
    });
    await page.load();
    if (action === 'gift') await page.openGiftPanel();
    const operation = action === 'gift' ? page.sendGift(giftEvent) : page.toggleFavorite();
    page.nextMember();
    page.previousMember();
    page.goMemberDetail();
    touch(page, [180, 200], [70, 200]);
    page.onCardTap();
    touch(page, [120, 180], [125, 310]);
    page.onCardTap();
    assert.equal(page.data.currentMember.id, 501, `${action} pending must retain the current card`);
    assert.equal(calls.navigations.length, 0);
    const request = action === 'gift' ? calls.gifts[0] : calls.interactions[0];
    assert.equal(request.targetUserId, 77);
    assert.equal(request.targetMemberId, 501);
    assert.equal(calls.loadingVisible, true);

    const quota = { dateKey: '2026-10-06', limit: 8, used: 1, remaining: 7 };
    pending.resolve(action === 'gift' ? { favorite: { favoriteQuota: quota } } : { favoriteQuota: quota });
    await operation;
    assert.equal(page.data.actionAnimating, true);
    assert.equal(page.data.actionEffect, action === 'gift' ? 'gift' : 'heart');
    page.nextMember();
    page.goMemberDetail();
    touch(page, [120, 180], [125, 310]);
    page.onCardTap();
    advance(459);
    assert.equal(page.data.currentMember.id, 501);
    assert.equal(calls.navigations.length, 0);
    advance(1);
    assert.equal(page.data.currentMember.id, 501);
    assert.equal(page.data.list[0].isFavorite, true);
    assert.equal(page.data.list[1].isFavorite, false);
    assert.equal(page.data.favoriteQuota.remaining, 7);
    assert.equal(page.data.giftPanelOpen, false);
    assert.equal(page.data.actionAnimating, false);
    assert.equal(page.data.actionEffect, '');
    assert.equal(calls.loadingVisible, false);
    assert.equal(calls.loadingHidden, 1);
  }
});

test('hiding removes only the selected member and keeps the next card across wrap and empty cases', async () => {
  const { page, calls, advance } = runtime();
  await page.load();
  page.nextMember();
  await page.hideCurrent();
  page.nextMember();
  page.goMemberDetail();
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(calls.navigations.length, 0);
  advance(460);
  assert.deepEqual(Array.from(page.data.list, row => row.id), [501, 503]);
  assert.equal(page.data.currentMember.id, 503);
  assert.equal(page.data.positionText, '2/2');
  assert.equal(page.data.total, 2);
  assert.equal(calls.interactions[0].targetUserId, 88);
  assert.equal(calls.interactions[0].targetMemberId, 'profile_602');

  await page.hideCurrent();
  advance(460);
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(page.data.positionText, '1/1');
  await page.hideCurrent();
  advance(460);
  assert.equal(page.data.currentMember, null);
  assert.equal(page.data.list.length, 0);
  assert.equal(page.data.positionText, '');
  assert.equal(page.data.total, 0);
  assert.equal(page.data.countText, '暂无可浏览会员');
});

test('an in-flight hide blocks browsing, detail and other card actions', async () => {
  const pending = deferred();
  const { page, calls, advance } = runtime(undefined, { interact: () => pending.promise });
  await page.load();
  const operation = page.hideCurrent();
  page.nextMember();
  page.previousMember();
  touch(page, [180, 200], [70, 200]);
  page.onCardTap();
  touch(page, [120, 180], [125, 310]);
  page.onCardTap();
  page.goMemberDetail();
  await page.toggleFavorite();
  await page.hideCurrent();
  await page.openGiftPanel();
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.navigations.length, 0);
  assert.equal(calls.interactions.length, 1);
  assert.equal(page.data.giftPanelOpen, false);
  assert.equal(calls.loadingVisible, true);
  pending.resolve({});
  await operation;
  advance(460);
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(page.data.total, 2);
  assert.equal(calls.loadingVisible, false);
});

test('failed favorite, hide and gift requests show feedback, clear progress and permit retry', async () => {
  for (const action of ['favorite', 'hide', 'gift']) {
    let attempts = 0;
    const submit = async () => {
      if (++attempts === 1) throw new Error('request rejected');
      return {};
    };
    const { page, calls, advance, timers } = runtime(undefined, {
      interact: submit,
      sendGift: submit
    });
    await page.load();
    if (action === 'gift') await page.openGiftPanel();
    if (action === 'gift') await page.sendGift(giftEvent);
    else if (action === 'hide') await page.hideCurrent();
    else await page.toggleFavorite();
    advance(1000);
    assert.equal(page.data.currentMember.id, 501);
    assert.equal(page.data.list.length, 3);
    assert.equal(page.data.list[0].isFavorite, false);
    assert.equal(page.data.actionAnimating, false);
    assert.equal(page.data.actionEffect, '');
    assert.equal(page.data.favoriteLoading, false);
    assert.equal(page.data.hideLoading, false);
    assert.equal(page.data.sendingGiftId, '');
    assert.equal(timers.size, 0);
    assert.equal(calls.loadingVisible, false);
    assert.equal(calls.loadingHidden, 1);
    assert.ok(calls.toasts.some(message => message.includes('request rejected')), `${action} failure must provide feedback`);

    if (action === 'gift') await page.sendGift(giftEvent);
    else if (action === 'hide') await page.hideCurrent();
    else await page.toggleFavorite();
    assert.equal(attempts, 2, `${action} must permit retry after failure`);
    assert.equal(page.data.actionAnimating, true);
    advance(460);
    assert.equal(page.data.currentMember.id, action === 'hide' ? 'profile_602' : 501);
    assert.equal(calls.loadingHidden, 2);
  }
});

test('a pending gift catalog does not delay showcasing cards and the gift panel opens immediately', async () => {
  const pending = deferred();
  const { page, calls } = runtime(undefined, { gifts: () => pending.promise });
  await page.load();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.giftCatalog, 0, 'showcase load must not fetch the gift catalog');

  const opening = page.openGiftPanel();
  assert.equal(page.data.giftPanelOpen, true);
  assert.equal(page.data.giftLoading, true);
  assert.equal(calls.giftCatalog, 1);
  page.nextMember();
  page.goMemberDetail();
  touch(page, [120, 180], [125, 310]);
  page.onCardTap();
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.navigations.length, 0);
  pending.resolve([{ id: 'rose', name: '玫瑰' }]);
  await opening;
  assert.equal(page.data.giftLoading, false);
  assert.equal(page.data.gifts[0].id, 'rose');
  page.closeGiftPanel();
  await page.openGiftPanel();
  assert.equal(calls.giftCatalog, 1, 'reopening should use the successful cached catalog');
});

test('a failed gift catalog keeps cards available and can be retried from the gift panel', async () => {
  let attempts = 0;
  const { page, calls } = runtime(undefined, {
    gifts: async () => {
      if (++attempts === 1) throw new Error('gift catalog unavailable');
      return [{ id: 'rose', name: '玫瑰' }];
    }
  });
  await page.load();
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.giftCatalog, 0);
  await page.openGiftPanel();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.giftLoading, false);
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(page.data.list.length, 3);
  assert.ok(calls.toasts.length > 0, 'catalog failure must explain the unavailable gifts');
  page.closeGiftPanel();
  page.nextMember();
  assert.equal(page.data.currentMember.id, 'profile_602');
  await page.openGiftPanel();
  assert.equal(calls.giftCatalog, 2);
  assert.equal(page.data.gifts[0].id, 'rose');
});

test('numeric and profile member IDs keep their distinct positive user IDs in action requests', async () => {
  for (const id of [601, 'profile_601']) {
    for (const action of ['favorite', 'hide', 'gift']) {
      const { page, calls } = runtime([{ ...member('a'), id, userId: '77' }]);
      await page.load();
      if (action === 'favorite') await page.toggleFavorite();
      else if (action === 'hide') await page.hideCurrent();
      else {
        await page.openGiftPanel();
        await page.sendGift(giftEvent);
      }
      const request = action === 'gift' ? calls.gifts[0] : calls.interactions[0];
      assert.equal(request.targetUserId, 77);
      assert.equal(request.targetMemberId, id);
    }
  }
});

test('invalid or absent user IDs produce feedback and are not inferred from member IDs', async () => {
  const invalidIds = [undefined, null, '', 'not-a-user', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const id of [601, 'profile_601']) {
    for (const userId of invalidIds) {
      const { page, calls } = runtime([{ ...member('a'), id, userId }]);
      await page.load();
      await page.toggleFavorite();
      await page.hideCurrent();
      await page.openGiftPanel();
      await page.sendGift(giftEvent);
      assert.equal(calls.interactions.length, 0, `${id}/${userId} must not submit interactions`);
      assert.equal(calls.gifts.length, 0, `${id}/${userId} must not submit gifts`);
      assert.equal(calls.giftCatalog, 0);
      assert.equal(page.data.giftPanelOpen, false);
      assert.equal(page.data.currentMember.id, id);
      assert.equal(calls.loading.length, 0);
      assert.equal(calls.toasts.length, 4, `${id}/${userId} needs feedback for every action`);
      assert.ok(calls.toasts.every(message => typeof message === 'string' && message.length > 0));
    }
  }
});

test('filled profile fields and the legacy verification flag do not imply credential approval', async () => {
  const { page } = runtime();
  await page.load();
  const badges = page.data.currentMember.certificationBadges;
  assert.equal(badges.length, 0);
});

test('unloading cancels pending card animation and prevents later card mutations', async () => {
  const { page, advance, timers } = runtime();
  await page.load();
  await page.toggleFavorite();
  assert.ok(timers.size > 0);
  page.onUnload();
  advance(1000);
  assert.equal(timers.size, 0);
  assert.equal(page.data.currentMember.id, 501);
});

test('warm showcase loads deduplicate requests and returning to the page keeps the selected card', async () => {
  const pending = deferred();
  const { page, calls } = runtime(undefined, { showcase: () => pending.promise });
  const first = page.load(false);
  const second = page.load(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.showcases.length, 1);
  pending.resolve({ list: [member('a'), member('b'), member('c')], total: 3 });
  await Promise.all([first, second]);
  page.nextMember();
  assert.equal(page.data.currentMember.id, 'profile_602');
  page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.showcases.length, 1);
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(page.data.loading, false);
});

test('showcase caches separate filters, user sessions and cloud environments', async () => {
  const { page, calls, session } = runtime();
  await page.load(false);
  await page.load(false);
  assert.equal(calls.showcases.length, 1);
  page.onKeyword({ detail: { value: '上海' } });
  await page.search();
  assert.equal(calls.showcases.length, 2);
  assert.equal(calls.showcases[1].keyword, '上海');
  page.onKeyword({ detail: { value: '' } });
  page.setData({ keyword: '' });
  await page.load(false);
  assert.equal(calls.showcases.length, 2);
  session.token = 'another-session';
  session.user = { id: 7002 };
  await page.load(false);
  assert.equal(calls.showcases.length, 3);
  session.env = 'another-environment';
  await page.load(false);
  assert.equal(calls.showcases.length, 4);
});

test('forced reload bypasses a warm cache and an expired cache refetches', async () => {
  const { page, calls, advance } = runtime();
  await page.load(false);
  await page.load(false);
  assert.equal(calls.showcases.length, 1);
  await page.load(true);
  assert.equal(calls.showcases.length, 2);
  await page.load(false);
  assert.equal(calls.showcases.length, 2);
  advance(60001);
  await page.load(false);
  assert.equal(calls.showcases.length, 3);
});

test('successfully hidden members stay removed on a warm return to the recommendation page', async () => {
  const { page, calls, advance } = runtime();
  await page.load(false);
  await page.hideCurrent();
  advance(460);
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(page.data.list.length, 2);
  page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.showcases.length, 1);
  assert.deepEqual(Array.from(page.data.list, row => row.id), ['profile_602', 503]);
  assert.equal(page.data.total, 2);
  assert.equal(page.data.currentMember.id, 'profile_602');
});

test('a late response from an old filter cannot replace the latest matching cards', async () => {
  const old = deferred();
  const latest = deferred();
  const { page, calls } = runtime(undefined, { showcase: query => query.keyword ? latest.promise : old.promise });
  const oldLoad = page.load(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.showcases.length, 1);
  page.onKeyword({ detail: { value: '上海' } });
  const latestLoad = page.search();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.showcases.length, 2);
  latest.resolve({ list: [member('b')], total: 1 });
  await latestLoad;
  assert.equal(page.data.currentMember.id, 'profile_602');
  old.resolve({ list: [member('a')], total: 1 });
  await oldLoad;
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(page.data.keyword, '上海');
  assert.equal(page.data.loading, false);
});

test('an old request finishing or failing cannot clear progress while the latest filter is pending', async () => {
  for (const oldFails of [false, true]) {
    const old = deferred();
    const latest = deferred();
    const { page, calls } = runtime(undefined, { showcase: query => query.keyword ? latest.promise : old.promise });
    const oldLoad = page.load(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.showcases.length, 1);
    page.onKeyword({ detail: { value: '上海' } });
    const latestLoad = page.search();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.showcases.length, 2);
    if (oldFails) old.reject(new Error('old request failed'));
    else old.resolve({ list: [member('a')], total: 1 });
    await oldLoad;
    assert.equal(page.data.loading, true);
    assert.equal(page.data.currentMember, null);
    latest.resolve({ list: [member('b')], total: 1 });
    await latestLoad;
    assert.equal(page.data.currentMember.id, 'profile_602');
    assert.equal(page.data.loading, false);
  }
});

test('an expired recommendation closes the gift panel and refreshes before accepting a gift', async () => {
  const { page, calls, advance } = runtime();
  await page.load(false);
  await page.openGiftPanel();
  assert.equal(page.data.giftPanelOpen, true);
  advance(60001);
  await page.sendGift(giftEvent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.gifts.length, 0);
  assert.equal(page.data.giftPanelOpen, false);
  assert.equal(page.data.sendingGiftId, '');
  assert.equal(page.data.actionAnimating, false);
  assert.equal(calls.showcases.length, 2);
  assert.equal(page.data.loading, false);
  await page.openGiftPanel();
  await page.sendGift(giftEvent);
  assert.equal(calls.gifts.length, 1);
  assert.equal(calls.gifts[0].targetUserId, 77);
});

test('expired recommendations refresh quietly while browsing continues and stale writes stay blocked', async () => {
  let reads = 0;
  const pending = deferred();
  const rows = [member('a'), member('b'), member('c')];
  const { page, calls, advance } = runtime(undefined, { showcase: () => {
    reads += 1;
    return reads === 1 ? Promise.resolve({ list: rows, total: 3 }) : pending.promise;
  } });
  await page.onShow();
  advance(60001);
  const refresh = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.loading, false);
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(page.data.list.length, 3);
  await page.toggleFavorite();
  await page.hideCurrent();
  await page.openGiftPanel();
  await page.sendGift(giftEvent);
  assert.equal(calls.interactions.length, 0);
  assert.equal(calls.gifts.length, 0);
  assert.equal(calls.giftCatalog, 0);
  assert.equal(page.data.giftPanelOpen, false);
  assert.equal(reads, 2, 'stale writes must share the existing refresh');

  touch(page, [120, 180], [125, 310]);
  page.onCardTap();
  assert.equal(page.data.currentMember.id, 'profile_602');
  assert.equal(calls.navigations.length, 0);
  touch(page, [120, 180], [121, 181]);
  page.onCardTap();
  assert.equal(calls.navigations[0], '/pages/user/member-detail?id=profile_602');
  assert.equal(calls.storage[0].value.id, 'profile_602');
  pending.resolve({ list: rows, total: 3 });
  await refresh;
  assert.equal(page.data.currentMember.id, 'profile_602', 'quiet responses must retain the card selected while loading');
  await page.toggleFavorite();
  assert.equal(calls.interactions.length, 1);
  assert.equal(calls.interactions[0].targetUserId, 88);
});

test('a failed quiet showcase refresh preserves the old cards and permits another quiet retry', async () => {
  const failed = deferred();
  const retry = deferred();
  let reads = 0;
  const { page, advance } = runtime(undefined, { showcase: () => {
    reads += 1;
    if (reads === 1) return Promise.resolve({ list: [member('a'), member('b')], total: 2 });
    return reads === 2 ? failed.promise : retry.promise;
  } });
  await page.onShow();
  advance(60001);
  const refreshing = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  failed.reject(new Error('background showcase failed'));
  await refreshing;
  assert.equal(page.data.loading, false);
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(page.data.list.length, 2);
  const retrying = page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.list.length, 2);
  retry.resolve({ list: [member('a'), member('b'), member('c')], total: 3 });
  await retrying;
  assert.equal(page.data.list.length, 3);
  assert.equal(page.data.total, 3);
});

test('an explicit showcase reload still marks loading and blocks card navigation until it completes', async () => {
  let reads = 0;
  const pending = deferred();
  const { page, calls } = runtime(undefined, { showcase: () => ++reads === 1
    ? Promise.resolve({ list: [member('a'), member('b')], total: 2 })
    : pending.promise
  });
  await page.onShow();
  const reload = page.load(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.loading, true);
  touch(page, [120, 180], [125, 310]);
  page.onCardTap();
  page.goMemberDetail();
  assert.equal(page.data.currentMember.id, 501);
  assert.equal(calls.navigations.length, 0);
  pending.resolve({ list: [member('a'), member('b')], total: 2 });
  await reload;
  assert.equal(page.data.loading, false);
});
