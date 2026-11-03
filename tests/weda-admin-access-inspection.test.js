'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const helper = import('../scripts/inspect-weda-admin-access.mjs');
const ACTUAL_ROLES = [
  { identity: 'administrator', id: '-1' }, { identity: 'allUser', id: '-100' },
  { identity: 'anonymousUser', id: '2063939556191813634' }, { identity: 'hl_operator', id: '2064514415116599298' },
  { identity: 'internalUser', id: '2063939556003069953' }, { identity: 'registerUser', id: '2063939556393140225' },
];
const response = roles => ({ Data: { Total: String(roles.length), RoleList: roles.map(([RoleIdentity, Id]) => ({ RoleIdentity, Id })) } });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function refreshDigests(snapshot) {
  snapshot.globalRolePolicyDigests = snapshot.rolePolicies.map(role => ({ identity: role.identity, id: role.id,
    policyCount: role.policies.length, policiesSha256: createHash('sha256').update(JSON.stringify(stable(role.policies))).digest('hex') }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
  return snapshot;
}
function restrict(before, TARGET) {
  const after = structuredClone(before);
  after.pre = after.prod = { total: 2, roles: [{ identity: 'administrator', id: '-1' }, { identity: 'externalUser', id: '-3' }] };
  for (const role of before.pre.roles.filter(role => role.id !== '-1')) after.pages[role.id].pages.forEach(page => { page.allowed = false; });
  after.rolePolicies.find(role => role.identity === 'anonymousUser').policies.push({ ResourceName: 'HL运营管理后台',
    IsBindAllAccess: false, Resource: TARGET.ResourceId, ResourceType: 'app', Effect: 'allow' });
  // Keep the unresolved legacy -3 view true while independently requiring every
  // real non-admin role to have all six pages denied.
  after.pages['-3'].pages.forEach(page => { page.allowed = true; });
  after.accessModelVersion = 3;
  after.actualRoleCatalog = { pre: { roles: structuredClone(ACTUAL_ROLES), reportedTotal: '1' },
    prod: { roles: structuredClone(ACTUAL_ROLES), reportedTotal: '1' } };
  after.actualRolePages = Object.fromEntries(ACTUAL_ROLES.map(role => [role.id, { identity: role.identity,
    allPages: role.id === '-1', pages: role.id === '-1' ? [] : after.pages['-3'].pages.map(page => ({ ...page, allowed: false })) }]));
  after.legacyExternalRoleId = '-3'; after.legacyExternalInActualRoleList = false; after.legacyExternalDisplayUnresolved = true;
  return refreshDigests(after);
}
function fixture(TARGET, PAGE_KEYS) {
  const roles = [{ identity: 'administrator', id: '-1' }, { identity: 'anonymousUser', id: '2063939556191813634' }, { identity: 'externalUser', id: '-3' }];
  return refreshDigests({ target: TARGET, readConsistencyVerified: true, pre: { total: 3, roles }, prod: { total: 3, roles },
    rolePolicies: ACTUAL_ROLES.map(role => ({ ...role, policies: !['administrator', 'anonymousUser', 'registerUser'].includes(role.identity) ? [] : [
      { ResourceName: '所有应用', IsBindAllAccess: true, Resource: '*', ResourceType: 'app', Effect: 'allow' },
      { ResourceName: '所有APIs', IsBindAllAccess: true, Resource: '*', ResourceType: 'apis', Effect: 'allow' }] })), appIds: [TARGET.ResourceId],
    pages: Object.fromEntries(roles.map(role => [role.id, role.id === '-1' ? { allPages: true, pages: [] }
      : { allPages: false, pages: PAGE_KEYS.map(key => ({ key, id: `${TARGET.ResourceId}-${key}`, allowed: true, global: false })) }])) });
}
test('application-shell gate retains only the fixed built-in external role with administrator', async () => {
  const { resourceRoles, assertAdministratorAndFixedExternalResourceRoles } = await helper;
  assert.equal(assertAdministratorAndFixedExternalResourceRoles(response([['administrator', '-1'], ['externalUser', '-3']])), true);
  for (const roles of [[['administrator', '-1']], [['administrator', '-1'], ['externalUser', '-3'], ['anonymousUser', '2063939556191813634']],
    [['administrator', '-1'], ['externalUser', '3']], [['administrator', '1'], ['externalUser', '-3']], []]) {
    assert.throws(() => assertAdministratorAndFixedExternalResourceRoles(response(roles)));
  }
  assert.throws(() => resourceRoles({ Data: { Total: 2, RoleList: [{ RoleIdentity: 'administrator', Id: '-1' }] } }));
  assert.throws(() => resourceRoles(response([['anonymousUser', 2063939556191813634]])));
});
test('read Int64 wrapper survives SDK-style deep object reconstruction without precision loss', async () => {
  const { preciseReadRoleId } = await helper;
  const value = preciseReadRoleId('2063939556191813634');
  const cloned = Object.fromEntries(Object.entries(value));
  assert.equal(JSON.stringify({ RoleId: cloned }), '{"RoleId":2063939556191813634}');
  assert.throws(() => preciseReadRoleId(2063939556191813634));
});
test('review plan preserves the built-in external app role and scopes three requests plus rollback', async () => {
  const { TARGET, PAGE_KEYS, buildReviewPlan } = await helper;
  const before = fixture(TARGET, PAGE_KEYS), plan = buildReviewPlan(before);
  assert.equal(plan.executableByThisHelper, false);
  assert.equal(plan.previewUnbinds.length, 3);
  assert.equal(plan.rollbackPre.length, 3);
  for (const operation of [...plan.previewUnbinds, ...plan.rollbackPre]) {
    assert.equal(operation.Param.EnvType, 'pre');
    assert.notEqual(operation.Param.RoleId, '-1');
    assert.ok(operation.Param.ResourceIds.every(id => id === TARGET.ResourceId || PAGE_KEYS.some(key => id === `${TARGET.ResourceId}-${key}`)));
    assert.equal(operation.Param.ResourceIds.includes('*'), false);
  }
  assert.equal(plan.previewUnbinds.some(operation => operation.Param.RoleId === '-3' && operation.Param.ResourceIds.includes(TARGET.ResourceId)), false);
  assert.equal(plan.rollbackPre.some(operation => operation.Param.RoleId === '-3' && operation.Param.ResourceIds.includes(TARGET.ResourceId)), false);
  assert.equal(plan.previewUnbinds.find(operation => operation.Param.RoleId === '-3').Param.SubType, '2');
  assert.deepEqual(plan.release.Param, { ...TARGET, EnvType: 'pre' });
});
test('app-scoped guard accepts only the observed exact anonymous override and preserves original policy multisets', async () => {
  const { TARGET, PAGE_KEYS, assertAppScopedPolicyChanges } = await helper;
  const before = fixture(TARGET, PAGE_KEYS), after = restrict(before, TARGET);
  assert.deepEqual(assertAppScopedPolicyChanges(before, after), {
    nonTargetPoliciesPreserved: true, originalPoliciesPreserved: true, targetAppOverrideVerified: true });
  const reordered = structuredClone(after);
  reordered.rolePolicies.forEach(role => role.policies.reverse()); refreshDigests(reordered);
  assert.equal(assertAppScopedPolicyChanges(before, reordered).nonTargetPoliciesPreserved, true);
  const mutations = [
    current => current.rolePolicies.find(role => role.identity === 'anonymousUser').policies.shift(),
    current => { current.rolePolicies.find(role => role.identity === 'anonymousUser').policies[0].IsBindAllAccess = false; },
    current => { current.rolePolicies.find(role => role.identity === 'anonymousUser').policies.at(-1).Effect = 'deny'; },
    current => { current.rolePolicies.find(role => role.identity === 'anonymousUser').policies.at(-1).Resource = 'other-app'; },
    current => { current.rolePolicies.find(role => role.identity === 'anonymousUser').policies.at(-1).Unexpected = true; },
    current => { const policies = current.rolePolicies.find(role => role.identity === 'anonymousUser').policies; policies.push(structuredClone(policies.at(-1))); },
    current => current.rolePolicies.find(role => role.identity === 'internalUser').policies.push({ Resource: `${TARGET.ResourceId}-overview`, ResourceType: 'app', Effect: 'deny' }),
    current => current.rolePolicies.push({ identity: 'newRole', id: '12', policies: [] }),
    current => { current.rolePolicies.find(role => role.identity === 'administrator').policies[0].Effect = 'deny'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(after); mutate(changed); refreshDigests(changed);
    assert.throws(() => assertAppScopedPolicyChanges(before, changed));
  }
  const rawMissing = structuredClone(after); delete rawMissing.rolePolicies;
  assert.throws(() => assertAppScopedPolicyChanges(before, rawMissing), /RAW_ROLE_POLICIES_MISSING/);
  const digestMismatch = structuredClone(after); digestMismatch.globalRolePolicyDigests[0].policiesSha256 = 'wrong';
  assert.throws(() => assertAppScopedPolicyChanges(before, digestMismatch), /RAW_ROLE_POLICIES_DIGEST_MISMATCH/);
  assert.throws(() => assertAppScopedPolicyChanges(before, before), /TARGET_APP_POLICY_CHANGE_UNEXPECTED/);
});
test('pre/prod gates accept aggregate app-role removal but require exact page/admin and scoped policy protection', async () => {
  const { TARGET, PAGE_KEYS, assertProtectedAccess } = await helper;
  const before = fixture(TARGET, PAGE_KEYS), after = restrict(before, TARGET);
  assert.equal(assertProtectedAccess(before, after, 'pre'), true);
  assert.equal(assertProtectedAccess(before, after, 'prod'), true);
  const globalDrift = structuredClone(after); globalDrift.globalRolePolicyDigests[0].policiesSha256 = 'changed';
  assert.throws(() => assertProtectedAccess(before, globalDrift, 'pre'));
  const prodDrift = structuredClone(after); prodDrift.prod = before.prod;
  assert.throws(() => assertProtectedAccess(before, prodDrift, 'pre'));
  const pageDrift = structuredClone(after); pageDrift.actualRolePages['2063939556393140225'].pages[0].allowed = true;
  assert.throws(() => assertProtectedAccess(before, pageDrift, 'pre'));
  const missingPage = structuredClone(after); missingPage.actualRolePages['-100'].pages.pop();
  assert.throws(() => assertProtectedAccess(before, missingPage, 'pre'));
  const administratorOnly = structuredClone(after); administratorOnly.pre = { total: 1, roles: [{ identity: 'administrator', id: '-1' }] };
  assert.throws(() => assertProtectedAccess(before, administratorOnly, 'pre'));
  const appDrift = structuredClone(after); appDrift.appIds.push('other-app');
  assert.throws(() => assertProtectedAccess(before, appDrift, 'prod'));
  assert.throws(() => assertProtectedAccess(before, after, 'unknown'));
});
test('V3 uses the complete actual role set and preserves the unresolved failed legacy view honestly', async () => {
  const { TARGET, PAGE_KEYS, actualRoleCatalog, assertActualRolePages, assertPreviewAccessSnapshot, assertLegacyPreviewAccessSnapshot } = await helper;
  const after = restrict(fixture(TARGET, PAGE_KEYS), TARGET);
  assert.equal(actualRoleCatalog({ Data: { Total: '1', RoleList: ACTUAL_ROLES.map(role => ({ RoleIdentity: role.identity, Id: role.id })) } }).roles.length, 6);
  assert.equal(assertPreviewAccessSnapshot(after), true);
  assert.equal(assertActualRolePages(after).actualNonAdministratorSixPagesDenied, true);
  assert.throws(() => assertLegacyPreviewAccessSnapshot(after), /RESTRICTED_ROLE_STILL_HAS_PAGE_ACCESS/);
  const mutations = [
    value => { delete value.accessModelVersion; },
    value => { delete value.actualRoleCatalog; },
    value => { value.actualRoleCatalog.pre.roles.pop(); },
    value => { value.actualRoleCatalog.prod.roles.push({ identity: 'externalUser', id: '-3' }); },
    value => { value.actualRoleCatalog.pre.roles[5].id = 'different'; },
    value => { delete value.actualRolePages['2063939556393140225']; },
    value => { value.actualRolePages['-3'] = value.pages['-3']; },
    value => { value.actualRolePages['2063939556003069953'].allPages = true; },
    value => { value.actualRolePages['2063939556393140225'].identity = 'externalUser'; },
    value => { value.actualRolePages['-1'].allPages = false; },
    value => { value.actualRolePages['-100'].pages[0].global = true; },
    value => { delete value.pages['-3']; },
    value => { value.legacyExternalInActualRoleList = true; },
    value => { value.legacyExternalDisplayUnresolved = false; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(after); mutate(changed); assert.throws(() => assertActualRolePages(changed)); }
  const duplicate = [...ACTUAL_ROLES.slice(0, 5), ACTUAL_ROLES[0]];
  assert.throws(() => actualRoleCatalog({ Data: { Total: '1', RoleList: duplicate.map(role => ({ RoleIdentity: role.identity, Id: role.id })) } }));
});
test('snapshot reads the complete actual role catalog and pages without changing legacy values or issuing writes', async () => {
  const { TARGET, PAGE_KEYS, snapshot, assertProtectedAccess } = await helper;
  const before = fixture(TARGET, PAGE_KEYS), expected = restrict(before, TARGET), calls = [];
  const manager = { commonService() { return { async call({ Action, Param }) {
    calls.push(Action);
    if (Action === 'DescribeResourceRoleList') return response(expected.pre.roles.map(role => [role.identity, role.id]));
    if (Action === 'DescribeWedaRoles') return { Data: { Total: '1', RoleList: ACTUAL_ROLES.map(role => ({ Id: role.id, RoleIdentity: role.identity })) } };
    if (Action === 'DescribeApps') return { Count: 1, Weapps: [{ Id: TARGET.ResourceId }] };
    if (Action === 'DescribeAppPagePermission') {
      const id = JSON.stringify(Param.RoleId), value = id === '-3' ? expected.pages[id] : expected.actualRolePages[id];
      assert.ok(value, 'query must use the exact known role ID');
      return { Data: { IsBindAllResource: value.allPages, AppPagePermissionList: value.pages.map(page => ({ PageId: page.id,
        PageKey: page.key, AccessAble: page.allowed, IsGlobalConfig: page.global })) } };
    }
    throw new Error('UNEXPECTED_OR_WRITE_ACTION');
  } }; } };
  const client = { async call(name, params) {
    assert.equal(name, 'queryPermissions'); assert.equal(params.action, 'listRoles');
    return { data: { total: ACTUAL_ROLES.length, systemRoles: expected.rolePolicies.map(role => ({ RoleIdentity: role.identity,
      RoleId: role.id, Policies: role.policies })), customRoles: [] } };
  } };
  const result = await snapshot(manager, client);
  assert.equal(assertProtectedAccess(before, result, 'prod'), true);
  assert.equal(result.pages['-3'].pages.every(page => page.allowed), true);
  assert.equal(result.actualRoleCatalog.pre.reportedTotal, '1');
  assert.equal(Object.keys(result.actualRolePages).length, 6);
  assert.equal(calls.filter(action => action === 'DescribeWedaRoles').length, 4);
  assert.equal(calls.filter(action => action === 'DescribeAppPagePermission').length, 7);
  assert.equal(calls.every(action => action.startsWith('Describe')), true);
});
