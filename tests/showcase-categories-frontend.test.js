const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const categories = ['recommend', 'popularity', 'education', 'assets'];
const event = category => ({ currentTarget: { dataset: { category } } });
const member = (id, extra = {}) => ({ id, userId: id + 1000, realName: `会员${id}`,
  city: '上海', age: 30, education: '本科', ...extra });
const ids = page => Array.from(page.data.list, row => row.id);

function categoryRuntime(rows, overrides = {}) {
  const reads = [];
  const context = runtime('pages/user/members.js', { memberApi: {
    showcase: async query => {
      reads.push(structuredClone(query));
      if (overrides.showcase) return overrides.showcase(query);
      const list = rows[query.category || 'recommend'] || [];
      const offset = (query.page - 1) * query.pageSize;
      return { list: list.slice(offset, offset + query.pageSize), total: list.length };
    },
    ...overrides.memberApi
  } });
  return { ...context, reads };
}

test('the four categories retain independent cards and cached pages in the same screen', async () => {
  const rows = Object.fromEntries(categories.map((category, index) => [category,
    [member(index * 10 + 1), member(index * 10 + 2), member(index * 10 + 3), member(index * 10 + 4)]]));
  const { page, reads } = categoryRuntime(rows);
  await page.load(false);
  page.nextMember();
  for (const category of categories.slice(1)) {
    await page.switchCategory(event(category));
    assert.equal(page.data.currentMember.id, rows[category][0].id);
    page.nextMember();
    page.nextMember();
  }
  await page.switchCategory(event('recommend'));
  assert.equal(page.data.currentMember.id, 2);
  for (const category of categories.slice(1)) {
    await page.switchCategory(event(category));
    assert.equal(page.data.currentMember.id, rows[category][2].id);
    assert.equal(page.data.currentIndex, 2);
  }
  assert.equal(reads.length, 4);
  assert.deepEqual(Array.from(page.data.categories, item => item.label), ['推荐', '颜值', '学历', '资产']);
});

test('switching retains the accumulated list, page number and selection beyond the first page', async () => {
  const rows = { recommend: Array.from({ length: 75 }, (_, index) => member(index + 1)), education: [member(200)] };
  const { page, reads } = categoryRuntime(rows);
  await page.load(false);
  await page.loadMoreShowcase();
  assert.equal(page.data.list.length, 75);
  assert.equal(page.data.showcasePage, 2);
  page.setData({ currentIndex: 55, currentMember: page.data.list[55] });
  page.rememberSelection();
  await page.switchCategory(event('education'));
  await page.switchCategory(event('recommend'));
  assert.equal(page.data.currentMember.id, 56);
  assert.equal(page.data.currentIndex, 55);
  assert.equal(page.data.list.length, 75);
  assert.equal(page.data.showcasePage, 2);
  assert.equal(reads.length, 3);
});

test('city, gender and keyword are shared while every category cache remains tied to the applied filters', async () => {
  const rows = Object.fromEntries(categories.map(category => [category, [member(1), member(2)]]));
  const { page, reads } = categoryRuntime(rows);
  await page.load(false);
  page.onKeyword({ detail: { value: '工程师' } });
  page.onCity({ detail: { value: '杭州' } });
  page.setGender({ currentTarget: { dataset: { gender: '2' } } });
  await page.search();
  for (const category of categories.slice(1)) await page.switchCategory(event(category));
  const filteredReads = reads.slice(1);
  assert.equal(filteredReads.length, 4);
  for (const query of filteredReads) {
    assert.equal(query.keyword, '工程师');
    assert.equal(query.city, '杭州');
    assert.equal(query.gender, '2');
  }
  await page.switchCategory(event('recommend'));
  assert.equal(reads.length, 5);
  await page.clearKeyword();
  await page.switchCategory(event('education'));
  assert.deepEqual(reads.at(-1), { page: 1, pageSize: 50, keyword: '', city: '', gender: '', category: 'education' });
});

test('late category responses cannot replace cards or clear another category progress', async () => {
  for (const oldFails of [false, true]) {
    const first = deferred();
    const latest = deferred();
    const { page, reads } = categoryRuntime({}, { showcase: query => query.category === 'recommend' ? first.promise : latest.promise });
    const oldLoad = page.load(false);
    await flush();
    const newLoad = page.switchCategory(event('education'));
    await flush();
    assert.equal(reads.length, 2);
    if (oldFails) first.reject(new Error('expired category request'));
    else first.resolve({ list: [member(1)], total: 1 });
    await oldLoad;
    assert.equal(page.data.category, 'education');
    assert.equal(page.data.loading, true);
    assert.equal(page.data.currentMember, null);
    latest.resolve({ list: [member(2)], total: 1 });
    await newLoad;
    assert.equal(page.data.currentMember.id, 2);
    assert.equal(page.data.loading, false);
  }
});

test('a late appended page cannot cross a category switch or enter its restored cache', async () => {
  const second = deferred();
  const rows = Array.from({ length: 60 }, (_, index) => member(index + 1));
  const { page, reads } = categoryRuntime({}, { showcase: query => {
    if (query.category === 'education') return { list: [member(200)], total: 1 };
    return query.page === 2 ? second.promise : { list: rows.slice(0, 50), total: 60 };
  } });
  await page.load(false);
  const append = page.loadMoreShowcase();
  await flush();
  assert.equal(page.data.loadingMore, true);
  await page.switchCategory(event('education'));
  second.resolve({ list: rows.slice(50), total: 60 });
  await append;
  assert.deepEqual(ids(page), [200]);
  assert.equal(page.data.loadingMore, false);
  await page.switchCategory(event('recommend'));
  assert.equal(page.data.list.length, 50);
  assert.equal(page.data.showcasePage, 1);
  assert.equal(reads.length, 3);
  await page.loadMoreShowcase();
  assert.equal(page.data.list.length, 60);
  assert.equal(reads.length, 4);
});

test('hiding removes a member from all loaded categories while retaining the other selected members', async () => {
  const rows = Object.fromEntries(categories.map(category => [category, [member(11), member(12), member(13), member(14)]]));
  const { page, reads, advance } = categoryRuntime(rows);
  await page.load(false);
  await page.switchCategory(event('popularity'));
  page.nextMember(); page.nextMember(); page.nextMember();
  await page.switchCategory(event('education'));
  page.nextMember(); page.nextMember();
  await page.switchCategory(event('assets'));
  page.nextMember();
  await page.hideCurrent();
  advance(460);
  assert.deepEqual(ids(page), [11, 13, 14]);
  assert.equal(page.data.currentMember.id, 13);
  for (const [category, selected, position] of [['recommend', 11, 0], ['popularity', 14, 2], ['education', 13, 1]]) {
    await page.switchCategory(event(category));
    assert.deepEqual(ids(page), [11, 13, 14]);
    assert.equal(page.data.currentMember.id, selected);
    assert.equal(page.data.currentIndex, position);
    assert.equal(page.data.total, 3);
  }
  assert.equal(reads.length, 4);
});

test('sending and retracting a heart synchronizes all cached categories without losing their cards', async () => {
  const rows = Object.fromEntries(categories.map(category => [category, [member(1), member(2)]]));
  const { page, reads, advance } = categoryRuntime(rows, { memberApi: {
    interact: async payload => {
      for (const list of Object.values(rows)) {
        const target = list.find(row => row.userId === payload.targetUserId);
        if (target) target.viewerState = { isFavorite: payload.active, isHidden: false };
      }
      return { viewerState: { isFavorite: payload.active } };
    }
  } });
  await page.load(false);
  for (const category of categories.slice(1)) await page.switchCategory(event(category));
  await page.toggleFavorite();
  advance(460);
  for (const category of categories) {
    await page.switchCategory(event(category));
    assert.equal(page.data.currentMember.isFavorite, true);
    assert.equal(page.data.currentMember.id, 1);
  }
  await page.toggleFavorite();
  advance(460);
  for (const category of categories) {
    await page.switchCategory(event(category));
    assert.equal(page.data.currentMember.isFavorite, false);
  }
  assert.equal(reads.length, 6);
});

test('retracting the 101st unique heart refreshes popularity qualification on this category and on the next switch', async () => {
  for (const activeCategory of ['recommend', 'popularity']) {
    let heartCount = 101;
    let favorite = true;
    const row = () => member(1, { viewerState: { isFavorite: favorite, isHidden: false } });
    const { page, reads } = categoryRuntime({}, {
      showcase: query => ({ list: query.category === 'popularity' && heartCount <= 100 ? [] : [row()],
        total: query.category === 'popularity' && heartCount <= 100 ? 0 : 1 }),
      memberApi: { interact: async payload => {
        favorite = payload.active;
        heartCount = favorite ? 101 : 100;
        return { viewerState: { isFavorite: favorite } };
      } }
    });
    await page.load(false);
    await page.switchCategory(event('popularity'));
    if (activeCategory === 'recommend') await page.switchCategory(event('recommend'));
    await page.toggleFavorite();
    assert.equal(heartCount, 100);
    if (activeCategory === 'recommend') await page.switchCategory(event('popularity'));
    else {
      await flush();
      if (page._showcaseLoadPromise) await page._showcaseLoadPromise;
    }
    assert.equal(page.data.category, 'popularity');
    assert.equal(page.data.currentMember, null);
    assert.equal(page.data.total, 0);
    assert.match(page.data.emptyNote, /门槛保持不变/);
    assert.deepEqual(reads.map(query => query.category), ['recommend', 'popularity', 'popularity']);
  }
});

test('a qualification refresh retains popularity pages and restores a selected member after reordered exclusions', async () => {
  let includeFirst = true;
  const rows = Array.from({ length: 75 }, (_, index) => member(index + 1,
    { viewerState: { isFavorite: index === 0, isHidden: false } }));
  const { page, reads } = categoryRuntime({}, {
    showcase: query => {
      const list = query.category === 'popularity' ? rows.filter(row => includeFirst || row.id !== 1) : [rows[0]];
      return { list: list.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: list.length };
    },
    memberApi: { interact: async payload => {
      includeFirst = payload.active;
      rows[0].viewerState.isFavorite = payload.active;
      return { viewerState: { isFavorite: payload.active } };
    } }
  });
  await page.load(false);
  await page.switchCategory(event('popularity'));
  await page.loadMoreShowcase();
  page.setData({ currentIndex: 55, currentMember: page.data.list[55] });
  page.rememberSelection();
  await page.switchCategory(event('recommend'));
  await page.toggleFavorite();
  await page.switchCategory(event('popularity'));
  assert.equal(page.data.currentMember.id, 56);
  assert.equal(page.data.currentIndex, 54);
  assert.equal(page.data.list.length, 74);
  assert.equal(page.data.total, 74);
  assert.equal(page.data.showcasePage, 2);
  assert.equal(reads.length, 5);
});

test('reviewed booleans control credential badges and only an approved public asset range is displayed', async () => {
  const rows = { recommend: [
    member(1, { education: '博士', isVerified: 1, educationVerified: false, assetVerified: false, financialAssetRange: 'over_10m' }),
    member(2, { education: '高中', educationVerified: true, verifiedEducation: '硕士', assetVerified: true, financialAssetRange: '2m_5m' }),
    member(3, { educationVerified: 1, assetVerified: 1, financialAssetRange: 'over_10m' }),
    member(4, { educationVerified: true, assetVerified: true }),
    member(5, { educationVerified: true, assetVerified: true, financialAssetRange: 'unknown_range' })
  ] };
  const { page } = categoryRuntime(rows);
  await page.load(false);
  assert.equal(page.data.currentMember.certificationBadges.length, 0);
  assert.equal(page.data.currentMember.financialAssetText, '');
  page.nextMember();
  const badges = page.data.currentMember.certificationBadges;
  assert.equal(badges.find(badge => badge.label === '学历认证').statusText, '已认证');
  assert.equal(badges.find(badge => badge.label === '资产认证').statusText, '已认证');
  assert.equal(badges.length, 2);
  assert.match(page.data.currentMember.profileLine, /硕士/);
  assert.match(page.data.currentMember.financialAssetText, /200.*500/);
  page.nextMember();
  assert.equal(page.data.currentMember.certificationBadges.length, 0);
  assert.equal(page.data.currentMember.financialAssetText, '');
  page.nextMember();
  assert.equal(page.data.currentMember.financialAssetText, '');
  page.nextMember();
  assert.equal(page.data.currentMember.financialAssetText, '');
});

test('reviewed education is identical on cards, detail headers and career fields', async () => {
  for (const [educationVerified, verifiedEducation, expected, certified] of [
    [true, '本科', '本科', true],
    [false, '本科', '博士', false],
    [1, '本科', '博士', false],
    ['true', '本科', '博士', false]
  ]) {
    const row = member(1, { education: '博士', educationVerified, verifiedEducation });
    const cards = categoryRuntime({ recommend: [row] });
    await cards.page.load(false);
    const detail = runtime('pages/user/member-detail.js', { memberApi: { showcaseDetail: async () => row } });
    detail.page.setData({ id: '1' });
    await detail.page.load();
    const card = cards.page.data.currentMember;
    const profile = detail.page.data.member;
    assert.equal(profile.education, expected);
    assert.equal(card.education, expected);
    assert.match(card.profileLine, new RegExp(expected));
    assert.match(profile.workText, new RegExp(expected));
    assert.equal(profile.careerRows.find(item => item.label === '学历').value, expected);
    assert.equal(profile.highlightTags.includes(expected), true);
    assert.equal(card.certificationBadges.some(item => item.label === '学历认证'), certified);
    assert.equal(detail.page.data.certificationRows.some(item => item.label === '学历核验'), certified);
    if (certified) {
      assert.equal(detail.page.data.certificationRows.find(item => item.label === '学历核验').value, '本科 · 学历已认证');
      assert.doesNotMatch(profile.workText, /博士/);
    }
  }
});

test('empty category messaging keeps its qualification and never falls back to normal recommendation', async () => {
  const { page, reads } = categoryRuntime({ recommend: [member(1)] });
  await page.load(false);
  for (const category of categories.slice(1)) {
    await page.switchCategory(event(category));
    assert.equal(page.data.currentMember, null);
    assert.equal(page.data.total, 0);
    assert.match(page.data.emptyTitle, /暂无符合条件/);
    assert.match(page.data.emptyNote, /门槛保持不变/);
    assert.ok(page.data.categoryDescription.length > 0);
  }
  await page.switchCategory(event('education'));
  assert.match(page.data.categoryDescription, /海外及港澳台/);
  await page.switchCategory(event('popularity'));
  assert.equal(page.data.categoryDescription, '收到超过100人爱心的会员');
  assert.equal(reads.length, 4);
});

test('opening details keeps the financial range out of persistent profile storage and scopes the public summary', async () => {
  const { page, calls } = categoryRuntime({ recommend: [member(1, {
    educationVerified: true, verifiedEducation: '本科', assetVerified: true, financialAssetRange: '2m_5m'
  })] });
  await page.load(false);
  assert.match(page.data.currentMember.financialAssetText, /200.*500/);
  page.goMemberDetail();
  const summary = calls.storage.find(entry => entry.key === 'selectedUserMember');
  const scope = calls.storage.find(entry => entry.key === 'selectedUserMemberScope');
  assert.ok(summary);
  assert.equal(summary.value.financialAssetRange, undefined);
  assert.equal(summary.value.financialAssetText, undefined);
  assert.equal(scope.value, page.sessionScope());
  assert.equal(summary.value.assetVerified, true);
  assert.equal(calls.navigation[0].url, '/pages/user/member-detail?id=1');
});
