const test = require('node:test');
const assert = require('node:assert/strict');
const { createVipMembershipService, VIP_COLLECTIONS } = require('../cloudfunctions/hlApi/vip-membership-service');
const C = { users: 'hl_users', members: 'hl_members', ...VIP_COLLECTIONS };

const now = '2026-10-12T00:00:00.000Z';
function fixture(count = 30, options = {}) {
  const ids = Array.from({ length: count + 1 }, (_, index) => index + 1);
  const rows = {
    [C.users]: ids.map(id => ({ _id: `user_${id}`, id, status: 1, nickname: `访客${id}`, avatarUrl: `cloud://avatar/${id}` })),
    [C.members]: ids.map(id => ({ _id: `member_${id}`, id, userId: id, status: 1, memberType: 'vip', expireAt: '2027-01-01T00:00:00Z' })),
    [C.memberVisits]: ids.slice(1).map(id => ({ _id: `visit_${id}`, id: `visit_${id}`, visitorUserId: id, targetUserId: 1,
      visitedAt: new Date(Date.parse(now) - (id - 2) * 60000).toISOString() }))
  };
  const hidden = new Set(), privateProfiles = new Set(), calls = { reads: [], batches: [], media: [], access: [], writes: [] };
  const matches = (row, query) => Object.entries(query || {}).every(([key, value]) => row[key] === value);
  const getAll = async (collection, query = {}, maxRows = 1000) => {
    calls.reads.push({ collection, query, maxRows });
    return structuredClone((rows[collection] || []).filter(row => matches(row, query)).slice(0, maxRows));
  };
  const getOne = async (collection, query) => (await getAll(collection, query, 1))[0] || null;
  const getById = (collection, id) => getOne(collection, { id: Number(id) });
  const ref = (collection, key) => ({
    async get() {
      const row = (rows[collection] || []).find(row => row._id === key);
      if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
      return { data: structuredClone(row) };
    },
    async set({ data }) {
      assert.equal('_id' in data, false);
      calls.writes.push({ collection, key });
      const list = rows[collection] ||= [], index = list.findIndex(row => row._id === key);
      const value = { ...structuredClone(data), _id: key };
      if (index < 0) list.push(value); else list[index] = value;
    }
  });
  const db = {
    collection: collection => ({ doc: key => ref(collection, String(key)) }),
    runTransaction: callback => callback({ collection: collection => ({ doc: key => ref(collection, String(key)) }) })
  };
  const dependencies = {
    db, getAll, getOne, getById, now: () => now,
    assertPublicTarget: async (viewerId, visitorId) => {
      calls.access.push({ viewerId, visitorId });
      if (privateProfiles.has(Number(visitorId)) || hidden.has(`${viewerId}_${visitorId}`) || hidden.has(`${visitorId}_${viewerId}`)) {
        throw Object.assign(new Error('not visible'), { status: 403 });
      }
      return { displayEnabled: true };
    },
    ...(options.fallback ? {} : {
      visitorViews: async (viewerId, visitorIds) => {
        calls.batches.push({ viewerId, visitorIds });
        return new Map(visitorIds.flatMap(visitorId => {
          const user = rows[C.users].find(row => row.id === visitorId);
          const allowed = user && user.status === 1 && !user.mergedIntoUserId && !privateProfiles.has(visitorId)
            && !hidden.has(`${viewerId}_${visitorId}`) && !hidden.has(`${visitorId}_${viewerId}`);
          return allowed ? [[visitorId, { visitorUserId: visitorId, displayName: user.nickname, avatarUrl: user.avatarUrl, privateWechat: 'never_project' }]] : [];
        }));
      },
      resolveVisitorPage: async list => {
        calls.media.push(structuredClone(list));
        return list.map(row => ({ ...row, avatarUrl: `https://fixture.invalid/avatar/${row.visitorUserId}`, internalArchive: 'never_project' }));
      }
    })
  };
  const service = createVipMembershipService(dependencies);
  return { service, rows, calls, hidden, privateProfiles,
    list: (query = {}, viewerId = 1) => service.handleRoute(viewerId, 'GET', '/member/vip/visitors', query) };
}

test('thirty visitors return two exclusive pages in latest-visit order with the default size of twenty', async () => {
  const r = fixture();
  const first = await r.list();
  const second = await r.list({ page: 2, pageSize: 20 });
  assert.equal(first.page, 1); assert.equal(first.pageSize, 20); assert.equal(first.total, 30);
  assert.equal(first.list.length, 20); assert.equal(second.list.length, 10); assert.equal(second.total, 30);
  assert.deepEqual(first.list.map(row => row.visitorUserId), Array.from({ length: 20 }, (_, index) => index + 2));
  assert.deepEqual(second.list.map(row => row.visitorUserId), Array.from({ length: 10 }, (_, index) => index + 22));
  assert.equal(new Set([...first.list, ...second.list].map(row => row.visitorUserId)).size, 30);
  assert.equal(r.calls.batches.length, 2);
  assert.ok(r.calls.batches.every(call => call.visitorIds.length === 30));
  assert.equal(r.calls.access.length, 0, 'production batch lookup never falls through to per-visitor access queries');
  assert.equal(r.calls.media[0].length, 20); assert.equal(r.calls.media[1].length, 10);
  assert.equal(first.list[0].avatarUrl, 'https://fixture.invalid/avatar/2');
  assert.equal(JSON.stringify(first).includes('never_project'), false);
});

test('repeated visits deduplicate by visitor and retain that visitor latest timestamp', async () => {
  const r = fixture();
  r.rows[C.memberVisits].push({ _id: 'repeat_old', id: 'repeat_old', visitorUserId: 2, targetUserId: 1, visitedAt: '2026-10-01T00:00:00Z' });
  r.rows[C.memberVisits].push({ _id: 'repeat_new', id: 'repeat_new', visitorUserId: 31, targetUserId: 1, visitedAt: '2026-10-12T01:00:00Z' });
  const result = await r.list();
  assert.equal(result.total, 30);
  assert.equal(result.list[0].visitorUserId, 31);
  assert.equal(result.list[0].id, 'repeat_new');
  assert.equal(result.list[0].visitedAt, '2026-10-12T01:00:00Z');
  assert.equal(new Set(r.calls.batches[0].visitorIds).size, 30);
});

test('private, disabled, merged and hidden-in-either-direction visitors are excluded before pagination and counting', async () => {
  const r = fixture();
  r.privateProfiles.add(2);
  r.rows[C.users].find(row => row.id === 3).status = 0;
  r.rows[C.users].find(row => row.id === 4).mergedIntoUserId = 99;
  r.hidden.add('1_5'); r.hidden.add('6_1');
  const result = await r.list({ page: 1, pageSize: 20 });
  assert.equal(result.total, 25);
  assert.equal(result.list.length, 20);
  assert.equal(result.list[0].visitorUserId, 7);
  assert.ok(result.list.every(row => ![2, 3, 4, 5, 6].includes(row.visitorUserId)));
  const second = await r.list({ page: 2, pageSize: 20 });
  assert.equal(second.total, 25); assert.equal(second.list.length, 5);
});

test('invalid pagination rejects with 400 before reading visit IDs or resolving media', async () => {
  for (const query of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: '1e2' }, { page: '' }, { page: null },
    { page: true }, { page: [] }, { page: Number.MAX_SAFE_INTEGER }, { pageSize: 0 }, { pageSize: 51 }, { pageSize: '2.5' }, { pageSize: Infinity }]) {
    const r = fixture();
    await assert.rejects(r.list(query), error => error.status === 400);
    assert.equal(r.calls.reads.filter(row => row.collection === C.memberVisits).length, 0);
    assert.equal(r.calls.batches.length, 0); assert.equal(r.calls.media.length, 0);
  }
});

test('numeric query strings are accepted and an out-of-range page keeps total without hydrating media', async () => {
  const r = fixture();
  const result = await r.list({ page: '3', pageSize: '20' });
  assert.deepEqual(result, { list: [], total: 30, page: 3, pageSize: 20 });
  assert.equal(r.calls.media.length, 0);
});

test('large visit histories use unbounded retrieval and preserve pages after the old one-thousand cap', async () => {
  const r = fixture(1050);
  const result = await r.list({ page: 53, pageSize: 20 });
  assert.equal(result.total, 1050); assert.equal(result.list.length, 10);
  assert.equal(result.list[0].visitorUserId, 1042);
  assert.equal(r.calls.reads.find(row => row.collection === C.memberVisits).maxRows, Infinity);
  assert.equal(r.calls.media[0].length, 10);
});

test('non-VIP callers cannot read visit records or invoke the visitor projection dependency', async () => {
  const r = fixture();
  r.rows[C.members][0].memberType = 'free';
  await assert.rejects(r.list(), error => error.status === 403);
  assert.equal(r.calls.reads.some(row => row.collection === C.memberVisits), false);
  assert.equal(r.calls.batches.length, 0); assert.equal(r.calls.media.length, 0);
});

test('valid VIP invisible visiting produces no record and therefore no visitor page entry', async () => {
  const r = fixture(1);
  r.rows[C.memberVisits] = [];
  r.rows[C.memberPrivacy] = [{ _id: 'privacy_user_2', userId: 2, invisible: true }];
  assert.deepEqual(await r.service.recordVisit(2, 1), { recorded: false });
  assert.equal(r.rows[C.memberVisits].length, 0);
  assert.equal((await r.list()).total, 0);
  assert.equal(r.calls.writes.some(row => row.collection === C.memberVisits), false);
});

test('legacy fixture fallback still filters private and disabled visitors and hydrates selected display rows only', async () => {
  const r = fixture(30, { fallback: true });
  r.privateProfiles.add(2);
  r.rows[C.users].find(row => row.id === 3).status = 0;
  const result = await r.list({ page: 2, pageSize: 20 });
  assert.equal(result.total, 28); assert.equal(result.list.length, 8);
  assert.equal(result.list[0].visitorUserId, 24);
  assert.equal(r.calls.batches.length, 0);
});
