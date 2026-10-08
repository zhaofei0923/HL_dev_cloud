const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

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

test('hide undo refreshes every category without losing the current selection or resetting filters', async () => {
  let hidden = false;
  const reads = [], actions = [];
  const { page, advance } = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { reads.push(query.category); const list = rows.filter(row => !hidden || row.userId !== 11); return { list, total: list.length }; },
    interact: async data => { actions.push(data); hidden = data.active; return { viewerState: { isHidden: hidden } }; }
  } });
  await page.load(false);
  await page.switchCategory(category('education'));
  page.nextMember();
  await page.switchCategory(category('recommend'));
  await page.hideCurrent();
  advance(460);
  assert.equal(page.data.currentMember.id, 2);
  assert.equal(page.data.undoHidden.targetUserId, 11);
  await page.undoHide();
  assert.equal(actions.at(-1).active, false);
  assert.equal(page.data.list.length, 3);
  assert.equal(page.data.currentMember.id, 2);
  assert.equal(page.data.undoHidden, null);
  await page.switchCategory(category('education'));
  assert.equal(page.data.list.length, 3);
  assert.equal(page.data.currentMember.id, 2);
  assert.equal(reads.filter(value => value === 'education').length, 2);
});

test('failed restoration keeps its undo action available and an old account result cannot alter a new account', async () => {
  const pending = deferred();
  const { page, session, calls } = runtime('pages/user/members.js', { memberApi: {
    interact: () => pending.promise,
    showcase: async () => ({ list: rows, total: 3 })
  } });
  await page.load(false);
  page.setData({ undoHidden: { targetUserId: 11, displayName: '会员1' } });
  const restoring = page.undoHide();
  await flush();
  session.token = 'new-account';
  session.user.id = 5;
  await page.load(false);
  pending.resolve({ viewerState: { isHidden: false } });
  await restoring;
  assert.equal(page.data.undoHidden, null);
  assert.equal(calls.toasts.length, 0);

  const other = runtime('pages/user/members.js', { memberApi: { interact: async () => { throw new Error('offline'); } } });
  other.page.setData({ undoHidden: { targetUserId: 11, displayName: '会员1' } });
  await other.page.undoHide();
  assert.equal(other.page.data.undoHidden.targetUserId, 11);
  assert.equal(other.page.data.restoringUserId, 0);
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

test('an older server that keeps hide active cannot report restoration success or clear undo', async () => {
  const { page, calls } = runtime('pages/user/members.js', { memberApi: {
    interact: async () => ({ active: true, viewerState: { isHidden: true } })
  } });
  page.setData({ undoHidden: { targetUserId: 11, displayName: '会员1' } });
  await page.undoHide();
  assert.equal(page.data.undoHidden.targetUserId, 11);
  assert.equal(page.data.restoringUserId, 0);
  assert.ok(calls.toasts.includes('恢复未完成，请重试'));
  assert.ok(!calls.toasts.some(value => value.startsWith('已恢复')));
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
