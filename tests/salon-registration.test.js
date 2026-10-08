const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { activeAttendance, minimumRegistrationStatus, salonAvailability } = require('../cloudfunctions/hlApi/salon-policy');
const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const plain = value => JSON.parse(JSON.stringify(value));
const photo = id => `cloud://test-env.bucket/hl_uploads/profile/20261008/user-${id}.jpg`;

function fixture(count = 6) {
  return {
    hl_users: Array.from({ length: count }, (_, index) => ({ _id: `u-${index + 1}`, id: index + 1,
      nickname: `称呼${index + 1}`, phone: `135${String(index + 1).padStart(8, '0')}`,
      avatarUrl: photo(index + 1), status: 1, gender: 2, openid: `wx-${index + 1}`, isVerified: 0 })),
    hl_profiles: Array.from({ length: count }, (_, index) => ({ _id: `p-${index + 1}`, id: index + 1,
      userId: index + 1, realName: `称呼${index + 1}`, photos: [photo(index + 1)], displayEnabled: false,
      city: '上海', age: 30, height: 170, privateArchive: { secret: 'PRIVATE_ARCHIVE' }, phone: 'PRIVATE_PHONE' })),
    hl_matchmakers: [{ _id: 'mm-1', id: 1, userId: 1, status: 1, certificationStatus: 2, level: 3 },
      { _id: 'mm-2', id: 2, userId: 2, status: 1, certificationStatus: 2, level: 2, parentId: 1 }],
    hl_salon_events: [{ _id: 'e-1', id: 1, organizerId: 1, title: '交流沙龙', status: 'upcoming',
      eventDate: '2099-01-01T10:00:00.000Z', maxParticipants: 10, currentParticipants: 0,
      registrationCountVersion: 1, registrationRevision: 0 }],
    hl_registrations: [], hl_member_interactions: [], hl_members: [], hl_member_matchmaker_requests: [],
    hl_counters: [{ _id: 'registration', key: 'registration', value: 0 },
      { _id: 'profile', key: 'profile', value: count }], hl_messages: [], hl_conversations: []
  };
}

function runtime(input, settings = {}) {
  const fixtures = structuredClone(input);
  const reads = [], writes = [], photoRequests = [];
  const versions = new Map();
  const op = (kind, values) => ({ kind, values });
  const keyFor = (name, id) => `${name}/${id}`;
  let generated = 0, conflicts = 0, transactionCount = 0;
  let failingCollection = settings.failWriteCollection || '';
  function matchesValue(actual, expected) {
    if (!expected || !expected.kind) return actual === expected;
    if (expected.kind === 'in') return expected.values.includes(actual);
    if (expected.kind === 'eq') return actual === expected.values;
    if (expected.kind === 'neq') return actual !== expected.values;
    if (expected.kind === 'regex') return typeof actual === 'string' && new RegExp(expected.values.regexp, expected.values.options || '').test(actual);
    throw new Error(`unsupported operator: ${expected.kind}`);
  }
  function matches(row, query) {
    if (!query) return true;
    if (query.kind === 'or') return query.values.some(part => matches(row, part));
    if (query.kind === 'and') return query.values.every(part => matches(row, part));
    return Object.entries(query).every(([field, expected]) => matchesValue(row[field], expected));
  }
  function applyWrite(store, name, id, data, mode, record = true) {
    const rows = store[name] || (store[name] = []);
    const index = rows.findIndex(row => row._id === id);
    if (mode === 'update' && index < 0) throw new Error('DOCUMENT_NOT_EXIST');
    const actual = Object.fromEntries(Object.entries(data).map(([field, value]) => [field,
      value && value.kind === 'inc' ? Number((rows[index] || {})[field] || 0) + value.values : structuredClone(value)]));
    const row = { ...(mode === 'update' ? rows[index] : {}), ...actual, _id: id };
    if (index < 0) rows.push(row); else rows[index] = row;
    if (record) {
      versions.set(keyFor(name, id), (versions.get(keyFor(name, id)) || 0) + 1);
      writes.push({ name, id, mode, data: structuredClone(data) });
    }
  }
  function document(store, name, id, tx = null) {
    return {
      async get() {
        if (tx) { tx.operations += 1; tx.readVersions.set(keyFor(name, id), tx.snapshotVersions.get(keyFor(name, id)) || 0); }
        reads.push({ name, id, transaction: !!tx });
        const row = (store[name] || []).find(item => item._id === id);
        if (!row && settings.strictMissingDocuments) throw new Error('DOCUMENT_NOT_EXIST');
        return { data: row ? structuredClone(row) : null };
      },
      async update({ data }) {
        if (failingCollection === name) { failingCollection = ''; throw new Error('simulated write failure'); }
        if (tx) { tx.operations += 1; applyWrite(store, name, id, data, 'update', false); tx.pending.push({ name, id, data, mode: 'update' }); }
        else applyWrite(store, name, id, data, 'update');
      },
      async set({ data }) {
        if (failingCollection === name) { failingCollection = ''; throw new Error('simulated write failure'); }
        if (tx) { tx.operations += 1; applyWrite(store, name, id, data, 'set', false); tx.pending.push({ name, id, data, mode: 'set' }); }
        else applyWrite(store, name, id, data, 'set');
      }
    };
  }
  function collection(name) {
    const state = { query: null, skip: 0, limit: 100, fields: null, orders: [] };
    const ref = {
      where(query) { state.query = query; return this; },
      skip(value) { state.skip = value; return this; },
      limit(value) { assert.ok(value <= 100); state.limit = value; return this; },
      field(value) { state.fields = value; return this; },
      orderBy(field, direction) { state.orders.push([field, direction]); return this; },
      async get() {
        let rows = (fixtures[name] || []).filter(row => matches(row, state.query));
        if (state.orders.length) rows = [...rows].sort((a, b) => {
          for (const [field, direction] of state.orders) {
            const difference = a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0;
            if (difference) return difference * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        rows = rows.slice(state.skip, state.skip + state.limit);
        reads.push({ name, ...plain(state), transaction: false });
        if (state.fields) rows = rows.map(row => ({ _id: row._id, ...Object.fromEntries(Object.keys(state.fields)
          .filter(field => state.fields[field] && field in row).map(field => [field, row[field]])) }));
        return { data: structuredClone(rows) };
      },
      doc(id) { return document(fixtures, name, id); },
      async add({ data }) { const id = `generated-${++generated}`; applyWrite(fixtures, name, id, data, 'set'); return { _id: id }; }
    };
    return ref;
  }
  const db = {
    collection,
    command: Object.fromEntries(['in', 'eq', 'neq', 'or', 'and', 'inc'].map(kind => [kind, values => op(kind, values)])),
    RegExp: values => op('regex', values),
    async createCollection(name) { fixtures[name] = fixtures[name] || []; },
    async runTransaction(callback) {
      transactionCount += 1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const snapshot = structuredClone(fixtures);
        const tx = { operations: 0, readVersions: new Map(), snapshotVersions: new Map(versions), pending: [] };
        // Intentionally no where/limit/get methods on transaction collections:
        // wx-server-sdk transactions permit only document operations.
        const result = await callback({ collection: name => ({ doc: id => document(snapshot, name, id, tx) }) });
        assert.ok(tx.operations <= 100, `CloudBase transaction operation budget: ${tx.operations}`);
        if (Array.from(tx.readVersions).some(([key, version]) => (versions.get(key) || 0) !== version)) { conflicts += 1; continue; }
        for (const write of tx.pending) applyWrite(fixtures, write.name, write.id, write.data, write.mode);
        return result;
      }
      throw new Error('transaction retry budget exhausted');
    }
  };
  const cloud = { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'test-env',
    getWXContext: () => ({ OPENID: settings.openid || 'wx-3', APPID: 'test-app' }),
    async getTempFileURL({ fileList }) {
      photoRequests.push([...fileList]);
      if (settings.onPhotoResolution) settings.onPhotoResolution(fixtures);
      return { fileList: fileList.map(fileID => ({ fileID,
        status: settings.missingPhotos ? -1 : 0,
        tempFileURL: settings.missingPhotos ? '' : `https://public.test/${encodeURIComponent(fileID)}` })) };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test={salon,auth,matchmaker,tokenService,minimumRegistrationView,saveMinimumRegistration,acceptMemberMatchmakerInvite};', {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'salon-registration-fixture-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', TCB_ENV: 'test-env', DEMO_MEMBERS: 'false', SEED_DATA: 'false', AUTO_CREATE_COLLECTIONS: 'false' } },
    Buffer, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} }
  }, { filename: apiPath });
  return { hooks: module.exports.__test, main: module.exports.main, fixtures, reads, writes, photoRequests,
    metrics: () => ({ conflicts, transactionCount }),
    token(userId) { return module.exports.__test.tokenService.sign({ userId, authVersion: 1, currentRole: 'user' }, { type: 'access' }); } };
}

function registration(userId, extra = {}) {
  return { _id: `r-${userId}`, id: userId, eventId: 1, userId, status: 'registered',
    participantProfileVisible: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra };
}

test('salon availability distinguishes expiry, exact start, invalid date, status and capacity', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  for (const [change, reason] of [
    [{ eventDate: now.toISOString() }, 'expired'], [{ eventDate: 'bad' }, 'invalid_date'],
    [{ status: 'cancelled' }, 'cancelled'], [{ status: 'ended' }, 'ended'],
    [{ status: 'pending' }, 'not_open'], [{ currentParticipants: 10 }, 'full']
  ]) {
    const result = salonAvailability({ ...fixture().hl_salon_events[0], ...change }, null, now);
    assert.equal(result.canRegister, false); assert.equal(result.registrationBlockedReason, reason);
  }
  assert.equal(salonAvailability(fixture().hl_salon_events[0], null, now).canRegister, true);
});

test('unusable activities reject registration, sharing and invitations without writes', async () => {
  for (const change of [{ eventDate: '2000-01-01' }, { eventDate: 'bad' }, { status: 'ended' },
    { status: 'cancelled' }, { status: 'pending' }]) {
    const input = fixture(); Object.assign(input.hl_salon_events[0], change);
    const r = runtime(input);
    await assert.rejects(r.hooks.salon.register(1, 3, { participantProfileVisible: true }));
    const share = await r.hooks.salon.shareCard(1, 3); assert.equal(share.canShare, false);
    await assert.rejects(r.hooks.salon.inviteMembers(1, 1, [3]));
    assert.equal(r.writes.length, 0);
    const detail = await r.hooks.salon.getEventDetail(1, 1);
    assert.equal(detail.canRegister, false);
  }
});

test('stored minimum registration gates all callers and rejects default or missing photos', async () => {
  const cases = [
    input => { input.hl_users[2].phone = ''; },
    input => { input.hl_users[2].nickname = '新用户'; input.hl_profiles[2].realName = ''; },
    input => { input.hl_users[2].avatarUrl = '/assets/members/avatar-female-1.png'; input.hl_profiles[2].photos = []; }
  ];
  for (const change of cases) {
    const input = fixture(); change(input);
    assert.equal(minimumRegistrationStatus(input.hl_users[2], input.hl_profiles[2]).complete, false);
    const r = runtime(input);
    await assert.rejects(r.hooks.salon.register(1, 3), /手机号|称呼|照片/);
    assert.equal(r.writes.length, 0);
  }
  const missingFile = runtime(fixture(), { missingPhotos: true });
  await assert.rejects(missingFile.hooks.salon.register(1, 3), /照片上传未完成/);
  assert.equal(missingFile.writes.length, 0);
});

test('minimum form saves user and profile atomically without global disclosure or verification upgrades', async () => {
  const input = fixture(); input.hl_users[2].isVerified = 1;
  const r = runtime(input);
  const result = await r.hooks.saveMinimumRegistration(3, { phone: '13812345678', nickname: '林女士', photos: [photo(3)] });
  assert.equal(result.completed, true); assert.equal(result.phoneStatus, 'filled');
  assert.equal(r.fixtures.hl_users[2].isVerified, 1); assert.equal(r.fixtures.hl_profiles[2].displayEnabled, false);
  assert.equal(r.fixtures.hl_users[2].nickname, '林女士'); assert.equal(r.fixtures.hl_profiles[2].realName, '林女士');
  const failing = runtime(input, { failWriteCollection: 'hl_profiles' });
  await assert.rejects(failing.hooks.saveMinimumRegistration(3, { phone: '13812345678', nickname: '林女士', photos: [photo(3)] }), /write failure/);
  assert.equal(failing.fixtures.hl_users[2].nickname, '称呼3'); assert.equal(failing.writes.length, 0);
  for (const payload of [
    { phone: '123', nickname: '林女士', photos: [photo(3)] },
    { phone: '13812345678', nickname: '用户0001', photos: [photo(3)] },
    { phone: '13812345678', nickname: '林女士', photos: ['cloud://test-env.bucket/hl_uploads/member-private/3/face.jpg'] }
  ]) await assert.rejects(r.hooks.saveMinimumRegistration(3, payload));
});

test('concurrent last-seat registrations cannot overbook and duplicate calls consume one seat', async () => {
  const input = fixture(25); input.hl_salon_events[0].maxParticipants = 1;
  const r = runtime(input, { strictMissingDocuments: true });
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => r.hooks.salon.register(1, index + 3, { participantProfileVisible: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(activeAttendance(r.fixtures.hl_registrations).length, 1);
  assert.equal(r.fixtures.hl_salon_events[0].currentParticipants, 1);
  assert.ok(r.metrics().conflicts > 0, 'fixture must exercise optimistic conflicts');
  const winner = activeAttendance(r.fixtures.hl_registrations)[0].userId;
  const duplicates = await Promise.all(Array.from({ length: 12 }, () => r.hooks.salon.register(1, winner, { participantProfileVisible: true })));
  assert.ok(duplicates.every(result => result.idempotent));
  assert.equal(activeAttendance(r.fixtures.hl_registrations).length, 1);
  assert.equal(r.fixtures.hl_salon_events[0].currentParticipants, 1);
  await Promise.all(Array.from({ length: 8 }, () => r.hooks.salon.cancelRegistration(1, winner)));
  assert.equal(r.fixtures.hl_salon_events[0].currentParticipants, 0);
  assert.equal(activeAttendance(r.fixtures.hl_registrations).length, 0);
});

test('legacy stale counts reconcile once, rollback leaves no phantom seat, and multiple seats remain available', async () => {
  const input = fixture(16); delete input.hl_salon_events[0].registrationCountVersion;
  input.hl_salon_events[0].currentParticipants = 999; input.hl_salon_events[0].maxParticipants = 10;
  input.hl_registrations = [registration(3), registration(3, { _id: 'r-3-duplicate', id: 30 })];
  const r = runtime(input);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => r.hooks.salon.register(1, index + 4, { participantProfileVisible: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 9);
  assert.equal(r.fixtures.hl_salon_events[0].currentParticipants, 10);
  assert.equal(activeAttendance(r.fixtures.hl_registrations).length, 10);
  const failing = runtime(fixture(), { failWriteCollection: 'hl_salon_events' });
  await assert.rejects(failing.hooks.salon.register(1, 3, { participantProfileVisible: true }), /write failure/);
  assert.equal(failing.fixtures.hl_registrations.length, 0); assert.equal(failing.fixtures.hl_salon_events[0].currentParticipants, 0);
});

test('attendance lists are minimal and details require same-event current access, consent and bilateral visibility', async () => {
  const input = fixture(); input.hl_registrations = [registration(3), registration(4), registration(5, { participantProfileVisible: false })];
  const r = runtime(input);
  const outsider = await r.hooks.salon.participants(1, 6);
  assert.equal(outsider.total, 3); assert.equal(outsider.canViewProfiles, false);
  assert.ok(outsider.list.every(row => row.canViewProfile === false));
  assert.doesNotMatch(JSON.stringify(outsider), /phone|openid|PRIVATE|privateArchive|memberNo|matchmakerId|expireAt|remark/);
  await assert.rejects(r.hooks.salon.participantProfile(1, 6, 3), /报名本场/);
  const attendee = await r.hooks.salon.participantProfile(1, 4, 3);
  assert.equal(attendee.profileDisclosure, 'event'); assert.equal(attendee.realName, '称呼3');
  assert.equal(input.hl_profiles[2].displayEnabled, false);
  assert.doesNotMatch(JSON.stringify(attendee), /phone|openid|PRIVATE|privateArchive|memberNo|matchmakerId|expireAt|remark/);
  await assert.rejects(r.hooks.salon.participantProfile(1, 4, 5), /未同意/);
  r.fixtures.hl_profiles[4].displayEnabled = true;
  assert.equal((await r.hooks.salon.participantProfile(1, 4, 5)).profileDisclosure, 'public');
  r.fixtures.hl_member_interactions.push({ userId: 3, targetUserId: 4, actionType: 'hide', active: true });
  await assert.rejects(r.hooks.salon.participantProfile(1, 4, 3), /不可查看/);
  assert.ok((await r.hooks.salon.participants(1, 4)).list.every(row => row.userId !== 3));
  r.fixtures.hl_member_interactions = [{ userId: 4, targetUserId: 3, actionType: 'hide', active: true }];
  await assert.rejects(r.hooks.salon.participantProfile(1, 4, 3), /不可查看/);
  const detail = await r.hooks.salon.getEventDetail(1, 6);
  assert.doesNotMatch(JSON.stringify(detail.registrations), /phone|openid|PRIVATE|privateArchive/);
});

test('latest legacy cancellation overrides older active consent and cancellation revokes profile access immediately', async () => {
  const input = fixture(); input.hl_registrations = [registration(3), registration(4),
    registration(3, { _id: 'r-3-cancelled', id: 30, status: 'cancelled', updatedAt: '2026-03-01' })];
  assert.ok(activeAttendance(input.hl_registrations).every(row => row.userId !== 3));
  const r = runtime(input);
  const detail = await r.hooks.salon.getEventDetail(1, 3);
  assert.equal(detail.isRegistered, false); assert.equal(detail.registrationStatus, 'cancelled');
  assert.equal(detail.isOrganizer, false);
  await assert.rejects(r.hooks.salon.participantProfile(1, 3, 4), /报名本场/);
  await assert.rejects(r.hooks.salon.participantProfile(1, 4, 3), /取消报名/);
  r.fixtures.hl_registrations = [registration(3), registration(4), registration(3, { _id: 'r-3-duplicate', id: 30 })];
  delete r.fixtures.hl_salon_events[0].registrationCountVersion;
  await r.hooks.salon.cancelRegistration(1, 3);
  assert.ok(r.fixtures.hl_registrations.filter(row => row.userId === 3).every(row => row.status === 'cancelled'));
  await assert.rejects(r.hooks.salon.participantProfile(1, 3, 4), /报名本场/);
  await assert.rejects(r.hooks.salon.participantProfile(1, 4, 3), /取消报名/);
  r.fixtures.hl_users[3].status = 0;
  await assert.rejects(r.hooks.salon.participantProfile(1, 1, 4), /不可查看/);
});

test('profile delivery revalidates cancellation and hiding that occurs during media resolution', async () => {
  for (const mutation of [
    rows => { rows.hl_registrations.find(row => row.userId === 3).status = 'cancelled'; },
    rows => { rows.hl_registrations.find(row => row.userId === 4).status = 'cancelled'; },
    rows => { rows.hl_member_interactions.push({ userId: 3, targetUserId: 4, actionType: 'hide', active: true }); },
    rows => { rows.hl_registrations.find(row => row.userId === 3).participantProfileVisible = false; }
  ]) {
    const input = fixture(); input.hl_registrations = [registration(3), registration(4)];
    const r = runtime(input, { onPhotoResolution: mutation });
    await assert.rejects(r.hooks.salon.participantProfile(1, 4, 3), /取消报名|报名本场|不可查看|未同意/);
    assert.equal(r.writes.length, 0);
  }
});

test('approved principals and approved partners create; pending applicants cannot inherit authority or promote themselves', async () => {
  const r = runtime(fixture());
  const create = { title: '新活动', eventDate: '2099-01-01', maxParticipants: 20, price: 0 };
  const principal = await r.hooks.salon.createEvent(1, create); assert.equal(principal.organizerRole, 'matchmaker');
  assert.equal((await r.hooks.salon.getEventDetail(1, 1)).isOrganizer, true);
  assert.equal((await r.hooks.salon.shareCard(1, 1)).canShare, true, 'organizer may share without consuming an attendee seat');
  const partner = await r.hooks.salon.createEvent(2, create); assert.equal(partner.organizerRole, 'partner');
  for (const parentId of [999, -1, 'bad', 2]) {
    r.fixtures.hl_matchmakers[1].parentId = parentId;
    await assert.rejects(r.hooks.salon.createEvent(2, create), /关系无效|所属主理人/);
  }
  r.fixtures.hl_matchmakers[1].parentId = 1;
  r.fixtures.hl_matchmakers[0].status = 0;
  await assert.rejects(r.hooks.salon.createEvent(2, create), /所属主理人/);
  r.fixtures.hl_matchmakers[0].status = 1;
  await assert.rejects(r.hooks.salon.updateEvent(principal.id, 2, { title: '改父活动' }), /发起人/);
  r.fixtures.hl_matchmakers[1].certificationStatus = 0;
  await assert.rejects(r.hooks.salon.createEvent(2, create), /审核通过/);
  await assert.rejects(r.hooks.salon.updateEvent(partner.id, 2, { title: '改子活动' }), /审核通过/);
  const response = await r.main({ method: 'POST', path: '/matchmaker/apply', token: r.token(6),
    data: { certificationStatus: 2, level: 3, parentId: 1, status: 1 } });
  assert.equal(response.code, 0);
  assert.equal(response.data.certificationStatus, 0); assert.equal(response.data.level, 1); assert.equal(response.data.parentId, null);
  await assert.rejects(r.hooks.salon.createEvent(6, create), /审核通过/);
});

test('activity shares and old invite acceptance register without changing another principal assignment', async () => {
  const input = fixture(); input.hl_members = [{ _id: 'm-3', id: 3, userId: 3, matchmakerId: 2, status: 1, memberType: 'vip' }];
  const r = runtime(input);
  await r.hooks.acceptMemberMatchmakerInvite(3, { source: 'memberSalonShare', eventId: 1,
    code: 'not-a-principal-code', participantProfileVisible: true });
  assert.deepEqual(r.fixtures.hl_members, input.hl_members);
  assert.ok(r.writes.every(row => !['hl_members', 'hl_member_matchmaker_requests', 'hl_messages', 'hl_conversations'].includes(row.name)));
  const share = await r.hooks.salon.shareCard(1, 3);
  assert.equal(share.canShare, true); assert.match(share.sharePath, /^\/pages\/user\/salon-detail\?id=1&source=memberSalonShare$/);
  assert.doesNotMatch(share.sharePath, /autoRegister|matchmaker-invite|code=/);
  const existingName = r.fixtures.hl_users[2].nickname;
  await r.hooks.auth.wxLogin({ nickname: '新用户' });
  assert.equal(r.fixtures.hl_users[2].nickname, existingName);
});

test('cancelled public activities have readable details while participation and private access remain blocked', async () => {
  const input = fixture();
  input.hl_salon_events[0].status = 'cancelled';
  input.hl_registrations.push(registration(2));
  const r = runtime(input);
  const listed = await r.hooks.salon.listEvents({ period: 'past' }, 3);
  assert.equal(listed.list[0].id, 1);
  const detail = await r.hooks.salon.getEventDetail(1, 3);
  assert.equal(detail.status, 'cancelled');
  assert.equal(detail.canRegister, false);
  await assert.rejects(r.hooks.salon.register(1, 3), /取消|cancelled|开放/);
  const participants = await r.hooks.salon.participants(1, 3, {});
  assert.equal(participants.canViewProfiles, false);
  assert.ok(participants.list.every(row => row.canViewProfile === false));
  for (const status of ['pending', 'rejected']) {
    r.fixtures.hl_salon_events[0].status = status;
    await assert.rejects(r.hooks.salon.getEventDetail(1, 3), /尚未公开/);
  }
});

test('activity period is filtered before pagination and past view excludes unpublished events', async () => {
  const input = fixture();
  const base = input.hl_salon_events[0];
  input.hl_salon_events = Array.from({ length: 40 }, (_, index) => ({ ...base,
    _id: `past-${index}`, id: index + 10, eventDate: '2020-01-01T10:00:00Z' }));
  input.hl_salon_events.push({ ...base },
    { ...base, _id: 'ended', id: 70, status: 'ended', eventDate: '2021-01-01T10:00:00Z' },
    { ...base, _id: 'pending', id: 71, status: 'pending', eventDate: '2022-01-01T10:00:00Z' },
    { ...base, _id: 'rejected', id: 72, status: 'rejected', eventDate: '2023-01-01T10:00:00Z' });
  const r = runtime(input);
  const upcoming = await r.hooks.salon.listEvents({ period: 'upcoming', page: 1, pageSize: 1 }, 3);
  assert.equal(upcoming.total, 1);
  assert.equal(upcoming.list[0].id, 1);
  const past = await r.hooks.salon.listEvents({ period: 'past', page: 1, pageSize: 100 }, 3);
  assert.equal(past.total, 41);
  assert.equal(past.list[0].id, 70);
  assert.equal(past.list.some(row => [1, 71, 72].includes(row.id)), false);
  assert.equal(r.writes.length, 0);
});
