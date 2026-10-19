const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function privateMember(id = 17) {
  return { id, userId: id + 100, realName: `私档 ${id}`, phone: '13800138000', identityStatus: 'pending',
    privateArchive: { basic: { phone: '13800138000' }, assetVerification: { financialAssetRange: 'over_10m' },
      personalProfile: { lifePhotos: ['private-photo'] }, compliance: { partialVerificationConfirmed: true, voluntarySubmissionConfirmed: true } } };
}
function detail(overrides = {}) {
  const instance = runtime('pages/matchmaker/member-detail.js', { ...overrides, wx: { hideShareMenu() {}, ...(overrides.wx || {}) } });
  instance.page.setData({ id: '17', isOwn: true });
  return instance;
}
function switchAccount(instance) {
  instance.session.token = 'replacement-account-token';
  instance.session.user = { id: 2, currentRole: 'matchmaker' };
}
function rows(count, start = 1) { return Array.from({ length: count }, (_, i) => ({ id: start + i, userId: 1000 + start + i, realName: `会员 ${start + i}` })); }

test('a private detail response cannot cross an account change, and denied replacement reads erase every private field', async () => {
  const pending = deferred(); let reads = 0;
  const instance = detail({ memberApi: { detail: () => ++reads === 1 ? pending.promise : Promise.reject(Object.assign(new Error('forbidden'), { code: 40300 })) } });
  const loading = instance.page.load();
  switchAccount(instance);
  pending.resolve(privateMember()); await loading;
  assert.equal(instance.page.data.member, null);
  assert.equal(instance.page.data.privateSections.length, 0);
  assert.equal(instance.page.data.privateLifePhotos.length, 0);
  await instance.page.onShow();
  for (const field of ['privateSections', 'profilePrivateSections', 'matchingPrivateSections', 'servicePrivateSections', 'privateLifePhotos']) assert.equal(instance.page.data[field].length, 0);
  assert.equal(instance.page.data.claimPhone, '');
  assert.equal(instance.page.data.claimInvite, null);
});

test('hiding or unloading rejects late private detail reads and a newer same-account read wins', async () => {
  for (const leave of ['onHide', 'onUnload']) {
    const pending = deferred(); let reads = 0;
    const instance = detail({ memberApi: { detail: () => ++reads === 1 ? pending.promise : Promise.resolve(privateMember(18)) } });
    const loading = instance.page.load(); instance.page[leave]();
    assert.equal(instance.page.data.loading, false);
    if (leave === 'onHide') await instance.page.onShow();
    pending.resolve(privateMember(17)); await loading;
    assert.equal(instance.page.data.member?.id || null, leave === 'onHide' ? 18 : null);
  }
});

test('old private display updates and claim invitations cannot change or disclose the replacement account', async () => {
  for (const operation of ['display', 'claim']) {
    const pending = deferred();
    const instance = detail({ memberApi: { detail: async () => privateMember(), update: () => pending.promise, createIdentityClaimInvite: () => pending.promise } });
    await instance.page.load();
    const action = operation === 'display' ? instance.page.onDisplayEnabledChange({ detail: { value: true } }) : instance.page.requestClaimInvite();
    switchAccount(instance);
    pending.resolve(operation === 'display' ? privateMember(18) : { status: 'pending', sharePath: '/pages/user/member-claim?token=old-private-invite' });
    await action;
    assert.equal(instance.calls.toasts.length, 0);
    assert.equal(instance.page.onShareAppMessage({ from: 'button', target: { dataset: { claim: 'member' } } }).path, '/pages/user/members');
    assert.equal(instance.page.data.member, null);
    assert.equal(instance.page.data.claimInvite, null);
  }
});

test('leaving private detail discards a pending chat result and clears its private archive immediately', async () => {
  const pending = deferred();
  const instance = detail({ memberApi: { detail: async () => ({ ...privateMember(), identityStatus: 'claimed' }) }, chatApi: { getOrCreateConversation: () => pending.promise } });
  await instance.page.load(); const action = instance.page.startChat();
  instance.page.onHide(); pending.resolve({ id: 99 }); await action;
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.page.data.privateLifePhotos.length, 0);
  assert.equal(instance.page.data.chatStarting, false);
});

test('a resource detail rechecks current visibility, ignores persistent old rows and reaches targets beyond the first hundred', async () => {
  const queries = [];
  const instance = detail({ memberApi: { resources: async query => {
    queries.push(query.page); return query.page === 1 ? { list: rows(100), total: 101 } : { list: rows(1, 101), total: 101 };
  } }, wx: { getStorageSync: key => key === 'selectedMatchmakerMember' ? privateMember(101) : undefined } });
  instance.page.setData({ id: '101', isOwn: false, scope: 'resource' });
  await instance.page.load();
  assert.deepEqual(queries, [1, 2]);
  assert.equal(instance.page.data.member.id, 101);
  assert.equal(instance.page.data.privateSections.length, 0);
  assert.equal(instance.page.data.privateLifePhotos.length, 0);
});

test('resource pagination exposes member 51 and service-member selection exposes member 21 without losing the chosen member', async () => {
  const resourceQueries = [], ownQueries = [], recommendations = [];
  const instance = runtime('pages/matchmaker/resources.js', { memberApi: {
    resources: async query => { resourceQueries.push(query.page); return { list: query.page === 1 ? rows(50) : rows(20, 51), total: 70 }; },
    inviteOptions: async query => { ownQueries.push(query.page); return { list: query.page === 1 ? rows(20, 201) : rows(15, 221), total: 35 }; },
    recommend: async data => { recommendations.push(data); return {}; }
  }, wx: { showModal() {} } });
  await instance.page.load();
  instance.page.onMemberChange({ detail: { value: '19' } });
  await instance.page.loadMoreOwnMembers();
  assert.equal(instance.page.data.selectedMemberIndex, 19);
  assert.equal(instance.page.data.myMembers.length, 35);
  await instance.page.onReachBottom();
  assert.equal(instance.page.data.list.length, 70);
  assert.equal(instance.page.data.resourceHasMore, false);
  assert.equal(instance.page.data.ownHasMore, false);
  instance.page.onMemberChange({ detail: { value: '34' } });
  await instance.page.recommend({ currentTarget: { dataset: { userId: 1070 } } });
  assert.equal(recommendations[0].myMemberId, 235);
  assert.equal(recommendations[0].resourceUserId, 1070);
  assert.deepEqual(resourceQueries, [1, 2]); assert.deepEqual(ownQueries, [1, 2]);
  instance.page.openDetail({ currentTarget: { dataset: { id: '70' } } });
  assert.equal(instance.calls.storage.length, 0, 'resource summaries are not persisted between sessions');
});

test('resource append failure retains rows for retry and a duplicate server page stops pagination', async () => {
  let failed = false; let repeats = false; const queries = [];
  const instance = runtime('pages/matchmaker/resources.js', { memberApi: {
    resources: async query => { queries.push(query.page); if (query.page === 2 && !failed) { failed = true; throw new Error('offline'); }
      return { list: query.page === 1 || repeats ? rows(50) : rows(1, 51), total: 100 }; },
    inviteOptions: async () => ({ list: rows(1), total: 1 })
  } });
  await instance.page.load(); await instance.page.loadMoreResources();
  assert.equal(instance.page.data.list.length, 50); assert.equal(instance.page.data.resourcePage, 1);
  assert.ok(instance.page.data.resourceError);
  await instance.page.loadMoreResources(); assert.equal(instance.page.data.list.length, 51);
  repeats = true; await instance.page.loadMoreResources(); await instance.page.loadMoreResources();
  assert.equal(instance.page.data.resourceHasMore, false); assert.deepEqual(queries, [1, 2, 2, 3]);
});

test('old resource reads and append results cannot repopulate another account or an unloaded page', async () => {
  for (const transition of ['account', 'unload']) {
    const pending = deferred(); let reads = 0;
    const instance = runtime('pages/matchmaker/resources.js', { memberApi: {
      resources: async () => ++reads === 1 ? { list: rows(50), total: 70 } : pending.promise,
      inviteOptions: async () => ({ list: rows(20), total: 35 })
    } });
    await instance.page.load(); const loading = instance.page.loadMoreResources();
    if (transition === 'account') { switchAccount(instance); instance.page.toggleMemberSelector(); }
    else instance.page.onUnload();
    pending.resolve({ list: rows(20, 51), total: 70 }); await loading;
    assert.equal(instance.page.data.list.length, 0); assert.equal(instance.page.data.myMembers.length, 0);
    assert.equal(instance.page.data.resourceLoadingMore, false);
  }
});

test('a delayed ordinary invite resolution cannot accept for another account or after leaving', async () => {
  for (const transition of ['account', 'hide', 'unload']) {
    const pending = deferred(); const accepted = [];
    const instance = runtime('pages/user/matchmaker-invite.js', { memberApi: {
      resolveMatchmakerInvite: () => pending.promise, acceptMatchmakerInvite: async data => { accepted.push(data); return {}; }
    } });
    const loading = instance.page.onLoad({ code: 'MM001', source: 'matchmakerShare' }); await flush();
    if (transition === 'account') switchAccount(instance); else instance.page[transition === 'hide' ? 'onHide' : 'onUnload']();
    pending.resolve({ alreadyAssigned: false }); await loading; instance.advance(1000);
    assert.equal(accepted.length, 0); assert.equal(instance.calls.navigation.length, 0);
  }
});

test('ordinary invite acceptance and manual application discard old completions and delayed navigation', async () => {
  for (const source of ['matchmakerShare', 'scan']) {
    for (const transition of ['account', 'hide', 'unload']) {
      const pending = deferred();
      const instance = runtime('pages/user/matchmaker-invite.js', { memberApi: {
        resolveMatchmakerInvite: async () => ({ alreadyAssigned: false }),
        acceptMatchmakerInvite: () => pending.promise, requestMatchmaker: () => pending.promise
      } });
      let action = instance.page.onLoad({ code: 'MM001', source }); await flush();
      if (source === 'scan') { await action; action = instance.page.submitRequest(); await flush(); }
      if (transition === 'account') switchAccount(instance); else instance.page[transition === 'hide' ? 'onHide' : 'onUnload']();
      pending.resolve({ invite: {}, status: 'pending' }); await action; instance.advance(1000);
      assert.equal(instance.calls.navigation.length, 0); assert.equal(instance.calls.toasts.length, 0);
    }
  }
});

test('the ordinary invite return timer rechecks account and is cancelled by hiding the page', async () => {
  for (const transition of ['account', 'hide', 'current']) {
    const instance = runtime('pages/user/matchmaker-invite.js', { memberApi: {
      resolveMatchmakerInvite: async () => ({ alreadyAssigned: false }), acceptMatchmakerInvite: async () => ({ invite: {} })
    } });
    await instance.page.onLoad({ code: 'MM001', source: 'matchmakerShare' });
    if (transition === 'account') switchAccount(instance); else if (transition === 'hide') instance.page.onHide();
    instance.advance(1000);
    assert.equal(instance.calls.navigation.length, transition === 'current' ? 1 : 0);
  }
});
