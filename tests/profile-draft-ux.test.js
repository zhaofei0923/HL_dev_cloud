const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const plain = value => JSON.parse(JSON.stringify(value));
const change = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const clickPhoto = index => ({ currentTarget: { dataset: { index } } });
const KINDS = ['identity', 'education', 'vehicle', 'property', 'assets'];
const emptyCertifications = () => ({ entries: KINDS.map(kind => ({ kind, status: 'unsubmitted', verified: false })) });

function profileRuntime(overrides = {}) {
  let stored = { realName: '已保存姓名', city: '上海', education: '本科', photos: [], displayEnabled: false, ...overrides.profile };
  return runtime('pages/user/profile.js', {
    ...overrides,
    memberApi: { certifications: async () => emptyCertifications(), ...overrides.memberApi },
    request: overrides.request || (async (_path, options) => {
      if (options && options.method === 'PUT') stored = { ...stored, ...plain(options.data) };
      return { id: 1, nickname: stored.realName, gender: 2, profile: { ...stored } };
    })
  });
}

test('immediate disclosure writes only its preference and never submits or clears draft text', async () => {
  const { page, calls, session } = profileRuntime();
  await page.onShow();
  page.updateForm('realName', '尚未决定的新姓名');
  page.updateForm('education', '硕士');
  await page.onDisplayEnabledChange({ detail: { value: true } });
  await page.onAssetPreferenceChange(change('assetRangeDisclosure', true));
  const writes = calls.requests.filter(row => row.options && row.options.method === 'PUT');
  assert.deepEqual(plain(writes.map(row => row.options.data)), [
    { displayEnabled: true }, { assetRangeDisclosure: true }
  ]);
  assert.equal(page.data.form.realName, '尚未决定的新姓名');
  assert.equal(page.data.form.education, '硕士');
  assert.equal(page._formDirty, true);
  assert.equal(page.data.formDirty, true);
  assert.match(page.data.saveStatus, /资料修改尚未保存/);
  assert.equal(session.user.nickname, '已保存姓名', 'an immediate preference cannot rename the account');
  assert.equal(session.user.gender, 2, 'a partial preference cannot reset gender');
});

test('failed visibility save restores its switch while retaining earlier and in-flight draft edits', async () => {
  const pending = deferred();
  const { page } = profileRuntime({ request: async (_path, options) =>
    options && options.method === 'PUT' ? pending.promise : { profile: { realName: '原姓名', city: '上海', displayEnabled: false } }
  });
  await page.onShow();
  page.updateForm('realName', '未保存姓名');
  const saving = page.onDisplayEnabledChange({ detail: { value: true } });
  assert.equal(page.data.form.displayEnabled, true);
  page.updateForm('city', '杭州');
  pending.reject(new Error('offline'));
  await saving;
  assert.equal(page.data.form.displayEnabled, false);
  assert.equal(page.data.form.realName, '未保存姓名');
  assert.equal(page.data.form.city, '杭州');
  assert.equal(page.data.saveState, 'error');
  assert.equal(page.data.formDirty, true);
  assert.match(page.data.saveStatus, /已恢复原设置/);
});

test('deleting a photo writes only photos and keeps draft text unsaved', async () => {
  const { page, calls } = profileRuntime({ profile: { photos: ['cloud://first.jpg', 'cloud://second.jpg'] } });
  await page.onShow();
  page.updateForm('selfIntro', '正在改写的介绍');
  page.deletePhoto(clickPhoto(0));
  await flush();
  const write = calls.requests.find(row => row.options && row.options.method === 'PUT');
  assert.deepEqual(plain(write.options.data), { photos: ['cloud://second.jpg'] });
  assert.equal(page.data.form.photoText, 'cloud://second.jpg');
  assert.equal(page.data.form.selfIntro, '正在改写的介绍');
  assert.equal(page._formDirty, true);
});

test('failed photo delete restores photos without reverting text typed during save', async () => {
  const pending = deferred();
  const { page } = profileRuntime({ request: async (_path, options) =>
    options && options.method === 'PUT' ? pending.promise : { profile: { realName: '会员', photos: ['cloud://first.jpg', 'cloud://second.jpg'] } }
  });
  await page.onShow();
  page.deletePhoto(clickPhoto(0));
  assert.equal(page.data.photoCount, 1);
  page.updateForm('selfIntro', '这段介绍应保留');
  pending.reject(new Error('offline'));
  await flush();
  assert.equal(page.data.photoCount, 2);
  assert.deepEqual(plain(page.data.form.photoDisplayUrls), ['cloud://first.jpg', 'cloud://second.jpg']);
  assert.equal(page.data.form.selfIntro, '这段介绍应保留');
  assert.equal(page.data.formDirty, true);
  assert.match(page.data.saveStatus, /已恢复原照片/);
});

test('explicit save excludes immediate fields and preserves text entered after the save tap', async () => {
  const pending = deferred();
  const { page, calls } = profileRuntime({ request: async (_path, options) =>
    options && options.method === 'PUT' ? pending.promise : { profile: { realName: '旧姓名', city: '上海', photos: ['cloud://photo.jpg'], displayEnabled: true } }
  });
  await page.onShow();
  page.openProfileEditor();
  page.updateForm('realName', '本次保存姓名');
  const saving = page.save();
  page.updateForm('city', '成都');
  pending.resolve({ profile: { realName: '本次保存姓名', city: '上海' } });
  await saving;
  const write = calls.requests.find(row => row.options && row.options.method === 'PUT');
  for (const field of ['photos', 'photoText', 'displayEnabled', 'assetCategoryConsent', 'assetRangeDisclosure']) {
    assert.equal(Object.hasOwn(write.options.data, field), false, field + ' must have its own save path');
  }
  assert.equal(page.data.form.realName, '本次保存姓名');
  assert.equal(page.data.form.city, '成都');
  assert.equal(page.data.form.photoText, 'cloud://photo.jpg');
  assert.equal(page.data.form.displayEnabled, true);
  assert.equal(page.data.formDirty, true);
  assert.equal(page.data.editingProfile, true);
});

test('failed explicit save keeps the editor and draft, then a retry clears the dirty state', async () => {
  let writes = 0;
  const { page } = profileRuntime({ request: async (_path, options) => {
    if (options && options.method === 'PUT') {
      if (++writes === 1) throw new Error('offline');
      return { profile: plain(options.data) };
    }
    return { profile: { realName: '旧姓名', city: '上海' } };
  } });
  await page.onShow();
  page.openProfileEditor();
  page.updateForm('realName', '新姓名');
  assert.equal(await page.save(), false);
  assert.equal(page.data.editingProfile, true);
  assert.equal(page.data.form.realName, '新姓名');
  assert.equal(page.data.formDirty, true);
  assert.equal(page.data.saveStatus, '保存失败，修改仍保留，请重试');
  assert.equal(await page.save(), true);
  assert.equal(page.data.formDirty, false);
  assert.equal(page.data.saveState, 'saved');
  assert.equal(page.data.saveStatus, '资料已保存');
});

test('editor opens at top and closing a draft offers continuation without discarding it', async () => {
  const modals = [];
  const { page, calls } = profileRuntime({ wx: { showModal: options => modals.push(options) } });
  await page.onShow();
  page.toggleProfileEditor();
  assert.equal(page.data.editingProfile, true);
  assert.equal(calls.scrolls.at(-1).scrollTop, 0);
  page.updateForm('realName', '保留本次编辑');
  page.toggleProfileEditor();
  assert.equal(page.data.editingProfile, true);
  modals.at(-1).success({ confirm: false });
  assert.equal(page.data.editingProfile, true);
  page.toggleProfileEditor();
  modals.at(-1).success({ confirm: true });
  assert.equal(page.data.editingProfile, false);
  assert.equal(page.data.form.realName, '保留本次编辑');
  assert.equal(page.data.formDirty, true);
  page.toggleProfileEditor();
  assert.equal(page.data.editingProfile, true);
});

test('logout requires a decision for unsaved text and ignores stale account dialogs', async () => {
  const modals = [];
  const { page, session } = profileRuntime({ wx: { showModal: options => modals.push(options) } });
  await page.onShow();
  page.updateForm('realName', '未保存');
  page.logout();
  assert.ok(session.token);
  modals.at(-1).success({ confirm: false });
  assert.equal(page.data.editingProfile, true);
  assert.ok(session.token);
  page.logout();
  const previousDialog = modals.at(-1);
  session.token = 'new-account-token';
  session.user = { id: 2, nickname: '新账号' };
  await page.onShow();
  previousDialog.success({ confirm: true });
  assert.equal(session.token, 'new-account-token');
  assert.equal(session.user.id, 2);
});

test('native leave guard belongs only to the visible profile and clears after saving', async () => {
  const guards = [];
  const { page } = profileRuntime({ wx: {
    enableAlertBeforeUnload: options => guards.push(['enable', options.message]),
    disableAlertBeforeUnload: () => guards.push(['disable'])
  } });
  await page.onShow();
  page.updateForm('realName', '草稿');
  assert.equal(guards.at(-1)[0], 'enable');
  page.onHide();
  assert.equal(guards.at(-1)[0], 'disable');
  await page.onDisplayEnabledChange({ detail: { value: true } });
  assert.equal(guards.at(-1)[0], 'disable', 'an off-screen response must not guard a different page');
  await page.onShow();
  assert.equal(guards.at(-1)[0], 'enable');
  await page.save();
  assert.equal(guards.at(-1)[0], 'disable');
  assert.equal(page.data.formDirty, false);
});

test('compact certification summary counts verified and actionable states before expansion', async () => {
  const { page } = profileRuntime({ memberApi: { certifications: async () => ({ entries: [
    { kind: 'identity', status: 'approved', verified: true },
    { kind: 'education', status: 'pending', verified: false },
    { kind: 'vehicle', status: 'unsubmitted', verified: false },
    { kind: 'property', status: 'rejected', verified: false },
    { kind: 'assets', status: 'unsubmitted', verified: false }
  ] }) } });
  await page.onShow();
  assert.equal(page.data.certificationsExpanded, false);
  assert.equal(page.data.certificationSummary, '1项已认证 · 1项待审核 · 1项需处理');
  page.toggleCertifications();
  assert.equal(page.data.certificationsExpanded, true);
  assert.equal(page.data.certificationRows.length, 5);
});
