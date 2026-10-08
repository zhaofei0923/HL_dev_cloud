const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred } = require('./helpers/miniprogram-runtime');
const future = '2026-10-07T10:00:00.000Z';
function event(extra = {}) {
  return { id: 7, title: '测试活动', status: 'upcoming', eventDate: future,
    registrationRequirements: { complete: true, missingFields: [] }, ...extra };
}
function salonRuntime(extra = {}, overrides = {}) {
  const state = { event: event(extra), writes: 0 };
  const harness = runtime('pages/user/salon-detail.js', { salonApi: {
    detail: async () => state.event,
    participants: async () => ({ list: [], total: 0, page: 1, pageSize: 20 }),
    shareCard: async () => ({ canShare: true }),
    register: async () => { state.writes++; state.event.isRegistered = true; },
    ...overrides
  } });
  harness.page.onLoad({ id: '7' });
  return { ...harness, state };
}

test('past upcoming activities disable even registered actions, and crossing the deadline prevents a stale tap', async () => {
  for (const isRegistered of [false, true]) {
    const { page, state } = salonRuntime({ eventDate: '2026-10-05T10:00:00.000Z', isRegistered });
    await page.onShow();
    assert.equal(page.data.event.primaryAction.disabled, true);
    assert.match(page.data.event.primaryAction.text, /过期/);
    await page.primaryAction();
    assert.equal(state.writes, 0);
  }
  const { page, advance, state } = salonRuntime({ eventDate: '2026-10-06T00:00:01.000Z' });
  await page.onShow();
  advance(1001);
  await page.primaryAction();
  assert.equal(state.writes, 0);
  assert.equal(page.data.event.primaryAction.disabled, true);
});

test('incomplete registration returns to the same activity via the minimal form without a write', async () => {
  const { page, state, calls } = salonRuntime({ registrationRequirements: { complete: false, missingFields: ['photo'] } });
  await page.onShow();
  await page.primaryAction();
  assert.equal(state.writes, 0);
  assert.equal(calls.navigation.at(-1).url, '/pages/index/index?register=1&eventId=7');
});

test('participant navigation uses event scope, respects unavailable profiles and never writes global profile storage', async () => {
  const list = [{ userId: 8, displayName: '甲', avatarUrl: '', canViewProfile: false }, { userId: 9, displayName: '乙', avatarUrl: '', canViewProfile: true }];
  const { page, calls } = salonRuntime({}, { participants: async () => ({ list, total: 2, page: 1 }) });
  await page.onShow();
  page.openParticipant({ currentTarget: { dataset: { userId: 8 } } });
  assert.equal(calls.navigation.length, 0);
  page.openParticipant({ currentTarget: { dataset: { userId: 9 } } });
  assert.equal(calls.navigation.at(-1).url, '/pages/user/salon-participant?eventId=7&userId=9');
  assert.equal(calls.storage.length, 0);
});

test('old participant results cannot return after another account or leaving the page', async () => {
  const pending = deferred();
  const { page, session } = salonRuntime({}, { participants: () => pending.promise });
  const read = page.onShow();
  session.token = 'other-account'; session.user = { id: 99 };
  page.onHide();
  pending.resolve({ list: [{ userId: 8, displayName: 'old', avatarUrl: '', canViewProfile: true }], total: 1 });
  await read;
  assert.equal(page.data.participants.length, 0);
});

test('participant profile rechecks its endpoint on every show and drops a revoked previous result', async () => {
  let reads = 0;
  const { page, calls } = runtime('pages/user/salon-participant.js', { salonApi: { participantProfile: async (eventId, userId) => {
    assert.equal(eventId, '7'); assert.equal(userId, '8');
    if (++reads === 2) throw Object.assign(new Error('revoked'), { code: 40300 });
    return { id: 'salon_8', userId: 8, realName: '测试报名人', photos: [] };
  } } });
  page.onLoad({ eventId: '7', userId: '8' });
  await page.onShow();
  assert.ok(page.data.member);
  page.onHide();
  assert.equal(page.data.member, null);
  await page.onShow();
  assert.equal(page.data.member, null);
  assert.match(page.data.error, /报名名单/);
  assert.equal(calls.storage.length, 0);
});

test('leaving during a registration clears progress and old completion cannot alter the returned page', async () => {
  const pending = deferred();
  const { page, calls } = salonRuntime({}, { register: () => pending.promise });
  await page.onShow();
  const write = page.register();
  assert.equal(page.data.actionLoading, true);
  page.onHide();
  await page.onShow();
  assert.equal(page.data.actionLoading, false);
  pending.resolve({});
  await write;
  assert.equal(calls.toasts.includes('报名成功'), false);
  assert.equal(page.data.actionLoading, false);
});

test('a warm activity list recomputes expiry rather than restoring stale open registration', async () => {
  let reads = 0;
  const { page, advance } = runtime('pages/user/salon.js', { salonApi: { list: async () => { reads++; return { list: [event({ eventDate: '2026-10-06T00:00:01.000Z' })], total: 1 }; } } });
  await page.onShow();
  advance(1001);
  await page.onShow();
  assert.equal(reads, 1);
  assert.match(page.data.list[0].statusText, /无法报名/);
});

test('a pending share card does not block activity actions or return after expiration', async () => {
  const pending = deferred();
  const { page, advance } = salonRuntime({ isRegistered: true, eventDate: '2026-10-06T00:00:01.000Z' }, { shareCard: () => pending.promise });
  await page.onShow();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.event.primaryAction.disabled, false);
  advance(1011);
  assert.equal(page.data.event.isExpired, true);
  pending.resolve({ canShare: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.shareCard.canShare, false);
});

test('warm organizer activities stop invitations after their start time', async () => {
  const { page, advance } = runtime('pages/matchmaker/salon.js', { matchmakerApi: {
    dashboard: async () => ({ matchmaker: { certificationStatus: 2, inviteCode: 'DEMO' } })
  }, salonApi: { myEvents: async () => ({ list: [event({ eventDate: '2026-10-06T00:00:01.000Z' })], total: 1 }) } });
  await page.onShow();
  advance(1001);
  await page.onShow();
  assert.equal(page.data.list[0].canInvite, false);
  assert.match(page.data.list[0].statusText, /无法报名/);
  const card = page.onShareAppMessage({ target: { dataset: { id: 7, title: 'expired' } } });
  assert.equal(card.path.includes('salon-detail'), false);
});

test('activity form uses a future default and serializes the chosen local time correctly', async () => {
  const { page, calls } = runtime('pages/matchmaker/salon-form.js', { salonApi: { create: async data => { calls.requests.push({ data }); } } });
  page.onLoad();
  assert.ok(new Date(page.data.form.eventDate).getTime() > Date.UTC(2026, 9, 6));
  page.onDateChange({ detail: { value: '2026-10-07' } });
  page.onTimeChange({ detail: { value: '10:30' } });
  const chosen = new Date(page.data.form.eventDate);
  assert.equal(chosen.getHours(), 10); assert.equal(chosen.getMinutes(), 30);
  page.setData({ 'form.title': '未来活动', 'form.location': '测试地点', 'form.eventDate': '2026-10-05T00:00:00.000Z' });
  await page.save();
  assert.equal(calls.requests.length, 0);
});
