const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const pageFiles = {
  dashboard: 'pages/matchmaker/dashboard.js',
  members: 'pages/matchmaker/members.js',
  salon: 'pages/matchmaker/salon.js',
  messages: 'pages/matchmaker/messages.js',
  mine: 'pages/matchmaker/mine.js'
};

function dashboard(status = 2) {
  return {
    matchmaker: { id: 101, userId: 1, certificationStatus: status, memberCount: 2, inviteCode: 'INVITE_CODE' },
    operations: { salonCount: 1, registrationCount: 2, resourceCount: 3, recentRecommendationCount: 1, todoCounts: {} }
  };
}

function member(id, name = 'PRIVATE_MEMBER') {
  return {
    id, userId: id + 100, realName: name, gender: 2, city: '上海', age: 30,
    privateArchive: { credentialLocation: 'EXCLUDED_ARCHIVE_MARKER' }
  };
}

function event(id) {
  return { id, title: 'PRIVATE_EVENT', status: 'upcoming', eventDate: '2026-10-12T00:00:00.000Z' };
}

function conversation(id) {
  return { id, peer: { id: 701, nickname: 'PRIVATE_CONVERSATION' }, conversationType: 'member_matchmaker', unreadCount: 1, updatedAt: '2026-10-06T00:00:00.000Z' };
}

function setup(pageName, responses = {}) {
  const counts = { dashboard: 0, members: 0, inviteOptions: 0, requests: 0, mineEvents: 0, allEvents: 0, conversations: 0, invite: 0, apply: 0 };
  function read(name, fallback, argument) {
    counts[name] += 1;
    return responses[name] ? responses[name](counts[name], argument) : Promise.resolve(fallback);
  }
  const instance = runtime(pageFiles[pageName], {
    matchmakerApi: {
      dashboard: () => read('dashboard', dashboard()),
      apply: async () => { counts.apply += 1; return {}; },
      memberRequests: query => read('requests', { list: [{ id: 81, realName: 'PRIVATE_REQUEST' }], total: 1 }, query),
      inviteCard: () => read('invite', { inviteCode: 'PRIVATE_INVITE_CODE', qrCodeFileID: 'PRIVATE_QR_CODE', sharePath: '/invite' })
    },
    memberApi: {
      list: query => read('members', { list: [member(501), member(502)], total: 2 }, query),
      inviteOptions: query => read('inviteOptions', { list: [501, 502].map(id => ({
        id, userId: id + 100, realName: 'PRIVATE_MEMBER', nickname: ''
      })), total: 2, page: query.page, pageSize: query.pageSize }, query)
    },
    salonApi: {
      myEvents: query => read('mineEvents', { list: [event(301)], total: 1 }, query),
      list: query => read('allEvents', { list: [event(302)], total: 1 }, query)
    },
    chatApi: { listConversations: query => read('conversations', { list: [conversation(901)], total: 1 }, query) }
  });
  instance.session.user.currentRole = 'matchmaker';
  return { ...instance, counts };
}

function loadPage(page) {
  if (page.onLoad) page.onLoad({});
  return page.onShow();
}

function cacheFor(instance) {
  return instance.load(path.join(miniprogramRoot, 'utils/matchmaker-page-cache.js'));
}

function displayedData(pageName, page) {
  if (pageName === 'dashboard') return {
    memberCount: page.data.dashboard.matchmaker.memberCount,
    certificationStatus: page.data.dashboard.matchmaker.certificationStatus
  };
  if (pageName === 'mine') return { inviteCode: page.data.inviteCard.inviteCode, qrCodeFileID: page.data.inviteCard.qrCodeFileID };
  return page.data.list.map(row => ({
    id: row.id,
    name: pageName === 'members' ? row.displayName : pageName === 'messages' ? row.peerName : row.title
  }));
}

test('all five matchmaker pages reconstruct from same-session snapshots without warm network reads', async () => {
  for (const pageName of Object.keys(pageFiles)) {
    const instance = setup(pageName);
    await loadPage(instance.page);
    await flush();
    const displayed = JSON.stringify(displayedData(pageName, instance.page));
    const reads = { ...instance.counts };
    if (instance.page.onUnload) instance.page.onUnload();
    const rebuilt = instance.recreatePage(pageFiles[pageName]);
    if (rebuilt.onLoad) rebuilt.onLoad({});
    const shown = rebuilt.onShow();
    assert.equal(JSON.stringify(displayedData(pageName, rebuilt)), displayed, `${pageName} must restore before fetching`);
    assert.equal(rebuilt.data.loading, false);
    await shown;
    await flush();
    assert.deepEqual(instance.counts, reads, `${pageName} must reuse its warm snapshot`);
    assert.equal(instance.calls.storage.length, 0, 'private navigation snapshots must stay in memory');
  }
});

test('an expired matchmaker member snapshot restores immediately and refreshes quietly', async () => {
  const pending = deferred();
  const instance = setup('members', { members: read => read === 1
    ? Promise.resolve({ list: [member(501)], total: 1 }) : pending.promise });
  await loadPage(instance.page);
  if (instance.page.onUnload) instance.page.onUnload();
  instance.advance(30001);
  const rebuilt = instance.recreatePage(pageFiles.members);
  if (rebuilt.onLoad) rebuilt.onLoad({});
  assert.equal(rebuilt.data.list[0].id, 501);
  const refresh = rebuilt.onShow();
  await flush();
  assert.equal(rebuilt.data.loading, false);
  assert.equal(rebuilt.data.list[0].id, 501);
  assert.equal(instance.counts.members, 2, 'expired member rows must refresh immediately');
  pending.resolve({ list: [member(502)], total: 1 });
  await refresh;
  assert.equal(rebuilt.data.list[0].id, 502);
});

test('network dashboard failures never submit a matchmaker application and can be retried', async () => {
  for (const pageName of ['dashboard', 'members', 'salon', 'mine']) {
    const instance = setup(pageName, { dashboard: read => {
      if (read === 1) throw Object.assign(new Error('network timeout'), { code: 50300 });
      return Promise.resolve(dashboard());
    } });
    await loadPage(instance.page);
    await flush();
    assert.equal(instance.counts.apply, 0, `${pageName} network failure must remain read-only`);
    await instance.page.onShow();
    await flush();
    assert.equal(instance.counts.dashboard, 2);
    assert.equal(instance.page.data.canOperate, true);
  }
});

test('an explicit missing matchmaker record permits one application before retrying its dashboard', async () => {
  const instance = setup('dashboard', { dashboard: read => read === 1
    ? Promise.reject(Object.assign(new Error('matchmaker not found'), { code: 40400 }))
    : Promise.resolve(dashboard(0)) });
  await loadPage(instance.page);
  await flush();
  assert.equal(instance.counts.apply, 1);
  assert.equal(instance.counts.dashboard, 2);
  assert.equal(instance.page.data.canOperate, false);
});

test('member filter responses cannot override a later filter selection', async () => {
  const old = deferred();
  const latest = deferred();
  const instance = setup('members', { members: (_read, query) => query.keyword ? latest.promise : old.promise });
  const initial = loadPage(instance.page);
  await flush();
  assert.equal(instance.counts.members, 1);
  instance.page.onKeyword({ detail: { value: '杭州' } });
  const filtered = instance.page.load(true);
  await flush();
  assert.equal(instance.counts.members, 2);
  latest.resolve({ list: [member(502, '杭州会员')], total: 1 });
  await filtered;
  old.resolve({ list: [member(501, '旧筛选会员')], total: 1 });
  await initial;
  await flush();
  assert.equal(instance.page.data.keyword, '杭州');
  assert.equal(instance.page.data.list[0].id, 502);
});

test('returning from member creation supersedes an older background member read', async () => {
  const old = deferred();
  const instance = setup('members', { members: read => read === 2
    ? old.promise : Promise.resolve({ list: [member(read === 1 ? 501 : 503)], total: 1 }) });
  await loadPage(instance.page);
  instance.advance(30001);
  const background = instance.page.onShow();
  await flush();
  instance.page.goAdd();
  const returned = instance.page.onShow();
  await flush();
  assert.equal(instance.counts.members, 3);
  old.resolve({ list: [member(502)], total: 1 });
  await Promise.all([background, returned]);
  assert.equal(instance.page.data.list[0].id, 503);
});

test('salon navigation remembers all-events selection and refreshes after creating an event', async () => {
  const instance = setup('salon', { allEvents: read => Promise.resolve({ list: [event(300 + read)], total: 1 }) });
  await loadPage(instance.page);
  await instance.page.loadAll();
  if (instance.page.onUnload) instance.page.onUnload();
  const rebuilt = instance.recreatePage(pageFiles.salon);
  if (rebuilt.onLoad) rebuilt.onLoad({});
  assert.equal(rebuilt.data.active, 'all');
  assert.equal(rebuilt.data.list[0].id, 301);
  await rebuilt.onShow();
  assert.equal(instance.counts.allEvents, 1);
  rebuilt.goCreate();
  await rebuilt.onShow();
  assert.equal(instance.counts.allEvents, 2);
  assert.equal(rebuilt.data.active, 'all');
  assert.equal(rebuilt.data.list[0].id, 302);
});

test('different matchmaker pages reuse the same warm dashboard while reading their own lists', async () => {
  const instance = setup('members');
  await loadPage(instance.page);
  instance.page.onUnload();
  const salon = instance.recreatePage(pageFiles.salon);
  await loadPage(salon);
  salon.onUnload();
  const mine = instance.recreatePage(pageFiles.mine);
  await loadPage(mine);
  assert.equal(instance.counts.dashboard, 1);
  assert.equal(instance.counts.members, 1, 'salon activities must not eagerly read another full member list');
  assert.equal(instance.counts.inviteOptions, 0, 'invite options wait for the management panel');
  assert.equal(instance.counts.mineEvents, 1);
  assert.equal(instance.counts.invite, 1);
});

test('navigation snapshots recursively exclude archives and credentials and remain independent copies', () => {
  const instance = setup('dashboard');
  const cache = cacheFor(instance);
  const value = { title: 'renderable', rows: [{ id: 5, nickname: 'shown',
    privateArchive: { evidence: 'PRIVATE_MARKER' }, phone: 'PHONE_MARKER',
    nested: { private_photos: ['PHOTO_MARKER'], accessToken: 'TOKEN_MARKER', password: 'PASSWORD_MARKER', safe: ['kept'] } }] };
  cache.writeMatchmakerPageSnapshot('/test-copy', value);
  value.rows[0].nested.safe[0] = 'changed-after-write';
  const first = cache.readMatchmakerPageSnapshot('/test-copy');
  assert.equal(first.data.rows[0].nested.safe[0], 'kept');
  assert.equal(first.data.rows[0].privateArchive, undefined);
  assert.equal(first.data.rows[0].phone, undefined);
  assert.equal(JSON.stringify(first).includes('MARKER'), false);
  first.data.rows[0].nested.safe[0] = 'changed-after-read';
  assert.equal(cache.readMatchmakerPageSnapshot('/test-copy').data.rows[0].nested.safe[0], 'kept');
  instance.advance(30001);
  assert.ok(cache.readMatchmakerPageSnapshot('/test-copy'), 'expired snapshots remain available for immediate render');
  assert.equal(instance.calls.storage.length, 0);
});

test('snapshot scopes isolate account, environment and role and never cache without a token', () => {
  for (const change of [
    instance => { instance.session.token = 'different-session'; },
    instance => { instance.session.user = { id: 2, currentRole: 'matchmaker' }; },
    instance => { instance.session.env = 'other-environment'; },
    instance => { instance.session.user.currentRole = 'user'; }
  ]) {
    const instance = setup('dashboard');
    const cache = cacheFor(instance);
    cache.writeMatchmakerPageSnapshot('/test-scope', { nickname: 'old-account' });
    const previousRevision = cache.matchmakerPageSnapshotRevision();
    change(instance);
    assert.equal(cache.readMatchmakerPageSnapshot('/test-scope'), null);
    assert.ok(cache.matchmakerPageSnapshotRevision() > previousRevision);
  }
  const instance = setup('dashboard');
  const cache = cacheFor(instance);
  instance.session.token = '';
  cache.writeMatchmakerPageSnapshot('/test-scope', { nickname: 'unauthenticated' });
  assert.equal(cache.readMatchmakerPageSnapshot('/test-scope'), null);
});

test('shared snapshot reads deduplicate and a forced replacement discards the old pending result', async () => {
  const instance = setup('dashboard');
  const cache = cacheFor(instance);
  const old = deferred();
  let reads = 0;
  const first = cache.requestMatchmakerPageSnapshot('/shared', () => { reads += 1; return old.promise; });
  const second = cache.requestMatchmakerPageSnapshot('/shared', () => { reads += 1; return Promise.resolve({ id: 999 }); });
  const settled = Promise.allSettled([first, second]);
  await flush();
  assert.equal(reads, 1);
  const replacement = await cache.requestMatchmakerPageSnapshot('/shared', () => { reads += 1; return Promise.resolve({ id: 2 }); }, true);
  assert.equal(replacement.data.id, 2);
  old.resolve({ id: 1 });
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'MatchmakerPageRequestDiscarded'));
  assert.equal(cache.readMatchmakerPageSnapshot('/shared').data.id, 2);
  const warm = await cache.requestMatchmakerPageSnapshot('/shared', () => { reads += 1; return Promise.resolve({ id: 3 }); });
  assert.equal(warm.data.id, 2);
  assert.equal(reads, 2);
});

test('partial member and salon refresh failures retain lists and permit an immediate retry', async () => {
  for (const pageName of ['members', 'salon']) {
    const instance = setup(pageName, pageName === 'members' ? {
      requests: read => read === 2 ? Promise.reject(new Error('temporary request failure')) : Promise.resolve({ list: [], total: 0 })
    } : {
      mineEvents: read => read === 2 ? Promise.reject(new Error('temporary event failure')) : Promise.resolve({ list: [event(301)], total: 1 })
    });
    await loadPage(instance.page);
    const shown = JSON.stringify(displayedData(pageName, instance.page));
    await instance.page.refreshGate(true);
    assert.equal(JSON.stringify(displayedData(pageName, instance.page)), shown);
    assert.ok(instance.page.data.refreshError);
    const before = pageName === 'members' ? instance.counts.requests : instance.counts.mineEvents;
    await instance.page.onShow();
    assert.equal(pageName === 'members' ? instance.counts.requests : instance.counts.mineEvents, before + 1,
      `${pageName} must not rate-limit retry after a partial force failure`);
    assert.equal(instance.page.data.refreshError, '');
  }
});

test('ordinary expired refresh errors retain member data and never submit an application', async () => {
  const instance = setup('members', { dashboard: read => read === 2
    ? Promise.reject(Object.assign(new Error('network timeout'), { code: 50300 })) : Promise.resolve(dashboard()) });
  await loadPage(instance.page);
  instance.advance(30001);
  await instance.page.onShow();
  assert.equal(instance.page.data.list[0].id, 501);
  assert.equal(instance.page.data.canOperate, true);
  assert.equal(instance.counts.apply, 0);
  await instance.page.onShow();
  assert.equal(instance.counts.dashboard, 3);
  assert.equal(instance.page.data.refreshError, '');
});

test('an account change clears member UI immediately and an old response cannot return', async () => {
  const old = deferred();
  const latest = deferred();
  const instance = setup('members', { members: read => read === 1 ? old.promise : latest.promise });
  const initial = loadPage(instance.page);
  await flush();
  instance.session.token = 'account-two-token';
  instance.session.user = { id: 2, currentRole: 'matchmaker' };
  const switched = instance.page.onShow();
  assert.equal(instance.page.data.list.length, 0);
  assert.equal(instance.page.data.recommendReady, false);
  await flush();
  latest.resolve({ list: [member(502, '新账号会员')], total: 1 });
  await switched;
  old.resolve({ list: [member(501, '旧账号会员')], total: 1 });
  await initial;
  assert.equal(instance.page.data.list[0].id, 502);
  assert.equal(instance.counts.apply, 0);
});

test('certification revocation clears all restricted member, salon and invite UI and snapshots', async () => {
  for (const pageName of ['members', 'salon', 'mine', 'dashboard']) {
    const instance = setup(pageName, { dashboard: read => Promise.resolve(dashboard(read === 1 ? 2 : 1)) });
    await loadPage(instance.page);
    assert.equal(instance.page.data.canOperate, true);
    if (pageName === 'members') instance.page.toggleRecommend();
    if (pageName === 'salon') {
      await instance.page.toggleEventManagement({ currentTarget: { dataset: { id: 301 } } });
      assert.ok(instance.page.data.memberOptions.length, 'load real private invite state before revocation');
    }
    if (pageName === 'mine') instance.page.toggleInvite();
    await (instance.page.refreshGate ? instance.page.refreshGate(true) : instance.page.loadDashboard(true));
    assert.equal(instance.page.data.canOperate, false, pageName);
    if (pageName === 'members') {
      assert.equal(instance.page.data.list.length, 0);
      assert.equal(instance.page.data.pendingRequests.length, 0);
      assert.equal(instance.page.data.recommendAOptions.length, 0);
      assert.equal(instance.page.data.recommendReady, false);
      assert.equal(cacheFor(instance).readMatchmakerPageSnapshot('/pages/matchmaker/members'), null);
    } else if (pageName === 'salon') {
      assert.equal(instance.page.data.list.length, 0);
      assert.equal(instance.page.data.memberOptions.length, 0);
      assert.equal(instance.page.data.selectedMemberName, '');
      assert.equal(instance.page.data.shareCode, '');
      assert.equal(cacheFor(instance).readMatchmakerPageSnapshot('/pages/matchmaker/salon'), null);
    } else {
      assert.equal(instance.page.data.dashboard.matchmaker.memberCount, 0);
      if (pageName === 'mine') {
        assert.equal(instance.page.data.inviteCard.inviteCode, '');
        assert.equal(instance.page.data.inviteCard.qrCodeFileID, '');
        assert.equal(instance.page.data.inviteOpen, false);
      }
      assert.equal(JSON.stringify(cacheFor(instance).readMatchmakerPageSnapshot('/matchmaker/dashboard')).includes('INVITE_CODE'), false);
    }
    instance.page.onUnload();
    const rebuilt = instance.recreatePage(pageFiles[pageName]);
    if (rebuilt.onLoad) rebuilt.onLoad({});
    const show = rebuilt.onShow();
    assert.equal(JSON.stringify(rebuilt.data).includes('PRIVATE_MEMBER'), false);
    assert.equal(JSON.stringify(rebuilt.data).includes('PRIVATE_INVITE_CODE'), false);
    await show;
  }
});

test('a denied member sub-read removes old private UI even when the dashboard still says certified', async () => {
  const instance = setup('members', { requests: read => read === 2
    ? Promise.reject(Object.assign(new Error('permission denied'), { code: 40301 })) : Promise.resolve({ list: [{ id: 81 }], total: 1 }) });
  await loadPage(instance.page);
  await instance.page.load(true);
  assert.equal(instance.page.data.canOperate, false);
  assert.equal(instance.page.data.list.length, 0);
  assert.equal(instance.page.data.pendingRequests.length, 0);
  assert.equal(instance.page.data.recommendReady, false);
  assert.equal(cacheFor(instance).readMatchmakerPageSnapshot('/pages/matchmaker/members'), null);
});

test('matchmaker messages expire after ten seconds and quietly retain rows on network failure with retry', async () => {
  const instance = setup('messages', { conversations: read => read === 2
    ? Promise.reject(new Error('offline')) : Promise.resolve({ list: [conversation(900 + read)], total: 1 }) });
  await loadPage(instance.page);
  instance.advance(10001);
  const refresh = instance.page.onShow();
  assert.equal(instance.page.data.loading, false);
  assert.equal(instance.page.data.list[0].id, 901);
  await refresh;
  assert.equal(instance.page.data.list[0].id, 901);
  assert.ok(instance.page.data.errorNote);
  await instance.page.onShow();
  assert.equal(instance.counts.conversations, 3);
  assert.equal(instance.page.data.list[0].id, 903);
  assert.equal(instance.page.data.errorNote, '');
});

test('authorization revision invalidation discards late messages and unloading cannot resurrect their snapshot', async () => {
  const old = deferred();
  const instance = setup('messages', { conversations: read => read === 2
    ? old.promise : Promise.resolve({ list: [conversation(901)], total: 1 }) });
  await loadPage(instance.page);
  instance.advance(10001);
  const pending = instance.page.onShow();
  await flush();
  const cache = cacheFor(instance);
  cache.invalidateMatchmakerPageSnapshots();
  instance.page.synchronizeSession();
  assert.equal(instance.page.data.list.length, 0);
  old.resolve({ list: [conversation(902)], total: 1 });
  await pending;
  assert.equal(instance.page.data.list.length, 0);
  instance.page.onUnload();
  assert.equal(cache.readMatchmakerPageSnapshot('pages/matchmaker/messages'), null);
  const rebuilt = instance.recreatePage(pageFiles.messages);
  assert.equal(rebuilt.data.list.length, 0);
});

test('member and salon late list reads cannot revive a revoked authorization revision', async () => {
  for (const pageName of ['members', 'salon']) {
    const old = deferred();
    const instance = setup(pageName, pageName === 'members'
      ? { members: read => read === 2 ? old.promise : Promise.resolve({ list: [member(501)], total: 1 }) }
      : { mineEvents: read => read === 2 ? old.promise : Promise.resolve({ list: [event(301)], total: 1 }) });
    await loadPage(instance.page);
    instance.advance(30001);
    const pending = instance.page.onShow();
    await flush();
    cacheFor(instance).invalidateMatchmakerPageSnapshots();
    instance.page.ensurePageSession();
    assert.equal(instance.page.data.canOperate, false);
    assert.equal(instance.page.data.list.length, 0);
    old.resolve({ list: [pageName === 'members' ? member(502) : event(302)], total: 1 });
    await pending;
    assert.equal(instance.page.data.list.length, 0);
    instance.page.onUnload();
    assert.equal(cacheFor(instance).readMatchmakerPageSnapshot(`/pages/matchmaker/${pageName}`), null);
  }
});

test('switching salon selection supersedes an old mine-events read', async () => {
  const old = deferred();
  const instance = setup('salon', { mineEvents: () => old.promise });
  const initial = loadPage(instance.page);
  await flush();
  const selected = instance.page.loadAll();
  await selected;
  assert.equal(instance.page.data.active, 'all');
  assert.equal(instance.page.data.list[0].id, 302);
  old.resolve({ list: [event(301)], total: 1 });
  await initial;
  assert.equal(instance.page.data.active, 'all');
  assert.equal(instance.page.data.list[0].id, 302);
});

test('returning from chat supersedes an older messages background read', async () => {
  const old = deferred();
  const instance = setup('messages', { conversations: read => read === 2
    ? old.promise : Promise.resolve({ list: [conversation(900 + read)], total: 1 }) });
  await loadPage(instance.page);
  instance.advance(10001);
  const background = instance.page.onShow();
  await flush();
  instance.page.openChat({ currentTarget: { dataset: { id: 901 } } });
  await instance.page.onShow();
  assert.equal(instance.counts.conversations, 3);
  assert.equal(instance.page.data.list[0].id, 903);
  old.resolve({ list: [conversation(902)], total: 1 });
  await background;
  assert.equal(instance.page.data.list[0].id, 903);
});

test('invite access denial clears invite data and a late superseded card cannot restore it', async () => {
  const old = deferred();
  const instance = setup('mine', { invite: read => read === 2 ? old.promise : read === 3
    ? Promise.reject(Object.assign(new Error('certification revoked'), { code: 40301 }))
    : Promise.resolve({ inviteCode: 'PRIVATE_INVITE_CODE', qrCodeFileID: 'PRIVATE_QR_CODE' }) });
  await loadPage(instance.page);
  const pending = instance.page.loadInviteCard(false, true);
  await flush();
  await instance.page.loadInviteCard(false, true);
  assert.equal(instance.page.data.canOperate, false);
  assert.equal(instance.page.data.inviteCard.inviteCode, '');
  assert.equal(cacheFor(instance).readMatchmakerPageSnapshot('/matchmaker/invite-card'), null);
  old.resolve({ inviteCode: 'LATE_PRIVATE_INVITE_CODE', qrCodeFileID: 'LATE_PRIVATE_QR_CODE' });
  await pending;
  assert.equal(instance.page.data.inviteCard.inviteCode, '');
  assert.equal(cacheFor(instance).readMatchmakerPageSnapshot('/matchmaker/invite-card'), null);
});

test('a failed forced shared read permits retry and an older failure cannot remove a newer snapshot', async () => {
  const instance = setup('dashboard');
  const cache = cacheFor(instance);
  let reads = 0;
  cache.writeMatchmakerPageSnapshot('/shared-failure', { id: 1 });
  await assert.rejects(cache.requestMatchmakerPageSnapshot('/shared-failure', () => {
    reads += 1;
    return Promise.reject(new Error('temporary network failure'));
  }, true));
  const failedSnapshot = cache.readMatchmakerPageSnapshot('/shared-failure');
  assert.equal(failedSnapshot.data.id, 1, 'failed refresh retains the immediate render data');
  assert.equal(failedSnapshot.loadedAt <= Date.UTC(2026, 9, 6) - cache.MATCHMAKER_PAGE_TTL_MS, true);
  const recovered = await cache.requestMatchmakerPageSnapshot('/shared-failure', () => {
    reads += 1;
    return Promise.resolve({ id: 2 });
  });
  assert.equal(reads, 2);
  assert.equal(recovered.data.id, 2);
  const old = deferred();
  const earlier = cache.requestMatchmakerPageSnapshot('/shared-failure', () => old.promise, true);
  const settled = Promise.allSettled([earlier]);
  await flush();
  await cache.requestMatchmakerPageSnapshot('/shared-failure', () => Promise.resolve({ id: 3 }), true);
  old.reject(new Error('late previous failure'));
  await settled;
  assert.equal(cache.readMatchmakerPageSnapshot('/shared-failure').data.id, 3);
});

test('failed dashboard refresh retains the immediate render snapshot after reconstruction', async () => {
  for (const pageName of ['dashboard', 'mine']) {
    const retry = deferred();
    const instance = setup(pageName, { dashboard: read => read === 2
      ? Promise.reject(new Error('temporary network failure')) : read === 3 ? retry.promise : Promise.resolve(dashboard()) });
    await loadPage(instance.page);
    const visible = JSON.stringify(displayedData(pageName, instance.page));
    instance.advance(30001);
    await instance.page.onShow();
    assert.equal(JSON.stringify(displayedData(pageName, instance.page)), visible, `${pageName} must keep loaded UI on network failure`);
    instance.page.onUnload();
    const rebuilt = instance.recreatePage(pageFiles[pageName]);
    const pending = rebuilt.onShow();
    try {
      await flush();
      assert.equal(JSON.stringify(displayedData(pageName, rebuilt)), visible, `${pageName} must restore old UI while retry is pending`);
      assert.equal(rebuilt.data.loading, false, `${pageName} must retry quietly after reconstruction`);
    } finally {
      retry.resolve(dashboard());
      await pending;
    }
  }
});
