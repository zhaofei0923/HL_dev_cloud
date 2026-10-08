const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const policy = require('../cloudfunctions/hlApi/showcase-policy');
const materialPolicy = require('../cloudfunctions/hlApi/certification-material-policy');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const plain = value => JSON.parse(JSON.stringify(value));
const TEST_SECRET = 'owner-certification-test-secret-32-characters';
const TEST_ADMIN_CODE = 'fixture-private-admin-code';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from('PRIVATE_DOCUMENT_CONTENT')]);

function fixture(includeMaterials = true) {
  return {
    hl_users: [1, 2, 3].map(id => ({ _id: `user-${id}`, id, status: 1, authVersion: 1, nickname: `会员${id}` })),
    hl_profiles: [1, 2].map(id => ({ _id: `profile-${id}`, id: 100 + id, userId: id, education: '博士',
      realName: `会员${id}`, displayEnabled: false, assetCategoryConsent: false, assetRangeDisclosure: false })),
    hl_member_certifications: includeMaterials ? [1, 2].map(userId => ({ _id: `user_${userId}`, userId,
      materials: Object.fromEntries(['identity', 'education', 'vehicle', 'property', 'assets'].map(kind => {
        const id = `fixture-${kind}`;
        return [id, { id, kind, mimeType: 'image/jpeg', size: JPEG.length, createdAt: '2026-10-08T00:00:00Z',
          expiresAt: '2030-01-01T00:00:00Z', status: 'staging', fileID: `cloud://private-fixture/${userId}/${id}` }];
      })) })) : []
  };
}

function runtime(input = fixture(), beforeTransaction = () => {}, options = {}) {
  const fixtures = structuredClone(input), reads = [], writes = [];
  const storage = new Map(), uploads = [], deletions = [], downloads = [], loggedErrors = [];
  for (const record of fixtures.hl_member_certifications) for (const material of Object.values(record.materials || {})) {
    storage.set(material.fileID, materialPolicy.sealMaterial(JPEG,
      { userId: record.userId, kind: material.kind, id: material.id }, { jwtSecret: TEST_SECRET }));
  }
  const op = (kind, values) => ({ kind, values });
  function matches(row, query) {
    if (!query) return true;
    if (query.kind === 'and') return query.values.every(part => matches(row, part));
    if (query.kind === 'or') return query.values.some(part => matches(row, part));
    return Object.entries(query).every(([field, value]) => value?.kind === 'in'
      ? value.values.includes(row[field]) : row[field] === value);
  }
  function collection(name, inTransaction = false) {
    const query = { where: null, skip: 0, limit: 100, fields: null };
    const ref = {
      where(value) {
        if (inTransaction) throw new Error('CloudBase transactions do not support where');
        query.where = value; return ref;
      },
      skip(value) { query.skip = value; return ref; },
      limit(value) { query.limit = value; return ref; },
      field(value) { query.fields = value; return ref; },
      async get() {
        reads.push({ name, query: plain(query) });
        let rows = (fixtures[name] || []).filter(row => matches(row, query.where)).slice(query.skip, query.skip + query.limit);
        if (query.fields) rows = rows.map(row => Object.fromEntries(Object.keys(query.fields).filter(key => query.fields[key] && key in row).map(key => [key, row[key]])));
        return { data: structuredClone(rows) };
      },
      doc(id) {
        return {
          async get() {
            reads.push({ name, id });
            if (name === 'hl_member_certifications' && options.certificationReadError) throw new Error(options.certificationReadError);
            const row = (fixtures[name] || []).find(item => item._id === id);
            if (!row) {
              const error = new Error('document does not exist'); error.errCode = 'DOCUMENT_NOT_EXIST'; throw error;
            }
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            const payload = { ...structuredClone(data), _id: id };
            const rows = fixtures[name] ||= [];
            const index = rows.findIndex(item => item._id === id);
            if (index >= 0) rows[index] = payload; else rows.push(payload);
            writes.push({ name, id, data: structuredClone(data) });
          },
          async update({ data }) {
            const row = (fixtures[name] || []).find(item => item._id === id);
            if (!row) throw new Error('missing fixture update');
            Object.assign(row, structuredClone(data)); writes.push({ name, id, data: structuredClone(data) });
          }
        };
      }
    };
    return ref;
  }
  const db = { collection,
    command: Object.fromEntries(['in', 'eq', 'neq', 'or', 'and'].map(kind => [kind, values => op(kind, values)])),
    async createCollection() {},
    async runTransaction(callback) {
      beforeTransaction(fixtures);
      const saved = structuredClone(fixtures), writeCount = writes.length;
      try { return await callback({ collection: name => collection(name, true) }); }
      catch (error) {
        Object.keys(fixtures).forEach(key => { delete fixtures[key]; }); Object.assign(fixtures, saved);
        writes.splice(writeCount); throw error;
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test={tokenService,certifications};', {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: 'fixture',
        async uploadFile({ cloudPath, fileContent }) {
          if (options.failUpload) throw new Error('upload failed');
          const fileID = `cloud://fixture/${cloudPath}`; storage.set(fileID, Buffer.from(fileContent)); uploads.push({ cloudPath, fileContent: Buffer.from(fileContent), fileID });
          if (options.afterUpload) options.afterUpload(fixtures);
          return { fileID };
        },
        async downloadFile({ fileID }) {
          downloads.push(fileID);
          if (!storage.has(fileID)) throw new Error('not found');
          return { fileContent: storage.get(fileID) };
        },
        async deleteFile({ fileList }) {
          if (options.failDelete) return { fileList: fileList.map(fileID => ({ fileID, status: -1 })) };
          fileList.forEach(fileID => { storage.delete(fileID); deletions.push(fileID); });
          return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) };
        }
      };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'owner-certification-test-secret-32-characters' }) };
      }
      return requireFromApi(name);
    },
    process: { env: { NODE_ENV: 'test', DEMO_MEMBERS: 'false', SEED_DATA: 'false', JWT_SECRET: TEST_SECRET,
      ADMIN_CODE: TEST_ADMIN_CODE, ...(options.env || {}) } },
    console: { warn() {}, error(...args) { loggedErrors.push(args.map(String).join(' ')); }, log() {} }, Buffer, setTimeout, clearTimeout
  }, { filename: apiPath });
  const hooks = module.exports.__test;
  return { fixtures, reads, writes, storage, uploads, deletions, downloads, loggedErrors,
    call: (url, method, data, token) => module.exports.main({ path: url, method, data, token }),
    token: userId => hooks.tokenService.sign({ userId, authVersion: 1 }, { type: 'access' }),
    adminToken: () => hooks.tokenService.sign({ role: 'admin', adminSessionId: 'review-session', certificationAdminVersion: 1,
      certificationCredentialFingerprint: crypto.createHmac('sha256', TEST_SECRET)
        .update(JSON.stringify(['hl.member-certification.admin-access.v1', options.env?.ADMIN_CODE || TEST_ADMIN_CODE])).digest('hex') }, { type: 'admin' }),
    legacyAdminToken: () => hooks.tokenService.sign({ role: 'admin', adminSessionId: 'legacy-session' }, { type: 'admin' })
  };
}

const entry = (response, kind) => response.data.entries.find(row => row.kind === kind);
const request = (kind, extra = {}) => ({ kind, consentConfirmed: true, materialIds: kind === 'education' ? [] : [`fixture-${kind}`], ...extra });
const educationRequest = (source = 'chsi') => request('education', { source, educationLevel: 'master', institutionName: ' 学校名称 ',
  ...(source === 'cscse' ? { method: 'cscse_number', certificateNumber: 'PRIVATE_CSCSE_CERTIFICATE_NUMBER' }
    : { method: 'chsi_code', verificationCode: 'A123456789012345' }) });
const upload = (r, kind, userId = 1, data = {}) => r.call('/user/certification-materials', 'POST',
  { kind, mimeType: 'image/jpeg', contentBase64: JPEG.toString('base64'), ...data }, r.token(userId));

test('owner certification overview returns all five entries and reads only the current user document', async () => {
  const r = runtime(fixture(false));
  const result = await r.call('/user/certifications', 'GET', { userId: 2 }, r.token(1));
  assert.equal(result.code, 0);
  assert.deepEqual(plain(result.data.entries.map(row => [row.kind, row.status, row.verified])),
    ['identity', 'education', 'vehicle', 'property', 'assets'].map(kind => [kind, 'unsubmitted', false]));
  assert.equal(r.writes.length, 0);
  assert.deepEqual(r.reads.filter(row => row.name === 'hl_member_certifications').map(row => row.id), ['user_1']);
  assert.ok(r.reads.every(row => ['hl_users', 'hl_member_certifications'].includes(row.name)));
  assert.equal((await r.call('/user/certifications', 'GET', {}, r.adminToken())).code, 40100);
  assert.equal((await r.call('/user/certifications', 'GET', {}, '')).code, 40100);
});

test('all five certification requests are pending intent and never confer qualification or change owner preferences', async () => {
  const r = runtime(), token = r.token(1), beforeProfiles = plain(r.fixtures.hl_profiles);
  for (const kind of ['identity', 'education', 'vehicle', 'property', 'assets']) {
    const result = await r.call('/user/certification-requests', 'POST', kind === 'education' ? educationRequest() : request(kind), token);
    assert.equal(result.code, 0, kind);
    assert.equal(entry(result, kind).status, 'pending'); assert.equal(entry(result, kind).verified, false);
    assert.equal(entry(result, kind).application.status, 'pending');
  }
  assert.deepEqual(plain(r.fixtures.hl_profiles), beforeProfiles);
  assert.ok(r.writes.every(row => row.name === 'hl_member_certifications' && row.id === 'user_1'));
  assert.deepEqual(plain(r.fixtures.hl_member_certifications[0].current), {});
  const application = r.fixtures.hl_member_certifications[0].applications.education;
  assert.equal(application.source, 'chsi'); assert.equal(application.institutionName, '学校名称');
  assert.equal(r.fixtures.hl_member_certifications[0].applications.assets.source, 'combined_financial_statement');
  assert.equal('financialAssetRange' in r.fixtures.hl_member_certifications[0].applications.assets, false);
});

test('domestic and overseas/Hong Kong/Macao/Taiwan education requests use the same levels and remain separated by owner', async () => {
  const r = runtime();
  const domestic = await r.call('/user/certification-requests', 'POST', educationRequest('chsi'), r.token(1));
  const overseas = await r.call('/user/certification-requests', 'POST', educationRequest('cscse'), r.token(2));
  assert.equal(entry(domestic, 'education').application.source, 'chsi');
  assert.equal(entry(overseas, 'education').application.source, 'cscse');
  assert.equal(entry(overseas, 'education').application.educationLevel, 'master');
  const own = await r.call('/user/certifications', 'GET', { userId: 2 }, r.token(1));
  assert.equal(entry(own, 'education').application.source, 'chsi');
});

test('repeated pending requests are idempotent and cannot overwrite the first application', async () => {
  const r = runtime(fixture(false)), token = r.token(1);
  const first = await r.call('/user/certification-requests', 'POST', educationRequest(), token);
  const stored = plain(r.fixtures.hl_member_certifications[0]), count = r.writes.length;
  const repeated = await r.call('/user/certification-requests', 'POST', educationRequest('cscse'), token);
  assert.deepEqual(plain(repeated.data), plain(first.data)); assert.equal(r.writes.length, count);
  assert.deepEqual(plain(r.fixtures.hl_member_certifications[0]), stored);
});

test('request rejects target users, evidence, self-approval, asset tiers and unconfirmed consent before any write', async () => {
  const r = runtime(fixture(false)), token = r.token(1);
  const rejected = [request('unknown'), request('identity', { userId: 2 }), request('identity', { status: 'approved' }),
    request('identity', { evidenceReference: '证件编号' }), request('assets', { financialAssetRange: 'over_10m' }),
    request('assets', { source: 'bank_statement' }), request('identity', { consentConfirmed: 'true' }),
    { kind: 'identity' }, educationRequest('school_upload'), request('education', { source: 'chsi', educationLevel: '__proto__' }),
    request('education', { source: 'cscse', educationLevel: 'master', institutionName: 'a'.repeat(121) })];
  for (const body of rejected) {
    const result = await r.call('/user/certification-requests', 'POST', body, token);
    assert.equal(result.code, 42240, JSON.stringify(body));
  }
  assert.equal(r.writes.length, 0); assert.equal(r.fixtures.hl_member_certifications.length, 0);
  assert.equal((await r.call('/admin/member-certifications/2', 'PUT', { kind: 'identity', status: 'approved',
    source: 'identity_document', evidenceReference: 'proof' }, token)).code, 40100);
});

test('unsaved profiles produce a clear 422 and are never created by requesting certification', async () => {
  const r = runtime();
  const result = await r.call('/user/certification-requests', 'POST', request('assets'), r.token(3));
  assert.equal(result.code, 42240); assert.match(result.message, /先保存我的资料/);
  assert.equal(r.writes.length, 0); assert.equal(r.fixtures.hl_profiles.length, 2);
});

test('admin reviews synchronize pending applications and only approved validated sources set public flags', async () => {
  const r = runtime(), token = r.token(1), admin = r.adminToken();
  for (const [kind, source, flag] of [['identity', 'identity_document', 'identityVerified'],
    ['vehicle', 'vehicle_license', 'vehicleVerified'], ['property', 'property_certificate', 'propertyVerified']]) {
    await r.call('/user/certification-requests', 'POST', request(kind), token);
    const approved = await r.call('/admin/member-certifications/1', 'PUT', { kind, status: 'approved', source,
      applicationId: r.fixtures.hl_member_certifications[0].applications[kind].requestId,
      evidenceReference: `PRIVATE_PROOF_${kind}`, remark: 'INTERNAL_AUDIT', feedback: '核验通过' }, admin);
    assert.equal(approved.code, 0); assert.equal(approved.data[flag], true);
    const own = await r.call('/user/certifications', 'GET', {}, token);
    assert.equal(entry(own, kind).verified, true); assert.equal(entry(own, kind).status, 'approved');
    assert.equal(entry(own, kind).application.status, 'approved'); assert.equal(entry(own, kind).feedback, '核验通过');
  }
  const profile = await r.call('/user/profile', 'GET', {}, token);
  assert.equal(profile.data.profile.identityVerified, true); assert.equal(profile.data.profile.vehicleVerified, true);
  assert.equal(profile.data.profile.propertyVerified, true);
  assert.doesNotMatch(JSON.stringify(profile), /PRIVATE_PROOF|INTERNAL_AUDIT|showcaseCertification|identity_document|feedback/);
  assert.equal(policy.publicCertificationFields({ identityVerified: true, propertyVerified: true, vehicleVerified: true }).identityVerified, false);
});

test('resubmission retains current approved education and assets until rejection/revocation, without changing consent', async () => {
  const r = runtime(), token = r.token(1), admin = r.adminToken();
  for (const body of [
    { kind: 'education', source: 'cscse', educationLevel: '博士', status: 'approved', evidenceReference: 'PRIVATE_EDU' },
    { kind: 'assets', source: 'bank_statement', financialAssetRange: '2m_5m', status: 'approved', evidenceReference: 'PRIVATE_BANK' }
  ]) assert.equal((await r.call('/admin/member-certifications/1', 'PUT', body, admin)).code, 0);
  const pending = await r.call('/user/certification-requests', 'POST', educationRequest('chsi'), token);
  assert.equal(entry(pending, 'education').status, 'pending'); assert.equal(entry(pending, 'education').verified, true);
  assert.equal(entry(pending, 'education').verifiedEducation, '博士');
  const assetsPending = await r.call('/user/certification-requests', 'POST', request('assets'), token);
  assert.equal(entry(assetsPending, 'assets').verified, true); assert.equal(entry(assetsPending, 'assets').verifiedFinancialAssetRange, '2m_5m');
  const profile = r.fixtures.hl_profiles[0];
  assert.equal(profile.assetCategoryConsent, false); assert.equal(profile.assetRangeDisclosure, false);
  for (const [kind, status] of [['education', 'rejected'], ['assets', 'revoked']]) {
    assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { kind, status,
      applicationId: r.fixtures.hl_member_certifications[0].applications[kind].requestId,
      feedback: '需重新提供可核验材料', remark: 'PRIVATE_AUDIT' }, admin)).code, 0);
    const own = await r.call('/user/certifications', 'GET', {}, token);
    assert.equal(entry(own, kind).status, status); assert.equal(entry(own, kind).verified, false);
    assert.equal(entry(own, kind).application.status, status); assert.equal(entry(own, kind).feedback, '需重新提供可核验材料');
    assert.equal('verifiedEducation' in entry(own, kind), false); assert.equal('verifiedFinancialAssetRange' in entry(own, kind), false);
  }
});

test('visible feedback is independent from private evidence, internal remarks and admin session data', async () => {
  const r = runtime(), token = r.token(1), admin = r.adminToken();
  await r.call('/user/certification-requests', 'POST', educationRequest('cscse'), token);
  await r.call('/admin/member-certifications/1', 'PUT', { kind: 'education', status: 'rejected',
    applicationId: r.fixtures.hl_member_certifications[0].applications.education.requestId,
    evidenceReference: 'PRIVATE_EVIDENCE', remark: 'PRIVATE_REMARK', feedback: '请联系主理人补充认证结果' }, admin);
  const own = await r.call('/user/certifications', 'GET', {}, token);
  assert.equal(entry(own, 'education').feedback, '请联系主理人补充认证结果');
  assert.doesNotMatch(JSON.stringify(own), /PRIVATE_|reviewedBy|shared-admin|review-session|reviews|consentConfirmed|requestId|applicationId/);
  const listed = await r.call('/admin/member-certifications', 'GET', { userId: 1 }, admin);
  assert.match(JSON.stringify(listed), /PRIVATE_EVIDENCE/); assert.match(JSON.stringify(listed), /PRIVATE_REMARK/);
  await r.call('/user/certification-requests', 'POST', educationRequest(), token);
  const renewed = await r.call('/user/certifications', 'GET', {}, token);
  assert.equal(entry(renewed, 'education').status, 'pending'); assert.equal('feedback' in entry(renewed, 'education'), false);
  assert.equal(r.fixtures.hl_member_certifications[0].applicationHistory.length, 1);
  assert.equal(r.fixtures.hl_member_certifications[0].applicationHistory[0].status, 'rejected');
});

test('admin source/proof and feedback validation reject malformed reviews and do not convert vehicle/property into assets', async () => {
  const r = runtime(), admin = r.adminToken();
  for (const body of [
    { kind: 'identity', status: 'approved', source: 'identity_document' },
    { kind: 'vehicle', status: 'approved', source: 'property_certificate', evidenceReference: 'proof' },
    { kind: 'assets', status: 'approved', source: 'vehicle_license', financialAssetRange: 'over_10m', evidenceReference: 'proof' },
    { kind: 'property', status: 'rejected', feedback: 'x'.repeat(501) },
    { kind: 'identity', status: 'rejected', feedback: { raw: 'not a visible string' } }
  ]) assert.equal((await r.call('/admin/member-certifications/1', 'PUT', body, admin)).code, 42240);
  assert.equal(r.writes.length, 0);
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { kind: 'vehicle', status: 'approved',
    source: 'vehicle_license', evidenceReference: 'proof' }, admin)).code, 0);
  const own = await r.call('/user/certifications', 'GET', {}, r.token(1));
  assert.equal(entry(own, 'assets').verified, false); assert.equal(entry(own, 'vehicle').verified, true);
});

test('reviewing a pending application requires its exact ID and cannot approve a newer application from an old review page', async () => {
  const r = runtime(), token = r.token(1), admin = r.adminToken();
  await r.call('/user/certification-requests', 'POST', educationRequest(), token);
  const applicationA = r.fixtures.hl_member_certifications[0].applications.education.requestId;
  const approve = { kind: 'education', status: 'approved', source: 'chsi', educationLevel: '硕士', evidenceReference: 'PRIVATE_A_PROOF' };
  const count = r.writes.length;
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', approve, admin)).code, 42240);
  assert.equal(r.writes.length, count);
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { ...approve, applicationId: applicationA }, admin)).code, 0);
  await r.call('/user/certification-requests', 'POST', educationRequest('cscse'), token);
  const applicationB = r.fixtures.hl_member_certifications[0].applications.education.requestId;
  assert.notEqual(applicationB, applicationA);
  const before = plain(r.fixtures), beforeWrites = r.writes.length;
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { ...approve, applicationId: applicationA }, admin)).code, 40940);
  assert.equal(r.writes.length, beforeWrites); assert.deepEqual(plain(r.fixtures), before);
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { ...approve, source: 'cscse', applicationId: applicationB }, admin)).code, 0);
  assert.equal(r.fixtures.hl_member_certifications[0].current.education.applicationId, applicationB);
});

test('mismatched certification ownership and user/profile changes cannot read or mutate another account', async () => {
  const f = fixture(false); f.hl_member_certifications.push({ _id: 'user_1', userId: 2, current: {
    assets: { status: 'approved', source: 'bank_statement', financialAssetRange: 'over_10m', evidenceReference: 'PRIVATE_OTHER' }
  } });
  const r = runtime(f);
  const leaked = await r.call('/user/certifications', 'GET', {}, r.token(1));
  assert.equal(leaked.code, 40940); assert.doesNotMatch(JSON.stringify(leaked), /PRIVATE_OTHER|over_10m/);
  assert.equal((await r.call('/user/certification-requests', 'POST', request('assets'), r.token(1))).code, 40940);
  assert.equal((await r.call('/admin/member-certifications/1', 'PUT', { kind: 'assets', status: 'revoked' }, r.adminToken())).code, 40940);
  assert.equal(r.writes.length, 0);
  const stale = runtime(fixture(), rows => { rows.hl_profiles[0].userId = 2; });
  assert.equal((await stale.call('/user/certification-requests', 'POST', request('identity'), stale.token(1))).code, 40940);
  assert.equal(stale.writes.length, 0);
});

test('inactive, merged and expired-auth accounts cannot query or submit their prior certifications', async () => {
  for (const patch of [{ status: 0 }, { mergedIntoUserId: 2 }, { authVersion: 2 }]) {
    const f = fixture(); Object.assign(f.hl_users[0], patch); const r = runtime(f);
    assert.equal((await r.call('/user/certifications', 'GET', {}, r.token(1))).code, 40100);
    assert.equal((await r.call('/user/certification-requests', 'POST', request('identity'), r.token(1))).code, 40100);
    assert.equal(r.writes.length, 0); assert.ok(r.reads.every(row => row.name !== 'hl_member_certifications'));
  }
});

test('material upload persists only AEAD ciphertext and returns an opaque metadata handle', async () => {
  const r = runtime(fixture(false));
  const first = await upload(r, 'identity'), second = await upload(r, 'identity');
  assert.equal(first.code, 0); assert.equal(second.code, 0);
  assert.deepEqual(Object.keys(first.data.material).sort(), ['createdAt', 'id', 'kind', 'mimeType', 'size']);
  assert.doesNotMatch(JSON.stringify(first), /cloud:\/\/|fileID|PRIVATE_DOCUMENT|contentBase64|algorithm/);
  assert.notEqual(r.uploads[0].fileContent.toString(), r.uploads[1].fileContent.toString());
  assert.doesNotMatch(r.uploads[0].fileContent.toString(), /PRIVATE_DOCUMENT_CONTENT/);
  assert.match(r.uploads[0].cloudPath, /^hl_uploads\/member-certification-encrypted\/[a-z0-9-]+\.enc$/);
  const stored = r.fixtures.hl_member_certifications[0].materials[first.data.material.id];
  assert.equal(stored.status, 'staging'); assert.ok(stored.expiresAt); assert.equal(stored.size, JPEG.length);
  assert.doesNotMatch(JSON.stringify(r.fixtures), /PRIVATE_DOCUMENT_CONTENT|contentBase64|fileName/);
  const own = await r.call(`/user/certification-materials/${stored.id}`, 'GET', {}, r.token(1));
  assert.equal(own.code, 0); assert.equal(own.data.contentBase64, JPEG.toString('base64'));
  assert.doesNotMatch(JSON.stringify(own), /fileID|cloud:\/\/|algorithm|iv|tag/);
});

test('material input validates canonical base64, file signature, size, kind and disallows filenames before uploading', async () => {
  const r = runtime(fixture(false));
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(512000)]).toString('base64');
  for (const data of [
    { mimeType: 'image/webp' }, { mimeType: 'image/png' }, { mimeType: 'application/pdf' },
    { contentBase64: 'not valid base64!' }, { contentBase64: '' }, { contentBase64: oversized },
    { kind: 'unknown' }, { fileName: 'id-card.jpg' }, { userId: 2 }
  ]) assert.equal((await upload(r, 'identity', 1, data)).code, 42240);
  assert.equal(r.uploads.length, 0); assert.equal(r.writes.length, 0);
  const adminOnly = await r.call('/user/certification-materials', 'POST', { kind: 'identity', mimeType: 'image/jpeg', contentBase64: JPEG.toString('base64') }, r.adminToken());
  assert.equal(adminOnly.code, 40100); assert.equal(r.uploads.length, 0);
});

test('three-file limit is transactional and a rejected fourth encrypted upload is compensated', async () => {
  const r = runtime(fixture(false));
  for (let index = 0; index < 3; index++) assert.equal((await upload(r, 'vehicle')).code, 0);
  const fourth = await upload(r, 'vehicle');
  assert.equal(fourth.code, 42240); assert.equal(r.storage.size, 3); assert.equal(r.deletions.length, 1);
  assert.equal(Object.keys(r.fixtures.hl_member_certifications[0].materials).length, 3);
});

test('materials cannot cross accounts, kinds, deleted state or expiry during application binding', async () => {
  const r = runtime(fixture(false));
  const uploaded = await upload(r, 'identity'); const id = uploaded.data.material.id;
  assert.equal((await r.call(`/user/certification-materials/${id}`, 'GET', {}, r.token(2))).code, 40400);
  assert.equal((await r.call(`/user/certification-materials/${id}`, 'DELETE', {}, r.token(2))).code, 40400);
  assert.equal((await r.call('/user/certification-requests', 'POST', request('identity', { materialIds: [id] }), r.token(2))).code, 42240);
  assert.equal((await r.call('/user/certification-requests', 'POST', request('property', { materialIds: [id] }), r.token(1))).code, 42240);
  assert.equal((await r.call('/user/certification-requests', 'POST', request('identity', { materialIds: [id, id] }), r.token(1))).code, 42240);
  r.fixtures.hl_member_certifications[0].materials[id].expiresAt = '2020-01-01T00:00:00Z';
  assert.equal((await r.call(`/user/certification-materials/${id}`, 'GET', {}, r.token(1))).code, 40400);
  assert.equal((await r.call('/user/certification-requests', 'POST', request('identity', { materialIds: [id] }), r.token(1))).code, 42240);
});

test('unbound staging removal deletes ciphertext and metadata; bound or historical materials never delete', async () => {
  const r = runtime(fixture(false));
  const uploaded = await upload(r, 'property'); const id = uploaded.data.material.id;
  assert.equal((await r.call(`/user/certification-materials/${id}`, 'DELETE', {}, r.token(1))).code, 0);
  assert.equal(r.storage.size, 0); assert.equal(id in r.fixtures.hl_member_certifications[0].materials, false);
  const boundUpload = await upload(r, 'property'), boundId = boundUpload.data.material.id;
  assert.equal((await r.call('/user/certification-requests', 'POST', request('property', { materialIds: [boundId] }), r.token(1))).code, 0);
  const applicationId = r.fixtures.hl_member_certifications[0].applications.property.requestId;
  assert.equal((await r.call(`/user/certification-materials/${boundId}`, 'DELETE', {}, r.token(1))).code, 40940);
  await r.call('/admin/member-certifications/1', 'PUT', { kind: 'property', status: 'rejected', applicationId }, r.adminToken());
  const second = await upload(r, 'property');
  assert.equal((await r.call('/user/certification-requests', 'POST', request('property', { materialIds: [second.data.material.id] }), r.token(1))).code, 0);
  assert.equal((await r.call(`/user/certification-materials/${boundId}`, 'DELETE', {}, r.token(1))).code, 40940);
  assert.ok(r.storage.has(boundUpload.data.material.id ? r.fixtures.hl_member_certifications[0].materials[boundId].fileID : ''));
});

test('expired staging cleanup is lazy, preserves application-bound files and leaves failed deletes blocked for retry', async () => {
  const r = runtime(fixture(false));
  const unbound = await upload(r, 'identity'), bound = await upload(r, 'vehicle');
  const unboundId = unbound.data.material.id, boundId = bound.data.material.id;
  await r.call('/user/certification-requests', 'POST', request('vehicle', { materialIds: [boundId] }), r.token(1));
  const materials = r.fixtures.hl_member_certifications[0].materials;
  materials[unboundId].expiresAt = '2020-01-01T00:00:00Z'; materials[boundId].expiresAt = '2020-01-01T00:00:00Z';
  assert.equal((await upload(r, 'property')).code, 0);
  const saved = r.fixtures.hl_member_certifications[0].materials;
  assert.equal(unboundId in saved, false); assert.equal(saved[boundId].status, 'bound');
  assert.equal((await r.call(`/user/certification-materials/${boundId}`, 'GET', {}, r.token(1))).code, 0);
  const failed = runtime(fixture(false), () => {}, { failDelete: true });
  const stage = await upload(failed, 'identity'); const stageId = stage.data.material.id;
  const removed = await failed.call(`/user/certification-materials/${stageId}`, 'DELETE', {}, failed.token(1));
  assert.equal(removed.code, 50340); assert.equal(failed.fixtures.hl_member_certifications[0].materials[stageId].status, 'deleting');
  assert.equal((await failed.call(`/user/certification-materials/${stageId}`, 'GET', {}, failed.token(1))).code, 40400);
  assert.equal((await failed.call('/user/certification-requests', 'POST', request('identity', { materialIds: [stageId] }), failed.token(1))).code, 42240);
});

test('upload rechecks account and profile after storage writes and compensates a changed session', async () => {
  const r = runtime(fixture(false), () => {}, { afterUpload: rows => { rows.hl_users[0].authVersion = 2; } });
  const result = await upload(r, 'identity');
  assert.equal(result.code, 40940); assert.equal(r.storage.size, 0); assert.equal(r.fixtures.hl_member_certifications.length, 0);
  const missing = runtime(fixture(false));
  assert.equal((await upload(missing, 'identity', 3)).code, 42240); assert.equal(missing.uploads.length, 0);
  const noKey = runtime(fixture(false), () => {}, { env: { JWT_SECRET: '' } });
  assert.equal((await upload(noKey, 'identity')).code, 50340); assert.equal(noKey.uploads.length, 0);
});

test('education method validation requires school, correct source and conditionally code, certificate number or materials', async () => {
  const r = runtime(), token = r.token(1);
  for (const data of [
    { ...educationRequest(), institutionName: '' }, { ...educationRequest(), educationLevel: '硕士' },
    { ...educationRequest(), source: 'cscse' }, { ...educationRequest(), verificationCode: '' },
    { ...educationRequest('cscse'), source: 'chsi' }, { ...educationRequest('cscse'), certificateNumber: '' },
    { ...educationRequest(), method: 'diploma_photo', verificationCode: undefined, materialIds: [] },
    { ...educationRequest(), method: 'study_proof', verificationCode: undefined, materialIds: [] },
    request('identity', { method: 'diploma_photo' }), request('vehicle', { verificationCode: '1234567890123456' })
  ]) assert.equal((await r.call('/user/certification-requests', 'POST', data, token)).code, 42240);
  for (const method of ['diploma_photo', 'study_proof']) {
    const f = runtime();
    const result = await f.call('/user/certification-requests', 'POST', request('education', { method, source: 'cscse', educationLevel: 'doctor',
      institutionName: '境外学校', materialIds: ['fixture-education'] }), f.token(1));
    assert.equal(result.code, 0); assert.equal(entry(result, 'education').application.method, method);
    assert.equal(entry(result, 'education').verified, false);
  }
  assert.equal(r.writes.length, 0);
});

test('codes, certificate numbers and declared assets are encrypted at rest and available only to authorized admin evidence reads', async () => {
  for (const [kind, body, secretField, secret] of [
    ['education', educationRequest(), 'verificationCode', 'A123456789012345'],
    ['education', educationRequest('cscse'), 'certificateNumber', 'PRIVATE_CSCSE_CERTIFICATE_NUMBER'],
    ['assets', request('assets', { declaredFinancialAssetRange: 'over_10m' }), 'declaredFinancialAssetRange', 'over_10m']
  ]) {
    const r = runtime(), token = r.token(1), admin = r.adminToken();
    const submitted = await r.call('/user/certification-requests', 'POST', body, token);
    assert.equal(submitted.code, 0);
    assert.equal(JSON.stringify(r.fixtures).includes(secret), false); assert.equal(JSON.stringify(submitted).includes(secret), false);
    const own = await r.call('/user/certifications', 'GET', {}, token);
    assert.equal(JSON.stringify(own).includes(secret), false); assert.equal(entry(own, kind).verified, false);
    const url = `/admin/member-certifications/1/applications/${kind}/evidence`;
    assert.equal((await r.call(url, 'GET', {}, token)).code, 40100);
    const evidence = await r.call(url, 'GET', {}, admin);
    assert.equal(evidence.code, 0); assert.equal(evidence.data[secretField], secret); assert.ok(evidence.data.applicationId);
    assert.doesNotMatch(JSON.stringify(evidence), /fileID|cloud:\/\/|sealedVerification|algorithm|requestId/);
    const listed = await r.call('/admin/member-certifications', 'GET', { userId: 1 }, admin);
    assert.equal(JSON.stringify(listed).includes(secret), false); assert.doesNotMatch(JSON.stringify(listed), /fileID|cloud:\/\/|sealedVerification/);
    assert.equal((await r.call(url, 'GET', { applicationId: 'stale' }, admin)).code, 40940);
  }
});

test('admin material reads require an admin session, matching target ownership and an application-bound material', async () => {
  const r = runtime(fixture(false)), token = r.token(1), admin = r.adminToken();
  const result = await upload(r, 'assets'), id = result.data.material.id;
  const path = `/admin/member-certifications/1/materials/${id}`;
  assert.equal((await r.call(path, 'GET', {}, admin)).code, 40400);
  await r.call('/user/certification-requests', 'POST', request('assets', { materialIds: [id], declaredFinancialAssetRange: '2m_5m' }), token);
  assert.equal((await r.call(path, 'GET', {}, token)).code, 40100);
  assert.equal((await r.call(`/admin/member-certifications/2/materials/${id}`, 'GET', {}, admin)).code, 40400);
  const read = await r.call(path, 'GET', {}, admin);
  assert.equal(read.code, 0); assert.equal(read.data.contentBase64, JPEG.toString('base64'));
  assert.doesNotMatch(JSON.stringify(read), /fileID|cloud:\/\/|algorithm/);
});

test('material ciphertext or context tampering cannot return decrypted evidence', async () => {
  const r = runtime(fixture(false)); const result = await upload(r, 'identity'), id = result.data.material.id;
  const material = r.fixtures.hl_member_certifications[0].materials[id];
  const envelope = JSON.parse(r.storage.get(material.fileID).toString('utf8'));
  envelope.tag = Buffer.alloc(16).toString('base64'); r.storage.set(material.fileID, Buffer.from(JSON.stringify(envelope)));
  const corrupted = await r.call(`/user/certification-materials/${id}`, 'GET', {}, r.token(1));
  assert.equal(corrupted.code, 42240); assert.doesNotMatch(JSON.stringify(corrupted), /PRIVATE_DOCUMENT|contentBase64/);
  const other = runtime(fixture(false)); const uploadOther = await upload(other, 'identity'), otherId = uploadOther.data.material.id;
  other.fixtures.hl_member_certifications[0].materials[otherId].kind = 'property';
  const wrongContext = await other.call(`/user/certification-materials/${otherId}`, 'GET', {}, other.token(1));
  assert.equal(wrongContext.code, 42240); assert.doesNotMatch(JSON.stringify(wrongContext), /PRIVATE_DOCUMENT|contentBase64/);
});

test('legacy Chinese application levels project to English while legacy direct admin approval remains supported', async () => {
  const f = fixture(false); f.hl_member_certifications.push({ _id: 'user_1', userId: 1, applications: {
    education: { status: 'pending', source: 'chsi', educationLevel: '硕士', institutionName: '原学校', requestId: 'legacy' }
  } });
  const r = runtime(f); const own = await r.call('/user/certifications', 'GET', {}, r.token(1));
  assert.equal(entry(own, 'education').application.educationLevel, 'master');
  const fresh = runtime(fixture(false));
  assert.equal((await fresh.call('/admin/member-certifications/1', 'PUT', { kind: 'education', status: 'approved',
    source: 'chsi', educationLevel: '硕士', evidenceReference: 'internal reference' }, fresh.adminToken())).code, 0);
  assert.equal((await fresh.call('/user/certifications', 'GET', {}, fresh.token(1))).data.entries.find(row => row.kind === 'education').verifiedEducation, '硕士');
});

test('admin login fails closed without a configured secret or with the public default, while configured admin sessions can review evidence', async () => {
  for (const value of [undefined, '', '  ', 'HLADMIN', ' hladmin ']) {
    const r = runtime(fixture(false), () => {}, { env: { ADMIN_CODE: value } });
    assert.equal((await r.call('/admin/login', 'POST', { code: 'HLADMIN' }, '')).code, 50340);
  }
  const r = runtime(), adminCode = 'fixture-private-admin-code';
  const configured = runtime(fixture(), () => {}, { env: { ADMIN_CODE: adminCode } });
  assert.equal((await configured.call('/admin/login', 'POST', { code: 'wrong' }, '')).code, 40102);
  const login = await configured.call('/admin/login', 'POST', { code: adminCode }, '');
  assert.equal(login.code, 0); assert.ok(login.data.token);
  await configured.call('/user/certification-requests', 'POST', educationRequest(), configured.token(1));
  const path = '/admin/member-certifications/1/applications/education/evidence';
  assert.equal((await configured.call(path, 'GET', {}, configured.token(1))).code, 40100);
  assert.equal((await configured.call(path, 'GET', {}, login.data.token)).code, 0);
  assert.equal((await r.call('/admin/login', 'POST', { code: adminCode }, '')).code, 0);
  assert.equal((await configured.call(path, 'GET', {}, configured.legacyAdminToken())).code, 40102);
  const disabled = runtime(fixture(), () => {}, { env: { ADMIN_CODE: undefined } });
  assert.equal((await disabled.call('/admin/login', 'POST', { code: 'HLADMIN' }, '')).code, 50340);
  assert.equal((await disabled.call(path, 'GET', {}, disabled.legacyAdminToken())).code, 50340);
});

test('certification admin access binds the currently configured credential, rejects legacy read/review tokens and preserves other admin routes', async () => {
  const original = runtime();
  await original.call('/user/certification-requests', 'POST', educationRequest(), original.token(1));
  const evidencePath = '/admin/member-certifications/1/applications/education/evidence';
  const legacy = original.legacyAdminToken();
  assert.equal((await original.call(evidencePath, 'GET', {}, legacy)).code, 40102);
  assert.equal((await original.call('/admin/member-certifications', 'GET', {}, legacy)).code, 40102);
  const before = original.writes.length;
  assert.equal((await original.call('/admin/member-certifications/1', 'PUT', { kind: 'education', status: 'rejected' }, legacy)).code, 40102);
  assert.equal(original.writes.length, before);
  assert.equal((await original.call('/admin/dashboard', 'GET', {}, legacy)).code, 0);
  const rotated = runtime(original.fixtures, () => {}, { env: { ADMIN_CODE: 'changed-private-admin-code' } });
  assert.equal((await rotated.call(evidencePath, 'GET', {}, original.adminToken())).code, 40102);
  const newLogin = await rotated.call('/admin/login', 'POST', { code: 'changed-private-admin-code' }, '');
  assert.equal(newLogin.code, 0);
  const reopened = await rotated.call(evidencePath, 'GET', {}, newLogin.data.token);
  assert.equal(reopened.code, 0); assert.equal(reopened.data.verificationCode, 'A123456789012345');
});

test('decrypted material bytes must still match the recorded MIME and exact size', async () => {
  for (const patch of [{ mimeType: 'application/pdf' }, { size: JPEG.length + 1 }]) {
    const r = runtime(fixture(false)); const uploaded = await upload(r, 'education'), id = uploaded.data.material.id;
    Object.assign(r.fixtures.hl_member_certifications[0].materials[id], patch);
    const response = await r.call(`/user/certification-materials/${id}`, 'GET', {}, r.token(1));
    assert.equal(response.code, 42240); assert.doesNotMatch(JSON.stringify(response), /contentBase64|PRIVATE_DOCUMENT/);
  }
});

test('certification SDK failures cannot echo sensitive request diagnostics into responses or logs', async () => {
  const r = runtime(fixture(false), () => {}, { certificationReadError: 'PRIVATE_DOCUMENT_CONTENT account-number verification-code fileID' });
  const response = await r.call('/user/certifications', 'GET', {}, r.token(1));
  assert.equal(response.code, 50340); assert.doesNotMatch(JSON.stringify(response), /PRIVATE_DOCUMENT|account-number|verification-code|fileID/);
  assert.doesNotMatch(r.loggedErrors.join(' '), /PRIVATE_DOCUMENT|account-number|verification-code|fileID/);
  assert.match(r.loggedErrors.join(' '), /50340/);
});
