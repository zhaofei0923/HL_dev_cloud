const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const member = extra => ({ id: 'profile_88', userId: 88, realName: '测试会员', ...extra });

test('member detail reads the current public target and displays only verified disclosed assets', async () => {
  const ids = [];
  const { page } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: async id => { ids.push(id); return member({ assetVerified: true, financialAssetRange: '2m_5m' }); },
    showcase: async () => { throw new Error('Must not scan the general recommendation page for a category detail'); }
  } });
  page.setData({ id: 'profile_88' });
  await page.load();
  assert.deepEqual(ids, ['profile_88']);
  assert.equal(page.data.certificationRows.at(-1).value, '200万—500万元');
  await page.onShow();
  assert.equal(ids.length, 1);
});

test('a new public detail read removes an asset range that the member no longer discloses', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: async () => member({ assetVerified: true, ...(reads++ === 0 ? { financialAssetRange: 'over_10m' } : {}) })
  } });
  page.setData({ id: 'profile_88' });
  await page.load();
  assert.equal(page.data.certificationRows.length, 2);
  await page.load();
  assert.equal(page.data.certificationRows.length, 1);
  assert.equal(page.data.certificationRows[0].value, '资产已认证');
  assert.equal(page.data.member.financialAssetRange, undefined);
});

test('a hidden or unavailable public member does not fall back to an older member object', async () => {
  const { page } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: async () => { throw new Error('not found'); }
  } });
  page.setData({ id: 'profile_88', member: member({ financialAssetRange: 'over_10m' }) });
  await page.load();
  assert.equal(page.data.member, null);
  assert.equal(page.data.certificationRows.length, 0);
  assert.equal(page.data.loading, false);
});

test('an old public detail response cannot show assets in another account', async () => {
  const pending = deferred();
  let reads = 0;
  const { page, session } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: () => reads++ === 0 ? pending.promise : Promise.resolve(member({ assetVerified: true }))
  } });
  page.setData({ id: 'profile_88' });
  const first = page.load();
  await flush();
  session.token = 'second-account';
  session.user = { id: 2 };
  await page.onShow();
  pending.resolve(member({ assetVerified: true, financialAssetRange: 'over_10m' }));
  await first;
  assert.equal(page.data.member.financialAssetRange, undefined);
  assert.equal(page.data.certificationRows.length, 1);
});

test('leaving member detail prevents pending private display updates', async () => {
  const pending = deferred();
  const { page } = runtime('pages/user/member-detail.js', { memberApi: { showcaseDetail: () => pending.promise } });
  page.setData({ id: 'profile_88' });
  const reading = page.load();
  page.onUnload();
  pending.resolve(member({ assetVerified: true, financialAssetRange: 'over_10m' }));
  await reading;
  assert.equal(page.data.member, null);
  assert.equal(page.data.certificationRows.length, 0);
});

test('returning from chat or a stale detail rechecks revoked asset disclosure', async () => {
  let reads = 0;
  const { page, advance } = runtime('pages/user/member-detail.js', { memberApi: {
    showcaseDetail: async () => member({ assetVerified: true, ...(reads++ === 0 ? { financialAssetRange: 'over_10m' } : {}) })
  } });
  page.setData({ id: 'profile_88' });
  await page.load();
  page.onHide();
  await page.onShow();
  assert.equal(reads, 2);
  assert.equal(page.data.certificationRows.length, 1);
  advance(45000);
  await page.onShow();
  assert.equal(reads, 3);
});
