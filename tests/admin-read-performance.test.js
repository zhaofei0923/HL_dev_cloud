'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadService, COLLECTIONS: C } = require('../cloudfunctions/hlAdminOperations/read-service');
const { cachedVipService, COLLECTIONS: COCKPIT } = require('../cloudfunctions/hlAdminCockpit/service');

const NOW = Date.parse('2026-10-19T03:00:00Z');
function project(row, fields) {
  const result = {};
  for (const field of Object.keys(fields)) {
    const keys = field.split('.');
    const value = keys.reduce((object, key) => object?.[key], row);
    if (value === undefined) continue;
    let target = result;
    for (const key of keys.slice(0, -1)) target = target[key] ||= {};
    target[keys[keys.length - 1]] = structuredClone(value);
  }
  return result;
}
function runtime(tables, { scoped = true, cursor = true } = {}, factory = createReadService) {
  const reads = [];
  let completedRound = 0;
  const db = { command: { ...(cursor ? { gt: value => ({ gt: value }) } : {}),
    ...(scoped ? { in: values => ({ in: values }) } : {}) }, collection(name) {
    let where = {}, fields, limit = 100, offset = 0;
    return { where(value) { where = value; return this; }, orderBy() { return this; },
      field(value) { fields = value; return this; }, limit(value) { limit = value; return this; },
      skip(value) { offset = value; return this; }, async get() {
        const round = completedRound + 1;
        const rows = (tables[name] || []).filter(row => Object.entries(where).every(([key, value]) =>
          value?.in ? value.in.includes(row[key]) : value?.gt !== undefined ? row[key] > value.gt : row[key] === value))
          .sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0).slice(offset, offset + limit);
        reads.push({ name, where, rows: rows.length, round });
        await new Promise(resolve => setImmediate(resolve));
        completedRound = Math.max(completedRound, round);
        return { data: rows.map(row => project(row, fields)) };
      } };
  } };
  return { service: factory({ db, now: () => NOW }), reads };
}
function fixture(unrelated = 0) {
  const tables = Object.fromEntries(Object.values(C).map(name => [name, []]));
  tables[C.users] = [{ _id: 'u1', id: 1, nickname: '主理人', status: 1 }];
  tables[C.matchmakers] = [{ _id: 'm1', id: 1, userId: 1, status: 1, certificationStatus: 0 }];
  tables[C.profiles] = [{ _id: 'p1', userId: '1', city: '杭州' }];
  tables[C.members] = [{ _id: 'mem1', userId: 2, matchmakerId: '1', status: 1 }];
  tables[C.salons] = [{ _id: 's1', id: 1, organizerId: '1', status: 'pending', eventDate: '2026-11-01T00:00:00Z' }];
  tables[C.registrations] = [{ _id: 'r1', id: 1, eventId: '1', userId: 2, status: 'registered', registrationRevision: 1 }];
  tables[C.certifications] = [{ _id: 'user_1', userId: 1, applications: {
    identity: { requestId: 'a1', status: 'pending', materialIds: [], submittedAt: '2026-10-18T00:00:00Z' }
  } }];
  for (let i = 0; i < unrelated; i += 1) {
    const key = `z${String(i).padStart(5, '0')}`;
    tables[C.profiles].push({ _id: key, userId: i + 2, city: '其他城市' });
    tables[C.members].push({ _id: key, matchmakerId: i + 2, status: 1 });
    tables[C.salons].push({ _id: key, id: i + 2, organizerId: i + 2, status: 'ended' });
    tables[C.registrations].push({ _id: key, id: i + 2, eventId: i + 2, userId: i + 2, status: 'registered' });
  }
  return tables;
}

test('small-table admin lists keep all reads in the original one network round', async () => {
  for (const [method, count] of [['listMatchmakers', 5], ['listSalons', 3], ['listCertifications', 3]]) {
    const rt = runtime(fixture());
    await rt.service[method]({});
    assert.equal(rt.reads.length, count, method);
    assert.equal(Math.max(...rt.reads.map(read => read.round)), 1, method);
  }
});

test('matchmaker page scopes large associated tables while preserving the full-scan DTO', async () => {
  const tables = fixture(3205), rt = runtime(tables), fallback = runtime(tables, { scoped: false });
  const actual = await rt.service.listMatchmakers({ pageSize: 20 });
  assert.deepEqual(actual, await fallback.service.listMatchmakers({ pageSize: 20 }));
  assert.equal(actual.list[0].memberCount, 1);
  assert.equal(actual.list[0].salonCount, 1);
  assert.equal(rt.reads.length, 8);
  assert.equal(Math.max(...rt.reads.map(read => read.round)), 2);
  assert.equal(rt.reads.reduce((sum, read) => sum + read.rows, 0), 305);
  assert.ok(rt.reads.filter(read => read.where.matchmakerId?.in).every(read => read.where.matchmakerId.in.includes('1')));
});

test('detail reads are independent of unrelated rows and preserve mixed numeric references', async () => {
  const tables = fixture(3205);
  for (const [method, count] of [['detailMatchmaker', 5], ['detailSalon', 3]]) {
    const rt = runtime(tables), fallback = runtime(tables, { scoped: false });
    const actual = await rt.service[method]({ id: 1 });
    assert.deepEqual(actual, await fallback.service[method]({ id: 1 }));
    assert.equal(rt.reads.length, count, method);
    assert.equal(Math.max(...rt.reads.map(read => read.round)), 2, method);
    assert.ok(rt.reads.filter(read => [C.profiles, C.members, C.registrations].includes(read.name)).every(read => Object.keys(read.where).length));
  }
});

test('one numeric lookup still rejects duplicate business IDs stored as number and text', async () => {
  for (const name of [C.users, C.matchmakers, C.salons]) {
    const tables = fixture();
    tables[name].push({ ...tables[name][0], _id: 'duplicate', id: '1' });
    const rt = runtime(tables);
    await assert.rejects(name === C.salons ? rt.service.detailSalon({ id: 1 }) : rt.service.detailMatchmaker({ id: 1 }), error => error.code === 40960);
  }
});

test('salon page reads attendance for just its returned page without losing latest cancellation', async () => {
  const tables = fixture(3205);
  tables[C.registrations].push({ _id: 'r2', id: 99999, eventId: 1, userId: 2, status: 'cancelled', registrationRevision: 2 });
  const rt = runtime(tables), fallback = runtime(tables, { scoped: false });
  const actual = await rt.service.listSalons({ status: 'pending' });
  assert.deepEqual(actual, await fallback.service.listSalons({ status: 'pending' }));
  assert.equal(actual.list[0].currentParticipants, 0);
  const related = rt.reads.filter(read => read.name === C.registrations);
  assert.equal(related.length, 2);
  assert.deepEqual(related[1].where.eventId.in, [1, '1']);
});

test('scoped certification profiles still detect numeric/string duplicate owners', async () => {
  const tables = fixture(3205);
  tables[C.profiles].push({ _id: 'p2', userId: 1, city: '杭州' });
  const rt = runtime(tables), fallback = runtime(tables, { scoped: false });
  const actual = await rt.service.listCertifications({ kind: 'identity' });
  assert.deepEqual(actual, await fallback.service.listCertifications({ kind: 'identity' }));
  assert.equal(actual.list[0].canView, false);
  assert.equal(actual.list[0].canReview, false);
  assert.equal(rt.reads.length, 4);
});

test('scoped references paginate beyond 100 rows and work without cursor support', async () => {
  const tables = fixture();
  tables[C.members] = Array.from({ length: 250 }, (_, i) => ({ _id: `m${String(i).padStart(4, '0')}`, matchmakerId: i % 2 ? '1' : 1, status: 1 }));
  for (const cursor of [true, false]) {
    const rt = runtime(tables, { cursor });
    assert.equal((await rt.service.detailMatchmaker({ id: 1 })).memberCount, 250);
    assert.equal(rt.reads.filter(read => read.name === C.members).length, 3);
  }
});

test('a 100-row page batches mixed reference types with bounded filters and retains exact counts', async () => {
  const tables = fixture(3205);
  tables[C.users] = Array.from({ length: 100 }, (_, i) => ({ _id: `u${String(i).padStart(3, '0')}`, id: i + 1, status: 1 }));
  tables[C.matchmakers] = Array.from({ length: 100 }, (_, i) => ({ _id: `m${String(i).padStart(3, '0')}`, id: i + 1,
    userId: i + 1, status: 1, certificationStatus: 0 }));
  const rt = runtime(tables), fallback = runtime(tables, { scoped: false });
  const actual = await rt.service.listMatchmakers({ pageSize: 100 });
  assert.deepEqual(actual, await fallback.service.listMatchmakers({ pageSize: 100 }));
  assert.equal(actual.total, 100);
  assert.equal(actual.list.length, 100);
  const queries = rt.reads.flatMap(read => Object.values(read.where).filter(value => value?.in));
  assert.equal(queries.length, 6);
  assert.ok(queries.every(query => query.in.length === 100));
});

test('an empty selected page does not read beyond speculative first association pages', async () => {
  const rt = runtime(fixture(3205));
  const actual = await rt.service.listMatchmakers({ keyword: '不存在' });
  assert.equal(actual.total, 0);
  assert.deepEqual(actual.list, []);
  assert.equal(rt.reads.length, 5);
});

test('cockpit entitlement adapter indexes once instead of scanning every user and membership per member', async () => {
  let idReads = 0, memberReferenceReads = 0;
  const count = 250, snapshot = Object.fromEntries(Object.keys(COCKPIT).map(key => [key, []]));
  snapshot.users = Array.from({ length: count }, (_, i) => ({ _id: `u${i + 1}`,
    get id() { idReads += 1; return i + 1; }, status: 1 }));
  snapshot.members = Array.from({ length: count }, (_, i) => ({ _id: `m${i + 1}`,
    get userId() { memberReferenceReads += 1; return i + 1; }, status: 1, memberType: 'free' }));
  const vip = cachedVipService(snapshot, NOW);
  for (let id = 1; id <= count; id += 1) assert.equal((await vip.getEntitlement(id)).isPremiumMember, false);
  assert.equal(idReads, count * 2);
  assert.ok(memberReferenceReads <= count * 3);
});

test('cockpit indexes preserve numeric user lookup and strict legacy membership queries', async () => {
  const snapshot = Object.fromEntries(Object.keys(COCKPIT).map(key => [key, []]));
  snapshot.users = [{ _id: 'u1', id: '01', status: 1 }];
  snapshot.members = [{ _id: 'm1', userId: '1', status: 1, memberType: 'vip' },
    { _id: 'm2', userId: 1, status: '1', memberType: 'vip' }];
  assert.equal((await cachedVipService(snapshot, NOW).getEntitlement(1)).isPremiumMember, false);
  snapshot.members.push({ _id: 'm3', userId: 1, status: 1, memberType: 'vip' });
  assert.equal((await cachedVipService(snapshot, NOW).getEntitlement(1)).isPremiumMember, true);
});
