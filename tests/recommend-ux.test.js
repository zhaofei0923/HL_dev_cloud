const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime: baseRuntime, deferred, flush } = require('./helpers/miniprogram-runtime');

// These cases exercise paid showcase layout, caching and interaction behavior.
const runtime = (page, options = {}) => baseRuntime(page, { source: true, ...options, memberApi: {
  vipOverview: async () => ({ isPremiumMember: true, membershipTier: 'vip', entitlements: {} }), ...options.memberApi
} });

const rows = [1, 2, 3].map(id => ({ id, userId: id + 10, realName: `会员${id}`, city: '上海' }));
const category = value => ({ currentTarget: { dataset: { category: value } } });

test('typing and dismissing filters never changes applied queries or heart recipients', async () => {
  const reads = [], actions = [];
  const { page } = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { reads.push(structuredClone(query)); return { list: rows, total: 3 }; },
    interact: async data => { actions.push(data); return { viewerState: { isFavorite: true } }; }
  } });
  await page.load(false);
  page.toggleFilter();
  page.onKeyword({ detail: { value: '博士' } });
  page.onCity({ detail: { value: '杭州' } });
  page.setGender({ currentTarget: { dataset: { gender: '2' } } });
  page.nextMember();
  await page.toggleFavorite();
  assert.equal(actions.length, 0, 'card actions are blocked while editing the overlay');
  assert.equal(page.data.currentMember.id, 1);
  page.toggleFilter();
  assert.equal(page.data.keyword, '');
  assert.equal(page.data.draftKeyword, '');
  await page.toggleFavorite();
  assert.equal(actions[0].targetUserId, 11);
  assert.equal(reads.length, 1);
});

test('applied filter chips are shared across categories and removal applies exactly one condition', async () => {
  const reads = [];
  const { page } = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { reads.push(structuredClone(query)); return { list: rows, total: 3 }; }
  } });
  await page.load(false);
  page.toggleFilter();
  page.onKeyword({ detail: { value: ' 硕士 ' } });
  page.onCity({ detail: { value: ' 上海 ' } });
  await page.search();
  assert.equal(page.data.filterChips.length, 2);
  await page.switchCategory(category('education'));
  assert.equal(reads.at(-1).keyword, '硕士');
  assert.equal(reads.at(-1).city, '上海');
  await page.removeFilter({ currentTarget: { dataset: { key: 'keyword' } } });
  assert.equal(reads.at(-1).keyword, '');
  assert.equal(reads.at(-1).city, '上海');
  assert.equal(page.data.filterChips.length, 1);
});

test('hiding removes a member from all four categories and refreshes preserve the exclusion and applied filters', async () => {
  let hidden = false;
  const reads = [], actions = [];
  const { page, advance } = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { reads.push(structuredClone(query)); const list = rows.filter(row => !hidden || row.userId !== 11); return { list, total: list.length }; },
    interact: async data => { actions.push(data); hidden = data.active; return { viewerState: { isHidden: hidden } }; }
  } });
  await page.load(false);
  page.toggleFilter();
  page.onKeyword({ detail: { value: '会员' } });
  page.onCity({ detail: { value: '上海' } });
  await page.search();
  await page.switchCategory(category('popularity'));
  await page.switchCategory(category('education'));
  page.nextMember();
  await page.switchCategory(category('assets'));
  page.nextMember();
  page.nextMember();
  await page.switchCategory(category('recommend'));
  const readsBeforeHide = reads.length;
  await page.hideCurrent();
  advance(460);
  assert.equal(page.data.currentMember.id, 2);
  for (const [value, selectedId] of [['popularity', 2], ['education', 2], ['assets', 3], ['recommend', 2]]) {
    await page.switchCategory(category(value));
    assert.deepEqual(Array.from(page.data.list, row => row.userId), [12, 13]);
    assert.equal(page.data.total, 2);
    assert.equal(page.data.currentMember.id, selectedId, `${value} retains its browsing position`);
  }
  assert.equal(reads.length, readsBeforeHide, 'all warm category caches remove the hidden user without another request');
  for (const value of ['recommend', 'popularity', 'education', 'assets']) {
    await page.switchCategory(category(value));
    await page.load(true);
    assert.deepEqual(Array.from(page.data.list, row => row.userId), [12, 13]);
    assert.equal(page.data.total, 2);
    assert.equal(reads.at(-1).category, value);
    assert.equal(reads.at(-1).keyword, '会员');
    assert.equal(reads.at(-1).city, '上海');
  }
  assert.equal(actions.length, 1, 'browsing and reloading never restore the hidden user');
  assert.equal(actions[0].actionType, 'hide');
  assert.equal(actions[0].active, true);
  assert.equal(actions[0].targetUserId, 11);
});

test('a late hide response from an old account cannot remove a member or change the new account cache', async () => {
  const pending = deferred();
  const { page, session, calls, advance } = runtime('pages/user/members.js', { memberApi: {
    interact: () => pending.promise,
    showcase: async () => ({ list: rows, total: 3 })
  } });
  await page.load(false);
  const hiding = page.hideCurrent();
  await flush();
  session.token = 'new-account';
  session.user.id = 5;
  await page.load(false);
  pending.resolve({ viewerState: { isHidden: true } });
  await hiding;
  advance(1000);
  await page.load(false);
  assert.deepEqual(Array.from(page.data.list, row => row.userId), [11, 12, 13]);
  assert.equal(page.data.currentMember.id, 1);
  assert.equal(page.data.total, 3);
  assert.equal(page.data.hideLoading, false);
  assert.equal(page.data.actionAnimating, false);
  assert.equal(calls.toasts.length, 0);
});

test('a failed hide preserves the selected member in every loaded category and permits a later retry', async () => {
  let attempts = 0;
  const { page, calls, advance } = runtime('pages/user/members.js', { memberApi: {
    showcase: async () => ({ list: rows, total: 3 }),
    interact: async () => { if (++attempts === 1) throw new Error('offline'); return { viewerState: { isHidden: true } }; }
  } });
  await page.load(false);
  for (const value of ['popularity', 'education', 'assets', 'recommend']) await page.switchCategory(category(value));
  await page.hideCurrent();
  advance(1000);
  for (const value of ['popularity', 'education', 'assets', 'recommend']) {
    await page.switchCategory(category(value));
    assert.deepEqual(Array.from(page.data.list, row => row.userId), [11, 12, 13]);
    assert.equal(page.data.currentMember.id, 1);
    assert.equal(page.data.total, 3);
  }
  assert.equal(page.data.hideLoading, false);
  assert.equal(page.data.actionAnimating, false);
  assert.ok(calls.toasts.includes('offline'));
  await page.hideCurrent();
  advance(460);
  assert.equal(attempts, 2);
  assert.deepEqual(Array.from(page.data.list, row => row.userId), [12, 13]);
});

test('detail failures distinguish unavailable profiles from retryable network errors', async () => {
  for (const unavailable of [true, false]) {
    let fail = true;
    const { page } = runtime('pages/user/member-detail.js', { memberApi: {
      showcaseDetail: async () => {
        if (fail) throw Object.assign(new Error(unavailable ? 'member not found' : 'network timeout'), unavailable ? { code: 40400 } : {});
        return { ...rows[0], viewerState: { isFavorite: true, chatAccess: 'allowed' } };
      }
    } });
    page.setData({ id: '1' });
    await page.load();
    assert.equal(page.data.unavailable, unavailable);
    assert.equal(page.data.member, null);
    assert.ok(page.data.loadError);
    fail = false;
    await page.load();
    assert.equal(page.data.chatAccess, 'allowed');
    assert.equal(page.data.loadError, '');
  }
});

test('the recommendation page offers no undo banner or hidden-member recovery controls after hiding', async () => {
  const { page, advance } = runtime('pages/user/members.js', { memberApi: {
    showcase: async () => ({ list: rows, total: 3 }),
    interact: async () => ({ viewerState: { isHidden: true } })
  } });
  await page.load(false);
  await page.hideCurrent();
  advance(460);
  for (const field of ['undoHidden', 'restoringUserId', 'hiddenPanelOpen', 'hiddenMembers']) {
    assert.equal(Object.hasOwn(page.data, field), false, `${field} is no longer a user-facing recovery state`);
  }
  for (const method of ['undoHide', 'restoreHidden', 'restoreHiddenUser', 'openHiddenPanel', 'loadHidden']) {
    assert.equal(typeof page[method], 'undefined', `${method} cannot request a recovery`);
  }
  const template = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'user', 'members.wxml'), 'utf8');
  assert.doesNotMatch(template, /(?:undoHidden|undoHide|restoreHidden|openHiddenPanel|hiddenPanelOpen|恢复推荐|撤销)/);
  assert.match(template, /bindtap="hideCurrent"/, 'the card keeps its permanent hide action');
});

test('detail from an older service keeps unknown permissions and offers a read-only refresh', async () => {
  let reads = 0, writes = 0;
  const { page } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: async () => { reads += 1; return rows[0]; },
    interact: async () => { writes += 1; return {}; }
  } });
  page.setData({ id: '1' });
  await page.load();
  assert.equal(page.data.chatAccess, 'unknown');
  await page.primaryAction();
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test('detail primary action respects server chat state and does not create a chat before permission', async () => {
  for (const chatAccess of ['allowed', 'membership_required', 'unavailable']) {
    let chats = 0, hearts = 0;
    const { page, calls } = runtime('pages/user/member-detail.js', { memberApi: {
      showcaseDetail: async () => ({ ...rows[0], viewerState: { isFavorite: false, chatAccess } }),
      interact: async () => { hearts += 1; return { viewerState: { isFavorite: true } }; }
    }, chatApi: { getOrCreateConversation: async () => { chats += 1; return { id: 90 }; } } });
    page.setData({ id: '1' });
    await page.load();
    await page.primaryAction();
    assert.equal(chats, chatAccess === 'allowed' ? 1 : 0);
    assert.equal(hearts, chatAccess === 'unavailable' ? 1 : 0);
    if (chatAccess === 'membership_required') assert.equal(calls.navigation[0].url, '/pages/user/membership');
  }
});
