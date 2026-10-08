const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const gate = { matchmaker: { id: 101, userId: 1, certificationStatus: 2 } };
function member(id) {
  return { id, userId: id + 1000, realName: `会员${id}`, city: '上海', age: 30, gender: 2 };
}
function pageOf(rows, query) {
  return { list: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    total: rows.length, page: query.page, pageSize: query.pageSize };
}
async function show(instance) {
  if (instance.page.onLoad) instance.page.onLoad({});
  await instance.page.onShow();
  await flush();
}
function event(id) { return { currentTarget: { dataset: { id } } }; }

test('recommendations wait for member 51 and loop only after the final batch', async () => {
  const rows = Array.from({ length: 105 }, (_, index) => member(index + 1));
  const second = deferred();
  const queries = [];
  const instance = runtime('pages/user/members.js', { memberApi: { showcase: query => {
    queries.push(query.page);
    return query.page === 2 ? second.promise : Promise.resolve(pageOf(rows, query));
  } } });
  await show(instance);
  for (let index = 0; index < 50; index += 1) instance.page.nextMember();
  await flush();
  assert.equal(instance.page.data.currentMember.id, 50);
  assert.equal(instance.page.data.loading, false, 'a pending page keeps the current card interactive');
  assert.equal(instance.page.data.loadingMore, true);
  const more = instance.page._showcaseMorePromise;
  second.resolve(pageOf(rows, { page: 2, pageSize: 50 }));
  await more;
  assert.equal(instance.page.data.currentMember.id, 51);
  assert.equal(instance.page.data.list.length, 100);
  for (let index = 0; index < 50; index += 1) instance.page.nextMember();
  await flush();
  if (instance.page._showcaseMorePromise) await instance.page._showcaseMorePromise;
  assert.equal(instance.page.data.list.length, 105);
  assert.equal(instance.page.data.hasMore, false);
  while (instance.page.data.currentMember.id !== 105) instance.page.nextMember();
  instance.page.nextMember();
  assert.equal(instance.page.data.currentMember.id, 1);
  assert.deepEqual(queries, [1, 2, 3]);
});

test('a warm return preserves an already running recommendation append', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => member(index + 1));
  const pending = deferred();
  let reads = 0;
  const instance = runtime('pages/user/members.js', { memberApi: { showcase: query => {
    reads += 1;
    return query.page === 2 ? pending.promise : Promise.resolve(pageOf(rows, query));
  } } });
  await show(instance);
  const append = instance.page.loadMoreShowcase();
  await flush();
  await instance.page.onShow();
  assert.equal(instance.page.data.loadingMore, true);
  pending.resolve(pageOf(rows, { page: 2, pageSize: 50 }));
  await append;
  assert.equal(instance.page.data.list.length, 60);
  assert.equal(instance.page.data.loadingMore, false);
  assert.equal(reads, 2);
});

test('a new leading member cannot trap deduplicated recommendation pages on the same offset', async () => {
  const rows = Array.from({ length: 155 }, (_, index) => member(index + 1));
  const pages = [];
  const { page } = runtime('pages/user/members.js', { memberApi: { showcase: async query => {
    pages.push(query.page);
    return pageOf(rows, query);
  } } });
  await page.load(false);
  rows.unshift(member(999));
  await page.loadMoreShowcase();
  await page.loadMoreShowcase();
  assert.deepEqual(pages, [1, 2, 3, 4]);
  assert.deepEqual(Array.from(page.data.list, row => row.id), Array.from({ length: 155 }, (_, index) => index + 1));
  assert.equal(page.data.currentMember.id, 1);
  assert.equal(page.data.hasMore, false);
  await page.loadMoreShowcase();
  assert.deepEqual(pages, [1, 2, 3, 4], 'the actual final page terminates even if the new first member has not been seen');
});

test('an entirely duplicated ranking page advances and its terminal cursor survives a category switch', async () => {
  let rows = Array.from({ length: 150 }, (_, index) => member(index + 1));
  const pages = [];
  const { page } = runtime('pages/user/members.js', { memberApi: { showcase: async query => {
    if (query.category !== 'popularity') return { list: [member(200)], total: 1 };
    pages.push(query.page);
    return pageOf(rows, query);
  } } });
  await page.switchCategory({ currentTarget: { dataset: { category: 'popularity' } } });
  rows = [...rows.slice(50, 100), ...rows.slice(0, 50), ...rows.slice(100)];
  await page.loadMoreShowcase();
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(page.data.list.length, 100);
  assert.equal(page.data.list.at(-1).id, 150);
  assert.equal(page.data.hasMore, false);
  page.setData({ currentIndex: 75, currentMember: page.data.list[75] });
  page.rememberSelection();
  await page.switchCategory({ currentTarget: { dataset: { category: 'recommend' } } });
  await page.switchCategory({ currentTarget: { dataset: { category: 'popularity' } } });
  assert.equal(page.data.currentMember.id, 126);
  assert.equal(page.data.showcasePage, 3);
  assert.equal(page.data.hasMore, false);
  await page.loadMoreShowcase();
  assert.deepEqual(pages, [1, 2, 3]);
});

test('a forced recommendation reload supersedes an older same-query request', async () => {
  const old = deferred();
  let reads = 0;
  const instance = runtime('pages/user/members.js', { memberApi: { showcase: () => {
    reads += 1;
    return reads === 1 ? old.promise : Promise.resolve({ list: [member(801)], total: 1 });
  } } });
  const initial = instance.page.onShow();
  await flush();
  const forced = instance.page.load(true);
  await flush();
  assert.equal(reads, 2);
  await forced;
  old.resolve({ list: [member(1)], total: 1 });
  await initial;
  assert.equal(instance.page.data.currentMember.id, 801);
  await instance.page.onShow();
  assert.equal(instance.page.data.currentMember.id, 801);
});

test('hiding shifts an offset page without losing member 51 or reviving the hidden person', async () => {
  const rows = Array.from({ length: 55 }, (_, index) => member(index + 1));
  const pages = [];
  const instance = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { pages.push(query.page); return pageOf(rows, query); },
    interact: async payload => { rows.splice(rows.findIndex(row => row.userId === payload.targetUserId), 1); return {}; }
  } });
  await show(instance);
  const loadedAt = instance.page._showcaseLoadedAt;
  await instance.page.hideCurrent();
  instance.advance(460);
  await instance.page.loadMoreShowcase();
  assert.deepEqual(Array.from(instance.page.data.list, row => row.id), Array.from({ length: 54 }, (_, index) => index + 2));
  assert.equal(instance.page.data.hasMore, false);
  assert.equal(instance.page._showcaseLoadedAt, loadedAt, 'appending does not extend older profiles freshness');
  assert.deepEqual(pages, [1, 1, 2]);
  const reads = pages.length;
  await instance.page.onShow();
  assert.equal(pages.length, reads);
  assert.equal(instance.page.data.list.some(row => row.id === 1), false);
});

test('several hides refill the server boundary after earlier pages overlapped', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => member(index + 1));
  const pages = [];
  const instance = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => { pages.push(query.page); return pageOf(rows, query); },
    interact: async payload => { rows.splice(rows.findIndex(row => row.userId === payload.targetUserId), 1); return {}; }
  } });
  await instance.page.load(false);
  rows.unshift(member(999));
  await instance.page.loadMoreShowcase();
  assert.equal(instance.page.data.showcasePage, 3);
  assert.equal(instance.page.data.list.length, 149);
  for (let index = 0; index < 2; index += 1) {
    await instance.page.hideCurrent();
    instance.advance(460);
  }
  await instance.page.loadMoreShowcase();
  await instance.page.loadMoreShowcase();
  assert.deepEqual(pages, [1, 2, 3, 3, 4, 5]);
  assert.deepEqual(Array.from(instance.page.data.list, row => row.id), Array.from({ length: 203 }, (_, index) => index + 3));
  assert.equal(instance.page.data.hasMore, false);
  assert.equal(instance.page.data.currentMember.id, 3);
});

test('failed recommendation append retains the last card and retries; growth and shrink use server totals', async () => {
  let rows = Array.from({ length: 51 }, (_, index) => member(index + 1));
  let failed = false;
  const instance = runtime('pages/user/members.js', { memberApi: { showcase: async query => {
    if (query.page === 2 && !failed) { failed = true; throw new Error('temporary page failure'); }
    return pageOf(rows, query);
  } } });
  await show(instance);
  for (let index = 0; index < 50; index += 1) instance.page.nextMember();
  await flush();
  assert.equal(instance.page.data.currentMember.id, 50);
  assert.ok(instance.page.data.paginationError);
  rows.push(...Array.from({ length: 9 }, (_, index) => member(index + 52)));
  await instance.page.loadMoreShowcase();
  assert.equal(instance.page.data.currentMember.id, 51);
  assert.equal(instance.page.data.list.length, 60);
  assert.equal(instance.page.data.total, 60);
  rows = rows.slice(0, 40);
  await instance.page.load(false, true);
  assert.equal(instance.page.data.list.length, 40);
  assert.equal(instance.page.data.total, 40);
  assert.equal(instance.page.data.hasMore, false);
});

test('a smaller server total during append refreshes the first batch quietly', async () => {
  let rows = Array.from({ length: 60 }, (_, index) => member(index + 1));
  const queries = [];
  const instance = runtime('pages/user/members.js', { memberApi: { showcase: async query => {
    queries.push(query.page);
    return pageOf(rows, query);
  } } });
  await show(instance);
  rows = rows.slice(0, 40);
  await instance.page.loadMoreShowcase();
  assert.deepEqual(queries, [1, 2, 1]);
  assert.equal(instance.page.data.list.length, 40);
  assert.equal(instance.page.data.total, 40);
  assert.equal(instance.page.data.loading, false);
  assert.equal(instance.page.data.loadingMore, false);
  assert.equal(instance.page.data.hasMore, false);
});

test('owned-member pagination survives a warm reconstruction and force returns to page one', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => member(index + 1));
  const pages = [];
  const instance = runtime('pages/matchmaker/members.js', {
    matchmakerApi: { dashboard: async () => gate },
    memberApi: { list: async query => { pages.push(query.page); return pageOf(rows, query); } }
  });
  instance.session.user.currentRole = 'matchmaker';
  await show(instance);
  await instance.page.onReachBottom();
  assert.equal(instance.page.data.list.length, 60);
  assert.equal(instance.page.data.page, 2);
  assert.equal(instance.page.data.hasMore, false);
  instance.page.onUnload();
  const rebuilt = instance.recreatePage('pages/matchmaker/members.js');
  rebuilt.onLoad({});
  await rebuilt.onShow();
  assert.equal(rebuilt.data.page, 2);
  assert.equal(rebuilt.data.list.length, 60);
  assert.deepEqual(pages, [1, 2]);
  await rebuilt.load(true);
  assert.equal(rebuilt.data.page, 1);
  assert.equal(rebuilt.data.list.length, 50);
  assert.equal(rebuilt.data.hasMore, true);
});

test('an old owned-member append cannot cross a newer filter or account', async () => {
  for (const change of ['filter', 'account']) {
    const rows = Array.from({ length: 60 }, (_, index) => member(index + 1));
    const pending = deferred();
    const instance = runtime('pages/matchmaker/members.js', {
      matchmakerApi: { dashboard: async () => gate },
      memberApi: { list: query => query.page === 2 ? pending.promise
        : Promise.resolve(query.keyword === '新筛选' || instance.session.user.id === 2
          ? { list: [member(801)], total: 1, page: 1 } : pageOf(rows, query)) }
    });
    instance.session.user.currentRole = 'matchmaker';
    await show(instance);
    const older = instance.page.loadMore();
    await flush();
    if (change === 'filter') instance.page.onKeyword({ detail: { value: '新筛选' } });
    else { instance.session.token = 'new-account'; instance.session.user.id = 2; }
    await instance.page.load(true);
    pending.resolve(pageOf(rows, { page: 2, pageSize: 50 }));
    await older;
    assert.deepEqual(Array.from(instance.page.data.list, row => row.id), [801]);
    assert.equal(instance.page.data.loadingMore, false);
  }
});

test('salon activities render independently and only an opened mine-management panel reads invite options', async () => {
  const options = deferred();
  let fullMemberReads = 0;
  let optionReads = 0;
  const activity = { id: 301, title: '活动', status: 'upcoming' };
  const instance = runtime('pages/matchmaker/salon.js', {
    matchmakerApi: { dashboard: async () => gate },
    memberApi: {
      list: async () => { fullMemberReads += 1; return { list: [] }; },
      inviteOptions: () => { optionReads += 1; return options.promise; }
    },
    salonApi: { myEvents: async () => ({ list: [activity] }), list: async () => ({ list: [activity] }) }
  });
  instance.session.user.currentRole = 'matchmaker';
  await show(instance);
  await instance.page.loadAll();
  assert.equal(instance.page.data.list.length, 1);
  assert.equal(optionReads, 0);
  assert.equal(fullMemberReads, 0);
  await instance.page.loadMine();
  const opening = instance.page.toggleEventManagement(event(301));
  await flush();
  assert.equal(optionReads, 1);
  assert.equal(instance.page.data.loading, false);
  assert.equal(instance.page.data.loadingMembers, true);
  assert.equal(instance.page.data.list.length, 1);
  options.resolve({ list: [{ id: 501, userId: 601, realName: '会员', nickname: '' }], total: 1, page: 1, pageSize: 100 });
  await opening;
  await instance.page.toggleEventManagement(event(301));
  await instance.page.toggleEventManagement(event(301));
  assert.equal(optionReads, 1);
  assert.equal(instance.page.data.selectedMemberName, '会员');
});

test('invite option permission denial clears already loaded private management data', async () => {
  let optionReads = 0;
  const instance = runtime('pages/matchmaker/salon.js', {
    matchmakerApi: { dashboard: async () => gate },
    memberApi: { inviteOptions: async () => {
      optionReads += 1;
      if (optionReads === 2) throw Object.assign(new Error('permission denied'), { code: 40301 });
      return { list: [{ id: 501, userId: 601, realName: 'PRIVATE_MEMBER', nickname: '' }], total: 1, page: 1, pageSize: 100 };
    } },
    salonApi: { myEvents: async () => ({ list: [{ id: 301, title: 'PRIVATE_EVENT', status: 'upcoming' }] }) }
  });
  instance.session.user.currentRole = 'matchmaker';
  await show(instance);
  await instance.page.toggleEventManagement(event(301));
  assert.equal(instance.page.data.members.length, 1);
  await instance.page.loadInviteMembers(true);
  assert.equal(instance.page.data.canOperate, false);
  assert.equal(instance.page.data.list.length, 0);
  assert.equal(instance.page.data.members.length, 0);
  assert.equal(instance.page.data.memberOptions.length, 0);
});

test('a repeated invite option page stops without a request loop', async () => {
  let reads = 0;
  const instance = runtime('pages/matchmaker/salon.js', {
    matchmakerApi: { dashboard: async () => gate },
    memberApi: { inviteOptions: async () => {
      reads += 1;
      if (reads > 2) throw new Error('duplicate pagination must stop');
      return { list: [{ id: 501, userId: 601, realName: '会员', nickname: '' }], total: 200, page: reads, pageSize: 100 };
    } },
    salonApi: { myEvents: async () => ({ list: [{ id: 301, title: '活动', status: 'upcoming' }] }) }
  });
  instance.session.user.currentRole = 'matchmaker';
  await show(instance);
  await instance.page.toggleEventManagement(event(301));
  assert.equal(reads, 2);
  assert.equal(instance.page.data.members.length, 1);
  assert.equal(instance.page.data.loadingMembers, false);
});

test('folded profiles read no auxiliary data and open panels use lightweight status without applying', async () => {
  const reads = { status: 0, dashboard: 0, referral: 0, apply: 0 };
  const instance = runtime('pages/user/profile.js', {
    matchmakerApi: {
      status: async () => { reads.status += 1; return gate; },
      dashboard: async () => { reads.dashboard += 1; return gate; },
      apply: async () => { reads.apply += 1; return {}; }
    },
    memberApi: { referralCard: async () => { reads.referral += 1; return { canShare: true }; } }
  });
  await show(instance);
  assert.equal(instance.calls.requests.length, 1);
  assert.deepEqual(reads, { status: 0, dashboard: 0, referral: 0, apply: 0 });
  await instance.page.toggleMatchmakerPanel();
  assert.equal(instance.page.data.matchmakerApproved, true);
  assert.deepEqual(reads, { status: 1, dashboard: 0, referral: 1, apply: 0 });
  await instance.page.toggleMatchmakerPanel();
  await instance.page.toggleMatchmakerPanel();
  assert.equal(reads.status, 1);
  instance.advance(30001);
  await instance.page.loadMatchmakerPanel();
  assert.equal(reads.status, 2);
  assert.equal(reads.dashboard, 0);
  assert.equal(reads.apply, 0);
});

test('old profile auxiliary responses cannot populate a changed account', async () => {
  const status = deferred();
  const referral = deferred();
  const instance = runtime('pages/user/profile.js', {
    matchmakerApi: { status: () => status.promise },
    memberApi: { referralCard: () => referral.promise }
  });
  await show(instance);
  const opening = instance.page.toggleMatchmakerPanel();
  instance.session.token = 'different-account';
  instance.session.user.id = 2;
  await instance.page.onShow();
  status.resolve(gate);
  referral.resolve({ canShare: true, matchmaker: { nickname: 'OLD_PRIVATE_NAME' } });
  await opening;
  assert.equal(instance.page.data.matchmakerApproved, false);
  assert.equal(instance.page.data.referralCard.canShare, false);
  assert.equal(JSON.stringify(instance.page.data).includes('OLD_PRIVATE_NAME'), false);
});
