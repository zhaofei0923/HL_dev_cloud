'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createReadService, MAX_ROWS, COLLECTIONS: C, FIELDS } = require('../cloudfunctions/hlAdminOperations/read-service');
const { versionFor } = require('../cloudfunctions/hlAdminOperations/contracts');
const { DEFAULT_MEMBERSHIP_PLANS } = require('../cloudfunctions/hlApi/vip-membership-service');

const NOW = '2026-10-14T03:00:00.000Z';
const BEFORE = '2026-10-13T03:00:00.000Z';
const FUTURE = '2026-11-01T03:00:00.000Z';
const clone = value => structuredClone(value);
const code = expected => error => error.code === expected;

function fixture() {
  return { [C.users]: [{ _id: 'user-1', id: 1, nickname: '测试管理员资料', status: 1,
    phone: '13800000000', avatarUrl: 'cloud://fixture/public/avatar.jpg', gender: 'female',
    openid: 'must-not-read-openid', token: 'must-not-read-token', createdAt: BEFORE }],
  [C.profiles]: [{ _id: 'profile-1', id: 11, userId: 1, province: '浙江', city: '杭州', privateNotes: 'must-not-read-profile' }],
  [C.members]: [{ _id: 'member-1', id: 21, userId: 1, matchmakerId: 31, status: 1 }],
  [C.matchmakers]: [{ _id: 'matchmaker-1', id: 31, userId: 1, status: 1, certificationStatus: 0,
    matchmakerNo: 'HL0031', level: 1, certificationRemark: '', inviteCode: 'must-not-read-invite',
    createdAt: BEFORE, updatedAt: BEFORE }],
  [C.salons]: [{ _id: 'salon-1', id: 41, organizerId: 1, title: '杭州交流活动', location: '杭州西湖',
    status: 'pending', eventDate: FUTURE, maxParticipants: 10, currentParticipants: 99,
    description: '活动介绍', coverImage: 'cloud://fixture/public/cover.jpg', price: 0,
    organizerRole: 'matchmaker', reviewRemark: '', createdAt: BEFORE, updatedAt: BEFORE }],
  [C.registrations]: [{ _id: 'registration-1', id: 51, userId: 1, eventId: 41, status: 'registered', registrationRevision: 1 }],
  [C.certifications]: [{ _id: 'user_1', userId: 1, updatedAt: BEFORE,
    applications: { identity: { requestId: 'application-identity', status: 'pending', source: 'identity_document',
      materialIds: ['material-identity'], sealedVerification: { ciphertext: 'must-not-return-verification' }, submittedAt: BEFORE },
    education: { requestId: 'application-education', status: 'pending', source: 'chsi', method: 'chsi_code',
      educationLevel: '硕士', institutionName: '示例高校', materialIds: [],
      sealedVerification: { ciphertext: 'must-not-read-other-application' }, submittedAt: BEFORE } },
    current: {}, materials: { 'material-identity': { id: 'material-identity', kind: 'identity', status: 'bound',
      applicationId: 'application-identity', fileID: 'cloud://fixture/private/identity.enc', mimeType: 'image/jpeg', size: 128, createdAt: BEFORE },
    'unrelated-material': { id: 'unrelated-material', kind: 'assets', fileID: 'must-not-read-other-material' } },
    reviews: [{ evidenceReference: 'must-not-read-internal-review' }] }],
  [C.plans]: [],
  [C.orders]: [{ _id: 'order-1', id: 61, userId: 1, outTradeNo: 'order_fixture_1', planCode: 'vip_week',
    planTitle: 'VIP周卡', productType: 'vip', amountFen: 6160, currency: 'CNY', status: 'pending',
    createdAt: BEFORE, updatedAt: BEFORE, paymentProvider: 'wechat_virtual', virtualPaymentEnv: 0,
    payerOpenid: 'must-not-read-payer', merchantId: 'must-not-read-merchant', appId: 'must-not-read-appid',
    paymentAttempts: [{ token: 'must-not-read-attempt' }], rawCallback: 'must-not-read-callback' }] };
}

function getPath(value, path) { return path.split('.').reduce((item, key) => item?.[key], value); }
function setPath(value, path, item) {
  const keys = path.split('.');
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(value, key)) Object.defineProperty(value, key, { value: {}, enumerable: true, writable: true });
    value = value[key];
  }
  Object.defineProperty(value, keys.at(-1), { value: clone(item), enumerable: true, writable: true, configurable: true });
}
function projected(row, fields) {
  assert.ok(fields && Object.keys(fields).length, 'each read must have an explicit positive projection');
  const result = {};
  for (const [key, selected] of Object.entries(fields)) {
    assert.equal(selected, true);
    const value = getPath(row, key);
    if (value !== undefined) setPath(result, key, value);
  }
  return result;
}
function runtime(options = {}) {
  const rows = clone(options.rows || fixture()), reads = [];
  const db = { ...(options.noCursor ? {} : { command: { gt: value => ({ operator: 'gt', value }) } }),
    collection(name) {
      assert.notEqual(name, 'hl_payment_merchant_config', 'payment configuration is never part of a read DTO');
      assert.ok(Object.values(C).includes(name), 'only the allowlisted business collections are read');
      let condition, sort, projection, offset = 0, maximum;
      return {
        where(value) { condition = value; return this; },
        orderBy(key, direction) { sort = [key, direction]; return this; },
        field(value) { projection = value; return this; },
        skip(value) { offset = value; return this; },
        limit(value) { maximum = value; return this; },
        async get() {
          assert.ok(maximum > 0 && maximum <= 100, 'all query pages are bounded');
          const read = { name, condition, projection, offset, maximum }; reads.push(read);
          if (options.readHook) {
            const intercepted = options.readHook(read, rows, reads);
            if (intercepted !== undefined) return intercepted;
          }
          let selected = (rows[name] || []).filter(row => !condition || Object.entries(condition).every(([key, expected]) =>
            expected?.operator === 'gt' ? row[key] > expected.value : row[key] === expected));
          if (sort) selected = [...selected].sort((a, b) => a[sort[0]] < b[sort[0]] ? -1 : a[sort[0]] > b[sort[0]] ? 1 : 0);
          return { data: selected.slice(offset, offset + maximum).map(row => projected(row, projection)) };
        },
        doc() { throw new Error('read service uses only projected query reads; no document write entry point'); },
        add() { throw new Error('writes forbidden'); }, update() { throw new Error('writes forbidden'); }, remove() { throw new Error('writes forbidden'); }
      };
    }, runTransaction() { throw new Error('read service must not start a writing transaction'); } };
  return { rows, reads, db, service: createReadService({ db, now: () => NOW }) };
}
function certArgs(patch = {}) { return { userId: 1, kind: 'identity', applicationId: 'application-identity', ...patch }; }

test('all five list methods return the common pagination contract without modifying stored data', async () => {
  const rt = runtime(), before = clone(rt.rows);
  for (const method of ['listMatchmakers', 'listSalons', 'listCertifications', 'listPlans', 'listOrders']) {
    const result = await rt.service[method]({});
    assert.deepEqual(Object.keys(result).sort(), ['list', 'page', 'pageSize', 'total']);
    assert.equal(result.page, 1); assert.equal(result.pageSize, 20);
    assert.ok(Array.isArray(result.list)); assert.ok(result.total >= result.list.length);
  }
  assert.deepEqual(rt.rows, before);
});

test('all list sources continue beyond 1,000 rows before filtering, sorting, and paging', async () => {
  const rows = fixture(), count = 1105;
  rows[C.users] = Array.from({ length: count }, (_, i) => ({ _id: `u_${String(i + 1).padStart(5, '0')}`, id: i + 1, nickname: `姓名${i + 1}`, status: 1 }));
  rows[C.matchmakers] = Array.from({ length: count }, (_, i) => ({ _id: `m_${String(i + 1).padStart(5, '0')}`, id: i + 1, userId: i + 1,
    matchmakerNo: `HL${i + 1}`, status: 1, certificationStatus: 0 }));
  rows[C.salons] = Array.from({ length: count }, (_, i) => ({ _id: `s_${String(i + 1).padStart(5, '0')}`, id: i + 1, organizerId: i + 1,
    title: `活动${i + 1}`, status: 'pending', eventDate: FUTURE }));
  rows[C.certifications] = Array.from({ length: count }, (_, i) => ({ _id: `user_${i + 1}`, userId: i + 1, current: {}, updatedAt: BEFORE,
    applications: { identity: { requestId: `app-${i + 1}`, status: 'pending', materialIds: [], submittedAt: BEFORE } } }));
  rows[C.orders] = Array.from({ length: count }, (_, i) => ({ _id: `o_${String(i + 1).padStart(5, '0')}`, id: i + 1, userId: 1,
    outTradeNo: `order_${i + 1}`, status: 'pending', amountFen: 6160 }));
  const rt = runtime({ rows });
  const matchmakers = await rt.service.listMatchmakers({ keyword: 'HL1105', status: 0 });
  assert.equal(matchmakers.total, 1); assert.equal(matchmakers.list[0].id, 1105);
  const salons = await rt.service.listSalons({ keyword: '活动1105' });
  assert.equal(salons.total, 1); assert.equal(salons.list[0].id, 1105);
  const certifications = await rt.service.listCertifications({ keyword: '姓名1105', kind: 'identity' });
  assert.equal(certifications.total, 1); assert.equal(certifications.list[0].userId, 1105);
  const orders = await rt.service.listOrders({ keyword: 'order_1105' });
  assert.equal(orders.total, 1); assert.equal(orders.list[0].id, 1105);
  const page = await rt.service.listMatchmakers({ page: 2, pageSize: 100 });
  assert.equal(page.total, count); assert.equal(page.list.length, 100); assert.equal(page.list[0].id, 1005);
  assert.ok(rt.reads.some(read => read.condition?._id?.operator === 'gt'));
});

test('bounded skip fallback still reads all rows when the database has no cursor command', async () => {
  const rows = fixture();
  rows[C.salons] = Array.from({ length: 230 }, (_, i) => ({ _id: `s${String(i).padStart(4, '0')}`, id: i + 1, organizerId: 1, status: 'pending', eventDate: FUTURE }));
  const rt = runtime({ rows, noCursor: true }), result = await rt.service.listSalons({ page: 12, pageSize: 20 });
  assert.equal(result.total, 230); assert.equal(result.list.length, 10);
  assert.deepEqual(rt.reads.filter(read => read.name === C.salons).map(read => read.offset), [0, 100, 200]);
});

test('matchmaker detail returns the raw-row version and safe owner/location/count fields', async () => {
  const rt = runtime(), result = await rt.service.detailMatchmaker({ id: '31' });
  assert.equal(result.version, versionFor('matchmakers', rt.rows[C.matchmakers][0]));
  assert.equal(result.user.phone, '13800000000'); assert.equal(result.city, '杭州');
  assert.deepEqual(result.profile, { city: '杭州', province: '浙江' });
  assert.equal(result.memberCount, 1); assert.equal(result.salonCount, 1); assert.equal(result.canReview, true);
  assert.equal(JSON.stringify(result).includes('must-not'), false);
  const fieldKeys = rt.reads.flatMap(read => Object.keys(read.projection));
  for (const forbidden of ['openid', 'token', 'inviteCode', 'privateNotes']) assert.equal(fieldKeys.includes(forbidden), false);
});

test('matchmaker review capability is limited to active pending records and active unmerged owners', async () => {
  for (const patch of [{ certificationStatus: 1 }, { certificationStatus: 2 }, { status: 0 }]) {
    const rt = runtime(); Object.assign(rt.rows[C.matchmakers][0], patch);
    assert.equal((await rt.service.detailMatchmaker({ id: 31 })).canReview, false);
  }
  for (const patch of [{ status: 0 }, { mergedIntoUserId: 2 }]) {
    const rt = runtime(); Object.assign(rt.rows[C.users][0], patch);
    assert.equal((await rt.service.detailMatchmaker({ id: 31 })).canReview, false);
  }
});

test('conflicting business ids, owners, and location records fail closed', async () => {
  for (const target of [C.users, C.matchmakers, C.salons]) {
    const rt = runtime(), original = rt.rows[target][0];
    rt.rows[target].push({ ...original, _id: `${original._id}-duplicate`, id: String(original.id) });
    const work = target === C.users ? rt.service.detailMatchmaker({ id: 31 })
      : target === C.matchmakers ? rt.service.detailMatchmaker({ id: 31 }) : rt.service.detailSalon({ id: 41 });
    await assert.rejects(work, code(40960));
  }
  const rt = runtime(); rt.rows[C.profiles].push({ _id: 'profile-duplicate', userId: 1, city: '宁波', province: '浙江' });
  await assert.rejects(rt.service.detailMatchmaker({ id: 31 }), code(40960));
});

test('salon attendance uses latest user registration instead of stale counters or duplicate rows', async () => {
  const rt = runtime(); rt.rows[C.registrations].push(
    { _id: 'registration-2', id: 52, userId: 1, eventId: 41, status: 'cancelled', registrationRevision: 2 },
    { _id: 'registration-3', id: 53, userId: 2, eventId: 41, status: 'registered', registrationRevision: 1 },
    { _id: 'registration-4', id: 54, userId: 2, eventId: 41, status: 'registered', registrationRevision: 1 });
  const result = await rt.service.detailSalon({ id: 41 });
  assert.equal(result.currentParticipants, 1); assert.equal(result.canApprove, true); assert.equal(result.canCancel, true);
  assert.equal(result.version, versionFor('salons', rt.rows[C.salons][0]));
  assert.equal(result.coverImage, 'cloud://fixture/public/cover.jpg'); assert.equal(result.description, '活动介绍');
});

test('salon capabilities align with pending review and future nonterminal cancellation rules', async () => {
  for (const status of ['pending', 'upcoming', 'rejected', 'cancelled', 'ended']) {
    for (const eventDate of [FUTURE, BEFORE, 'invalid']) {
      const rt = runtime(); Object.assign(rt.rows[C.salons][0], { status, eventDate });
      const result = await rt.service.detailSalon({ id: 41 });
      assert.equal(result.canApprove, status === 'pending' && eventDate === FUTURE);
      assert.equal(result.canReject, ['pending', 'upcoming'].includes(status));
      assert.equal(result.canCancel, ['pending', 'upcoming', 'rejected'].includes(status) && eventDate === FUTURE);
    }
  }
});

test('certification lists project no material records, private verification, or internal reviewer fields', async () => {
  const rt = runtime(), result = await rt.service.listCertifications({ kind: 'identity', status: 'pending' });
  assert.equal(result.total, 1); const row = result.list[0];
  assert.equal(row.applicationId, 'application-identity'); assert.equal(row.materialCount, 1);
  assert.equal(row.canView, true); assert.equal(row.canReview, true);
  assert.equal(JSON.stringify(result).includes('must-not'), false);
  assert.equal(Object.hasOwn(row, 'materialIds'), false);
  const projection = rt.reads.find(read => read.name === C.certifications).projection;
  assert.equal(Object.keys(projection).some(key => key === 'materials' || key.startsWith('materials.') || key.includes('sealedVerification')), false);
});

test('only canonical certification records contribute; legacy conclusions without a bound application cannot be reviewed', async () => {
  const rt = runtime(); rt.rows[C.certifications].push({ _id: 'archive_1', userId: 1,
    applications: { identity: { requestId: 'archive-app', status: 'pending', materialIds: [] } }, current: { identity: { status: 'approved' } } });
  rt.rows[C.certifications][0].current.identity = { status: 'revoked', source: 'identity_document' };
  delete rt.rows[C.certifications][0].applications.identity;
  const result = await rt.service.listCertifications({ kind: 'identity' });
  assert.equal(result.total, 1); assert.equal(result.list[0].status, 'revoked'); assert.equal(result.list[0].verified, false);
  assert.equal(result.list[0].canReview, false); assert.equal(result.list[0].canView, false);
});

test('certification detail returns only selected application and its safe referenced material metadata with an exact version', async () => {
  const rt = runtime(), result = await rt.service.detailCertification(certArgs());
  assert.equal(result.version, versionFor('certifications', rt.rows[C.certifications][0], 'identity'));
  assert.deepEqual(result.materialIds, ['material-identity']);
  assert.deepEqual(result.materials, [{ id: 'material-identity', kind: 'identity', mimeType: 'image/jpeg', size: 128, createdAt: BEFORE }]);
  assert.equal(result.canReview, true); assert.equal(result.canRevoke, false); assert.equal(result.effectiveStatus, 'pending');
  const serialized = JSON.stringify(result);
  for (const forbidden of ['fileID', 'fileId', 'cloud://fixture/private', 'sealedVerification', 'must-not', 'evidenceReference', 'reviewedBy']) assert.equal(serialized.includes(forbidden), false);
  const projections = rt.reads.filter(read => read.name === C.certifications).flatMap(read => Object.keys(read.projection));
  assert.equal(projections.some(key => key === 'materials' || key.includes('education') || key.includes('unrelated-material') || key === 'reviews'), false);
  assert.ok(projections.includes('materials.material-identity.fileID'));
});

test('certificate-only education applications need no uploaded materials and remain reviewable', async () => {
  const rt = runtime(), result = await rt.service.detailCertification(certArgs({ kind: 'education', applicationId: 'application-education' }));
  assert.deepEqual(result.materialIds, []); assert.deepEqual(result.materials, []); assert.equal(result.method, 'chsi_code');
  assert.equal(result.canReview, true); assert.equal(result.version, versionFor('certifications', rt.rows[C.certifications][0], 'education'));
});

test('certification detail rejects changed applications, conflicting owners and duplicate profiles', async () => {
  await assert.rejects(runtime().service.detailCertification(certArgs({ applicationId: 'obsolete-app' })), code(40960));
  const owner = runtime(); owner.rows[C.certifications][0].userId = 2;
  await assert.rejects(owner.service.detailCertification(certArgs()), code(40360));
  const duplicate = runtime(); duplicate.rows[C.profiles].push({ _id: 'other-profile', userId: '1', city: '杭州' });
  await assert.rejects(duplicate.service.detailCertification(certArgs()), code(40960));
  for (const patch of [{ status: 0 }, { mergedIntoUserId: 2 }]) {
    const rt = runtime(); Object.assign(rt.rows[C.users][0], patch);
    await assert.rejects(rt.service.detailCertification(certArgs()), code(40360));
  }
});

test('certification material ownership, binding, status, and file references are checked before returning metadata', async () => {
  for (const patch of [{ id: 'other' }, { kind: 'assets' }, { status: 'staged' }, { applicationId: 'previous-app' }, { fileID: 'https://private.example/identity' }]) {
    const rt = runtime(); Object.assign(rt.rows[C.certifications][0].materials['material-identity'], patch);
    await assert.rejects(rt.service.detailCertification(certArgs()), code(40960));
  }
  const missing = runtime(); delete missing.rows[C.certifications][0].materials['material-identity'];
  await assert.rejects(missing.service.detailCertification(certArgs()), code(40960));
  const duplicate = runtime(); duplicate.rows[C.certifications][0].applications.identity.materialIds = ['material-identity', 'material-identity'];
  await assert.rejects(duplicate.service.detailCertification(certArgs()), code(40960));
});

test('a certification application change between its two reads fails closed', async () => {
  let count = 0;
  const rt = runtime({ readHook(read, rows) {
    if (read.name === C.certifications && ++count === 2) rows[C.certifications][0].applications.identity.materialIds = [];
  } });
  await assert.rejects(rt.service.detailCertification(certArgs()), code(40960));
});

test('certification status uses showcase rules for still-effective conclusions and expired financial evidence', async () => {
  const rt = runtime(); const certification = rt.rows[C.certifications][0];
  certification.current.identity = { status: 'approved', source: 'identity_document', reviewedAt: BEFORE };
  certification.current.assets = { status: 'approved', source: 'combined_financial_statement', financialAssetRange: '2m_5m', reviewedAt: '2025-01-01T00:00:00.000Z' };
  const pending = await rt.service.listCertifications({ kind: 'identity' });
  assert.equal(pending.list[0].status, 'pending'); assert.equal(pending.list[0].verified, true);
  const detail = await rt.service.detailCertification(certArgs()); assert.equal(detail.canRevoke, true);
  const expired = await rt.service.listCertifications({ status: 'expired' });
  assert.equal(expired.total, 1); assert.equal(expired.list[0].kind, 'assets'); assert.equal(expired.list[0].verified, false);
});

test('six canonical plans have fixed prices and independent default-enabled configuration versions', async () => {
  const rt = runtime(), result = await rt.service.listPlans({});
  assert.equal(result.total, 6);
  for (const canonical of DEFAULT_MEMBERSHIP_PLANS) {
    const row = result.list.find(plan => plan.planCode === canonical.planCode);
    assert.equal(row.amountFen, canonical.amountFen); assert.equal(row.title, canonical.title);
    assert.equal(row.active, true); assert.equal(row.configured, false); assert.equal(row.canUpdate, true);
    assert.equal(row.priceEditable, false); assert.equal(row.paymentReadyIndependent, true);
    assert.equal(row.version, versionFor('plans', { ...canonical, active: true }));
  }
  const detail = await rt.service.detailPlan({ planCode: 'vip_week' });
  assert.equal(detail.amountFen, 6160); assert.match(detail.version, /^v1_[a-f0-9]{64}$/);
});

test('persisted plan only overrides activation; versions keep original fields including absent active and code alias', async () => {
  const rt = runtime(); rt.rows[C.plans] = [{ _id: 'configured-1', code: 'vip_week', amountFen: 1, title: '错误覆盖标题', durationDays: 999,
    productType: 'matchmaking', serviceCount: 999, active: false, updatedAt: BEFORE }];
  let result = await rt.service.detailPlan({ planCode: 'vip_week' });
  assert.equal(result.title, 'VIP周卡'); assert.equal(result.amountFen, 6160); assert.equal(result.durationDays, 7);
  assert.equal(result.productType, 'vip'); assert.equal(result.serviceCount, 0); assert.equal(result.active, false);
  assert.equal(result.version, versionFor('plans', rt.rows[C.plans][0]));
  delete rt.rows[C.plans][0].active;
  result = await rt.service.detailPlan({ planCode: 'vip_week' });
  assert.equal(result.active, true); assert.equal(result.version, versionFor('plans', rt.rows[C.plans][0]));
  assert.equal(Object.hasOwn(rt.rows[C.plans][0], 'active'), false);
});

test('legacy and retired plans are read-only while duplicate canonical aliases fail closed', async () => {
  const rt = runtime(); rt.rows[C.plans] = [{ _id: 'legacy-1', planCode: 'matchmaking_month', active: true, title: '历史套餐', amountFen: 100 }];
  const detail = await rt.service.detailPlan({ planCode: 'matchmaking_month' });
  assert.equal(detail.retired, true); assert.equal(detail.readOnly, true); assert.equal(detail.canUpdate, false);
  rt.rows[C.plans].push({ _id: 'legacy-duplicate', code: 'matchmaking_month' });
  await assert.rejects(rt.service.listPlans({}), code(40960));
});

test('order amount remains its snapshot, secret payment fields are not read, and sandbox/test flags are explicit', async () => {
  const rt = runtime(), first = await rt.service.detailOrder({ outTradeNo: 'order_fixture_1' });
  assert.equal(first.amountFen, 6160); assert.equal(first.status, 'pending'); assert.equal(first.fulfillmentStatus, '');
  assert.equal(first.isTest, false); assert.equal(first.isSandbox, false); assert.equal(first.user.nickname, '测试管理员资料');
  assert.equal(JSON.stringify(first).includes('must-not'), false);
  for (const forbidden of ['payerOpenid', 'merchantId', 'appId', 'paymentAttempts', 'rawCallback']) assert.equal(Object.hasOwn(FIELDS.orders, forbidden), false);
  Object.assign(rt.rows[C.orders][0], { paymentTestRunId: 'sandbox-run-private', virtualPaymentEnv: 1, status: 'paid', transactionId: 'wx-fixture-transaction' });
  const result = await rt.service.listOrders({ fulfillmentStatus: 'fulfilled', productType: 'vip', userId: '1' });
  assert.equal(result.total, 1); assert.equal(result.list[0].isTest, true); assert.equal(result.list[0].isSandbox, true);
  assert.equal(Object.hasOwn(result.list[0], 'paymentTestRunId'), false); assert.equal(result.list[0].transactionId, 'wx-fixture-transaction');
});

test('orders support legacy/product/status filtering without inferring paid amounts and reject conflicting order numbers', async () => {
  const rt = runtime(); delete rt.rows[C.orders][0].productType;
  assert.equal((await rt.service.listOrders({ productType: 'legacy', status: 'pending' })).total, 1);
  assert.equal((await rt.service.listOrders({ productType: 'vip' })).total, 0);
  rt.rows[C.orders].push({ ...rt.rows[C.orders][0], _id: 'order-duplicate', id: 62 });
  await assert.rejects(rt.service.listOrders({}), code(40960));
  await assert.rejects(rt.service.detailOrder({ outTradeNo: 'order_fixture_1' }), code(40960));
});

test('all invalid selectors and pagination inputs are rejected before any database read', async () => {
  const cases = [
    ['listMatchmakers', null], ['listMatchmakers', []], ['listMatchmakers', { status: null }], ['listMatchmakers', { status: true }],
    ['listMatchmakers', { status: { toString() { throw new Error('must not coerce objects'); } } }],
    ['listMatchmakers', { page: '1.0' }], ['listSalons', { page: 0 }], ['listSalons', { pageSize: 101 }],
    ['listSalons', { status: 'open' }], ['listSalons', { keyword: '\u0000bad' }], ['listOrders', { keyword: 'x'.repeat(81) }],
    ['listOrders', { status: 'success' }], ['listOrders', { fulfillmentStatus: 'paid' }], ['listOrders', { userId: '01' }],
    ['listCertifications', { kind: 'photo' }], ['listCertifications', { status: 'verified' }],
    ['listPlans', { active: 'true' }], ['detailMatchmaker', { id: { $gt: 0 } }], ['detailSalon', { id: -1 }],
    ['detailMatchmaker', { id: 31, token: 'injected' }], ['detailPlan', { planCode: 'VIP_WEEK' }],
    ['detailOrder', { outTradeNo: 'order/../../escape' }], ['detailCertification', certArgs({ kind: '' })],
    ['detailCertification', certArgs({ applicationId: 'application.with.dot' })]
  ];
  for (const [method, args] of cases) {
    const rt = runtime(); await assert.rejects(rt.service[method](args), code(42260)); assert.equal(rt.reads.length, 0, method);
  }
  const rt = runtime(); const withGetter = {};
  Object.defineProperty(withGetter, 'keyword', { get() { throw new Error('must not run a getter'); } });
  await assert.rejects(rt.service.listSalons(withGetter), code(42260)); assert.equal(rt.reads.length, 0);
});

test('missing details return 404 and malformed query snapshots fail closed', async () => {
  const rt = runtime();
  for (const [method, args] of [['detailMatchmaker', { id: 999 }], ['detailSalon', { id: 999 }],
    ['detailCertification', certArgs({ userId: 999 })], ['detailPlan', { planCode: 'missing_plan' }], ['detailOrder', { outTradeNo: 'missing_order' }]]) {
    await assert.rejects(rt.service[method](args), code(40460));
  }
  for (const snapshot of [{ data: null }, { code: 'DATABASE_ERROR', data: [] }, { errCode: 'FORBIDDEN', data: [] }]) {
    const broken = runtime({ readHook: () => snapshot });
    await assert.rejects(broken.service.listOrders({}), code(50360));
    await assert.rejects(broken.service.detailOrder({ outTradeNo: 'order_fixture_1' }), code(50360));
  }
});

test('nonmonotonic cursors and mismatched detail identities fail closed rather than returning the wrong row', async () => {
  const repeated = runtime({ readHook: () => ({ data: Array.from({ length: 100 }, () => ({ _id: 'same', id: 1 })) }) });
  await assert.rejects(repeated.service.listOrders({}), code(40960));
  const mismatched = runtime({ readHook: read => read.name === C.orders ? ({ data: [{ _id: 'bad', outTradeNo: 'different_order' }] }) : undefined });
  await assert.rejects(mismatched.service.detailOrder({ outTradeNo: 'order_fixture_1' }), code(40960));
});

test('the explicit safety ceiling errors instead of silently returning a prefix', async () => {
  const rt = runtime({ readHook(read) {
    if (read.name !== C.orders) return;
    const cursor = Number(read.condition?._id?.value || 0);
    const data = Array.from({ length: 100 }, (_, i) => ({ _id: String(cursor + i + 1).padStart(8, '0'), outTradeNo: `order_${cursor + i + 1}` }));
    return { data };
  } });
  await assert.rejects(rt.service.listOrders({}), code(50360));
  assert.equal(rt.reads.filter(read => read.name === C.orders).length, MAX_ROWS / 100 + 1);
});

test('the read module loads without importing the merchant configuration module', () => {
  const modulePath = require.resolve('../cloudfunctions/hlAdminOperations/read-service');
  const script = `const Module=require('node:module');const original=Module._load;Module._load=function(name,...args){if(/merchant.*config|membership-payment-policy/.test(name))throw new Error('forbidden payment config dependency');return original.call(this,name,...args)};require(${JSON.stringify(modulePath)});`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
