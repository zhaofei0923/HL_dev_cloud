const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const policy = require('../cloudfunctions/hlApi/showcase-policy');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const plain = value => JSON.parse(JSON.stringify(value));

function runtime(input, beforeRead = () => {}) {
  const fixtures = structuredClone(input);
  const reads = [], writes = [];
  const op = (kind, values) => ({ kind, values });
  function matchesValue(value, expected) {
    if (!expected || !expected.kind) return value === expected;
    if (expected.kind === 'in') return expected.values.includes(value);
    if (expected.kind === 'regex') return typeof value === 'string' && new RegExp(expected.values.regexp).test(value);
    if (expected.kind === 'eq') return value === expected.values;
    if (expected.kind === 'neq') return value !== expected.values;
    throw new Error(`Unsupported fixture operator ${expected.kind}`);
  }
  function matches(row, query) {
    if (!query) return true;
    if (query.kind === 'or') return query.values.some(part => matches(row, part));
    if (query.kind === 'and') return query.values.every(part => matches(row, part));
    return Object.entries(query).every(([field, expected]) => matchesValue(row[field], expected));
  }
  function collection(name) {
    const state = { query: null, offset: 0, limit: 100, fields: null, order: [] };
    const ref = {
      where(query) { state.query = query; return ref; },
      skip(offset) { state.offset = offset; return ref; },
      limit(limit) { assert.ok(limit <= 100); state.limit = limit; return ref; },
      field(fields) { state.fields = fields; return ref; },
      orderBy(field, direction) { state.order.push([field, direction]); return ref; },
      async get() {
        beforeRead(name, state, fixtures);
        let rows = (fixtures[name] || []).filter(row => matches(row, state.query));
        if (state.order.length) rows = [...rows].sort((a, b) => {
          for (const [field, direction] of state.order) {
            const diff = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
            if (diff) return direction === 'desc' ? -diff : diff;
          }
          return 0;
        });
        rows = rows.slice(state.offset, state.offset + state.limit);
        reads.push({ name, ...plain(state), returned: rows.length });
        if (state.fields) rows = rows.map(row => Object.fromEntries(Object.keys(state.fields)
          .filter(key => state.fields[key] && key in row).map(key => [key, row[key]])));
        return { data: structuredClone(rows) };
      },
      doc(id) {
        return {
          async get() { return { data: structuredClone((fixtures[name] || []).find(row => row._id === id)) }; },
          async update({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            if (!row) throw new Error(`Missing fixture ${name}/${id}`);
            Object.assign(row, structuredClone(data));
            writes.push({ name, id, data: structuredClone(data) });
          },
          async set({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            const payload = { ...structuredClone(data), _id: id };
            if (row) Object.assign(row, payload); else (fixtures[name] ||= []).push(payload);
            writes.push({ name, id, data: payload });
          }
        };
      },
      async add({ data }) {
        const row = { ...structuredClone(data), _id: `${name}-${(fixtures[name] || []).length + 1}` };
        (fixtures[name] ||= []).push(row);
        writes.push({ name, data: row });
        return { _id: row._id };
      }
    };
    return ref;
  }
  const db = { collection,
    command: Object.fromEntries(['in', 'eq', 'neq', 'or', 'and'].map(kind => [kind, values => op(kind, values)])),
    RegExp: values => op('regex', values), async createCollection() {},
    async runTransaction(callback) {
      return callback({
        collection(name) {
          return {
            where() { throw new Error('CloudBase transactions do not support where'); },
            doc(id) {
              const document = collection(name).doc(id);
              return { ...document,
                async get() {
                  const result = await document.get();
                  if (!result.data) {
                    const error = new Error('document does not exist');
                    error.errCode = 'DOCUMENT_NOT_EXIST';
                    throw error;
                  }
                  return result;
                }
              };
            }
          };
        }
      });
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test={member,admin,tokenService,editableProfilePatch,publicShowcasePage,publicShowcaseRows,memberRequestView};', {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture' };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'showcase-category-test-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', DEMO_MEMBERS: 'false', SEED_DATA: 'false',
      JWT_SECRET: 'showcase-category-test-secret-32-characters', ADMIN_CODE: 'private-showcase-admin-code' } },
    console: { warn() {}, error() {}, log() {} }, Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  const hooks = module.exports.__test;
  return { hooks, fixtures, reads, writes, call: (path, method, data, token) => module.exports.main({ path, method, data, token }),
    accessToken: userId => hooks.tokenService.sign({ userId, authVersion: 1 }, { type: 'access' }),
    adminToken: () => hooks.tokenService.sign({ role: 'admin', adminSessionId: 'verified-session', certificationAdminVersion: 1,
      certificationCredentialFingerprint: crypto.createHmac('sha256', 'showcase-category-test-secret-32-characters')
        .update(JSON.stringify(['hl.member-certification.admin-access.v1', 'private-showcase-admin-code'])).digest('hex') }, { type: 'admin' }) };
}

function fixture(count = 7) {
  return {
    hl_users: Array.from({ length: count }, (_, index) => ({ _id: `user-${index + 1}`, id: index + 1,
      status: 1, openid: `wx-${index + 1}`, nickname: `会员${index + 1}`, gender: 2, isVerified: 1 })),
    hl_profiles: Array.from({ length: count }, (_, index) => ({ _id: `profile-${index + 1}`, id: 100 + index + 1,
      userId: index + 1, realName: `会员${index + 1}`, city: '上海', gender: 2,
      education: '博士', displayEnabled: true, assetCategoryConsent: false, assetRangeDisclosure: false, photos: [] })),
    hl_members: [], hl_match_records: [], hl_member_interactions: [], hl_member_certifications: [],
    hl_matchmakers: [], hl_counters: [], hl_salon_events: [], hl_member_private_archives: []
  };
}

function education(level, source = 'chsi') { return { policyVersion: 1, education: { status: 'approved', level, source } }; }
function assets(range) { return { policyVersion: 1, assets: { status: 'approved', financialAssetRange: range, source: 'bank_statement' } }; }
function favorite(id, senderId, targetId, extra = {}) {
  return { _id: `heart-${id}`, id, userId: senderId, targetUserId: targetId,
    actionType: 'favorite', active: true, status: 'active', updatedAt: '2026-01-01T00:00:00Z', ...extra };
}
function addPopularity(f, targetId, count, start = 1000) {
  for (let index = 0; index < count; index++) {
    const senderId = start + index;
    if (!f.hl_users.some(user => user.id === senderId)) f.hl_users.push({ _id: `user-${senderId}`, id: senderId, status: 1 });
    f.hl_member_interactions.push(favorite(f.hl_member_interactions.length + 1, senderId, targetId));
  }
}

test('recommend retains normal ordering; specialized categories never use a threshold fallback', async () => {
  const r = runtime(fixture());
  const normal = await r.hooks.publicShowcasePage(1, {});
  const explicit = await r.hooks.publicShowcasePage(1, { category: 'recommend' });
  assert.deepEqual(plain(normal), plain(explicit));
  assert.deepEqual(plain(normal.list.map(row => row.userId)), [7, 6, 5, 4, 3, 2]);
  for (const category of ['education', 'assets', 'popularity']) {
    const page = await r.hooks.publicShowcasePage(1, { category });
    assert.equal(page.total, 0); assert.equal(page.list.length, 0);
  }
  await assert.rejects(r.hooks.publicShowcasePage(1, { category: 'unknown' }), /有效的推荐分类/);
});

test('popularity counts 101 different active users, deduplicates gifts/hearts and newest withdrawal', async () => {
  const f = fixture();
  addPopularity(f, 2, 100); addPopularity(f, 3, 101); addPopularity(f, 4, 102);
  f.hl_member_interactions.push(favorite(5000, '1000', '3', { favoriteSource: 'gift' }));
  f.hl_member_interactions.push(favorite(5001, 1000, 4, { active: false, status: 'inactive', updatedAt: '2026-01-02T00:00:00Z' }));
  f.hl_member_interactions.push(favorite(5002, 4, 4)); // Self-hearts are never people counted.
  f.hl_member_interactions.push(favorite(5003, 999999, 3)); // No registered account.
  f.hl_member_interactions.push(favorite(5004, 1001, 2, { status: 'invalid', updatedAt: '2026-01-03T00:00:00Z' }));
  f.hl_member_interactions.push(favorite(5005, 1002, 2, { expiresAt: '2020-01-01', updatedAt: '2026-01-03T00:00:00Z' }));
  const r = runtime(f);
  const page = await r.hooks.publicShowcasePage(1, { category: 'popularity' });
  assert.deepEqual(plain(page.list.map(row => [row.userId, row.popularityCount])), [[4, 101], [3, 101]]);
  r.fixtures.hl_users.find(user => user.id === 1000).status = 0;
  r.fixtures.hl_users.find(user => user.id === 1100).mergedIntoUserId = 1002;
  assert.equal((await r.hooks.publicShowcasePage(1, { category: 'popularity' })).total, 0);
});

test('popularity orders by people count ahead of normal order and remains complete beyond 1000 hearts', async () => {
  const f = fixture(); addPopularity(f, 2, 1001); addPopularity(f, 3, 102);
  const r = runtime(f);
  const page = await r.hooks.publicShowcasePage(1, { category: 'popularity' });
  assert.deepEqual(plain(page.list.map(row => [row.userId, row.popularityCount])), [[2, 1001], [3, 102]]);
});

test('education uses verified domestic/overseas levels equally, rejects self-report and malformed legacy fallback', async () => {
  const f = fixture();
  f.hl_profiles[1].showcaseCertification = education('博士', 'cscse');
  f.hl_profiles[2].showcaseCertification = education('博士');
  f.hl_profiles[3].showcaseCertification = education('硕士', 'cscse');
  f.hl_profiles[4].showcaseCertification = education('本科');
  f.hl_profiles[5].educationVerified = true; f.hl_profiles[5].verifiedEducation = '博士';
  f.hl_profiles.push({ id: 999, userId: -1, displayEnabled: true, education: '博士' });
  const r = runtime(f);
  const page = await r.hooks.publicShowcasePage(1, { category: 'education' });
  assert.deepEqual(plain(page.list.map(row => [row.userId, row.verifiedEducation])), [[3, '博士'], [2, '博士'], [4, '硕士'], [5, '本科']]);
  assert.equal((await r.hooks.publicShowcasePage(1, { category: 'education', city: '杭州' })).total, 0);
});

test('assets use only verified financial tier, explicit owner consent and optional public disclosure', async () => {
  const f = fixture();
  for (const [userId, range] of [[2, '500k_2m'], [3, '2m_5m'], [4, '5m_10m'], [5, 'over_10m']]) {
    f.hl_profiles[userId - 1].showcaseCertification = assets(range);
    f.hl_profiles[userId - 1].assetCategoryConsent = true;
  }
  f.hl_profiles[4].assetRangeDisclosure = true;
  f.hl_profiles[5].showcaseCertification = assets('over_10m'); // No owner consent.
  f.hl_profiles[6].assetVerified = true; f.hl_profiles[6].financialAssetRange = 'over_10m';
  f.hl_profiles[6].assetCategoryConsent = true; f.hl_profiles[6].houseStatus = '10套房'; f.hl_profiles[6].incomeRange = '千万以上';
  const r = runtime(f);
  const page = await r.hooks.publicShowcasePage(1, { category: 'assets' });
  assert.deepEqual(plain(page.list.map(row => row.userId)), [5, 4, 3]);
  assert.equal(page.list[0].financialAssetRange, 'over_10m');
  assert.equal('financialAssetRange' in page.list[1], false);
  assert.ok(page.list.every(row => row.assetVerified && !('showcaseCertification' in row) && !('assetCategoryConsent' in row)));
  r.fixtures.hl_profiles[4].assetRangeDisclosure = false;
  assert.equal('financialAssetRange' in await r.hooks.member.showcaseDetail(1, 'profile_105'), false);
  r.fixtures.hl_profiles[4].assetCategoryConsent = false;
  assert.equal((await r.hooks.publicShowcasePage(1, { category: 'assets' })).total, 2);
});

test('hide excludes the same person from every category and public detail', async () => {
  const f = fixture(); f.hl_profiles[1].showcaseCertification = { ...education('博士'), ...assets('over_10m'), education: education('博士').education };
  f.hl_profiles[1].assetCategoryConsent = true; addPopularity(f, 2, 101);
  f.hl_member_interactions.push({ id: 9999, userId: 1, targetUserId: 2, actionType: 'hide', active: true });
  const r = runtime(f);
  for (const category of ['recommend', 'popularity', 'education', 'assets']) {
    assert.ok((await r.hooks.publicShowcasePage(1, { category })).list.every(row => row.userId !== 2));
  }
  await assert.rejects(r.hooks.member.showcaseDetail(1, 'profile_102'), error => error.status === 404);
  await assert.rejects(r.hooks.member.showcaseDetail(1, 'profile_101'), error => error.status === 404);
});

test('owner patch rejects fake certifications and strict boolean consent; principal cannot authorize consent', async () => {
  const f = fixture(); f.hl_matchmakers.push({ _id: 'mm-1', id: 1, userId: 1, status: 1, certificationStatus: 2 });
  f.hl_members.push({ _id: 'm-2', id: 202, userId: 2, matchmakerId: 1, status: 1 });
  const r = runtime(f);
  const forged = { educationVerified: true, verifiedEducation: '博士', showcaseCertification: education('博士'),
    verifiedFinancialAssetRange: 'over_10m', financialAssetRange: 'over_10m', assetVerified: true,
    assetCategoryConsent: true, assetRangeDisclosure: true };
  assert.deepEqual(plain(r.hooks.editableProfilePatch(forged)), { assetCategoryConsent: true, assetRangeDisclosure: true });
  assert.throws(() => r.hooks.editableProfilePatch({ assetCategoryConsent: 'true' }), /必须为布尔值/);
  await r.hooks.member.update(1, 202, forged);
  assert.equal(r.fixtures.hl_profiles[1].assetCategoryConsent, false);
  assert.equal(r.fixtures.hl_profiles[1].assetRangeDisclosure, false);
  const response = await r.call('/user/profile', 'PUT', forged, r.accessToken(2));
  assert.equal(response.code, 0); assert.equal(response.data.profile.assetCategoryConsent, true);
  assert.equal(response.data.profile.educationVerified, false);
  assert.equal('showcaseCertification' in response.data.profile, false);
  assert.equal('financialAssetRange' in response.data.profile, false);
});

test('admin certification writes private review history, trusts only approved results and protects intake/preferences', async () => {
  const f = fixture(); f.hl_profiles[1].assetCategoryConsent = true;
  f.hl_member_private_archives.push({ _id: 'archive-2', memberId: 202, userId: 2,
    assetVerification: { financialAssetRange: 'under_500k', credentialLocation: 'PRIVATE_INTAKE' } });
  const r = runtime(f); const token = r.adminToken();
  const body = { kind: 'education', status: 'approved', source: 'cscse', educationLevel: '硕士',
    evidenceReference: 'PRIVATE_CSCSE_EVIDENCE', remark: '港澳台认证结果' };
  const noAdmin = await r.call('/admin/member-certifications/2', 'PUT', body, r.accessToken(1));
  assert.equal(noAdmin.code, 40100); assert.equal(r.writes.length, 0);
  const approved = await r.call('/admin/member-certifications/2', 'PUT', body, token);
  assert.equal(approved.code, 0); assert.equal(approved.data.verifiedEducation, '硕士');
  const finance = await r.call('/admin/member-certifications/2', 'PUT', { kind: 'assets', status: 'approved', source: 'bank_statement',
    financialAssetRange: '2m_5m', evidenceReference: 'PRIVATE_BANK_EVIDENCE' }, token);
  assert.equal(finance.code, 0); assert.equal(finance.data.assetVerified, true);
  const stored = r.fixtures.hl_member_certifications[0];
  assert.equal(stored.reviews.length, 2); assert.equal(stored.reviews[0].reviewedBy.sessionId, 'verified-session');
  assert.ok(stored.reviews[0].reviewedAt); assert.equal(stored.current.education.evidenceReference, 'PRIVATE_CSCSE_EVIDENCE');
  assert.equal(r.fixtures.hl_profiles[1].assetCategoryConsent, true);
  assert.equal(r.fixtures.hl_member_private_archives[0].assetVerification.financialAssetRange, 'under_500k');
  for (const response of [await r.hooks.publicShowcasePage(1), await r.hooks.publicShowcaseRows({ keepUserId: true }),
    await r.hooks.member.showcaseDetail(1, 'profile_102'), await r.call('/user/profile', 'GET', {}, r.accessToken(2))]) {
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|showcaseCertification|bank_statement|reviewedBy|2m_5m/);
  }
  const listed = await r.call('/admin/member-certifications', 'GET', { userId: 2 }, token);
  assert.equal(listed.data.list[0].reviews.length, 2);
  const revoked = await r.call('/admin/member-certifications/2', 'PUT', { kind: 'education', status: 'revoked', remark: '认证失效' }, token);
  assert.equal(revoked.code, 0); assert.equal(revoked.data.educationVerified, false);
  assert.equal((await r.hooks.publicShowcasePage(1, { category: 'education' })).total, 0);
  assert.equal((await r.hooks.publicShowcasePage(1, { category: 'assets' })).total, 1);
});

test('certification validators reject missing proof, wrong sources and inherited object keys', () => {
  assert.throws(() => policy.normalizeCertificationReview({ kind: 'education', status: 'approved', source: 'cscse', educationLevel: '博士' }), /内部凭据引用/);
  for (const inherited of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => policy.normalizeCertificationReview({ kind: 'education', status: 'approved', source: 'cscse',
      educationLevel: inherited, evidenceReference: 'proof' }), /本科、硕士或博士/);
    assert.throws(() => policy.normalizeCertificationReview({ kind: 'assets', status: 'approved', source: 'bank_statement',
      financialAssetRange: inherited, evidenceReference: 'proof' }), /金融资产区间/);
    assert.equal(policy.publicCertificationFields({ showcaseCertification: education(inherited) }).educationVerified, false);
    assert.equal(policy.publicCertificationFields({ showcaseCertification: assets(inherited) }).assetVerified, false);
  }
  assert.throws(() => policy.normalizeCertificationReview({ kind: 'education', status: 'approved', source: 'school_upload',
    educationLevel: '硕士', evidenceReference: 'proof' }), /来源与审核类型不匹配/);
});

test('qualification revoked during hydration does not expose an ineligible category card', async () => {
  const f = fixture(); f.hl_profiles[1].showcaseCertification = education('博士');
  const r = runtime(f, (name, state, rows) => {
    if (name === 'hl_profiles' && state.fields && state.fields.photos) rows.hl_profiles[1].showcaseCertification.education.status = 'revoked';
  });
  const page = await r.hooks.publicShowcasePage(1, { category: 'education' });
  assert.equal(page.list.length, 0);
});

test('public detail API resolves both id formats and rechecks current visibility without a private-detail fallback', async () => {
  const f = fixture();
  f.hl_members.push({ _id: 'm-2', id: 202, userId: 2, status: 1, matchmakerId: 9 });
  f.hl_profiles[1].showcaseCertification = assets('5m_10m');
  f.hl_member_private_archives.push({ _id: 'archive-2', memberId: 202, userId: 2,
    assetVerification: { credentialLocation: 'PRIVATE_ARCHIVE' } });
  const r = runtime(f), token = r.accessToken(1);
  const memberDetail = await r.call('/member/showcase/202', 'GET', {}, token);
  assert.equal(memberDetail.code, 0); assert.equal(memberDetail.data.id, 202);
  assert.equal(memberDetail.data.assetVerified, true);
  const profileDetail = await r.call('/member/showcase/profile_103', 'GET', {}, token);
  assert.equal(profileDetail.code, 0); assert.equal(profileDetail.data.userId, 3);
  assert.equal((await r.call('/member/showcase/profile_102', 'GET', {}, token)).code, 40400, 'active member identity overrides an old standalone id');
  assert.equal((await r.call('/member/showcase/profile_101', 'GET', {}, token)).code, 40400, 'own profile stays unavailable');
  assert.equal((await r.call('/member/showcase/202', 'GET', {}, r.adminToken())).code, 40100);
  assert.ok(r.reads.every(read => read.name !== 'hl_member_private_archives' && read.name !== 'hl_member_certifications'));
  assert.doesNotMatch(JSON.stringify(memberDetail), /PRIVATE_|showcaseCertification|financialAssetRange|matchmakerId|phone/);
  r.fixtures.hl_profiles[1].displayEnabled = false;
  assert.equal((await r.call('/member/showcase/202', 'GET', {}, token)).code, 40400);
  r.fixtures.hl_profiles[1].displayEnabled = true;
  r.fixtures.hl_users[1].status = 0;
  assert.equal((await r.call('/member/showcase/202', 'GET', {}, token)).code, 40400);
});
