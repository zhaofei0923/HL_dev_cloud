'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const tabs = ['members', 'messages', 'profile'];
const certifications = () => ({ entries: ['identity', 'education', 'vehicle', 'property', 'assets']
  .map(kind => ({ kind, status: 'unsubmitted', verified: false })) });

function signedOut(instance) {
  instance.session.token = '';
  instance.session.user = null;
}

test('guest user tabs explain their functions without login, private reads or automatic navigation', async () => {
  for (const name of tabs) {
    const privateReads = [];
    const read = action => async () => { privateReads.push(action); throw new Error('guest must not read'); };
    const r = runtime(`pages/user/${name}.js`, { source: true,
      request: read('request'),
      memberApi: { showcase: read('showcase'), vipOverview: read('vip'), relationships: read('relationships'),
        certifications: read('certifications'), referralCard: read('referral') },
      chatApi: { listConversations: read('conversations') }
    });
    signedOut(r);
    await r.page.onShow();
    await r.page.onShow();
    if (r.page.onPullDownRefresh) await r.page.onPullDownRefresh();
    await flush();
    assert.equal(r.page.data.guest, true, name);
    assert.deepEqual(privateReads, [], name);
    assert.deepEqual(r.calls.navigation, [], name);
    assert.ok(r.calls.tabUpdates.length > 0, `${name} retains native tabs`);
    const template = fs.readFileSync(path.join(miniprogramRoot, `pages/user/${name}.wxml`), 'utf8');
    assert.match(template, /wx:if="\{\{guest\}\}"/);
    assert.match(template, /bindtap="goGuestLogin">登录后使用/);
    assert.match(template, /bindtap="browseActivities">浏览活动/);
    assert.match(template, /<block wx:else>/);
  }
});

test('only explicit guest buttons open the login intent or the public activity tab', async () => {
  for (const name of tabs) {
    const r = runtime(`pages/user/${name}.js`, { source: true });
    signedOut(r);
    await r.page.onShow();
    r.page.goGuestLogin();
    r.page.browseActivities();
    assert.deepEqual(r.calls.navigation.map(({ method, url }) => ({ method, url })), [
      { method: 'navigateTo', url: `/pages/index/index?login=1&returnTo=${name}` },
      { method: 'switchTab', url: '/pages/user/salon' }
    ]);
  }
});

test('recommendation tab removes old member cards, filters and cache before guest display', async () => {
  let reads = 0;
  const removed = [];
  const r = runtime('pages/user/members.js', { source: true,
    wx: { removeStorageSync: key => removed.push(key) },
    memberApi: { showcase: async () => { reads += 1; return { list: [{ id: 'profile_8', userId: 8,
      realName: '旧账号可见会员', photos: [] }], total: 1 }; } }
  });
  await r.page.onShow();
  assert.equal(r.page.data.guest, false);
  assert.equal(r.page.data.list.length, 1);
  r.page.setData({ keyword: '私有筛选', draftKeyword: '未提交筛选', gifts: [{ id: 'private', name: '礼品' }] });
  signedOut(r);
  await r.page.onShow();
  assert.equal(r.page.data.guest, true);
  assert.equal(r.page.data.list.length, 0);
  assert.equal(r.page.data.currentMember, null);
  assert.equal(r.page.data.keyword, '');
  assert.equal(r.page.data.draftKeyword, '');
  assert.equal(r.page.data.gifts.length, 0);
  assert.equal(r.page.data.favoriteQuota, null);
  assert.equal(r.page.data.isVip, false);
  assert.ok(removed.includes('selectedUserMember'));
  r.session.token = 'navigation-test-session';
  r.session.user = { id: 1, gender: 2 };
  await r.page.onShow();
  assert.equal(reads, 2, 'the signed-out account cache is not reused after login');
});

test('late recommendation and message responses cannot restore the signed-out account', async () => {
  const showcase = deferred();
  const members = runtime('pages/user/members.js', { source: true,
    memberApi: { showcase: () => showcase.promise } });
  const memberLoad = members.page.onShow();
  await flush();
  signedOut(members);
  await members.page.onShow();
  showcase.resolve({ list: [{ id: 'profile_8', userId: 8, realName: '迟到资料' }], total: 1 });
  await memberLoad;
  assert.equal(members.page.data.guest, true);
  assert.equal(members.page.data.list.length, 0);

  const conversations = deferred();
  const relationships = deferred();
  const messages = runtime('pages/user/messages.js', { source: true,
    chatApi: { listConversations: () => conversations.promise },
    memberApi: { relationships: () => relationships.promise } });
  const messageLoad = messages.page.onShow();
  await flush();
  messages.page.setData({ list: [{ id: 2, peerName: '旧会话' }], relationshipItems: [{ id: 'old' }],
    relationshipCounts: { incoming: 7, mutual: 3 } });
  signedOut(messages);
  await messages.page.onShow();
  conversations.resolve({ list: [{ id: 2, title: '迟到会话' }], total: 1 });
  relationships.resolve({ list: [{ id: 'private', userId: 8 }], total: 1, counts: { incoming: 9, mutual: 4 } });
  await messageLoad;
  assert.equal(messages.page.data.guest, true);
  assert.equal(messages.page.data.list.length, 0);
  assert.equal(messages.page.data.relationshipItems.length, 0);
  assert.equal(messages.page.data.relationshipCounts.incoming, 0);
  assert.equal(messages.page.data.relationshipCounts.mutual, 0);
});

test('profile guest view clears old identity, draft, certification and admin state and ignores late reads', async () => {
  const pending = deferred();
  const r = runtime('pages/user/profile.js', { source: true,
    request: requestPath => requestPath === '/user/profile' ? pending.promise : Promise.resolve({ allowed: false, ready: false }),
    memberApi: { certifications: async () => certifications() }
  });
  const loading = r.page.onShow();
  await flush();
  r.page.setData({ form: { realName: '未保存姓名', phone: '13800138000', photoText: 'private-photo' },
    preview: { displayName: '旧姓名', avatarUrl: 'private-photo' }, user: { id: 1, phone: '13800138000' },
    editingProfile: true, adminEntryVisible: true, isVipBadge: true,
    referralCard: { canShare: true, sharePath: '/private-invite' }, matchmakerCode: 'PRIVATE',
    certificationRows: [{ kind: 'identity', state: '已认证' }] });
  signedOut(r);
  await r.page.onShow();
  pending.resolve({ profile: { realName: '迟到姓名', photos: ['private-photo'] } });
  await loading;
  assert.equal(r.page.data.guest, true);
  assert.equal(r.page.data.user, null);
  assert.equal(r.page.data.form.realName, '');
  assert.equal(r.page.data.form.photoText, '');
  assert.equal(r.page.data.editingProfile, false);
  assert.equal(r.page.data.profileReady, false);
  assert.equal(r.page.data.adminEntryVisible, false);
  assert.equal(r.page.data.isVipBadge, false);
  assert.equal(r.page.data.referralCard.canShare, false);
  assert.equal(r.page.data.matchmakerCode, '');
  assert.ok(!JSON.stringify(r.page.data).includes('private-photo'));
  assert.deepEqual(r.calls.navigation, []);
});

test('a cached identity without a credential is never used to prefill the guest profile', async () => {
  const r = runtime('pages/user/profile.js', { source: true });
  r.session.token = '';
  r.session.user = { id: 1, nickname: '缓存私密姓名', phone: '13800138000' };
  await r.page.onShow();
  assert.equal(r.page.data.guest, true);
  assert.equal(r.page.data.form.realName, '');
  assert.ok(!JSON.stringify(r.page.data).includes('缓存私密姓名'));
  assert.deepEqual(r.calls.requests, []);
});
