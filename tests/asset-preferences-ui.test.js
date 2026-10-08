const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const change = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });

function profileRuntime(overrides = {}) {
  return runtime('pages/user/profile.js', {
    request: async (_path, options) => ({ profile: options && options.method === 'PUT'
      ? options.data : { realName: '测试会员', ...overrides.profile } }),
    ...overrides
  });
}

test('asset category participation and range disclosure default to explicit opt-out', async () => {
  const { page } = profileRuntime({ profile: { assetCategoryConsent: 'true', assetRangeDisclosure: 1 } });
  await page.onShow();
  assert.equal(page.data.form.assetCategoryConsent, false);
  assert.equal(page.data.form.assetRangeDisclosure, false);
});

test('asset participation and disclosure save independently and retain the other preference', async () => {
  const { page, calls } = profileRuntime();
  await page.onShow();
  await page.onAssetPreferenceChange(change('assetCategoryConsent', true));
  assert.equal(page.data.form.assetCategoryConsent, true);
  assert.equal(page.data.form.assetRangeDisclosure, false);
  await page.onAssetPreferenceChange(change('assetRangeDisclosure', true));
  await page.onAssetPreferenceChange(change('assetCategoryConsent', false));
  assert.equal(page.data.form.assetCategoryConsent, false);
  assert.equal(page.data.form.assetRangeDisclosure, true);
  const writes = calls.requests.filter(row => row.options && row.options.method === 'PUT');
  assert.equal(writes.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.data)), { assetCategoryConsent: true });
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].options.data)), { assetRangeDisclosure: true });
  assert.deepEqual(JSON.parse(JSON.stringify(writes[2].options.data)), { assetCategoryConsent: false });
});

test('a failed preference save restores its switch while preserving newer form edits', async () => {
  const pending = deferred();
  const { page, calls } = profileRuntime({ request: (_path, options) => options && options.method === 'PUT'
    ? pending.promise : Promise.resolve({ profile: { realName: '测试会员', education: '本科' } }) });
  await page.onShow();
  const saving = page.onAssetPreferenceChange(change('assetCategoryConsent', true));
  await flush();
  page.updateForm('education', '硕士');
  pending.reject(new Error('save failed'));
  await saving;
  assert.equal(page.data.form.assetCategoryConsent, false);
  assert.equal(page.data.form.education, '硕士');
  assert.equal(page._formDirty, true);
  assert.ok(calls.toasts.includes('设置未保存，请重试'));
});

test('preference failures restore a clean form and ignore events outside the two allowed choices', async () => {
  const { page, calls } = profileRuntime({ request: (_path, options) => options && options.method === 'PUT'
    ? Promise.reject(new Error('save failed')) : Promise.resolve({ profile: { realName: '测试会员' } }) });
  await page.onShow();
  await page.onAssetPreferenceChange(change('assetRangeDisclosure', true));
  assert.equal(page.data.form.assetRangeDisclosure, false);
  assert.equal(page._formDirty, false);
  const count = calls.requests.length;
  await page.onAssetPreferenceChange(change('educationVerified', true));
  assert.equal(calls.requests.length, count);
});

test('an old account preference failure cannot change or notify the new account', async () => {
  const pending = deferred();
  const { page, session, calls } = profileRuntime({ request: (_path, options) => options && options.method === 'PUT'
    ? pending.promise : Promise.resolve({ profile: { realName: '测试会员' } }) });
  await page.onShow();
  const saving = page.onAssetPreferenceChange(change('assetCategoryConsent', true));
  await flush();
  session.token = 'other-account';
  session.user = { id: 2 };
  await page.onShow();
  pending.reject(new Error('old account save failed'));
  await saving;
  assert.equal(page.data.form.assetCategoryConsent, false);
  assert.ok(!calls.toasts.includes('设置未保存，请重试'));
});

test('public certification display rejects self-filled claims and never guesses a financial range', () => {
  const { publicCertificationRows } = require('../miniprogram/utils/member-certification');
  assert.deepEqual(publicCertificationRows({ education: '博士', isVerified: 1, financialAssetRange: 'over_10m' }), []);
  assert.deepEqual(publicCertificationRows({ educationVerified: true, verifiedEducation: '硕士', assetVerified: true }), [
    { label: '学历核验', value: '硕士 · 学历已认证' }, { label: '资产核验', value: '资产已认证' }
  ]);
  assert.deepEqual(publicCertificationRows({ assetVerified: true, financialAssetRange: 'unknown' }), [
    { label: '资产核验', value: '资产已认证' }
  ]);
  assert.deepEqual(publicCertificationRows({ assetVerified: true, financialAssetRange: '2m_5m' }), [
    { label: '资产核验', value: '资产已认证' }, { label: '已核验金融资产', value: '200万—500万元' }
  ]);
});
