const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const touch = dataset => ({ currentTarget: { dataset } });
const vip = () => ({ isPremiumMember: true, membershipTier: 'vip', entitlements: {}, expireAt: '2026-12-01T00:00:00Z', privacy: { invisible: false } });
const readiness = { ready: true, profileComplete: true, matchmakerConfirmed: true, matchmakerId: 7, reason: '' };
const request = extra => ({ id: 'request_a', memberUserId: 1, targetUserId: 2, status: 'pending', memberConsent: false, targetConsent: false,
  serviceConfirmed: false, createdAt: '2026-10-06T00:00:00Z', ...extra });
const exchange = extra => ({ id: 'exchange_1_2', requesterId: 2, recipientId: 1, status: 'pending', createdAt: '2026-10-06T00:00:00Z', ...extra });
const packageBalance = extra => ({ id: 'package_a', planTitle: '人工牵线2次', status: 'active', totalCount: 2, usedCount: 0,
  remainingCount: 2, expireAt: '2026-11-06T00:00:00Z', ...extra });
const progress = extra => ({ status: 'needs_profile', purchased: true, profileComplete: false, assigned: false,
  matchmakerConfirmed: false, matchmakerId: null, matchmakerUserId: null, matchmakerName: '', requestedAt: '2026-10-06T00:00:00Z',
  remainingCount: 2, earliestExpireAt: '2026-11-06T00:00:00Z', ...extra });

test('ordinary viewers can browse categories and free filters, while advanced search still requires VIP', async () => {
  const reads = [];
  const { page, calls } = runtime('pages/user/members.js', { source: true, memberApi: {
    showcase: async query => { reads.push({ ...query }); return { list: [{ id: 11, userId: 2 }], total: 1 }; }
  } });
  await page.onShow();
  await page.switchCategory(touch({ category: 'education' }));
  assert.equal(page.data.category, 'education');
  assert.equal(reads.length, 2);
  assert.equal(calls.navigation.length, 0);
  page.toggleFilter();
  page.onKeyword({ detail: { value: '工程师' } });
  page.onCity({ detail: { value: '上海' } });
  page.setGender(touch({ gender: '2' }));
  await page.search();
  assert.equal(reads.at(-1).keyword, '工程师');
  assert.equal(reads.at(-1).city, '上海');
  assert.equal(reads.at(-1).gender, '2');
  assert.equal(reads.at(-1).education, undefined);
  const readCount = reads.length;
  page.setData({ draftAgeMin: '28' });
  await page.search();
  assert.equal(calls.navigation.at(-1).url, '/pages/user/membership');
  assert.equal(reads.length, readCount);
  assert.equal(page.data.ageMin, '');
  assert.equal(page.data.category, 'education');
});

test('VIP advanced criteria use separate cache keys and the badge survives sanitized showcase caches', async () => {
  const reads = [];
  const { page, load } = runtime('pages/user/members.js', { source: true, memberApi: {
    vipOverview: async () => vip(),
    showcase: async query => { reads.push({ ...query }); return { list: [{ id: 11, userId: 2, vipBadge: true, membershipTier: 'vip' }], total: 1 }; }
  } });
  await page.onShow();
  page.toggleFilter();
  page.onAdvancedInput({ currentTarget: { dataset: { field: 'draftAgeMin' } }, detail: { value: '28' } });
  page.onAdvancedInput({ currentTarget: { dataset: { field: 'draftAgeMax' } }, detail: { value: '36' } });
  page.onAdvancedPicker({ currentTarget: { dataset: { field: 'draftEducation' } }, detail: { value: '3' } });
  await page.search();
  assert.equal(reads.at(-1).ageMin, '28');
  assert.equal(reads.at(-1).ageMax, '36');
  assert.equal(reads.at(-1).education, '本科');
  assert.equal(page.data.currentMember.vipBadge, true);
  const cache = load(require('node:path').join(__dirname, '..', 'miniprogram/utils/showcase-cache.ts'));
  const query = page.showcaseQuery();
  assert.notEqual(cache.showcaseQueryKey(query), cache.showcaseQueryKey({ ...query, ageMin: '29' }));
});

test('an entitlement expiry clears advanced filters while preserving the public category', async () => {
  let active = true;
  const expiry = new Date(Date.UTC(2026, 9, 6) + 500).toISOString();
  const { page, advance } = runtime('pages/user/members.js', { source: true, memberApi: {
    vipOverview: async () => ({ ...vip(), isPremiumMember: active, expireAt: expiry }),
    showcase: async () => ({ list: [{ id: 11, userId: 2 }], total: 1 })
  } });
  await page.onShow();
  await page.switchCategory(touch({ category: 'assets' }));
  assert.equal(page.data.category, 'assets');
  page.setData({ ageMin: '30', draftAgeMin: '30' });
  active = false;
  advance(600);
  await page.onShow();
  assert.equal(page.data.isVip, false);
  assert.equal(page.data.category, 'assets');
  assert.equal(page.data.ageMin, '');
  assert.equal(page.data.draftAgeMin, '');
});

test('an unavailable entitlement refresh preserves public categories and removes advanced filters', async () => {
  let unavailable = false;
  const { page, advance } = runtime('pages/user/members.js', { source: true, memberApi: {
    vipOverview: async () => { if (unavailable) throw new Error('unavailable'); return vip(); },
    showcase: async () => ({ list: [{ id: 11, userId: 2 }], total: 1 })
  } });
  await page.onShow();
  await page.switchCategory(touch({ category: 'education' }));
  page.setData({ ageMin: '30', draftAgeMin: '30' });
  unavailable = true;
  advance(45001);
  await page.onShow();
  assert.equal(page.data.category, 'education');
  assert.equal(page.data.isVip, false);
  assert.equal(page.data.ageMin, '');
  assert.equal(page.data.draftAgeMin, '');
});

test('a non-VIP recipient can consent to an incoming exchange but cannot initiate one or reveal pending contacts', async () => {
  const responses = [], reveals = [];
  const { page, calls } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    wechatExchanges: async () => ({ list: [exchange()] }),
    visitors: async () => { throw new Error('must not read VIP visitors'); },
    respondWechatExchange: async (id, data) => { responses.push({ id, data }); return exchange({ status: 'accepted' }); },
    wechatExchange: async id => { reveals.push(id); return exchange({ status: 'accepted', wechat: { mine: 'mine', peer: 'peer' } }); }
  } });
  page.onLoad({ section: 'exchanges', targetUserId: '2' });
  await page.onShow();
  assert.equal(page.data.isVip, false);
  assert.equal(page.data.canRespondExchange, true);
  assert.equal(page.data.visitors.length, 0);
  await page.revealWechat(touch({ id: 'exchange_1_2' }));
  assert.equal(reveals.length, 0);
  page.onWechatInput({ detail: { value: 'my_personal_wechat' } });
  await page.respondExchange(touch({ id: 'exchange_1_2', accepted: true }));
  assert.equal(responses[0].data.accepted, true);
  assert.equal(responses[0].data.wechatId, 'my_personal_wechat');
  page.requestExchange();
  assert.equal(calls.navigation.at(-1).url, '/pages/user/membership');
});

test('a changed account discards late VIP overview and private records', async () => {
  const pending = deferred();
  const { page, session } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: () => pending.promise,
    wechatExchanges: async () => ({ list: [exchange({ status: 'accepted' })] })
  } });
  const loading = page.onShow();
  session.token = 'new-account-token'; session.user = { id: 9 };
  pending.resolve(vip());
  await loading;
  assert.equal(page.data.isVip, false);
  assert.equal(page.data.exchanges.length, 0);
  assert.equal(page.data.revealedWechat, '');
});

test('member consent stays unavailable until the current matchmaker confirms service arrangements', async () => {
  let serviceConfirmed = false;
  const responses = [];
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    matchmakingRequests: async () => ({ list: [request({ serviceConfirmed })] }),
    respondMatchmaking: async (id, data) => { responses.push({ id, data }); return request({ serviceConfirmed: true, memberConsent: true }); }
  } });
  await page.onShow();
  assert.equal(page.data.requests[0].canRespond, false);
  await page.respondMatchmaking(touch({ id: 'request_a', accepted: true }));
  assert.equal(responses.length, 0);
  serviceConfirmed = true;
  await page.load();
  assert.equal(page.data.requests[0].canRespond, true);
  await page.respondMatchmaking(touch({ id: 'request_a', accepted: true }));
  assert.equal(responses[0].data.accepted, true);
});

test('a non-VIP member with an independent active package can submit a prepared manual matchmaking request', async () => {
  const submitted = [];
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => ({ isPremiumMember: false, membershipTier: 'free', entitlements: {}, matchmakingReadiness: readiness,
      matchmakingPackages: [{ id: 'package_a', planTitle: '人工牵线1个月', status: 'active', totalCount: 2, usedCount: 0, remainingCount: 2, expireAt: '2026-11-06T00:00:00Z' }] }),
    requestMatchmaking: async data => { submitted.push(data); return request(); }
  } });
  page.onLoad({ section: 'matchmaking', targetUserId: '2' });
  await page.onShow();
  assert.equal(page.data.isVip, false);
  await page.applyMatchmaking();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].targetUserId, 2);
});

test('paid service displays each next step without making users find their own principal', async () => {
  for (const [status, profileComplete, assigned, matchmakerConfirmed, label] of [
    ['needs_profile', false, false, false, '完善资料'],
    ['awaiting_assignment', true, false, false, '平台待分配'],
    ['awaiting_contact', true, true, false, '主理人待对接'],
    ['ready', true, true, true, '可申请人工牵线']
  ]) {
    const submitted = [];
    const { page, calls } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
      vipOverview: async () => ({ ...vip(), isPremiumMember: false, matchmakingPackages: [packageBalance()],
        matchmakingProgress: progress({ status, profileComplete, assigned, matchmakerConfirmed, matchmakerId: assigned ? 7 : null }) }),
      requestMatchmaking: async data => { submitted.push(data); return request(); }
    } });
    page.onLoad({ type: 'matchmaking', targetUserId: '2' });
    await page.onShow();
    assert.match(page.data.matchmakingProgressTitle, new RegExp(label));
    assert.equal(page.data.hasMatchmakingService, true);
    assert.equal(page.data.canContactMatchmaker, assigned);
    assert.equal(page.data.matchmakingReady, status === 'ready');
    await page.applyMatchmaking();
    assert.equal(submitted.length, status === 'ready' ? 1 : 0);
    assert.equal(calls.navigation.length, 0);
    if (!assigned) {
      await page.contactMatchmaker();
      assert.equal(calls.navigation.length, 0);
    }
  }
});

test('legacy readiness builds a platform assignment next step while purchase remains available', async () => {
  const { page, calls } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => ({ ...vip(), isPremiumMember: false, matchmakingPackages: [packageBalance()],
      matchmakingReadiness: { ...readiness, ready: false, activeAssignment: false, matchmakerId: null } })
  } });
  page.onLoad({ type: 'matchmaking' });
  await page.onShow();
  assert.equal(page.data.matchmakingProgress.status, 'awaiting_assignment');
  assert.equal(page.data.canContactMatchmaker, false);
  assert.match(page.data.matchmakingProgressNote, /平台将安排主理人/);
  page.goMembership();
  assert.equal(calls.navigation.at(-1).url, '/pages/user/membership?type=matchmaking');
});

test('optional contact opens only the current assigned principal and never an old service conversation', async () => {
  const targets = [];
  const { page, calls } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => ({ ...vip(), isPremiumMember: false, matchmakingPackages: [packageBalance()],
      matchmakingProgress: progress({ status: 'awaiting_contact', assigned: true, matchmakerId: 7, matchmakerUserId: 70 }) })
  }, chatApi: {
    listConversations: async () => ({ list: [{ id: 80, conversationType: 'member_matchmaker', peer: { id: 71 } }] }),
    getOrCreateConversation: async data => { targets.push(data.targetUserId); return { id: 90 }; }
  } });
  await page.onShow();
  await page.contactMatchmaker();
  assert.deepEqual(targets, [70]);
  assert.equal(calls.navigation.at(-1).url, '/pages/user/chat?id=90');
});

test('legacy preparation with a false ready flag does not unlock a recommendation request', async () => {
  const submitted = [];
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => ({ ...vip(), isPremiumMember: false, matchmakingPackages: [packageBalance()],
      matchmakingReadiness: { ...readiness, ready: false } }),
    requestMatchmaking: async data => submitted.push(data)
  } });
  page.onLoad({ type: 'matchmaking', targetUserId: '2' });
  await page.onShow();
  assert.equal(page.data.matchmakingReady, false);
  await page.applyMatchmaking();
  assert.equal(submitted.length, 0);
});

test('expired, exhausted and refunded packages keep records without enabling a new recommendation request', async () => {
  for (const status of ['expired', 'exhausted', 'refunded']) {
    const submitted = [];
    const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
      vipOverview: async () => ({ ...vip(), isPremiumMember: false, matchmakingPackages: [packageBalance({ status })],
        matchmakingProgress: progress({ status, remainingCount: 0 }) }),
      requestMatchmaking: async data => submitted.push(data)
    } });
    page.onLoad({ type: 'matchmaking', targetUserId: '2' });
    await page.onShow();
    assert.equal(page.data.packages.length, 1);
    assert.equal(page.data.matchmakingReady, false);
    assert.equal(page.data.hasMatchmakingService, false);
    await page.applyMatchmaking();
    assert.equal(submitted.length, 0);
  }
});

test('a matchmaker manages only the selected owned member and approves arrangements without consenting for either party', async () => {
  const approvals = [], confirmations = [];
  const { page, session } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    matchmakingReadiness: async () => readiness,
    matchmakingRequests: async () => ({ list: [request(), request({ id: 'request_b', memberUserId: 5 })] }),
    approveMatchmaking: async id => { approvals.push(id); return request({ serviceConfirmed: true }); },
    respondMatchmaking: async (...args) => { confirmations.push(args); return {}; }
  } });
  session.user = { id: 7, currentRole: 'matchmaker' };
  page.onLoad({ tab: 'matchmaking', memberUserId: '1' });
  await page.onShow();
  assert.equal(page.data.managingMember, true);
  assert.equal(page.data.requests.length, 1);
  assert.equal(page.data.requests[0].canRespond, false);
  await page.approveMatchmaking(touch({ id: 'request_a' }));
  await page.respondMatchmaking(touch({ id: 'request_a', accepted: true }));
  assert.deepEqual(approvals, ['request_a']);
  assert.equal(confirmations.length, 0);
});

test('detail visits are recorded only after an accessible detail response while the page remains visible', async () => {
  const visits = [];
  const first = runtime('pages/user/member-detail.js', { source: true, memberApi: {
    showcaseDetail: async () => ({ id: 11, userId: 2, realName: '会员', viewerState: {} }),
    recordVisit: async id => { visits.push(id); return { recorded: true }; }
  } });
  first.page.setData({ id: '11' });
  await first.page.load();
  assert.deepEqual(visits, [2]);
  const pending = deferred();
  const second = runtime('pages/user/member-detail.js', { source: true, memberApi: {
    showcaseDetail: () => pending.promise,
    recordVisit: async id => { visits.push(id); return { recorded: true }; }
  } });
  second.page.setData({ id: '12' });
  const loading = second.page.load();
  second.page.onHide();
  pending.resolve({ id: 12, userId: 3, viewerState: {} });
  await loading;
  assert.deepEqual(visits, [2]);
});

test('foreground heartbeat skips anonymous sessions, stops in background and reads the current account on each minute', async () => {
  const seen = [];
  let context;
  context = runtime('app.js', { source: true, memberApi: {
    updatePresence: async () => { seen.push(context.session.user.id); return { online: true }; }
  } });
  context.session.token = ''; context.session.user = null;
  context.page.onShow();
  context.advance(60000); await flush();
  assert.equal(seen.length, 0);
  context.session.token = 'first'; context.session.user = { id: 1 };
  context.advance(60000); await flush();
  assert.deepEqual(seen, [1]);
  context.session.token = 'second'; context.session.user = { id: 2 };
  context.advance(60000); await flush();
  assert.deepEqual(seen, [1, 2]);
  context.page.onHide(); context.advance(180000); await flush();
  assert.deepEqual(seen, [1, 2]);
});

test('startup heartbeat waits for App registration and resumes on the next foreground interval', async () => {
  let registered = false;
  let updates = 0;
  const context = runtime('app.js', { source: true,
    getApp: session => registered ? ({ globalData: session }) : undefined,
    memberApi: { updatePresence: async () => { updates += 1; return { online: true }; } }
  });
  assert.doesNotThrow(() => context.page.onShow());
  assert.equal(updates, 0);
  registered = true;
  context.advance(60000); await flush();
  assert.equal(updates, 1);
  context.page.onHide();
  context.advance(120000); await flush();
  assert.equal(updates, 1);
});

test('failed privilege actions release their locks, and hiding removes revealed contact data', async () => {
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => vip(),
    updatePrivacy: async () => { throw new Error('temporary failure'); },
    visitors: async () => ({ list: [], total: 0 })
  } });
  await page.onShow();
  await page.onPrivacyChange({ detail: { value: true } });
  assert.equal(page.data.busy, '');
  assert.equal(page.data.invisible, false);
  page.setData({ revealedWechat: 'sensitive_contact', wechatId: 'mine' });
  page.onHide();
  assert.equal(page.data.revealedWechat, '');
  assert.equal(page.data.wechatId, '');
});

test('expired VIP users can still cancel their own existing online subscriptions', async () => {
  const changes = [];
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    onlineSubscriptions: async () => ({ list: [{ targetUserId: 2, active: true }] }),
    subscribeOnline: async data => { changes.push(data); return data; }
  } });
  await page.onShow();
  await page.unsubscribe(touch({ id: 2 }));
  assert.equal(changes[0].active, false);
  assert.equal(changes[0].targetUserId, 2);
});

test('an old action settling after hide and reopen cannot unlock the new visible action', async () => {
  const oldAction = deferred(), newAction = deferred();
  let actionCount = 0;
  const { page } = runtime('pages/user/vip-privileges.js', { source: true, memberApi: {
    vipOverview: async () => vip(), visitors: async () => ({ list: [], total: 0 }),
    updatePrivacy: () => ++actionCount === 1 ? oldAction.promise : newAction.promise
  } });
  await page.onShow();
  const first = page.onPrivacyChange({ detail: { value: true } });
  page.onHide();
  await page.onShow();
  const second = page.onPrivacyChange({ detail: { value: true } });
  oldAction.resolve({ invisible: true });
  await first;
  assert.equal(page.data.busy, 'privacy');
  newAction.resolve({ invisible: true });
  await second;
  assert.equal(page.data.busy, '');
});
