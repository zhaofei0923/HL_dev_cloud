const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function salon(id, title) {
  return { id, title, eventDate: '2026-10-10T03:00:00.000Z', status: 'upcoming' };
}

test('salon tab returns preserve the selected list without another warm request', async () => {
  let allReads = 0;
  let mineReads = 0;
  const { page } = runtime('pages/user/salon.js', { salonApi: {
    list: async () => { allReads += 1; return { list: [salon(1, '精选活动')] }; },
    myRegistrations: async () => { mineReads += 1; return { list: [{ status: 'registered', event: salon(2, '我的活动') }] }; }
  } });
  await page.onShow();
  await page.loadMine();
  await page.onShow();
  assert.equal(page.data.active, 'mine');
  assert.equal(page.data.list[0].id, 2);
  assert.equal(allReads, 1);
  assert.equal(mineReads, 1);
});

test('salon quiet refresh retains rows, deduplicates reads and permits retry after failure', async () => {
  let reads = 0;
  const pending = deferred();
  const { page, advance } = runtime('pages/user/salon.js', { salonApi: {
    list: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ list: [salon(1, '原活动')] });
      if (reads === 2) return pending.promise;
      return Promise.resolve({ list: [salon(2, '更新活动')] });
    }
  } });
  await page.onShow();
  advance(30001);
  const refresh = page.onShow();
  const duplicate = page.onShow();
  await flush();
  assert.equal(page.data.list[0].id, 1);
  assert.equal(page.data.loading, false);
  assert.equal(reads, 2);
  pending.reject(new Error('refresh failed'));
  await Promise.all([refresh, duplicate]);
  assert.equal(page.data.list[0].id, 1);
  await page.onShow();
  assert.equal(reads, 3);
  assert.equal(page.data.list[0].id, 2);
});

test('salon pull refresh and returning from activity detail bypass the warm cache', async () => {
  let reads = 0;
  const { page, calls } = runtime('pages/user/salon.js', { salonApi: {
    list: async () => { reads += 1; return { list: [salon(1, '活动')] }; }
  } });
  await page.onShow();
  await page.onPullDownRefresh();
  assert.equal(reads, 2);
  assert.equal(calls.stopRefresh, 1);
  page.openDetail({ currentTarget: { dataset: { id: 1 } } });
  await page.onShow();
  assert.equal(reads, 3);
});

test('old salon responses cannot replace a new filter or another account list', async () => {
  const old = deferred();
  const mine = deferred();
  const latest = deferred();
  let allReads = 0;
  const { page, session } = runtime('pages/user/salon.js', { salonApi: {
    list: () => ++allReads === 1 ? old.promise : latest.promise,
    myRegistrations: () => mine.promise
  } });
  const first = page.onShow();
  const mineLoad = page.loadMine();
  mine.resolve({ list: [salon(2, '我的活动')] });
  await mineLoad;
  old.resolve({ list: [salon(1, '旧活动')] });
  await first;
  assert.equal(page.data.active, 'mine');
  assert.equal(page.data.list[0].id, 2);
  session.token = 'second-account-session';
  session.user = { id: 2 };
  const switched = page.onShow();
  assert.equal(page.data.list.length, 0);
  assert.equal(page.data.active, 'all');
  latest.resolve({ list: [salon(3, '第二账户活动')] });
  await switched;
  assert.equal(page.data.list[0].id, 3);
});

test('profile tab returns preserve unsaved form edits through warm and quiet refreshes', async () => {
  let reads = 0;
  let dashboardReads = 0;
  let referralReads = 0;
  const pending = deferred();
  const { page, advance } = runtime('pages/user/profile.js', {
    request: () => {
      reads += 1;
      return reads === 1 ? Promise.resolve({ profile: { realName: '已保存资料', city: '上海' } }) : pending.promise;
    },
    matchmakerApi: { dashboard: async () => { dashboardReads += 1; return { matchmaker: null }; } },
    memberApi: { referralCard: async () => { referralReads += 1; return { canShare: false }; } }
  });
  await page.onShow();
  await flush();
  page.toggleProfileEditor();
  page.updateForm('realName', '尚未保存的修改');
  page.toggleProfileEditor();
  await page.onShow();
  assert.equal(reads, 1);
  assert.equal(dashboardReads, 0, 'a folded matchmaker panel must not read the full dashboard');
  assert.equal(referralReads, 0, 'referral reads wait until the panel opens');
  assert.equal(page.data.form.realName, '尚未保存的修改');
  advance(30001);
  const refresh = page.onShow();
  await flush();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.form.realName, '尚未保存的修改');
  pending.resolve({ profile: { realName: '服务器更新的名字', city: '杭州' } });
  await refresh;
  await flush();
  assert.equal(page.data.form.realName, '尚未保存的修改');
});

test('profile quiet refresh failure retains the form and the next show retries', async () => {
  let reads = 0;
  const { page, advance } = runtime('pages/user/profile.js', { request: async () => {
    reads += 1;
    if (reads === 2) throw new Error('profile refresh failed');
    return { profile: { realName: reads === 1 ? '初始资料' : '新资料', city: '上海' } };
  } });
  await page.onShow();
  advance(30001);
  await page.onShow();
  assert.equal(page.data.form.realName, '初始资料');
  assert.equal(page.data.loading, false);
  await page.onShow();
  assert.equal(reads, 3);
  assert.equal(page.data.form.realName, '新资料');
});

test('profile account changes clear old form data and ignore the previous account response', async () => {
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const { page, session, advance } = runtime('pages/user/profile.js', { request: () => {
    reads += 1;
    if (reads === 1) return Promise.resolve({ profile: { realName: '第一账户隐私' } });
    return reads === 2 ? old.promise : latest.promise;
  } });
  await page.onShow();
  advance(30001);
  const oldRefresh = page.onShow();
  await flush();
  session.token = 'second-account-session';
  session.user = { id: 2, nickname: '第二账户' };
  const switched = page.onShow();
  assert.ok(!JSON.stringify(page.data.form).includes('第一账户'));
  latest.resolve({ profile: { realName: '第二账户资料' } });
  await switched;
  old.resolve({ profile: { realName: '第一账户过期响应' } });
  await oldRefresh;
  await flush();
  assert.equal(page.data.form.realName, '第二账户资料');
  assert.equal(page.data.user.id, 2);
});

test('an old profile save cannot update storage or current user after switching accounts', async () => {
  const oldSave = deferred();
  const { page, session, calls } = runtime('pages/user/profile.js', { request: (_path, options) => {
    if (options && options.method === 'PUT') return oldSave.promise;
    return Promise.resolve({ profile: { realName: session.user.id === 2 ? '第二账户资料' : '第一账户资料' } });
  } });
  await page.onShow();
  page.updateForm('realName', '第一账户待保存');
  const saving = page.save();
  await flush();
  session.token = 'second-account-session';
  session.user = { id: 2, nickname: '第二账户' };
  await page.onShow();
  oldSave.resolve({ user: { id: 1, nickname: '旧保存用户' }, profile: { realName: '旧保存返回' } });
  await saving;
  await flush();
  assert.equal(session.user.id, 2);
  assert.equal(page.data.user.id, 2);
  assert.equal(page.data.form.realName, '第二账户资料');
  assert.ok(calls.storage.every(entry => entry.key !== 'user' || entry.value.id !== 1));
});

test('returning from salon detail starts a fresh read even with an older refresh pending', async () => {
  let reads = 0;
  const old = deferred();
  const { page, advance } = runtime('pages/user/salon.js', { salonApi: {
    list: () => {
      reads += 1;
      if (reads === 2) return old.promise;
      return Promise.resolve({ list: [salon(reads === 1 ? 1 : 3, reads === 1 ? '初始活动' : '报名后活动')] });
    }
  } });
  await page.onShow();
  advance(30001);
  const background = page.onShow();
  await flush();
  assert.equal(reads, 2);
  page.openDetail({ currentTarget: { dataset: { id: 1 } } });
  const returned = page.onShow();
  await flush();
  assert.equal(reads, 3);
  old.resolve({ list: [salon(2, '过期后台响应')] });
  await Promise.all([background, returned]);
  assert.equal(page.data.list[0].id, 3);
});

test('returning from membership starts a fresh profile read and discards an older refresh', async () => {
  let reads = 0;
  const old = deferred();
  const { page, advance } = runtime('pages/user/profile.js', { request: () => {
    reads += 1;
    if (reads === 2) return old.promise;
    return Promise.resolve({ profile: { realName: reads === 1 ? '初始资料' : '会员页返回后资料' } });
  } });
  await page.onShow();
  advance(30001);
  const background = page.onShow();
  await flush();
  assert.equal(reads, 2);
  page.goMembership();
  const returned = page.onShow();
  await flush();
  assert.equal(reads, 3);
  old.resolve({ profile: { realName: '过期后台响应' } });
  await Promise.all([background, returned]);
  assert.equal(page.data.form.realName, '会员页返回后资料');
});

test('salon request functions that throw synchronously can be retried', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/salon.js', { salonApi: {
    list: () => {
      if (++reads === 1) throw new Error('synchronous salon failure');
      return Promise.resolve({ list: [salon(2, '恢复活动')] });
    }
  } });
  await page.onShow();
  await page.onShow();
  assert.equal(reads, 2);
  assert.equal(page.data.list[0].id, 2);
  assert.equal(page.data.loading, false);
});

test('profile request functions that throw synchronously can be retried', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/profile.js', { request: () => {
    if (++reads === 1) throw new Error('synchronous profile failure');
    return Promise.resolve({ profile: { realName: '恢复资料' } });
  } });
  await page.onShow();
  await page.onShow();
  assert.equal(reads, 2);
  assert.equal(page.data.form.realName, '恢复资料');
  assert.equal(page.data.loading, false);
});
