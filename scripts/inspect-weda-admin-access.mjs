import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
export const TARGET = Object.freeze({ EnvId: 'cloud1-d2gza7q9c8d69c721', ResourceType: 'app', ResourceId: 'app-pq2auygx' });
export const PAGE_KEYS = Object.freeze(['overview', 'matchmakers', 'certifications', 'salons', 'plans', 'orders']);
export const OUTPUT = join(ROOT, 'output/admin-release-20261015');
const BEFORE = join(OUTPUT, 'app-access-before.json');
const PLAN = join(OUTPUT, 'app-access-plan-v2.json');
const POLICY_BACKUP = join(OUTPUT, 'app-access-global-policy-backup.json');
const ANONYMOUS_ROLE_ID = '2063939556191813634';
export const ACTUAL_ROLES = Object.freeze([
  { identity: 'administrator', id: '-1' }, { identity: 'allUser', id: '-100' },
  { identity: 'anonymousUser', id: ANONYMOUS_ROLE_ID }, { identity: 'hl_operator', id: '2064514415116599298' },
  { identity: 'internalUser', id: '2063939556003069953' }, { identity: 'registerUser', id: '2063939556393140225' },
].map(Object.freeze));
const ANONYMOUS_APP_OVERRIDE = Object.freeze({ ResourceName: 'HL运营管理后台', IsBindAllAccess: false,
  Resource: TARGET.ResourceId, ResourceType: 'app', Effect: 'allow' });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function check(ok, safeCode) { if (!ok) throw Object.assign(new Error(safeCode), { safeCode }); }
function roleId(value) {
  check(typeof value === 'string' || Number.isSafeInteger(value), 'ROLE_ID_PRECISION_UNCONFIRMED');
  const text = String(value);
  check(/^-?[1-9]\d{0,24}$/.test(text), 'ROLE_ID_INVALID');
  return text;
}
// CommonService deepRemoveVoid recreates a rawJSON object. An own toJSON
// method survives that normalization and emits an exact Int64 JSON number.
// This representation is proven only for the read API used below.
export function preciseReadRoleId(value) {
  const text = roleId(value);
  check(typeof JSON.rawJSON === 'function', 'LOSSLESS_INTEGER_SERIALIZER_UNAVAILABLE');
  return { toJSON() { return JSON.rawJSON(text); } };
}
export function resourceRoles(response) {
  const payload = response?.Response ?? response;
  check(payload && !payload.Error && Array.isArray(payload.Data?.RoleList), 'RESOURCE_ROLE_RESPONSE_INVALID');
  const rows = payload.Data.RoleList.map(row => {
    check(typeof row.RoleIdentity === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.RoleIdentity), 'ROLE_IDENTITY_INVALID');
    return { identity: row.RoleIdentity, id: roleId(row.Id) };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  const total = Number(payload.Data.Total);
  check(Number.isSafeInteger(total) && total === rows.length && new Set(rows.map(row => row.id)).size === rows.length,
    'RESOURCE_ROLE_LIST_INCOMPLETE');
  return { total, roles: rows, requestId: payload.RequestId ?? null };
}
export function assertOnlyAdministratorResourceRoles(response) {
  const parsed = response?.roles ? response : resourceRoles(response);
  check(parsed.total === 1 && parsed.roles.length === 1 && parsed.roles[0].identity === 'administrator'
    && parsed.roles[0].id === '-1', 'APP_ACCESS_NOT_ADMINISTRATOR_ONLY');
  return true;
}
export function assertAdministratorAndFixedExternalResourceRoles(response) {
  const parsed = response?.roles ? response : resourceRoles(response);
  check(parsed.total === 2 && parsed.roles.length === 2
    && parsed.roles.some(role => role.identity === 'administrator' && role.id === '-1')
    && parsed.roles.some(role => role.identity === 'externalUser' && role.id === '-3'), 'APP_SHELL_ROLES_UNEXPECTED');
  return true;
}
// Preserve the failed legacy gate as evidence; V3 does not claim -3 became denied.
export function assertLegacyPreviewAccessSnapshot(snapshot) {
  check(digest(snapshot.target) === digest(TARGET) && snapshot.readConsistencyVerified === true,
    'SNAPSHOT_TARGET_OR_CONSISTENCY_INVALID');
  assertAdministratorAndFixedExternalResourceRoles(snapshot.pre);
  check(snapshot.pages['-1']?.allPages === true, 'ADMINISTRATOR_PAGE_ACCESS_LOST');
  for (const id of ['-3', ANONYMOUS_ROLE_ID]) {
    const current = snapshot.pages[id];
    check(current && !current.allPages && current.pages.length === PAGE_KEYS.length
      && new Set(current.pages.map(page => page.key)).size === PAGE_KEYS.length
      && PAGE_KEYS.every(key => current.pages.some(page => page.key === key
        && page.id === `${TARGET.ResourceId}-${key}` && page.allowed === false)), 'RESTRICTED_ROLE_STILL_HAS_PAGE_ACCESS');
  }
  return true;
}
function exactPageSet(value, allowed) {
  return value && value.allPages === false && Array.isArray(value.pages) && value.pages.length === PAGE_KEYS.length
    && new Set(value.pages.map(page => page.key)).size === PAGE_KEYS.length
    && PAGE_KEYS.every(key => value.pages.some(page => page.key === key && page.id === `${TARGET.ResourceId}-${key}`
      && typeof page.allowed === 'boolean' && (allowed === undefined || page.allowed === allowed) && page.global === false));
}
function sameRoleCatalog(roles) {
  return Array.isArray(roles) && digest(roles.map(({ identity, id }) => ({ identity, id })).sort((a, b) => a.identity.localeCompare(b.identity)))
    === digest(ACTUAL_ROLES);
}
export function actualRoleCatalog(response) {
  const payload = response?.Response ?? response;
  check(payload && !payload.Error && Array.isArray(payload.Data?.RoleList), 'ACTUAL_ROLE_CATALOG_RESPONSE_INVALID');
  const roles = payload.Data.RoleList.map(row => ({ identity: row.RoleIdentity, id: roleId(row.Id) }))
    .sort((a, b) => String(a.identity).localeCompare(String(b.identity)));
  // DescribeWedaRoles reported Total='1' alongside five system roles and one
  // custom role. Validate the complete fixed set, not that pagination field.
  check(sameRoleCatalog(roles), 'ACTUAL_ROLE_SET_CHANGED');
  return { roles, reportedTotal: String(payload.Data.Total), requestId: payload.RequestId ?? null };
}
export function assertActualRolePages(value) {
  check(value.accessModelVersion === 3 && digest(value.target) === digest(TARGET) && value.readConsistencyVerified === true,
    'ACTUAL_ROLE_SNAPSHOT_INVALID');
  check(sameRoleCatalog(value.actualRoleCatalog?.pre?.roles) && sameRoleCatalog(value.actualRoleCatalog?.prod?.roles)
    && sameRoleCatalog(value.rolePolicies), 'ACTUAL_ROLE_SET_CHANGED');
  const pages = value.actualRolePages;
  check(pages && digest(Object.keys(pages).sort()) === digest(ACTUAL_ROLES.map(role => role.id).sort()), 'ACTUAL_ROLE_PAGE_SET_CHANGED');
  for (const role of ACTUAL_ROLES) {
    const current = pages[role.id];
    check(current?.identity === role.identity, 'ACTUAL_ROLE_PAGE_IDENTITY_MISMATCH');
    if (role.id === '-1') check(current.allPages === true && Array.isArray(current.pages) && current.pages.length === 0,
      'ADMINISTRATOR_PAGE_ACCESS_LOST');
    else check(exactPageSet(current, false), 'ACTUAL_NON_ADMINISTRATOR_PAGE_ACCESS_PRESENT');
  }
  check(value.legacyExternalRoleId === '-3' && value.legacyExternalInActualRoleList === false
    && value.legacyExternalDisplayUnresolved === true && exactPageSet(value.pages?.['-3']), 'LEGACY_EXTERNAL_EVIDENCE_MISSING');
  check(value.pages?.['-1']?.allPages === true && exactPageSet(value.pages?.[ANONYMOUS_ROLE_ID], false), 'LEGACY_ACTUAL_PAGE_READS_DISAGREE');
  return { actualRoleCount: ACTUAL_ROLES.length,
    actualNonAdministratorRoleIdentities: ACTUAL_ROLES.filter(role => role.id !== '-1').map(role => role.identity),
    actualNonAdministratorSixPagesDenied: true, legacyExternalDisplayUnresolved: true };
}
export function assertPreviewAccessSnapshot(value) {
  assertAdministratorAndFixedExternalResourceRoles(value.pre);
  assertActualRolePages(value);
  return true;
}
function sameRoles(left, right) { return digest(left.roles) === digest(right.roles) && left.total === right.total; }
function policyRoles(rows) {
  check(Array.isArray(rows), 'RAW_ROLE_POLICIES_MISSING');
  const roles = rows.map(row => {
    check(typeof row.identity === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.identity)
      && Array.isArray(row.policies) && row.policies.every(policy => policy && typeof policy === 'object' && !Array.isArray(policy)),
    'RAW_ROLE_POLICIES_INVALID');
    return { identity: row.identity, id: roleId(row.id), policies: row.policies };
  }).sort((a, b) => a.identity.localeCompare(b.identity));
  check(new Set(roles.map(role => role.identity)).size === roles.length
    && new Set(roles.map(role => role.id)).size === roles.length, 'RAW_ROLE_POLICIES_DUPLICATED');
  return roles;
}
function rolePolicyDigests(roles) {
  return roles.map(role => ({ identity: role.identity, id: role.id, policyCount: role.policies.length,
    policiesSha256: digest(role.policies) }));
}
function policiesForSnapshot(value, allowSavedBackup) {
  let raw = value.rolePolicies;
  if (!raw && allowSavedBackup) {
    check(existsSync(POLICY_BACKUP), 'ORIGINAL_POLICY_BACKUP_MISSING');
    const saved = JSON.parse(readFileSync(POLICY_BACKUP, 'utf8'));
    check(digest(saved.target) === digest(TARGET), 'ORIGINAL_POLICY_BACKUP_TARGET_INVALID');
    raw = saved.roles;
  }
  const roles = policyRoles(raw);
  // Bind an older snapshot to its immutable policy backup; never trust a backup
  // merely because its filename or target matches. No member data is read.
  check(digest(rolePolicyDigests(roles)) === digest(value.globalRolePolicyDigests), 'RAW_ROLE_POLICIES_DIGEST_MISMATCH');
  return roles;
}
function policyMultiset(policies) { return policies.map(policy => JSON.stringify(stable(policy))).sort(); }
export function assertAppScopedPolicyChanges(before, after) {
  check(digest(before.target) === digest(TARGET) && digest(after.target) === digest(TARGET)
    && before.readConsistencyVerified === true && after.readConsistencyVerified === true, 'SNAPSHOT_TARGET_OR_CONSISTENCY_INVALID');
  const original = policiesForSnapshot(before, true), current = policiesForSnapshot(after, false);
  check(digest(original.map(({ identity, id }) => ({ identity, id })))
    === digest(current.map(({ identity, id }) => ({ identity, id }))), 'GLOBAL_ROLE_SET_CHANGED');
  let overrides = 0;
  for (let index = 0; index < original.length; index++) {
    const prior = original[index], next = current[index];
    if (prior.identity === 'anonymousUser' && prior.id === ANONYMOUS_ROLE_ID) {
      const expected = JSON.stringify(stable(ANONYMOUS_APP_OVERRIDE));
      check(!prior.policies.some(policy => JSON.stringify(stable(policy)) === expected), 'ORIGINAL_TARGET_OVERRIDE_UNEXPECTED');
      const remaining = next.policies.filter(policy => JSON.stringify(stable(policy)) !== expected);
      overrides = next.policies.length - remaining.length;
      check(overrides === 1 && digest(policyMultiset(prior.policies)) === digest(policyMultiset(remaining)),
        'TARGET_APP_POLICY_CHANGE_UNEXPECTED');
    } else check(digest(policyMultiset(prior.policies)) === digest(policyMultiset(next.policies)), 'NON_TARGET_ROLE_POLICY_CHANGED');
  }
  check(overrides === 1, 'TARGET_APP_OVERRIDE_MISSING');
  return { nonTargetPoliciesPreserved: true, originalPoliciesPreserved: true, targetAppOverrideVerified: true };
}
function pagePermissions(response) {
  const payload = response?.Response ?? response, data = payload?.Data;
  check(payload && !payload.Error && data && typeof data.IsBindAllResource === 'boolean', 'PAGE_PERMISSION_RESPONSE_INVALID');
  const pages = (data.AppPagePermissionList ?? []).map(row => {
    check(PAGE_KEYS.includes(row.PageKey) && row.PageId === `${TARGET.ResourceId}-${row.PageKey}`
      && typeof row.AccessAble === 'boolean' && typeof row.IsGlobalConfig === 'boolean', 'UNEXPECTED_PAGE_PERMISSION');
    return { id: row.PageId, key: row.PageKey, allowed: row.AccessAble, global: row.IsGlobalConfig };
  }).sort((a, b) => a.key.localeCompare(b.key));
  check(!data.AppSubPagePermissionList?.length && new Set(pages.map(row => row.id)).size === pages.length,
    'UNEXPECTED_SUBPAGE_PERMISSION');
  return { allPages: data.IsBindAllResource, pages, requestId: payload.RequestId ?? null };
}
export function buildReviewPlan(before) {
  check(before.target && digest(before.target) === digest(TARGET) && before.readConsistencyVerified === true,
    'SNAPSHOT_TARGET_OR_CONSISTENCY_INVALID');
  check(sameRoles(before.pre, before.prod), 'PRE_PROD_DIFFER_REVIEW_REQUIRED');
  check(before.pre.roles.some(role => role.identity === 'administrator' && role.id === '-1'), 'ADMINISTRATOR_ACCESS_MISSING');
  const revoked = before.pre.roles.filter(role => role.identity !== 'administrator');
  check(revoked.length === 2 && revoked.some(role => role.identity === 'externalUser' && role.id === '-3')
    && revoked.some(role => role.identity === 'anonymousUser' && role.id === ANONYMOUS_ROLE_ID), 'ROLE_SCOPE_REQUIRES_REVIEW');
  const pageIds = PAGE_KEYS.map(key => `${TARGET.ResourceId}-${key}`);
  const previewUnbinds = [], rollbackPre = [];
  for (const role of revoked) {
    const original = before.pages[role.id];
    check(original && !original.allPages && original.pages.length === PAGE_KEYS.length
      && original.pages.every(page => page.allowed && !page.global), 'REVOCATION_SOURCE_REQUIRES_REVIEW');
    const base = { EnvId: TARGET.EnvId, EnvType: 'pre', ResourceType: 'app', RoleId: role.id };
    // The official UI forbids deleting the externalUser application binding.
    // Keep that built-in shell role and remove only its six page permissions.
    if (role.identity === 'anonymousUser') {
      previewUnbinds.push({ Action: 'UnbindWedaResource', Param: { ...base, ResourceIds: [TARGET.ResourceId] } });
      rollbackPre.push({ Action: 'BindWedaResource', Param: { ...base, ResourceIds: [TARGET.ResourceId] } });
    }
    previewUnbinds.push({ Action: 'UnbindWedaResource', Param: { ...base, ResourceIds: pageIds, SubType: '2', IsBindAllResource: false, ParentResourceId: TARGET.ResourceId } });
    rollbackPre.push({ Action: 'BindWedaResource', Param: { ...base, ResourceIds: original.pages.filter(page => page.allowed).map(page => page.id),
      SubType: '2', IsBindAllResource: original.allPages, ParentResourceId: TARGET.ResourceId } });
  }
  return { target: TARGET, planVersion: 2, planOnly: true, executableByThisHelper: false, cloudWritesPerformed: 0,
    officialEditorContract: 'DISABLE_DELETE_ROLE_IDENTITY includes administrator and externalUser. Do not unbind their application roles. ExternalUser page edits are allowed; anonymous app/page unbinding is allowed. EnvType defaults to pre.',
    writeRoleIdContract: 'Exact strings as passed by the official V1 editor. V3 write parameter type has NOT been exercised; never Number() a long role ID. Use the official console if V3 type cannot be confirmed.',
    inheritanceStatus: 'Observed anonymous app unbinding adds the exact target app IsBindAllAccess:false/Effect:allow override while preserving original wildcard/API policies. Both app-role lists reflect this aggregate policy. Require exact raw policy comparison; this is not proof of production page publication.',
    restrictedRoles: revoked, retainedBuiltInApplicationRole: { identity: 'externalUser', id: '-3' }, previewUnbinds, rollbackPre,
    preGate: 'Exactly administrator(-1) and fixed externalUser(-3) in both app-role lists; external and anonymous each denied on all six editor/default-pre pages; administrator allPages true; all original policies/app list preserved with only the observed anonymous target-app override allowed.',
    release: { Action: 'ReleaseResourcePermissions', Param: { ...TARGET, EnvType: 'pre' } },
    releasePolling: { Action: 'DescribePermissionsReleaseStatus', Param: { EnvId: TARGET.EnvId, EnvType: 'pre', TaskId: 'RETURNED_TASK_ID' },
      successStatus: 'SUCCESS', failureStatus: 'FAILED' },
    postGate: 'Exactly administrator(-1) and fixed externalUser(-3) in both pre/prod; six-page denial gate remains true; resource permission release TaskStatus SUCCESS proof required; all original policies/app list preserved with only the observed anonymous target-app override allowed; inspect real anonymous, external and administrator sessions.',
    rollbackNote: 'Restore only these app/page bindings in pre and verify original role/page access. If prod was released, release the restored pre bindings for this app and verify prod. This is a reviewed inverse plan, not proof of exact wildcard storage rollback.',
    forbidden: ['Global app/* policy replacement or removal', 'Role/member creation or deletion', 'Other apps or resources', 'Business calls or certification material reads'] };
}
export function assertProtectedAccess(before, after, stage) {
  assertAppScopedPolicyChanges(before, after);
  check(digest(before.appIds) === digest(after.appIds), 'APPLICATION_SET_CHANGED');
  assertPreviewAccessSnapshot(after);
  check(stage === 'pre' || stage === 'prod', 'VERIFY_STAGE_INVALID');
  // App-specific role policy aggregation was observed in both lists after the
  // pre edit. This does not prove production page publication; release SUCCESS
  // and actual session acceptance remain separate required evidence.
  assertAdministratorAndFixedExternalResourceRoles(after.prod);
  return true;
}

export async function snapshot(manager, client) {
  const call = async (Action, Param) => {
    const response = await manager.commonService('lowcode').call({ Action, Param });
    const payload = response?.Response ?? response;
    check(payload && !payload.Error, 'READ_ONLY_PERMISSION_QUERY_FAILED');
    return payload;
  };
  const readRoles = type => call('DescribeResourceRoleList', { ...TARGET, EnvType: type, PageNo: 1, PageSize: 100 }).then(resourceRoles);
  const readActualRoles = type => call('DescribeWedaRoles', { EnvId: TARGET.EnvId, EnvType: type, PageNo: 1, PageSize: 10000 }).then(actualRoleCatalog);
  const globalPolicies = async () => {
    const response = await client.call('queryPermissions', { action: 'listRoles', pageNo: 1, pageSize: 100 });
    const data = response.data, roles = [...(data?.systemRoles ?? []), ...(data?.customRoles ?? [])];
    check(Number(data?.total) === roles.length, 'GLOBAL_ROLE_LIST_INCOMPLETE');
    const rolePolicies = policyRoles(roles.map(role => ({ identity: role.RoleIdentity, id: role.RoleId, policies: role.Policies ?? [] })));
    return { rolePolicies, digests: rolePolicyDigests(rolePolicies) };
  };
  const [pre, prod, globals, apps, actualPre, actualProd] = await Promise.all([readRoles('pre'), readRoles('prod'), globalPolicies(),
    call('DescribeApps', { EnvId: TARGET.EnvId, Limit: 100, Offset: 0 }), readActualRoles('pre'), readActualRoles('prod')]);
  check(sameRoleCatalog(globals.rolePolicies), 'ACTUAL_ROLE_SET_CHANGED');
  const listed = apps.Weapps ?? apps.WeApps ?? apps.Data?.Weapps ?? apps.Data?.WeApps;
  check(Array.isArray(listed), 'APPLICATION_LIST_UNCONFIRMED');
  const appIds = listed.map(app => app.Id ?? app.id).sort();
  check(Number(apps.Count ?? apps.Data?.Count ?? listed.length) === listed.length && appIds.includes(TARGET.ResourceId), 'APPLICATION_LIST_INCOMPLETE');
  const requested = new Map([...pre.roles, ...prod.roles].map(role => [role.id, role]));
  // Continue reading revoked roles after an edit so verify can prove page access disappeared.
  if (existsSync(BEFORE)) {
    const saved = JSON.parse(readFileSync(BEFORE, 'utf8'));
    check(digest(saved.target) === digest(TARGET), 'SAVED_SNAPSHOT_TARGET_INVALID');
    for (const role of saved.pre.roles) requested.set(role.id, role);
  }
  for (const role of [{ identity: 'administrator', id: '-1' }, { identity: 'externalUser', id: '-3' },
    { identity: 'anonymousUser', id: ANONYMOUS_ROLE_ID }]) requested.set(role.id, role);
  const allRequested = new Map([...requested, ...ACTUAL_ROLES.map(role => [role.id, role])]);
  const pageResults = await Promise.all([...allRequested].map(async ([id]) => [id, pagePermissions(await call('DescribeAppPagePermission',
    { EnvId: TARGET.EnvId, WeAppId: TARGET.ResourceId, RoleId: preciseReadRoleId(id), AppType: 'app' }))]));
  const [preAfter, prodAfter, globalsAfter, actualPreAfter, actualProdAfter] = await Promise.all([
    readRoles('pre'), readRoles('prod'), globalPolicies(), readActualRoles('pre'), readActualRoles('prod')]);
  check(sameRoles(pre, preAfter) && sameRoles(prod, prodAfter) && digest(globals) === digest(globalsAfter)
    && digest(actualPre.roles) === digest(actualPreAfter.roles) && digest(actualProd.roles) === digest(actualProdAfter.roles), 'PERMISSIONS_CHANGED_DURING_SNAPSHOT');
  const allPages = Object.fromEntries(pageResults);
  return { capturedAt: new Date().toISOString(), target: TARGET, readOnly: true, readConsistencyVerified: true,
    pre, prod, pages: Object.fromEntries([...requested.keys()].map(id => [id, allPages[id]])),
    pagePermissionEnvironment: 'Editor/default pre; production page publication requires independent release SUCCESS and session acceptance.',
    accessModelVersion: 3, actualRoleCatalog: { pre: actualPre, prod: actualProd },
    actualRolePages: Object.fromEntries(ACTUAL_ROLES.map(role => [role.id, { identity: role.identity, ...allPages[role.id] }])),
    legacyExternalRoleId: '-3', legacyExternalInActualRoleList: false, legacyExternalDisplayUnresolved: true,
    globalRolePolicyDigests: globals.digests, rolePolicies: globals.rolePolicies,
    appIds, userIdentifiersOrSecretsSaved: false, cloudWrites: 0, businessCalls: 0 };
}
export async function inspect(mode = 'snapshot') {
  check(['snapshot', 'plan-v2', 'verify-pre', 'verify-prod'].includes(mode), 'READ_ONLY_MODE_REQUIRED');
  if (mode === 'plan-v2') {
    check(existsSync(BEFORE) && !existsSync(PLAN), 'SNAPSHOT_MISSING_OR_PLAN_ALREADY_EXISTS');
    const plan = buildReviewPlan(JSON.parse(readFileSync(BEFORE, 'utf8')));
    writeFileSync(PLAN, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    return { mode, plan: PLAN, requestCount: plan.previewUnbinds.length, cloudWrites: 0, cloudReads: 0 };
  }
  if (mode === 'snapshot') check(!existsSync(BEFORE) && !existsSync(PLAN), 'SNAPSHOT_ALREADY_EXISTS');
  else check(existsSync(BEFORE), 'SNAPSHOT_MISSING');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.EnvId, region: 'ap-shanghai', site: 'domestic' }, authStrategy: 'fail_fast' });
  const client = new PaymentMcpClient(SDK.replace(/index\.cjs$/, 'cli.cjs'), { envId: TARGET.EnvId, region: 'ap-shanghai', cwd: ROOT });
  try {
    await client.ready;
    const result = await snapshot(manager, client);
    if (mode === 'snapshot') {
      const plan = buildReviewPlan(result);
      mkdirSync(OUTPUT, { recursive: true });
      writeFileSync(BEFORE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      writeFileSync(PLAN, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
      return { mode, snapshot: BEFORE, plan: PLAN, beforeRoles: result.pre.roles.map(role => role.identity), cloudWrites: 0 };
    }
    const before = JSON.parse(readFileSync(BEFORE, 'utf8'));
    assertProtectedAccess(before, result, mode === 'verify-pre' ? 'pre' : 'prod');
    const path = join(OUTPUT, `app-access-${mode}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return { mode, passed: true, evidence: path, cloudWrites: 0 };
  } finally { client.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length <= 3, 'READ_ONLY_MODE_REQUIRED');
    console.log(JSON.stringify(await inspect(process.argv[2] ?? 'snapshot')));
  } catch (error) {
    console.error(JSON.stringify({ passed: false, diagnostic: error.safeCode || 'READ_ONLY_PERMISSION_QUERY_FAILED', cloudWrites: 0, rawErrorWithheld: true }));
    process.exitCode = 1;
  }
}
