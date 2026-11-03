const test = require('node:test');
const assert = require('node:assert/strict');
test('native WeDa preview gates exact design, fixed built-in app roles, release proof and platform URL', async () => {
  const api = await import('../scripts/deploy-weda-admin-preview.mjs');
  assert.equal(api.semanticSha256({ a: 1, b: { x: 2 } }), api.semanticSha256({ b: { x: 2 }, a: 1 }));
  const admin = { RoleIdentity: 'administrator', Id: '-1' };
  const external = { RoleIdentity: 'externalUser', Id: '-3' };
  assert.doesNotThrow(() => api.assertApplicationRoles({ Data: { Total: '2', RoleList: [admin, external] } }));
  for (const data of [{ Total: '1', RoleList: [admin] },
    { Total: '3', RoleList: [admin, external, { RoleIdentity: 'anonymousUser', Id: '2063939556191813634' }] },
    { Total: '2', RoleList: [admin, { RoleIdentity: 'custom', Id: '-3' }] }]) {
    assert.throws(() => api.assertApplicationRoles({ Data: data }));
  }
  const proof = { target: { EnvId: api.TARGET.envId, ResourceType: 'app', ResourceId: api.TARGET.appId },
    TaskId: 'permission-task-id', TaskStatus: 'SUCCESS' };
  assert.equal(api.assertPermissionReleaseProof(proof), proof.TaskId);
  assert.throws(() => api.assertPermissionReleaseProof({ ...proof, TaskStatus: 'RUNNING' }), /PERMISSION_RELEASE_SUCCESS_REQUIRED/);
  assert.throws(() => api.assertPermissionReleaseProof({ ...proof, target: { ...proof.target, ResourceId: '*' } }), /PERMISSION_RELEASE_TARGET_MISMATCH/);
  assert.deepEqual(api.previewParameters(), { EnvId: api.TARGET.envId, Id: api.TARGET.appId, Mode: 'preview', BuildType: 'web' });
  const response = { Data: { WeAppId: api.TARGET.appId, Items: ['pre', 'prod'].map(EnvType => ({ EnvType, Active: true,
    Url: `https://example.tcloudbaseapp.com/${api.TARGET.appId}/${EnvType === 'pre' ? 'preview' : 'production'}/` })) } };
  assert.match(api.officialUrls(response).pre, /\/preview\/$/);
  response.Data.Items[0].Url += '?token=refuse';
  assert.throws(() => api.officialUrls(response), /PLATFORM_URL_UNEXPECTED/);
});
test('preview evidence distinguishes actual role denial from unresolved legacy external display', async () => {
  const api = await import('../scripts/deploy-weda-admin-preview.mjs');
  const { PAGE_KEYS } = await import('../scripts/inspect-weda-admin-access.mjs');
  const pages = allowed => PAGE_KEYS.map(key => ({ key, id: `${api.TARGET.appId}-${key}`, allowed }));
  const current = { pre: { roles: [{ identity: 'administrator' }, { identity: 'externalUser' }] },
    actualRolePages: { '-1': { identity: 'administrator', allPages: true, pages: [] },
      '2064514415116599298': { identity: 'hl_operator', allPages: false, pages: pages(false) } },
    pages: { '-3': { allPages: false, pages: pages(true) } } };
  const result = api.summarizeActualAccess(current);
  assert.equal(result.actualNonAdministratorSixPagesDenied, true);
  assert.deepEqual(result.actualNonAdministratorRoleIdentities, ['hl_operator']);
  assert.equal(result.legacyExternalRole.inActualRoleList, false);
  assert.equal(result.legacyExternalRole.allowedPageKeys.length, 6);
  assert.equal(result.legacyExternalRole.displayUnresolved, true);
  assert.equal(result.legacyExternalRole.runtimeAccessVerified, false);
  current.actualRolePages['2064514415116599298'].pages[0].allowed = true;
  assert.equal(api.summarizeActualAccess(current).actualNonAdministratorSixPagesDenied, false);
});
