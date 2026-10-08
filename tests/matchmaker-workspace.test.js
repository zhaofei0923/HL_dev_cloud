const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

function dashboard(status = 2) {
  return { matchmaker: { id: 101, userId: 1, certificationStatus: status, memberCount: 1 },
    operations: { salonCount: 1, registrationCount: 1, resourceCount: 1, todoCounts: {} } };
}

function member(id = 501) {
  return { id, userId: id + 100, realName: 'PRIVATE_WORKSPACE_MEMBER', gender: 2, city: '上海', age: 30 };
}

function setup(responses = {}, options = {}) {
  const reads = { dashboard: 0, members: 0, requests: 0, events: 0, conversations: 0, invite: 0 };
  const read = (name, fallback, query) => {
    reads[name] += 1;
    return responses[name] ? responses[name](reads[name], query) : Promise.resolve(fallback);
  };
  const instance = runtime('pages/matchmaker/workspace.js', {
    ...options,
    matchmakerApi: {
      dashboard: () => read('dashboard', dashboard()),
      status: () => read('dashboard', dashboard()),
      memberRequests: () => read('requests', { list: [], total: 0 }),
      approveMemberRequest: async id => { if (responses.approve) await responses.approve(id); return {}; },
      inviteCard: () => read('invite', { inviteCode: 'PRIVATE_WORKSPACE_INVITE', qrCodeFileID: 'PRIVATE_WORKSPACE_QR' })
    },
    memberApi: {
      list: query => read('members', { list: [member()], total: 1 }, query),
      inviteOptions: query => read('members', { list: [member()], total: 1, page: query.page || 1, pageSize: query.pageSize || 100 }, query)
    },
    salonApi: {
      myEvents: () => read('events', { list: [{ id: 301, title: 'PRIVATE_WORKSPACE_EVENT', status: 'upcoming' }], total: 1 }),
      list: () => read('events', { list: [{ id: 302, title: 'PUBLIC_WORKSPACE_EVENT', status: 'upcoming' }], total: 1 })
    },
    chatApi: { listConversations: () => read('conversations', { list: [{ id: 901,
      conversationType: 'member_matchmaker', peer: { id: 701, nickname: 'PRIVATE_WORKSPACE_CONVERSATION' }, unreadCount: 0 }], total: 1 }) }
  });
  instance.session.user.currentRole = 'matchmaker';
  return { ...instance, reads };
}

async function start(instance, tab = 'dashboard') {
  if (instance.page.onLoad) await instance.page.onLoad({ tab });
  await instance.page.onShow();
  await flush();
}

async function select(instance, key) {
  await instance.page.onTabChange({ detail: { key } });
  await flush();
}

function event(detail = {}, dataset = {}) {
  return { type: 'tap', detail, currentTarget: { dataset } };
}

test('workspace tab changes reuse the host and keep member filters and salon selection without navigation', async () => {
  const instance = setup();
  await start(instance);
  const host = instance.page;
  const nav = runtime('components/bottom-nav/bottom-nav.js', { role: 'matchmaker', active: 'dashboard', embedded: true });
  nav.component.switchTab(event({}, { key: 'members', path: '/pages/matchmaker/members' }));
  assert.equal(nav.calls.navigation.length, 0);
  assert.equal(nav.calls.events[0].name, 'change');
  await host.onTabChange({ detail: nav.calls.events[0].detail });
  await flush();
  host.workspace_members_onKeyword(event({ value: '杭州' }));
  await host.workspace_members_load(event());
  host.workspace_members_toggleFilters(event());
  assert.equal(host.data.view.keyword, '杭州');
  assert.equal(host.data.view.filtersOpen, true);
  assert.equal(host.data.view.list[0].id, 501);
  await select(instance, 'salon');
  await host.workspace_salon_loadAll(event());
  assert.equal(host.data.view.active, 'all');
  const memberReads = instance.reads.members;
  const eventReads = instance.reads.events;
  await select(instance, 'messages');
  await select(instance, 'mine');
  await select(instance, 'members');
  assert.equal(instance.page, host);
  assert.equal(host.data.activeTab, 'members');
  assert.equal(host.data.view.keyword, '杭州');
  assert.equal(host.data.view.filtersOpen, true);
  assert.equal(host.data.view.list[0].id, 501);
  assert.equal(instance.reads.members, memberReads, 'warm internal returns must reuse retained member data');
  await select(instance, 'salon');
  assert.equal(host.data.view.active, 'all');
  assert.equal(instance.reads.events, eventReads);
  assert.equal(instance.calls.navigation.length, 0);
});

test('workspace event wrappers dispatch only to the active controller and preserve original detail datasets', async () => {
  const instance = setup();
  await start(instance);
  await select(instance, 'members');
  instance.page.workspace_members_onKeyword(event({ value: '已选筛选' }));
  await instance.page.workspace_members_load(event());
  await select(instance, 'salon');
  instance.page.workspace_members_onKeyword(event({ value: '迟到事件' }));
  assert.equal(instance.page.data.activeTab, 'salon');
  await select(instance, 'members');
  assert.equal(instance.page.data.view.keyword, '已选筛选');
  const before = instance.reads.members;
  instance.page.workspace_members_openDetail(event({}, { id: 501 }));
  assert.equal(instance.calls.navigation[0].method, 'navigateTo');
  assert.equal(instance.calls.navigation[0].url, '/pages/matchmaker/member-detail?id=501&scope=own');
  await instance.page.onShow();
  assert.equal(instance.reads.members, before + 1, 'detail return retains the controller force-refresh flag');
  assert.equal(instance.page.data.view.keyword, '已选筛选');
});

test('workspace detail return supersedes an older member background read', async () => {
  const old = deferred();
  const instance = setup({ members: read => read === 2
    ? old.promise : Promise.resolve({ list: [member(read === 1 ? 501 : 503)], total: 1 }) });
  await start(instance, 'members');
  instance.advance(30001);
  const background = instance.page.onShow();
  await flush();
  instance.page.workspace_members_goAdd(event());
  await instance.page.onShow();
  assert.equal(instance.reads.members, 3);
  assert.equal(instance.page.data.view.list[0].id, 503);
  old.resolve({ list: [member(502)], total: 1 });
  await background;
  assert.equal(instance.page.data.view.list[0].id, 503);
});

test('workspace account changes clear active and hidden controller content and reject the previous account response', async () => {
  const old = deferred();
  const newGate = deferred();
  const instance = setup({
    members: read => read === 2 ? old.promise : Promise.resolve({ list: [member(read === 1 ? 501 : 503)], total: 1 }),
    dashboard: (_read) => instance.session.user.id === 2 ? newGate.promise : Promise.resolve(dashboard())
  });
  await start(instance, 'members');
  await select(instance, 'mine');
  await instance.page.workspace_mine_toggleInvite(event());
  await flush();
  assert.equal(instance.page.data.view.inviteCard.inviteCode, 'PRIVATE_WORKSPACE_INVITE');
  await select(instance, 'members');
  instance.advance(30001);
  const background = instance.page.onShow();
  await flush();
  instance.session.token = 'workspace-account-two';
  instance.session.user = { id: 2, currentRole: 'matchmaker' };
  const switched = instance.page.onShow();
  assert.equal(instance.page.data.view.list.length, 0);
  const showMine = instance.page.onTabChange({ detail: { key: 'mine' } });
  assert.equal(instance.page.data.view.inviteCard.inviteCode, '');
  old.resolve({ list: [member(502)], total: 1 });
  await background;
  assert.equal(instance.page.data.view.inviteCard.inviteCode, '');
  newGate.resolve(dashboard());
  await Promise.all([switched, showMine]);
  await select(instance, 'members');
  assert.equal(instance.page.data.view.list[0].id, 503);
});

test('workspace authorization revision changes erase hidden private views before refreshing denied access', async () => {
  let revoked = false;
  const instance = setup({
    dashboard: () => Promise.resolve(dashboard(revoked ? 1 : 2)),
    conversations: () => revoked ? Promise.reject(Object.assign(new Error('certification revoked'), { code: 40301 }))
      : Promise.resolve({ list: [{ id: 901, peer: { id: 701, nickname: 'PRIVATE_WORKSPACE_CONVERSATION' }, unreadCount: 0 }], total: 1 })
  });
  await start(instance, 'members');
  await select(instance, 'salon');
  await select(instance, 'messages');
  await select(instance, 'mine');
  await instance.page.workspace_mine_toggleInvite(event());
  await flush();
  revoked = true;
  const cache = instance.load(path.join(miniprogramRoot, 'utils/matchmaker-page-cache.js'));
  cache.invalidateMatchmakerPageSnapshots();
  const refreshed = instance.page.onShow();
  assert.equal(instance.page.data.view.inviteCard.inviteCode, '');
  await refreshed;
  for (const tab of ['members', 'salon', 'messages']) {
    const pending = instance.page.onTabChange({ detail: { key: tab } });
    assert.equal(instance.page.data.view.list.length, 0, `${tab} must not render its hidden old private view`);
    await pending;
    await flush();
    assert.equal(instance.page.data.view.list.length, 0);
  }
  assert.equal(instance.calls.storage.length, 0);
});

test('workspace persistent member-read denial clears content without repeatedly starting another automatic read', async () => {
  const instance = setup({ requests: read => {
    // Bound a buggy automatic loop so the regression fails instead of hanging the runner.
    if (read > 4) throw Object.assign(new Error('unexpected automatic read loop'), { code: 50300 });
    return Promise.reject(Object.assign(new Error('certification revoked'), { code: 40301 }));
  } });
  await start(instance, 'members');
  await flush();
  await flush();
  assert.equal(instance.page.data.view.canOperate, false);
  assert.equal(instance.page.data.view.list.length, 0);
  assert.equal(instance.page.data.view.pendingRequests.length, 0);
  assert.equal(instance.reads.requests <= 2, true, 'a denied current panel must not run a self-triggered request loop');
});

test('workspace approval invalidation preserves the active member controller and its forced refresh flow', async () => {
  let approved;
  const instance = setup({
    requests: () => Promise.resolve({ list: [{ id: 81, profile: { realName: '待审批会员' } }], total: 1 }),
    approve: id => { approved = id; },
    members: read => Promise.resolve({ list: [member(read === 1 ? 501 : 503)], total: 1 })
  });
  await start(instance, 'members');
  instance.page.workspace_members_onKeyword(event({ value: '杭州' }));
  await instance.page.workspace_members_load(event());
  instance.page.workspace_members_toggleFilters(event());
  const before = instance.reads.members;
  await instance.page.workspace_members_approveRequest(event({}, { id: 81 }));
  await flush();
  assert.equal(approved, 81);
  assert.equal(instance.page.data.activeTab, 'members');
  assert.equal(instance.page.data.view.keyword, '杭州');
  assert.equal(instance.page.data.view.filtersOpen, true);
  assert.equal(instance.page.data.view.list[0].id, 503);
  assert.equal(instance.page.data.view.requestProcessingId, '');
  assert.equal(instance.reads.members, before + 1, 'approval must complete one fresh member read');
});

test('workspace input updates have the same small payload with one or fifty member rows', async () => {
  const sizes = [];
  for (const count of [1, 50]) {
    const instance = setup({ members: () => Promise.resolve({
      list: Array.from({ length: count }, (_, index) => ({ ...member(501 + index), selfIntro: '期望建立真诚长久的关系。' })), total: count
    }) });
    await start(instance, 'members');
    const before = instance.calls.updates.length;
    instance.page.workspace_members_onKeyword(event({ value: '杭州' }));
    const updates = instance.calls.updates.slice(before);
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0]), ['view.keyword']);
    assert.equal(instance.page.data.view.keyword, '杭州');
    assert.equal(instance.page.data.view.list.length, count, 'an incremental input update must preserve the rendered rows');
    sizes.push(Buffer.byteLength(JSON.stringify(updates[0])));
  }
  assert.equal(sizes[0], sizes[1]);
  assert.ok(sizes[1] < 100);
});

test('workspace nested array patches update the rendered row while removing private field paths', async () => {
  const instance = setup();
  await start(instance, 'members');
  const controller = instance.page._controllers.members;
  const before = instance.calls.updates.length;
  controller.setData({
    'list[0].displayName': '更新后的会员',
    'list[0].privateArchive': { file: 'PRIVATE_ARCHIVE_MARKER' },
    'list[0].phone': 'PRIVATE_PHONE_MARKER',
    'list[0].nested': { safe: 'kept', password: 'PRIVATE_PASSWORD_MARKER' }
  });
  assert.equal(instance.page.data.view.list[0].displayName, '更新后的会员');
  assert.equal(controller.data.list[0].displayName, '更新后的会员');
  assert.equal(instance.page.data.view.list[0].nested.safe, 'kept');
  assert.equal(instance.page.data.view.list[0].privateArchive, undefined);
  assert.equal(instance.page.data.view.list[0].phone, undefined);
  assert.doesNotMatch(JSON.stringify(instance.calls.updates.slice(before)), /PRIVATE_.*MARKER/);
  assert.doesNotMatch(JSON.stringify(controller.data), /PRIVATE_.*MARKER/);
});

test('workspace delayed render callbacks cannot run after session or authorization changes', async () => {
  for (const change of ['session', 'authorization']) {
    const instance = setup({}, { manualSetDataCallbacks: true });
    await start(instance, 'members');
    let callbacks = 0;
    const controller = instance.page._controllers.members;
    controller.setData({ keyword: '当前账号' }, () => { callbacks += 1; });
    instance.flushSetDataCallbacks();
    assert.equal(callbacks, 1);
    controller.setData({ keyword: '延迟回调' }, () => { callbacks += 1; });
    if (change === 'session') {
      instance.session.token = 'new-render-session';
      instance.session.user = { id: 2, currentRole: 'matchmaker' };
    } else instance.load(path.join(miniprogramRoot, 'utils/matchmaker-page-cache.js')).invalidateMatchmakerPageSnapshots();
    instance.flushSetDataCallbacks();
    assert.equal(callbacks, 1, change);
  }
});

test('workspace reaching the bottom loads the active member page without dispatching to hidden panels', async () => {
  const instance = setup({ members: (_read, query) => Promise.resolve({
    list: query.page === 1 ? Array.from({ length: 50 }, (_, index) => member(501 + index)) : [member(551)],
    total: 51, page: query.page, pageSize: query.pageSize
  }) });
  await start(instance, 'members');
  assert.equal(instance.page.data.view.list.length, 50);
  await instance.page.onReachBottom();
  assert.equal(instance.page.data.view.list.length, 51);
  assert.equal(instance.page.data.view.list[50].id, 551);
  assert.equal(instance.page.data.view.hasMore, false);
  const memberReads = instance.reads.members;
  await select(instance, 'messages');
  await instance.page.onReachBottom();
  assert.equal(instance.reads.members, memberReads);
});
