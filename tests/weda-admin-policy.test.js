'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WEDA_ENV_ID, CAPABILITIES, ACTION_NAMES, MAX_PAGE, prepareWedaAdminAction, assertCertificationBinding
} = require('../cloudfunctions/hlApi/weda-admin-policy');

const UID = 'fixture-cloudbase-admin-one';
const secondUid = 'fixture-cloudbase-admin-two';
function context(patch = {}) {
  return { env: { uid: UID, envId: WEDA_ENV_ID, envType: 'prod', isPreview: false, isAnonymous: false, ...patch } };
}
function permissions(capabilities = CAPABILITIES) {
  return { [UID]: { enabled: true, displayName: '管理员甲', wedaUserId: 'fixture-weda-one', capabilities: [...capabilities] } };
}
function plan(action = 'dashboard.read', args = {}, options = {}) {
  return prepareWedaAdminAction({ trustedContext: context(), params: { action, args },
    serverPermissions: permissions(), serverRequestId: 'server-request-001', ...options });
}
function rejects(fn, status) {
  assert.throws(fn, error => error instanceof Error && error.status === status && Number.isInteger(error.code));
}
function ownerRecord(patch = {}) {
  return { userId: 12, applications: { identity: { requestId: 'application_current', status: 'pending', materialIds: ['material_current'] } },
    materials: { material_current: { id: 'material_current', kind: 'identity', applicationId: 'application_current', status: 'bound' } }, ...patch };
}
const identityArgs = { userId: 12, kind: 'identity', applicationId: 'application_current' };

test('default permission map denies every caller and cannot be replaced by a caller-provided identity', () => {
  rejects(() => prepareWedaAdminAction({ trustedContext: context(), params: { action: 'dashboard.read' }, serverRequestId: 'server-1' }), 403);
  rejects(() => prepareWedaAdminAction({ params: { action: 'dashboard.read', trustedContext: context(), uid: UID, role: 'admin' },
    serverPermissions: permissions(), serverRequestId: 'server-1' }), 401);
  rejects(() => plan('dashboard.read', {}, { trustedContext: { uid: UID, role: 'admin' } }), 401);
});

test('only the verified custom-API context shape is accepted; no process or native SDK fallback supplies identity', () => {
  const cases = [undefined, null, {}, { env: null }, { env: { uid: UID } },
    { environment: { TCB_UUID: UID, TCB_ENV: WEDA_ENV_ID } }, { environ: { TCB_UUID: UID } },
    { env: Object.create(context().env) }, { env: { ...context().env, uid: undefined } },
    { env: { ...context().env, uid: '' } }, { env: { ...context().env, uid: ` ${UID}` } },
    { env: { ...context().env, uid: `${UID}\n` } }, { env: { ...context().env, uid: 12 } }];
  const previous = process.env.TCB_UUID;
  process.env.TCB_UUID = UID;
  try { for (const trustedContext of cases) rejects(() => plan('dashboard.read', {}, { trustedContext }), 401); }
  finally { if (previous === undefined) delete process.env.TCB_UUID; else process.env.TCB_UUID = previous; }
});

test('anonymous, foreign environment, preview and missing trusted identity flags fail closed', () => {
  for (const patch of [{ isAnonymous: true }, { isAnonymous: 'false' }, { isAnonymous: undefined },
    { envId: 'another-environment' }, { envId: undefined }, { envType: 'pre' }, { envType: undefined },
    { isPreview: true }, { isPreview: undefined }, { isPreview: 'false' }]) {
    rejects(() => plan('dashboard.read', {}, { trustedContext: context(patch) }), 401);
  }
});

test('unknown or disabled operators and inherited permissions do not gain access', () => {
  rejects(() => plan('dashboard.read', {}, { trustedContext: context({ uid: 'unlisted-external-user' }) }), 403);
  for (const enabled of [false, 'true', undefined]) {
    const config = permissions(); config[UID].enabled = enabled;
    rejects(() => plan('dashboard.read', {}, { serverPermissions: config }), 403);
  }
  rejects(() => plan('dashboard.read', {}, { serverPermissions: Object.create(permissions()) }), 503);
  rejects(() => plan('dashboard.read', {}, { trustedContext: context({ uid: '__proto__' }) }), 403);
});

test('two explicitly bound operators receive their own actor and independent capabilities', () => {
  const config = { ...permissions(['dashboard.read']),
    [secondUid]: { enabled: true, displayName: '管理员乙', wedaUserId: 'fixture-weda-two', capabilities: ['payment-orders.read'] } };
  const first = plan('dashboard.read', {}, { serverPermissions: config });
  const second = plan('payment-orders.list', {}, { trustedContext: context({ uid: secondUid }), serverPermissions: config });
  assert.deepEqual(first.actor, { provider: 'weda', uid: UID, envId: WEDA_ENV_ID, envType: 'prod', displayName: '管理员甲', wedaUserId: 'fixture-weda-one' });
  assert.equal(second.actor.uid, secondUid);
  assert.equal(second.actor.displayName, '管理员乙');
  rejects(() => plan('salons.review', { salonId: 5, status: 'upcoming' }, { serverPermissions: config }), 403);
  config[secondUid].enabled = false;
  rejects(() => plan('payment-orders.list', {}, { trustedContext: context({ uid: secondUid }), serverPermissions: config }), 403);
});

test('malformed server configuration and wildcard capabilities do not broaden access', () => {
  for (const patch of [{ capabilities: ['*'] }, { capabilities: ['admin'] }, { capabilities: ['payment-orders.write'] },
    { capabilities: 'dashboard.read' }, { displayName: '' }, { displayName: 'unsafe\nname' }, { wedaUserId: '../operator' }]) {
    const config = permissions(); Object.assign(config[UID], patch);
    rejects(() => plan('dashboard.read', {}, { serverPermissions: config }), 503);
  }
});

test('no frontend credential, route, function, identity or permission fields are accepted at either request level', () => {
  for (const key of ['uid', 'role', 'roles', 'token', 'code', 'path', 'method', 'functionName', 'actor', 'trustedContext', 'serverPermissions']) {
    rejects(() => plan('dashboard.read', {}, { params: { action: 'dashboard.read', [key]: 'forged' } }), 422);
    rejects(() => plan('payment-orders.list', { [key]: 'forged' }), 422);
  }
  rejects(() => plan('payment-orders.list', JSON.parse('{"__proto__":{"role":"admin"}}')), 422);
  rejects(() => plan('payment-orders.list', { keyword: { token: 'hidden' } }), 422);
  rejects(() => plan('payment-orders.list', { page: [1] }), 422);
  const getterParams = { action: 'dashboard.read' };
  Object.defineProperty(getterParams, 'args', { enumerable: true, get() { throw new Error('getter must not run'); } });
  rejects(() => plan('dashboard.read', {}, { params: getterParams }), 422);
});

test('all exported actions map to fixed existing administration routes', () => {
  const fixtures = [
    ['dashboard.read', {}, 'GET', '/admin/dashboard'],
    ['matchmakers.list', {}, 'GET', '/admin/matchmakers'],
    ['matchmakers.review', { matchmakerId: '11', certificationStatus: 2 }, 'PUT', '/admin/matchmakers/11/certification'],
    ['salons.list', {}, 'GET', '/admin/salons'],
    ['salons.review', { salonId: 13, status: 'upcoming' }, 'POST', '/admin/salons/13/review'],
    ['salons.cancel', { salonId: 13 }, 'PUT', '/admin/salons/13/cancel'],
    ['certifications.list', {}, 'GET', '/admin/member-certifications'],
    ['certifications.evidence', identityArgs, 'GET', '/admin/member-certifications/12/applications/identity/evidence'],
    ['certifications.material', { ...identityArgs, materialId: 'material_current' }, 'GET', '/admin/member-certifications/12/materials/material_current'],
    ['certifications.review', { ...identityArgs, status: 'rejected', feedback: '请补充资料' }, 'PUT', '/admin/member-certifications/12'],
    ['membership-plans.list', {}, 'GET', '/admin/membership-plans'],
    ['payment-orders.list', {}, 'GET', '/admin/payment-orders']
  ];
  assert.deepEqual(fixtures.map(row => row[0]), ACTION_NAMES);
  for (const [action, args, method, route] of fixtures) {
    const result = plan(action, args);
    assert.equal(result.method, method); assert.equal(result.path, route);
    assert.equal(result.audit.action, action);
    assert.ok(CAPABILITIES.includes(result.capability));
    assert.equal(result.actor.uid, UID);
  }
});

test('payment, price and entitlement mutations are absent even for a fully privileged configured operator', () => {
  for (const action of ['payment-orders.refund', 'payment-orders.update', 'payment-orders.confirm', 'membership-plans.update',
    'matchmaking.restore', 'cloud.invoke', '/admin/payment-orders', 'admin.login']) rejects(() => plan(action), 403);
  for (const action of ['membership-plans.list', 'payment-orders.list']) {
    assert.equal(plan(action).method, 'GET');
    for (const args of [{ price: 1 }, { amountFen: 1 }, { status: 'paid', refund: true }, { fulfillmentStatus: 'fulfilled', token: 'admin' },
      { active: true, planCode: 'vip_year' }]) rejects(() => plan(action, args), 422);
  }
});

test('list pagination, identifiers and keywords have strict bounds and safe normalization', () => {
  assert.deepEqual(plan('payment-orders.list', { page: '2', pageSize: '100', keyword: '  牵线  ', userId: '12' }).data,
    { page: 2, pageSize: 100, keyword: '牵线', userId: 12 });
  for (const page of [0, -1, 1.5, MAX_PAGE + 1, NaN, Infinity, true, '1e3', ' 1', null]) rejects(() => plan('payment-orders.list', { page }), 422);
  for (const pageSize of [0, 101, '101', -1, 1.2]) rejects(() => plan('payment-orders.list', { pageSize }), 422);
  for (const userId of [0, -1, Number.MAX_SAFE_INTEGER + 1, '../12', '12/other', true]) rejects(() => plan('certifications.list', { userId }), 422);
  for (const keyword of ['x'.repeat(129), 'unsafe\nkeyword', 'unsafe\u0000keyword', 12]) rejects(() => plan('payment-orders.list', { keyword }), 422);
  rejects(() => plan('matchmakers.list', { keyword: 'x'.repeat(81) }), 422);
});

test('only supported list filters and review results are accepted', () => {
  assert.deepEqual(plan('payment-orders.list', { status: 'paid', fulfillmentStatus: 'requires_review', productType: 'matchmaking' }).data,
    { page: 1, pageSize: 20, status: 'paid', fulfillmentStatus: 'requires_review', productType: 'matchmaking' });
  for (const args of [{ status: 'success' }, { fulfillmentStatus: 'refunded' }, { productType: 'anything' }]) rejects(() => plan('payment-orders.list', args), 422);
  rejects(() => plan('membership-plans.list', { active: 'true' }), 422);
  assert.equal(plan('membership-plans.list', { active: false }).data.active, false);
  rejects(() => plan('matchmakers.review', { matchmakerId: 1, certificationStatus: '2' }), 422);
  rejects(() => plan('salons.review', { salonId: 1, status: 'paid' }), 422);
  rejects(() => plan('salons.cancel', { salonId: '../1' }), 422);
});

test('ordinary operators and other certification categories cannot access identity or asset materials', () => {
  const material = { ...identityArgs, materialId: 'material_current' };
  for (const capabilities of [['dashboard.read', 'certifications.read'], ['certifications.identity.review'],
    ['certifications.identity.evidence.read'], ['certifications.assets.materials.read']]) {
    rejects(() => plan('certifications.material', material, { serverPermissions: permissions(capabilities) }), 403);
  }
  assert.equal(plan('certifications.material', material,
    { serverPermissions: permissions(['certifications.identity.materials.read']) }).capability, 'certifications.identity.materials.read');
  rejects(() => plan('certifications.evidence', { ...identityArgs, kind: 'assets' },
    { serverPermissions: permissions(['certifications.identity.evidence.read']) }), 403);
});

test('every certification evidence, material and review action requires its current application ID and category', () => {
  for (const action of ['certifications.evidence', 'certifications.material', 'certifications.review']) {
    const valid = { ...identityArgs, ...(action === 'certifications.material' ? { materialId: 'material_current' } : {}),
      ...(action === 'certifications.review' ? { status: 'rejected' } : {}) };
    for (const key of ['userId', 'kind', 'applicationId', ...(action === 'certifications.material' ? ['materialId'] : [])]) {
      const missing = { ...valid }; delete missing[key]; rejects(() => plan(action, missing), 422);
    }
    rejects(() => plan(action, { ...valid, applicationId: '../application' }), 422);
    rejects(() => plan(action, { ...valid, kind: 'role' }), 422);
  }
});

test('evidence/material/review plans contain explicit owner, category and application constraints', () => {
  for (const action of ['certifications.evidence', 'certifications.material', 'certifications.review']) {
    const args = { ...identityArgs, ...(action === 'certifications.material' ? { materialId: 'material_current' } : {}),
      ...(action === 'certifications.review' ? { status: 'rejected' } : {}) };
    const result = plan(action, args);
    assert.deepEqual(result.certificationBinding, { ...identityArgs, ...(action === 'certifications.material' ? { materialId: 'material_current' } : {}) });
    assert.equal(assertCertificationBinding(result, ownerRecord()), true);
    rejects(() => assertCertificationBinding(result, ownerRecord({ userId: 13 })), 409);
    const newer = ownerRecord(); newer.applications.identity.requestId = 'application_newer';
    rejects(() => assertCertificationBinding(result, newer), 409);
  }
});

test('a historical, wrong-kind, missing or unbound material cannot satisfy a current-application plan', () => {
  const result = plan('certifications.material', { ...identityArgs, materialId: 'material_current' });
  const mutations = [
    record => { record.materials.material_current.applicationId = 'application_old'; },
    record => { record.materials.material_current.kind = 'assets'; },
    record => { record.materials.material_current.status = 'staging'; },
    record => { record.materials.material_current.status = 'deleting'; },
    record => { record.materials.material_current.id = 'another_material'; },
    record => { delete record.materials.material_current; },
    record => { record.applications.identity.materialIds = []; },
    record => { record.applications.identity.materialIds.push('material_current'); },
    record => { delete record.applications.identity; }
  ];
  for (const mutate of mutations) { const record = ownerRecord(); mutate(record); rejects(() => assertCertificationBinding(result, record), 409); }
  const guessedOldId = plan('certifications.material', { ...identityArgs, materialId: 'material_old' });
  const record = ownerRecord(); record.materials.material_old = { id: 'material_old', kind: 'identity', applicationId: 'application_old', status: 'bound' };
  record.applicationHistory = [{ requestId: 'application_old', materialIds: ['material_old'] }];
  rejects(() => assertCertificationBinding(guessedOldId, record), 409);
});

test('review payloads retain existing approval rules and cannot mix certification-specific fields', () => {
  const approved = plan('certifications.review', { userId: 12, kind: 'education', applicationId: 'application_current',
    status: 'approved', source: 'chsi', evidenceReference: 'internal-case-001', educationLevel: '硕士' });
  assert.equal(approved.data.educationLevel, '硕士');
  assert.equal(Object.hasOwn(approved.data, 'level'), false);
  for (const args of [{ ...identityArgs, status: 'approved' }, { ...identityArgs, status: 'approved', source: 'chsi', evidenceReference: 'ref' },
    { ...identityArgs, status: 'rejected', educationLevel: '本科' }, { ...identityArgs, status: 'rejected', financialAssetRange: 'over_10m' },
    { ...identityArgs, status: 'rejected', feedback: 'x'.repeat(501) }]) rejects(() => plan('certifications.review', args), 422);
});

test('audit actor is server-derived, excludes evidence contents, and separates server and caller request IDs', () => {
  const result = plan('certifications.review', { ...identityArgs, status: 'rejected', remark: 'private internal remark', feedback: 'private feedback' },
    { params: { action: 'certifications.review', args: { ...identityArgs, status: 'rejected', remark: 'private internal remark' }, requestId: 'caller-correlation' } });
  assert.equal(result.audit.serverRequestId, 'server-request-001');
  assert.equal(result.audit.clientRequestId, 'caller-correlation');
  assert.deepEqual(result.audit.target, identityArgs);
  assert.equal(result.audit.actor.uid, UID);
  assert.equal(JSON.stringify(result.audit).includes('private internal remark'), false);
  assert.equal(JSON.stringify(result.actor).includes('token'), false);
  rejects(() => plan('dashboard.read', {}, { serverRequestId: undefined }), 503);
  rejects(() => plan('dashboard.read', {}, { serverRequestId: 'bad\nrequest' }), 503);
  rejects(() => plan('dashboard.read', {}, { params: { action: 'dashboard.read', requestId: '../forged' } }), 422);
});

test('plans are immutable copies and preparing/binding a plan never changes caller, config or owner records', () => {
  const args = { ...identityArgs, materialId: 'material_current' }, config = permissions(), trustedContext = context();
  const options = { trustedContext, params: { action: 'certifications.material', args }, serverPermissions: config, serverRequestId: 'server-1' };
  const before = structuredClone(options);
  const result = prepareWedaAdminAction(options);
  assert.deepEqual(options, before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.data) && Object.isFrozen(result.actor)
    && Object.isFrozen(result.certificationBinding) && Object.isFrozen(result.audit.target));
  args.applicationId = 'application_changed'; config[UID].displayName = 'changed';
  assert.equal(result.certificationBinding.applicationId, 'application_current');
  assert.equal(result.actor.displayName, '管理员甲');
  const record = ownerRecord(), snapshot = structuredClone(record);
  assert.equal(assertCertificationBinding(result, record), true); assert.deepEqual(record, snapshot);
  rejects(() => prepareWedaAdminAction(null), 422);
});

test('the draft has no production entrypoint integration or dependency on cloud, storage, network or process identity', () => {
  const directory = path.join(__dirname, '..', 'cloudfunctions', 'hlApi');
  const source = fs.readFileSync(path.join(directory, 'weda-admin-policy.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:wx-server-sdk|@cloudbase\/|node:(?:fs|https?|net|child_process))/);
  assert.doesNotMatch(source, /process\.env\s*(?:\[|\.)|console\.(?:log|warn|error)\s*\(/);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'index.js'), 'utf8'), /require\(['"]\.\/weda-admin-policy['"]\)/);
});
