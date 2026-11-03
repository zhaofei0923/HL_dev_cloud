const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const apiPath = path.resolve(process.env.HL_API_TEST_PATH || path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'));
const requireFromApi = createRequire(apiPath);
const { activeAttendance, minimumRegistrationStatus, salonAvailability } = requireFromApi('./salon-policy');
const plain = value => JSON.parse(JSON.stringify(value));
const photo = id => `cloud://test-env.bucket/hl_uploads/profile/20261008/user-${id}.jpg`;
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const copiedPhoto = `cloud://test-env.bucket/hl_moderated/images/${crypto.createHash('sha256').update(imageBytes).digest('hex')}.png`;

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
    hl_counters: [{ _id: 'salon', key: 'salon', value: 1 }, { _id: 'registration', key: 'registration', value: 0 },
      { _id: 'profile', key: 'profile', value: count }], hl_messages: [], hl_conversations: []
  };
}

function runtime(input, settings = {}) {
  const fixtures = structuredClone(input);
  const reads = [], writes = [], photoRequests = [], securityRequests = [], imageDownloads = [], imageChecks = [], imageCopies = [];
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
    if (settings.beforeWrite) settings.beforeWrite(store, name, id, data, mode);
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
      if (settings.beforeTransaction) settings.beforeTransaction(fixtures);
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
    getWXContext: () => ({ OPENID: settings.openid || 'wx-3', APPID: 'test-app', ENV: 'test-env' }),
    async downloadFile({ fileID }) {
      imageDownloads.push(fileID);
      if (settings.imageDownloadError) throw settings.imageDownloadError;
      return { fileContent: Buffer.from(imageBytes), statusCode: 200 };
    },
    async uploadFile({ cloudPath, fileContent }) {
      imageCopies.push({ cloudPath, fileContent: Buffer.from(fileContent) });
      if (settings.imageCopyError) throw settings.imageCopyError;
      return { fileID: `cloud://test-env.bucket/${cloudPath}` };
    },
    openapi: {
      phonenumber: { async getPhoneNumber() { return { phoneInfo: { purePhoneNumber: settings.phone || '13500000003' } }; } },
      security: { async msgSecCheck(request) {
        securityRequests.push(structuredClone(request));
        if (settings.contentSecurityError) throw settings.contentSecurityError;
        return structuredClone(settings.contentSecurityResult === undefined
          ? { errCode: 0, result: { suggest: 'pass', label: 100 }, traceId: 'fixture-security-pass' }
          : settings.contentSecurityResult);
      }, async imgSecCheck(request) {
        imageChecks.push({ media: { contentType: request.media.contentType, value: Buffer.from(request.media.value) } });
        if (settings.onImageCheck) settings.onImageCheck(fixtures, request, imageChecks.length);
        if (settings.imageSecurityError) throw settings.imageSecurityError;
        return structuredClone(settings.imageSecurityResult === undefined ? { errCode: 0 } : settings.imageSecurityResult);
      } }
    },
    async getTempFileURL({ fileList }) {
      photoRequests.push([...fileList]);
      if (settings.onPhotoResolution) settings.onPhotoResolution(fixtures);
      return { fileList: fileList.map(fileID => ({ fileID,
        status: settings.missingPhotos ? -1 : 0,
        tempFileURL: settings.missingPhotos ? '' : `https://public.test/${encodeURIComponent(fileID)}` })) };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(process.env.HL_API_TEST_PATH || apiPath, 'utf8') + '\nexports.__test={salon,auth,admin,member,matchmaker,chat,tokenService,minimumRegistrationView,saveMinimumRegistration,acceptMemberMatchmakerInvite,ensureChatConversation,createMemberIdentityClaimInvite,confirmMemberIdentityClaim};', {
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
  return { hooks: module.exports.__test, main: module.exports.main, fixtures, reads, writes, photoRequests, securityRequests,
    imageDownloads, imageChecks, imageCopies,
    metrics: () => ({ conflicts, transactionCount }),
    token(userId) { return module.exports.__test.tokenService.sign({ userId, authVersion: 1, currentRole: 'user' }, { type: 'access' }); } };
}

function registration(userId, extra = {}) {
  return { _id: `r-${userId}`, id: userId, eventId: 1, userId, status: 'registered',
    participantProfileVisible: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra };
}

function claimFixture() {
  const input = fixture();
  Object.assign(input.hl_matchmakers[0], { matchmakerNo: 'MM000001', inviteCode: 'HLCLAIM',
    inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-01-01T00:00:00Z' });
  input.hl_users[2].openid = 'manual_3';
  input.hl_users[3].phone = '';
  input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1, memberNo: 'HL200' });
  return input;
}

function imageSubmissionFixture() {
  const input = fixture();
  Object.assign(input.hl_matchmakers[0], { matchmakerNo: 'MM000001', inviteCode: 'PRINCIPAL1',
    inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-01-01T00:00:00.000Z' });
  input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
  return input;
}

function imageSubmissionOperations() {
  return [
    { label: 'new login avatar', path: '/auth/wx-login', method: 'POST', openid: 'wx-new', data: { nickname: '新用户称呼', avatarUrl: photo(3) },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.openid === 'wx-new').avatarUrl]; } },
    { label: 'existing login avatar', path: '/auth/wx-login', method: 'POST', userId: 3, data: { avatarUrl: photo(3) },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl]; } },
    { label: 'new profile photos', path: '/user/profile', method: 'PUT', userId: 3, data: { photos: [photo(3)] },
      setup(input) { input.hl_profiles = input.hl_profiles.filter(row => row.userId !== 3); },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'existing profile photos', path: '/user/profile', method: 'PUT', userId: 3, data: { photos: [photo(3)] },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'minimum registration photos', path: '/user/minimum-registration', method: 'PUT', userId: 3,
      data: { phone: '13812345678', nickname: '新的称呼', photos: [photo(3)] },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'manual member photo intake', userId: 1, hook: true,
      data: { realName: '称呼3', phone: '13500000003', photos: [photo(3)] },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'principal member edit photos', path: '/member/200', method: 'PUT', userId: 1, data: { photos: [photo(3)] },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'salon create cover', path: '/salon/events', method: 'POST', userId: 1,
      data: { title: '即将发布的活动', eventDate: '2099-02-01', coverImage: photo(3) },
      persisted(r) { return [r.fixtures.hl_salon_events.find(row => row.id !== 1).coverImage]; } },
    { label: 'salon edit cover', path: '/salon/events/1', method: 'PUT', userId: 1, data: { coverImage: photo(3) },
      persisted(r) { return [r.fixtures.hl_salon_events[0].coverImage]; } },
    { label: 'profile publication rechecks inherited photos', path: '/user/profile', method: 'PUT', userId: 3, data: { displayEnabled: true },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'principal publication rechecks inherited photos', path: '/member/200', method: 'PUT', userId: 1, data: { displayEnabled: true },
      persisted(r) { return [r.fixtures.hl_users.find(row => row.id === 3).avatarUrl, ...r.fixtures.hl_profiles.find(row => row.userId === 3).photos]; } },
    { label: 'salon republish rechecks inherited cover', path: '/salon/events/1', method: 'PUT', userId: 1, data: { title: '重新发布活动' },
      setup(input) { Object.assign(input.hl_salon_events[0], { status: 'pending', coverImage: photo(3) }); },
      persisted(r) { return [r.fixtures.hl_salon_events[0].coverImage]; } }
  ];
}

async function submitImages(r, operation, extra = {}) {
  const data = { ...operation.data, contentSecurityPassed: true, imageSecurityPassed: true, moderationStatus: 'passed', ...extra };
  if (operation.hook) {
    try { return { code: 0, data: await r.hooks.member.addManual(1, data) }; }
    catch (error) { return { code: error.code, message: error.message }; }
  }
  return r.main({ method: operation.method, path: operation.path, token: operation.userId ? r.token(operation.userId) : '', data });
}

test('every avatar, profile, member and activity publication path rejects risky images or unavailable checking before business writes', async t => {
  for (const outcome of [
    { name: 'risky image', options: { imageSecurityResult: { errCode: 87014, errMsg: 'PRIVATE provider label' } }, code: 40061 },
    { name: 'detector unavailable', options: { imageSecurityError: new Error('PRIVATE detector error') }, code: 50361 },
    { name: 'storage copy unavailable', options: { imageCopyError: new Error('PRIVATE copy error') }, code: 50361 }
  ]) for (const operation of imageSubmissionOperations()) await t.test(`${operation.label}: ${outcome.name}`, async () => {
    const input = imageSubmissionFixture(); operation.setup?.(input);
    const r = runtime(input, { ...outcome.options, ...(operation.openid ? { openid: operation.openid } : {}) });
    const result = await submitImages(r, operation);
    assert.equal(result.code, outcome.code);
    assert.ok(r.imageChecks.length > 0, 'a client-supplied passed flag cannot bypass server detection');
    assert.equal(r.writes.length, 0, 'a failed image gate must precede profiles, users, events, counters, entitlements and relationship writes');
    assert.deepEqual(r.fixtures, input);
    if (outcome.code === 40061) assert.equal(result.message, '内容含有违规信息，请修改后重试');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|provider label/);
    if (outcome.name !== 'storage copy unavailable') assert.equal(r.imageCopies.length, 0);
  });
});

test('all image publication paths persist the checked server copy rather than the writable original', async t => {
  for (const operation of imageSubmissionOperations()) await t.test(operation.label, async () => {
    const input = imageSubmissionFixture(); operation.setup?.(input);
    const r = runtime(input, operation.openid ? { openid: operation.openid } : {});
    const result = await submitImages(r, operation);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(r.imageChecks.length > 0);
    assert.ok(r.imageCopies.length > 0);
    const persisted = operation.persisted(r);
    assert.ok(persisted.length > 0);
    assert.ok(persisted.every(value => value === copiedPhoto), JSON.stringify(persisted));
    assert.ok(r.imageCopies.every(row => row.cloudPath.startsWith('hl_moderated/images/') && row.fileContent.equals(imageBytes)));
    assert.ok(r.imageChecks.every(row => row.media.contentType === 'image/png' && row.media.value.equals(imageBytes)));
  });
});

test('profile and principal publication also recheck the old avatar when no profile photo remains', async () => {
  for (const target of ['profile', 'member']) {
    const input = imageSubmissionFixture(); input.hl_profiles[2].photos = [];
    const r = runtime(input, { imageSecurityResult: { errCode: 87014 } });
    const result = await r.main({ method: 'PUT', path: target === 'profile' ? '/user/profile' : '/member/200',
      token: r.token(target === 'profile' ? 3 : 1), data: { displayEnabled: true, imageSecurityPassed: true } });
    assert.equal(result.code, 40061);
    assert.deepEqual(r.imageDownloads, [photo(3)]);
    assert.equal(r.writes.length, 0);
    assert.deepEqual(r.fixtures, input);
  }
});

test('new image submissions cannot claim the system asset exemption or publish external URLs', async () => {
  for (const photos of [['/assets/members/avatar-female-1.png'], ['https://untrusted.example/avatar.png']]) {
    const input = imageSubmissionFixture();
    const r = runtime(input);
    const result = await r.main({ method: 'PUT', path: '/user/profile', token: r.token(3),
      data: { photos, skipSystem: true, contentSecurityPassed: true, imageSecurityPassed: true } });
    assert.equal(result.code, 40062);
    assert.equal(r.imageChecks.length, 0);
    assert.equal(r.writes.length, 0);
    assert.deepEqual(r.fixtures, input);
  }
});

test('profile and minimum form responses separate persistent approved photo IDs from temporary display URLs', async () => {
  const r = runtime(imageSubmissionFixture());
  const saved = await r.main({ method: 'PUT', path: '/user/profile', token: r.token(3), data: { photos: [photo(3)] } });
  assert.equal(saved.code, 0);
  const display = `https://public.test/${encodeURIComponent(copiedPhoto)}`;
  assert.deepEqual(plain(saved.data.profile.photos), [copiedPhoto]);
  assert.deepEqual(plain(saved.data.profile.photoDisplayUrls), [display]);
  assert.equal(saved.data.avatarUrl, display);
  const loaded = await r.main({ method: 'GET', path: '/user/profile', token: r.token(3) });
  assert.equal(loaded.code, 0);
  assert.deepEqual(plain(loaded.data.profile.photos), [copiedPhoto]);
  assert.deepEqual(plain(loaded.data.profile.photoDisplayUrls), [display]);
  const minimum = await r.main({ method: 'GET', path: '/user/minimum-registration', token: r.token(3) });
  assert.equal(minimum.code, 0);
  assert.equal(minimum.data.completed, true);
  assert.deepEqual(plain(minimum.data.profile.photos), [copiedPhoto]);
  assert.deepEqual(plain(minimum.data.profile.photoDisplayUrls), [display]);
  assert.equal(r.fixtures.hl_users[2].avatarUrl, copiedPhoto);
  assert.deepEqual(r.fixtures.hl_profiles[2].photos, [copiedPhoto]);
  assert.ok(!JSON.stringify(r.fixtures).includes('https://public.test/'), 'temporary URLs must never replace stored image identities');
});

test('fresh voice sends remain closed until media moderation is configured and cannot update chat or unread counts', async () => {
  const input = imageSubmissionFixture();
  input.hl_conversations.push({ _id: 'c-10', id: 10, conversationType: 'member_matchmaker', participantIds: [1, 3],
    status: 'active', unreadBy: { 1: 0, 3: 0 }, lastMessageContent: '' });
  const r = runtime(input);
  const result = await r.main({ method: 'POST', path: '/chat/conversations/10/messages', token: r.token(3),
    data: { contentType: 'voice', content: 'cloud://test-env.bucket/hl_uploads/chat_voice/private.mp3',
      voiceDuration: 2, contentSecurityPassed: true, mediaCheckPassed: true } });
  assert.equal(result.code, 50363);
  assert.equal(r.writes.length, 0);
  assert.equal(r.securityRequests.length, 0);
  assert.equal(r.imageChecks.length, 0);
  assert.deepEqual(r.fixtures, input);
});

test('profile and member edits reject text or objects in numeric fields before any write or safety call', async () => {
  for (const field of ['age', 'height']) {
    for (const value of ['unreviewed content', { text: 'unreviewed content' }, ['30'], true, -1, '0x20', '1e2', 'Infinity']) {
      for (const target of ['profile', 'member']) {
        const input = fixture();
        Object.assign(input.hl_matchmakers[0], { matchmakerNo: 'MM000001', inviteCode: 'PRINCIPAL1',
          inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-01-01T00:00:00.000Z' });
        input.hl_members.push({ _id: 'm-3', id: 3, userId: 3, matchmakerId: 1, status: 1 });
        const r = runtime(input);
        const response = await r.main({ method: 'PUT', path: target === 'profile' ? '/user/profile' : '/member/3',
          token: r.token(target === 'profile' ? 3 : 1), data: { [field]: value } });
        assert.equal(response.code, 40001, `${target} ${field}: ${JSON.stringify(value)}`);
        assert.deepEqual(r.fixtures, input);
        assert.equal(r.writes.length, 0);
        assert.equal(r.securityRequests.length, 0);
      }
    }
  }
});

test('numeric profile fields preserve supported numbers, decimal strings, and empty values', async () => {
  for (const field of ['age', 'height']) {
    for (const value of [0, 30, 170.5, '30', ' 170.5 ', '+1.5', '.5', '0.0', null, '']) {
      const r = runtime(fixture());
      const response = await r.main({ method: 'PUT', path: '/user/profile', token: r.token(3), data: { [field]: value } });
      assert.equal(response.code, 0, `${field}: ${JSON.stringify(value)}`);
      assert.equal(r.fixtures.hl_profiles.find(row => row.userId === 3)[field], value);
    }
  }
});

test('recommendation notes are checked against the authenticated matchmaker before writes in either mode', async () => {
  for (const mode of ['internal', 'external']) {
    const input = fixture();
    Object.assign(input.hl_matchmakers[0], { matchmakerNo: 'MM000001', inviteCode: 'PRINCIPAL1',
      inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-01-01T00:00:00.000Z' });
    input.hl_members.push({ _id: 'm-3', id: 3, userId: 3, matchmakerId: 1, status: 1 });
    const r = runtime(input, { contentSecurityResult: { errCode: 0, result: { suggest: 'risky' } } });
    const response = await r.main({ method: 'POST', path: '/member/recommend', token: r.token(1),
      data: { myMemberId: 3, mode, targetMemberId: 4, resourceUserId: 4, note: 'recommendation note under review' } });
    assert.equal(response.code, 40061);
    assert.equal(r.writes.length, 0);
    assert.deepEqual(r.fixtures, input);
    assert.equal(r.securityRequests.length, 1);
    assert.equal(r.securityRequests[0].openid, 'wx-1');
    assert.equal(r.securityRequests[0].scene, 2);
    assert.equal(r.securityRequests[0].content, 'recommendation note under review');
  }
});

test('flag-only profile publication checks inherited text before exposing the existing profile', async () => {
  const input = fixture();
  Object.assign(input.hl_profiles[2], { displayEnabled: false, selfIntro: 'previously stored introduction requiring review' });
  const r = runtime(input, { contentSecurityResult: { errCode: 0, result: { suggest: 'review' } } });
  const response = await r.main({ method: 'PUT', path: '/user/profile', token: r.token(3), data: { displayEnabled: true } });
  assert.equal(response.code, 40061);
  assert.equal(r.writes.length, 0);
  assert.deepEqual(r.fixtures, input);
  assert.equal(r.securityRequests.length, 1);
  assert.ok(r.securityRequests[0].content.includes('previously stored introduction requiring review'));
});

test('unsafe, review and failed text checks prevent profile, nickname and activity writes through API routes', async t => {
  const outcomes = [
    ['risky', { contentSecurityResult: { errCode: 0, result: { suggest: 'risky', label: 20002 } } }, 40061],
    ['review', { contentSecurityResult: { errCode: 0, result: { suggest: 'review', label: 20013 } } }, 40061],
    ['unavailable', { contentSecurityError: new Error('PRIVATE_PROVIDER_PAYLOAD') }, 50361]
  ];
  const operations = [
    { label: 'new login', path: '/auth/wx-login', method: 'POST', openid: 'wx-new',
      data: { nickname: '新的用户称呼' } },
    { label: 'existing login', path: '/auth/wx-login', method: 'POST', userId: 3,
      data: { nickname: '新的用户称呼' } },
    { label: 'profile create', path: '/user/profile', method: 'PUT', userId: 3,
      data: { nickname: '新的用户称呼', selfIntro: '需要检测的自我介绍' },
      setup(input) { input.hl_profiles = input.hl_profiles.filter(row => row.userId !== 3); } },
    { label: 'minimum registration', path: '/user/minimum-registration', method: 'PUT', userId: 3,
      data: { phone: '13812345678', nickname: '新的用户称呼', photos: [photo(3)] } },
    { label: 'salon create', path: '/salon/events', method: 'POST', userId: 1,
      data: { title: '需要检测的活动', description: '需要检测的活动介绍', eventDate: '2099-01-01' } },
    { label: 'salon edit', path: '/salon/events/1', method: 'PUT', userId: 1,
      data: { title: '需要检测的活动修改' } },
    { label: 'chat send', path: '/chat/conversations/10/messages', method: 'POST', userId: 3,
      data: { content: '需要检测的聊天内容' },
      setup(input) { input.hl_conversations.push({ _id: 'c-10', id: 10, conversationType: 'member_matchmaker',
        participantIds: [1, 3], status: 'active', unreadBy: { 1: 0, 3: 0 }, lastMessageContent: '' }); } }
  ];
  for (const [outcome, security, expectedCode] of outcomes) {
    for (const operation of operations) await t.test(`${operation.label}: ${outcome}`, async () => {
      const input = fixture();
      operation.setup?.(input);
      const r = runtime(input, { ...security, ...(operation.openid ? { openid: operation.openid } : {}) });
      const result = await r.main({ method: operation.method, path: operation.path,
        token: operation.userId ? r.token(operation.userId) : '',
        data: { ...operation.data, openid: 'forged-client-openid', contentSecurityPassed: true } });
      assert.equal(result.code, expectedCode);
      assert.ok(r.securityRequests.length > 0, 'submission must invoke the SDK check');
      assert.ok(r.securityRequests.every(request => request.openid === (operation.openid || `wx-${operation.userId}`)),
        'caller-supplied OpenID cannot replace the authenticated author');
      assert.equal(r.writes.length, 0, 'blocked submissions must not write content, counters, or conversation summaries');
      assert.deepEqual(r.fixtures, input);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_PAYLOAD|forged-client-openid/);
    });
  }
});

test('principal member edits and manual intake reject unsafe text before user, profile, entitlement or counter writes', async t => {
  for (const operation of ['manual create', 'member edit']) await t.test(operation, async () => {
    const input = fixture();
    Object.assign(input.hl_matchmakers[0], { matchmakerNo: 'MM000001', inviteCode: 'PRINCIPAL1',
      inviteCodeStatus: 'active', inviteCodeUpdatedAt: '2026-01-01T00:00:00.000Z' });
    input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
    const r = runtime(input, { contentSecurityResult: { errCode: 0, result: { suggest: 'risky', label: 20002 } } });
    const attempt = operation === 'manual create'
      ? r.hooks.member.addManual(1, { realName: '需要检测的称呼', phone: '13812345678', openid: 'forged-client-openid' })
      : r.hooks.member.update(1, 200, { remark: '需要检测的会员备注', openid: 'forged-client-openid' });
    await assert.rejects(attempt, error => error.code === 40061);
    assert.ok(r.securityRequests.length > 0);
    assert.ok(r.securityRequests.every(request => request.openid === 'wx-1'), 'manual changes use the principal author, not the target member');
    assert.equal(r.writes.length, 0);
    assert.deepEqual(r.fixtures, input);
  });
});

test('passing checks allow a profile save and chat send using the authenticated author', async () => {
  const input = fixture();
  input.hl_conversations.push({ _id: 'c-10', id: 10, conversationType: 'member_matchmaker', participantIds: [1, 3],
    status: 'active', unreadBy: { 1: 0, 3: 0 }, lastMessageContent: '' });
  const r = runtime(input);
  const profile = await r.main({ method: 'PUT', path: '/user/profile', token: r.token(3),
    data: { realName: '林女士', selfIntro: '喜欢户外运动', openid: 'forged-client-openid' } });
  assert.equal(profile.code, 0);
  assert.equal(r.fixtures.hl_users[2].nickname, '林女士');
  assert.equal(r.fixtures.hl_profiles[2].selfIntro, '喜欢户外运动');
  assert.ok(r.securityRequests.some(request => request.content.includes('喜欢户外运动')));
  const message = await r.main({ method: 'POST', path: '/chat/conversations/10/messages', token: r.token(3),
    data: { content: '您好，很高兴认识您', openid: 'forged-client-openid' } });
  assert.equal(message.code, 0);
  assert.equal(r.fixtures.hl_chat_messages.length, 1);
  assert.equal(r.fixtures.hl_chat_messages[0].content, '您好，很高兴认识您');
  assert.equal(r.fixtures.hl_conversations[0].lastMessageContent, '您好，很高兴认识您');
  assert.ok(r.securityRequests.every(request => request.openid === 'wx-3' && request.version === 2));
  assert.ok(r.securityRequests.some(request => request.scene === 2 && request.content.includes('您好，很高兴认识您')));
});

test('new conversations use supported document-only transactions and concurrent creation returns one conversation', async () => {
  const r = runtime(fixture(), { strictMissingDocuments: true });
  const rows = await Promise.all([r.hooks.ensureChatConversation([3, 4], 'member_pair', { matchRecordId: 20 }),
    r.hooks.ensureChatConversation([4, 3], 'member_pair', { matchRecordId: 20 })]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(r.fixtures.hl_conversations.length, 1);
  assert.deepEqual(plain(r.fixtures.hl_conversations[0].participantIds), [3, 4]);
  assert.equal(r.fixtures.hl_conversations[0].matchRecordId, 20);
  assert.ok(r.reads.some(read => read.name === 'hl_conversations' && read.transaction && read.id));
});

test('manual claim invitation and verified-phone confirmation complete with document-only transactions', async () => {
  const r = runtime(claimFixture(), { strictMissingDocuments: true, openid: 'wx-4' });
  const invite = await r.hooks.createMemberIdentityClaimInvite(1, 200);
  const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
  const preview = await r.hooks.auth.previewMemberIdentityClaim(token);
  assert.equal(preview.status, 'pending');
  const result = await r.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code');
  assert.equal(result.user.id, 3);
  assert.equal(result.claimStatus, 'claimed');
  assert.equal(r.fixtures.hl_users.find(row => row.id === 3).openid, 'wx-4');
  assert.equal(r.fixtures.hl_users.find(row => row.id === 4).status, 0);
  assert.equal(r.fixtures.hl_member_identity_claims[0].status, 'claimed');
  assert.equal(r.fixtures.hl_members[0].userId, 3, 'service ownership stays on the canonical manual account');
  const writes = r.writes.length;
  const repeated = await r.hooks.confirmMemberIdentityClaim(3, token, 'unused-phone-code');
  assert.equal(repeated.idempotent, true);
  assert.equal(r.writes.length, writes);
});

test('claim invitation rejects a phone changed between preflight and document transaction', async () => {
  const r = runtime(claimFixture(), { strictMissingDocuments: true,
    beforeTransaction(rows) { rows.hl_users.find(row => row.id === 3).phone = '13900000003'; } });
  await assert.rejects(r.hooks.createMemberIdentityClaimInvite(1, 200), error => error.code === 42220);
  assert.equal((r.fixtures.hl_member_identity_claims || []).length, 0);
  assert.equal(r.fixtures.hl_users.find(row => row.id === 3).claimInviteVersion, undefined);
});

test('claim confirmation rechecks document status and cannot merge after principal approval is revoked', async () => {
  let revoke = false;
  const r = runtime(claimFixture(), { strictMissingDocuments: true, openid: 'wx-4',
    beforeTransaction(rows) { if (revoke) rows.hl_matchmakers[0].certificationStatus = 1; } });
  const invite = await r.hooks.createMemberIdentityClaimInvite(1, 200);
  const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
  revoke = true;
  await assert.rejects(r.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code'), error => error.code === 40927);
  assert.equal(r.fixtures.hl_users.find(row => row.id === 3).openid, 'manual_3');
  assert.equal(r.fixtures.hl_users.find(row => row.id === 4).status, 1);
  assert.equal(r.fixtures.hl_member_identity_claims[0].status, 'pending');
});

test('claim invitation detects multiple active phone owners without unsupported transactional queries', async () => {
  const input = claimFixture();
  input.hl_users[4].phone = input.hl_users[2].phone;
  const r = runtime(input, { strictMissingDocuments: true });
  await assert.rejects(r.hooks.createMemberIdentityClaimInvite(1, 200), error => error.code === 40920);
  assert.equal((r.fixtures.hl_member_identity_claims || []).length, 0);
});

test('claim invitation and confirmation reject a principal account revoked during preflight', async () => {
  for (const changes of [{ status: 0 }, { mergedIntoUserId: 6 }]) {
    const inviteRuntime = runtime(claimFixture(), { strictMissingDocuments: true,
      beforeTransaction(rows) { Object.assign(rows.hl_users.find(row => row.id === 1), changes); } });
    await assert.rejects(inviteRuntime.hooks.createMemberIdentityClaimInvite(1, 200), error => error.code === 40922);
    assert.equal(inviteRuntime.writes.length, 0);

    let revoke = false;
    const confirmRuntime = runtime(claimFixture(), { strictMissingDocuments: true, openid: 'wx-4',
      beforeTransaction(rows) { if (revoke) Object.assign(rows.hl_users.find(row => row.id === 1), changes); } });
    const invite = await confirmRuntime.hooks.createMemberIdentityClaimInvite(1, 200);
    const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
    revoke = true;
    const writes = confirmRuntime.writes.length;
    await assert.rejects(confirmRuntime.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code'), error => error.code === 40927);
    assert.equal(confirmRuntime.writes.length, writes);
    assert.equal(confirmRuntime.fixtures.hl_users.find(row => row.id === 3).openid, 'manual_3');
    assert.equal(confirmRuntime.fixtures.hl_member_identity_claims[0].status, 'pending');
  }
});

test('claim confirmation rejects mismatched verified phone and expired or replaced invitation without writes', async () => {
  for (const reason of ['phone', 'expired', 'replaced']) {
    const r = runtime(claimFixture(), { strictMissingDocuments: true, openid: 'wx-4',
      ...(reason === 'phone' ? { phone: '13900000004' } : {}) });
    const invite = await r.hooks.createMemberIdentityClaimInvite(1, 200);
    const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
    if (reason === 'expired') r.fixtures.hl_member_identity_claims[0].expiresAt = '2000-01-01T00:00:00Z';
    if (reason === 'replaced') await r.hooks.createMemberIdentityClaimInvite(1, 200);
    const writes = r.writes.length;
    const expectedCode = { phone: 40924, expired: 41021, replaced: 41020 }[reason];
    await assert.rejects(r.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code'), error => error.code === expectedCode);
    assert.equal(r.writes.length, writes);
    assert.equal(r.fixtures.hl_users.find(row => row.id === 3).openid, 'manual_3');
    assert.equal(r.fixtures.hl_users.find(row => row.id === 4).status, 1);
  }
});

test('claim confirmation rechecks source and target account revocation and assignment changes', async () => {
  for (const [targetId, changes] of [[3, { status: 0 }], [3, { mergedIntoUserId: 6 }],
    [4, { status: 0 }], [4, { mergedIntoUserId: 6 }], [4, { openid: 'wx-other' }], ['member', { matchmakerId: 2 }]]) {
    let revoke = false;
    const r = runtime(claimFixture(), { strictMissingDocuments: true, openid: 'wx-4',
      beforeTransaction(rows) {
        if (revoke) Object.assign(targetId === 'member' ? rows.hl_members[0] : rows.hl_users.find(row => row.id === targetId), changes);
      } });
    const invite = await r.hooks.createMemberIdentityClaimInvite(1, 200);
    const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
    revoke = true;
    const writes = r.writes.length;
    await assert.rejects(r.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code'), error => error.code === 40927);
    assert.equal(r.writes.length, writes);
    assert.equal(r.fixtures.hl_users.find(row => row.id === 3).openid, 'manual_3');
    assert.equal(r.fixtures.hl_member_identity_claims[0].status, 'pending');
  }
});

test('claim preserves canonical assignment and premium entitlements and prevents another account from replaying the token', async () => {
  const input = claimFixture();
  Object.assign(input.hl_members[0], { membershipTier: 'vip', membershipExpireAt: '2099-01-01', serviceCount: 6 });
  input.hl_vip_entitlements = [{ _id: 'vip-3', userId: 3, status: 'active', expireAt: '2099-01-01' }];
  input.hl_matchmaking_packages = [{ _id: 'package-3', userId: 3, totalCount: 6, usedCount: 2, status: 'active' }];
  const r = runtime(input, { strictMissingDocuments: true, openid: 'wx-4' });
  const invite = await r.hooks.createMemberIdentityClaimInvite(1, 200);
  const token = new URL(invite.sharePath, 'https://fixture.test').searchParams.get('token');
  const ownership = structuredClone(r.fixtures.hl_members);
  const result = await r.hooks.confirmMemberIdentityClaim(4, token, 'verified-phone-code');
  assert.equal(result.user.id, 3);
  assert.deepEqual(r.fixtures.hl_members, ownership);
  assert.deepEqual(r.fixtures.hl_vip_entitlements, input.hl_vip_entitlements);
  assert.deepEqual(r.fixtures.hl_matchmaking_packages, input.hl_matchmaking_packages);
  const writes = r.writes.length;
  const repeated = await r.hooks.confirmMemberIdentityClaim(3, token, 'unused-phone-code');
  assert.equal(repeated.idempotent, true);
  assert.equal(r.writes.length, writes);
  r.fixtures.hl_users.find(row => row.id === 5).openid = 'wx-4';
  await assert.rejects(r.hooks.confirmMemberIdentityClaim(5, token, 'unused-phone-code'), error => error.code === 40921);
  assert.equal(r.writes.length, writes);
});

test('public salon status filters cannot enumerate pending or rejected activities while organizers retain their own list', async () => {
  const input = fixture();
  input.hl_salon_events.push({ ...input.hl_salon_events[0], _id: 'e-2', id: 2, status: 'pending', title: '尚未审核' },
    { ...input.hl_salon_events[0], _id: 'e-3', id: 3, status: 'rejected', title: '未通过' });
  const r = runtime(input);
  for (const status of ['pending', 'rejected']) {
    const result = await r.main({ path: '/salon/events', token: r.token(3), data: { status } });
    assert.equal(result.code, 0);
    assert.ok(result.data.list.every(event => event.status === 'upcoming'));
  }
  assert.equal((await r.hooks.salon.myEvents(1)).total, 3);
  await assert.rejects(r.hooks.salon.getEventDetail(2, 3), error => error.status === 404);
});

test('external recommendation rejects private, inactive or merged target accounts before creating business records', async () => {
  for (const changes of [{ displayEnabled: false }, { status: 0 }, { mergedIntoUserId: 5 }]) {
    const input = fixture();
    input.hl_profiles[3].displayEnabled = true;
    if (changes.displayEnabled !== undefined) input.hl_profiles[3].displayEnabled = changes.displayEnabled;
    Object.assign(input.hl_users[3], { ...changes });
    input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
    const r = runtime(input, { strictMissingDocuments: true });
    await assert.rejects(r.hooks.member.recommend(1, { myMemberId: 200, resourceUserId: 4 }), error => error.status === 404);
    assert.equal((r.fixtures.hl_match_records || []).length, 0);
    assert.equal(r.fixtures.hl_messages.length, 0);
    assert.equal(r.fixtures.hl_conversations.length, 0);
  }
});

test('external recommendation still creates a formal pair for a currently public and active target', async () => {
  const input = fixture();
  input.hl_profiles[3].displayEnabled = true;
  input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
  const r = runtime(input, { strictMissingDocuments: true });
  const result = await r.hooks.member.recommend(1, { myMemberId: 200, resourceUserId: 4 });
  assert.equal(result.matchRecord.userBId, 4);
  assert.equal(r.fixtures.hl_match_records.length, 1);
  assert.equal(r.fixtures.hl_messages.length, 1);
  assert.equal(r.fixtures.hl_conversations.length, 1);
});

test('external recommendation rejects a target hidden while reserving the match record number', async () => {
  const input = fixture();
  input.hl_profiles[3].displayEnabled = true;
  input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
  const r = runtime(input, { strictMissingDocuments: true,
    beforeWrite(rows, name, id) {
      if (name === 'hl_counters' && id === 'matchRecord') rows.hl_profiles[3].displayEnabled = false;
    } });
  await assert.rejects(r.hooks.member.recommend(1, { myMemberId: 200, resourceUserId: 4 }), error => error.status === 404);
  assert.equal((r.fixtures.hl_match_records || []).length, 0);
  assert.equal(r.fixtures.hl_messages.length, 0);
  assert.equal(r.fixtures.hl_conversations.length, 0);
  assert.ok(r.reads.some(read => read.name === 'hl_profiles' && read.id === 'p-4' && read.transaction));
});

test('external recommendation transaction rechecks target identity, source assignment and principal eligibility', async () => {
  const revocations = [
    rows => { rows.hl_users[3].status = 0; },
    rows => { rows.hl_users[3].mergedIntoUserId = 5; },
    rows => { rows.hl_profiles[3].displayEnabled = false; },
    rows => { rows.hl_profiles[3].userId = 5; },
    rows => { rows.hl_members[0].status = 0; },
    rows => { rows.hl_members[0].matchmakerId = 2; },
    rows => { rows.hl_matchmakers[0].certificationStatus = 1; },
    rows => { rows.hl_matchmakers[0].status = 0; },
    rows => { rows.hl_users[0].status = 0; }
  ];
  for (const revoke of revocations) {
    const input = fixture();
    input.hl_profiles[3].displayEnabled = true;
    input.hl_members.push({ _id: 'member-200', id: 200, userId: 3, matchmakerId: 1, status: 1 });
    const r = runtime(input, { strictMissingDocuments: true, beforeTransaction: revoke });
    await assert.rejects(r.hooks.member.recommend(1, { myMemberId: 200, resourceUserId: 4 }),
      error => [403, 404].includes(error.status));
    assert.equal((r.fixtures.hl_match_records || []).length, 0);
    assert.equal(r.fixtures.hl_messages.length, 0);
    assert.equal(r.fixtures.hl_conversations.length, 0);
  }
});

test('salon reviews approve only future pending events and cannot reopen terminal or rejected states', async () => {
  for (const status of ['cancelled', 'ended', 'rejected', 'upcoming']) {
    const input = fixture();
    input.hl_salon_events[0].status = status;
    const r = runtime(input, { strictMissingDocuments: true });
    await assert.rejects(r.hooks.admin.reviewSalon(1, 'upcoming'), error => error.code === 40940);
    assert.equal(r.fixtures.hl_salon_events[0].status, status);
    assert.equal(r.writes.length, 0);
  }
  for (const eventDate of ['2000-01-01', 'invalid']) {
    const input = fixture();
    Object.assign(input.hl_salon_events[0], { status: 'pending', eventDate });
    const r = runtime(input, { strictMissingDocuments: true });
    await assert.rejects(r.hooks.admin.reviewSalon(1, 'upcoming'), error => error.code === 40940);
    assert.equal(r.writes.length, 0);
  }
  const input = fixture();
  input.hl_salon_events[0].status = 'pending';
  const r = runtime(input, { strictMissingDocuments: true });
  assert.equal((await r.hooks.admin.reviewSalon(1, 'upcoming', '审核通过')).status, 'upcoming');
  assert.equal((await r.hooks.admin.reviewSalon(1, 'rejected', '暂停活动')).status, 'rejected');
});

test('salon review rechecks a cancellation committed after the operator loaded the pending event', async () => {
  const input = fixture();
  input.hl_salon_events[0].status = 'pending';
  const r = runtime(input, { strictMissingDocuments: true,
    beforeTransaction(rows) { rows.hl_salon_events[0].status = 'cancelled'; } });
  await assert.rejects(r.hooks.admin.reviewSalon(1, 'upcoming'), error => error.code === 40940);
  assert.equal(r.fixtures.hl_salon_events[0].status, 'cancelled');
  assert.equal(r.writes.length, 0);
});

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

test('approved principals and approved partners directly publish; pending applicants cannot inherit authority or promote themselves', async () => {
  const r = runtime(fixture());
  const create = { title: '新活动', eventDate: '2099-01-01', maxParticipants: 20, price: 0 };
  const principal = await r.hooks.salon.createEvent(1, create); assert.equal(principal.organizerRole, 'matchmaker');
  assert.equal(principal.status, 'upcoming');
  assert.equal((await r.hooks.salon.getEventDetail(1, 1)).isOrganizer, true);
  assert.equal((await r.hooks.salon.shareCard(1, 1)).canShare, true, 'organizer may share without consuming an attendee seat');
  const partner = await r.hooks.salon.createEvent(2, create); assert.equal(partner.organizerRole, 'partner');
  assert.equal(partner.status, 'upcoming');
  const publicEvents = await r.hooks.salon.listEvents({}, 3);
  assert.ok(publicEvents.list.some(event => event.id === principal.id));
  assert.ok(publicEvents.list.some(event => event.id === partner.id));
  assert.equal((await r.hooks.salon.getEventDetail(partner.id, 3)).status, 'upcoming');
  assert.equal((await r.hooks.salon.register(partner.id, 3)).status, 'registered');
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

test('direct salon publishing retains future time, capacity, price and organizer ownership validation', async () => {
  const r = runtime(fixture()), create = { title: '即时发布活动', eventDate: '2099-01-01', maxParticipants: 20, price: 0 };
  const before = r.writes.length;
  for (const patch of [{ eventDate: 'bad' }, { eventDate: '2000-01-01' }, { maxParticipants: -1 },
    { maxParticipants: 1.5 }, { price: -1 }, { price: 'bad' }]) {
    await assert.rejects(r.hooks.salon.createEvent(1, { ...create, ...patch }), error => error.code === 42240);
    assert.equal(r.writes.length, before);
  }
  const event = await r.hooks.salon.createEvent(1, { ...create, organizerId: 2, organizerRole: 'admin', status: 'ended' });
  assert.equal(event.organizerId, 1); assert.equal(event.organizerMatchmakerId, 1);
  assert.equal(event.organizerRole, 'matchmaker'); assert.equal(event.status, 'upcoming');
  await assert.rejects(r.hooks.salon.updateEvent(event.id, 2, { title: '越权修改' }), /发起人/);
  r.fixtures.hl_users[0].status = 0;
  await assert.rejects(r.hooks.salon.createEvent(1, create));
});

test('explicit organizer saves publish owned pending or rejected drafts and keep published edits public', async () => {
  for (const status of ['upcoming', 'pending', 'rejected']) {
    const input = fixture();
    Object.assign(input.hl_salon_events[0], { status, reviewRemark: '旧审核意见' });
    input.hl_salon_events.push({ ...input.hl_salon_events[0], _id: 'untouched', id: 90, status: 'pending' });
    const r = runtime(input);
    const changed = await r.hooks.salon.updateEvent(1, 1, { title: '已重新发布', eventDate: '2099-02-01', maxParticipants: 20, price: 0 });
    assert.equal(changed.status, 'upcoming'); assert.equal(changed.reviewRemark, '');
    assert.equal((await r.hooks.salon.getEventDetail(1, 3)).title, '已重新发布');
    assert.equal((await r.hooks.salon.register(1, 3)).status, 'registered');
    assert.equal(r.fixtures.hl_salon_events.find(row => row.id === 90).status, 'pending');
  }
});

test('republishing never reopens terminal or expired activities and rejects invalid inherited draft dates', async () => {
  for (const patch of [{ status: 'ended' }, { status: 'cancelled' }, { status: 'pending', eventDate: '2000-01-01' },
    { status: 'rejected', eventDate: 'invalid' }]) {
    const input = fixture(); Object.assign(input.hl_salon_events[0], patch);
    const r = runtime(input);
    await assert.rejects(r.hooks.salon.updateEvent(1, 1, { title: '不能绕过发布规则' }));
    assert.equal(r.writes.length, 0);
  }
  const input = fixture(); input.hl_salon_events[0].status = 'pending';
  const r = runtime(input);
  await assert.rejects(r.hooks.salon.updateEvent(1, 1, { title: ' ' }), error => error.code === 42240);
  assert.equal(r.writes.length, 0);
});

test('publishing transaction rejects revoked organizer, partner or parent credentials without creating an activity', async () => {
  for (const change of [
    rows => { rows.hl_users[1].status = 0; },
    rows => { rows.hl_users[1].mergedIntoUserId = 3; },
    rows => { rows.hl_matchmakers[1].certificationStatus = 0; },
    rows => { rows.hl_matchmakers[1].parentId = null; },
    rows => { rows.hl_matchmakers[0].status = 0; }
  ]) {
    const r = runtime(fixture(), { beforeTransaction: change });
    await assert.rejects(r.hooks.salon.createEvent(2, { title: '不可越权发布', eventDate: '2099-01-01' }), error => error.code === 40301);
    assert.equal(r.fixtures.hl_salon_events.length, 1); assert.equal(r.writes.length, 0);
  }
});

test('publishing save rechecks organizer eligibility and concurrent cancellation without reopening an activity', async () => {
  for (const change of [
    rows => { rows.hl_users[0].status = 0; },
    rows => { rows.hl_matchmakers[0].certificationStatus = 0; },
    rows => { rows.hl_salon_events[0].status = 'cancelled'; }
  ]) {
    const r = runtime(fixture(), { beforeTransaction: change });
    await assert.rejects(r.hooks.salon.updateEvent(1, 1, { title: '不可强制覆盖' }), error => [40301, 40942].includes(error.code));
    assert.equal(r.writes.length, 0);
  }
});

test('simultaneous salon publications reserve different activity numbers with document-only transactions', async () => {
  const r = runtime(fixture());
  const events = await Promise.all([1, 2].map(id => r.hooks.salon.createEvent(id, { title: `即时活动${id}`, eventDate: '2099-01-01' })));
  assert.equal(new Set(events.map(row => row.id)).size, 2);
  assert.ok(events.every(row => row.status === 'upcoming' && row.id > 1));
  assert.equal(r.fixtures.hl_salon_events.length, 3);
  assert.ok(r.metrics().conflicts > 0);
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
