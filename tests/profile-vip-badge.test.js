const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const free = { membershipTier: 'free', isPremiumMember: false, entitlements: {} };
const valid = { membershipTier: 'vip', isPremiumMember: true, entitlements: {},
  vipMembership: { tier: 'vip', expireAt: '2026-10-07T00:00:00Z', lifetime: false } };
function profileRuntime(vipOverview) {
  return runtime('pages/user/profile.js', { memberApi: { vipOverview,
    certifications: async () => ({ entries: ['identity', 'education', 'vehicle', 'property', 'assets'].map(kind => ({ kind, status: 'unsubmitted', verified: false })) }) },
    request: async () => ({ profile: { realName: '测试档案', city: '上海', photos: [], displayEnabled: false } }) });
}

test('profile badge distinguishes unopened, active and expired VIP without changing the form', async () => {
  for (const [overview, expected] of [[free, false], [valid, true],
    [{ ...valid, vipMembership: { ...valid.vipMembership, expireAt: '2026-10-05T00:00:00Z' } }, false]]) {
    const r = profileRuntime(async () => overview);
    await r.page.onShow(); await flush();
    assert.equal(r.page.data.isVipBadge, expected);
    assert.equal(r.page.data.form.realName, '测试档案');
    assert.equal(r.page.data.formDirty, false);
    assert.equal(r.page.data.profileReady, true);
  }
});

test('visible profile cancels its badge at the exact expiry instead of waiting for another tab visit', async () => {
  const r = profileRuntime(async () => ({ ...valid,
    vipMembership: { ...valid.vipMembership, expireAt: '2026-10-06T00:00:01Z' } }));
  await r.page.onShow(); await flush();
  assert.equal(r.page.data.isVipBadge, true);
  r.advance(999); assert.equal(r.page.data.isVipBadge, true);
  r.advance(1); assert.equal(r.page.data.isVipBadge, false);
});

test('a late old-account VIP result cannot decorate the replacement account', async () => {
  const pending = deferred();
  let reads = 0;
  const r = profileRuntime(() => ++reads === 1 ? pending.promise : Promise.resolve(free));
  await r.page.onShow();
  r.session.token = 'replacement-account'; r.session.user = { id: 2 };
  await r.page.onShow(); await flush();
  pending.resolve(valid); await flush();
  assert.equal(r.page.data.isVipBadge, false);
  assert.equal(r.page.data.user.id, 2);
});

test('VIP badge loading never delays the draft editor and unload discards its response', async () => {
  const pending = deferred();
  const r = profileRuntime(() => pending.promise);
  await r.page.onShow();
  assert.equal(r.page.data.profileReady, true);
  r.page.updateForm('realName', '未保存的修改');
  assert.equal(r.page.data.formDirty, true);
  r.page.onUnload(); pending.resolve(valid); await flush();
  assert.equal(r.page.data.isVipBadge, false);
  assert.equal(r.page.data.form.realName, '未保存的修改');
  assert.equal(r.page.data.formDirty, true);
});

test('badge request failure hides the badge while preserving the existing draft and collapse state', async () => {
  let fail = false;
  const r = profileRuntime(async () => { if (fail) throw new Error('offline'); return valid; });
  await r.page.onShow(); await flush();
  r.page.updateForm('realName', '仍保留的草稿');
  r.page.setData({ certificationsExpanded: true, accountPanelOpen: true });
  fail = true; await r.page.loadVipBadge();
  assert.equal(r.page.data.isVipBadge, false);
  assert.equal(r.page.data.form.realName, '仍保留的草稿');
  assert.equal(r.page.data.formDirty, true);
  assert.equal(r.page.data.certificationsExpanded, true);
  assert.equal(r.page.data.accountPanelOpen, true);
});
