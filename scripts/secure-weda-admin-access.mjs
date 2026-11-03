import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { TARGET, OUTPUT, snapshot, preciseReadRoleId, buildReviewPlan, assertProtectedAccess, assertAppScopedPolicyChanges, assertAdministratorAndFixedExternalResourceRoles } from './inspect-weda-admin-access.mjs';

const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const ROOT = resolve(import.meta.dirname, '..');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const load = name => JSON.parse(readFileSync(join(OUTPUT, name), 'utf8'));
const save = (name, value, exclusive = false) => writeFileSync(join(OUTPUT, name), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
export function accessSemantics(value) {
  return { target: value.target, pre: { total: value.pre.total, roles: value.pre.roles },
    prod: { total: value.prod.total, roles: value.prod.roles },
    pages: Object.fromEntries(Object.entries(value.pages).map(([id, item]) => [id, { allPages: item.allPages, pages: item.pages }])),
    globalRolePolicyDigests: value.globalRolePolicyDigests, appIds: value.appIds,
    actualRolePages: value.actualRolePages ? Object.fromEntries(Object.entries(value.actualRolePages).map(([id, item]) =>
      [id, { identity: item.identity, allPages: item.allPages, pages: item.pages }])) : null,
    actualRoleCatalog: value.actualRoleCatalog ? { pre: value.actualRoleCatalog.pre.roles, prod: value.actualRoleCatalog.prod.roles } : null };
}
function unchangedOutsidePreview(before, current) {
  check(current.readConsistencyVerified && digest(before.target) === digest(current.target)
    && digest(before.appIds) === digest(current.appIds), 'ACCESS_CHANGED_OUTSIDE_APPLICATION_SCOPE');
  assertAppScopedPolicyChanges(before, current);
  // The first scoped Unbind changed both role lists in this environment.
  // Preserve only the approved administrator and built-in external shell roles.
  assertAdministratorAndFixedExternalResourceRoles(current.pre);
  assertAdministratorAndFixedExternalResourceRoles(current.prod);
  check(current.pages['-1']?.allPages === true, 'ADMINISTRATOR_PAGE_ACCESS_LOST');
}
let stage = 'arguments', state, client;
try {
  const [mode] = process.argv.slice(2);
  check(['reconcile-first', 'external-selection', 'external-remove-pages', 'pre-string', 'pre-int64', 'release', 'verify-release'].includes(mode) && process.argv.length === 3, 'MODE_REQUIRED');
  const before = load('app-access-before.json'), plan = buildReviewPlan(before);
  const actions = plan.previewUnbinds;
  check(actions.length === 3 && actions.every(item => item.Action === 'UnbindWedaResource'
    && item.Param.EnvId === TARGET.EnvId && item.Param.EnvType === 'pre' && item.Param.ResourceType === 'app'
    && (item.Param.RoleId !== '-3' || item.Param.SubType === '2')), 'SCOPED_PLAN_UNEXPECTED');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.EnvId, region: 'ap-shanghai', site: 'domestic' }, authStrategy: 'fail_fast' });
  client = new PaymentMcpClient(SDK.replace(/index\.cjs$/, 'cli.cjs'), { envId: TARGET.EnvId, region: 'ap-shanghai', cwd: ROOT });
  const call = async (Action, Param) => {
    const raw = await manager.commonService('lowcode', '2021-01-08').call({ Action, Param });
    const result = raw?.Response ?? raw;
    check(result && !result.Error, 'LOWCODE_OPERATION_NOT_CONFIRMED'); return result;
  };
  stage = 'fresh_access';
  let current = await snapshot(manager, client);
  if (mode === 'reconcile-first') {
    stage = 'reconcile_confirmed_first_write';
    const prior = load('app-access-edit-state.json'), progress = load('app-access-edit-progress.json');
    check(digest(prior.target) === digest(TARGET) && prior.status === 'in_flight' && prior.completed === 0 && prior.operationIndex === 0, 'RECONCILE_STATE_UNEXPECTED');
    check(digest(accessSemantics(progress)) === digest(accessSemantics(current)), 'ACCESS_CHANGED_AFTER_CONFIRMED_FIRST_WRITE');
    check(current.pre.total === 2 && current.prod.total === 2
      && digest(current.pre.roles) === digest(current.prod.roles)
      && current.pre.roles.every(row => (row.id === '-1' && row.identity === 'administrator')
        || (row.id === '-3' && row.identity === 'externalUser'))
      && digest(Object.fromEntries(Object.entries(before.pages).map(([id, value]) => [id, { allPages: value.allPages, pages: value.pages }])))
        === digest(Object.fromEntries(Object.entries(current.pages).map(([id, value]) => [id, { allPages: value.allPages, pages: value.pages }]))),
      'FIRST_OPERATION_READBACK_UNEXPECTED');
    unchangedOutsidePreview(before, current);
    save('app-access-edit-progress.json', current);
    save('app-access-first-write-reconciliation.json', { status: 'confirmed_by_fresh_readback', target: TARGET,
      completed: 1, firstRequestReplayed: false, capturedAt: new Date().toISOString(), cloudWrites: 0 });
    save('app-access-edit-state.json', { target: TARGET, status: 'step_verified', completed: 1, roleEncoding: 'pre-int64', automaticRetry: false });
    console.log(JSON.stringify({ status: 'first_scoped_operation_reconciled', cloudWrites: 0, requestReplayed: false }));
  } else if (mode === 'external-selection') {
    stage = 'external_selection_preflight';
    const completed = load('app-access-edit-state.json');
    check(digest(completed.target) === digest(TARGET) && completed.completed === 3
      && completed.status === 'step_verified', 'PAGE_UNBIND_COMPLETION_UNCONFIRMED');
    unchangedOutsidePreview(before, current);
    check(current.pages['2063939556191813634']?.pages.length === 6
      && current.pages['2063939556191813634'].pages.every(page => !page.allowed)
      && current.pages['-3']?.allPages === false && current.pages['-3'].pages.length === 6
      && current.pages['-3'].pages.every(page => page.allowed), 'EXTERNAL_SELECTION_PRECONDITION_CHANGED');
    const stateName = 'app-access-external-selection-state.json';
    check(!existsSync(join(OUTPUT, stateName)), 'EXTERNAL_SELECTION_ALREADY_REQUESTED');
    // Official PermissionItemDetail save also calls onChangePagePermissionToRoleType(false)
    // after unbinding checked pages. Complete that exact selected-pages operation.
    const params = { EnvId: TARGET.EnvId, EnvType: 'pre', ResourceType: 'app',
      RoleId: preciseReadRoleId('-3'), ResourceIds: [TARGET.ResourceId],
      SubType: '2', IsBindAllResource: false, ParentResourceId: TARGET.ResourceId };
    save(stateName, { target: TARGET, status: 'in_flight', requests: 1, automaticRetry: false,
      action: 'BindWedaResource', selectedPages: [], officialEditorOperation: 'onChangePagePermissionToRoleType(false)' }, true);
    stage = 'external_selection_request';
    await call('BindWedaResource', params);
    stage = 'external_selection_readback';
    current = await snapshot(manager, client);
    save('app-access-external-selection-readback.json', current);
    unchangedOutsidePreview(before, current);
    save(stateName, { target: TARGET, status: 'readback_received', requests: 1, automaticRetry: false });
    assertProtectedAccess(before, current, 'pre');
    save(stateName, { target: TARGET, status: 'verified', requests: 1, automaticRetry: false });
    save('app-access-pre-verified.json', { status: 'verified', target: TARGET,
      preAccessSha256: digest(accessSemantics(current)), capturedAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'all_management_pages_restricted', administratorPagesPreserved: true,
      externalDefaultAppRolePreserved: true, environmentWrites: 0, businessCalls: 0 }));
  } else if (mode === 'external-remove-pages') {
    stage = 'external_page_removal_preflight';
    const selected = load('app-access-external-selection-state.json');
    check(digest(selected.target) === digest(TARGET) && selected.status === 'readback_received'
      && selected.requests === 1, 'SELECTION_MODE_OUTCOME_UNCONFIRMED');
    unchangedOutsidePreview(before, current);
    check(current.pages['2063939556191813634']?.pages.length === 6
      && current.pages['2063939556191813634'].pages.every(page => !page.allowed)
      && current.pages['-3']?.allPages === false && current.pages['-3'].pages.length === 6
      && current.pages['-3'].pages.every(page => page.allowed), 'EXTERNAL_PAGE_REMOVAL_PRECONDITION_CHANGED');
    const stateName = 'app-access-external-page-removal-state.json';
    check(!existsSync(join(OUTPUT, stateName)), 'EXTERNAL_PAGE_REMOVAL_ALREADY_REQUESTED');
    // Exact official page-removal callback; do not use app-removal ParentResourceId flags.
    const params = { EnvId: TARGET.EnvId, EnvType: 'pre', ResourceType: 'app',
      RoleId: preciseReadRoleId('-3'), ResourceIds: before.pages['-3'].pages.map(page => page.id), SubType: '2' };
    save(stateName, { target: TARGET, status: 'in_flight', requests: 1, automaticRetry: false,
      action: 'UnbindWedaResource', officialEditorOperation: 'onUnGrandPagePermissionToRole' }, true);
    stage = 'external_page_removal_request';
    await call('UnbindWedaResource', params);
    stage = 'external_page_removal_readback';
    current = await snapshot(manager, client);
    save('app-access-external-page-removal-readback.json', current);
    unchangedOutsidePreview(before, current);
    save(stateName, { target: TARGET, status: 'readback_received', requests: 1, automaticRetry: false });
    assertProtectedAccess(before, current, 'pre');
    save(stateName, { target: TARGET, status: 'verified', requests: 1, automaticRetry: false });
    save('app-access-pre-verified.json', { status: 'verified', target: TARGET,
      preAccessSha256: digest(accessSemantics(current)), capturedAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'all_management_pages_restricted', administratorPagesPreserved: true,
      externalDefaultAppRolePreserved: true, environmentWrites: 0, businessCalls: 0 }));
  } else if (mode.startsWith('pre-')) {
    const name = 'app-access-edit-state.json';
    state = existsSync(join(OUTPUT, name)) ? load(name) : { completed: 0, status: 'ready', target: TARGET };
    check(digest(state.target) === digest(TARGET) && Number.isInteger(state.completed) && state.completed >= 0
      && state.completed <= actions.length && state.status !== 'in_flight', 'PRE_EDIT_OUTCOME_UNKNOWN');
    const expected = state.completed ? load('app-access-edit-progress.json') : before;
    check(digest(accessSemantics(expected)) === digest(accessSemantics(current)), 'ACCESS_CHANGED_SINCE_LAST_VERIFIED_STEP');
    if (!existsSync(join(OUTPUT, 'app-access-global-policy-backup.json'))) {
      const roles = await client.call('queryPermissions', { action: 'listRoles', pageNo: 1, pageSize: 100 });
      const data = roles.data, rows = [...(data?.systemRoles ?? []), ...(data?.customRoles ?? [])];
      check(Number(data?.total) === rows.length, 'ROLE_BACKUP_INCOMPLETE');
      save('app-access-global-policy-backup.json', { target: TARGET,
        roles: rows.map(row => ({ identity: row.RoleIdentity, id: String(row.RoleId), policies: row.Policies ?? [] })),
        capturedAt: new Date().toISOString(), restoreAutomatically: false }, true);
    }
    for (let index = state.completed; index < actions.length; index++) {
      const action = actions[index];
      const params = { ...action.Param, ...(mode === 'pre-int64' ? { RoleId: preciseReadRoleId(action.Param.RoleId) } : {}) };
      stage = `pre_change_${index}`;
      state = { target: TARGET, status: 'in_flight', completed: index, operationIndex: index,
        roleEncoding: mode, automaticRetry: false };
      save(name, state);
      try { await call(action.Action, params); }
      catch (error) {
        const code = String(error.code || '');
        if (/^InvalidParameter/.test(code)) {
          state.status = 'rejected'; state.errorCode = code;
          state.safeParameterMessage = /RoleId|SubType|ResourceIds/i.test(error.message || '')
            ? String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 250) : undefined;
          save(name, state);
        }
        throw error;
      }
      stage = `pre_readback_${index}`;
      current = await snapshot(manager, client);
      save('app-access-edit-progress.json', current);
      unchangedOutsidePreview(before, current);
      state = { target: TARGET, status: 'step_verified', completed: index + 1,
        roleEncoding: mode, automaticRetry: false };
      save(name, state);
    }
    assertProtectedAccess(before, current, 'pre');
    save('app-access-pre-verified.json', { status: 'verified', target: TARGET,
      preAccessSha256: digest(accessSemantics(current)), capturedAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'preview_access_verified', completed: actions.length,
      administratorPagesPreserved: true, externalDefaultAppRolePreserved: true, businessCalls: 0, environmentWrites: 0 }));
  } else {
    assertProtectedAccess(before, current, mode === 'release' ? 'pre' : 'prod');
    let released;
    if (mode === 'release') {
      check(!existsSync(join(OUTPUT, 'app-access-release-state.json')), 'RELEASE_ALREADY_REQUESTED_USE_VERIFY');
      stage = 'release_request';
      save('app-access-release-state.json', { status: 'in_flight', target: TARGET, requests: 1, automaticRetry: false }, true);
      released = await call('ReleaseResourcePermissions', plan.release.Param);
      check(typeof released.Data?.TaskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(released.Data.TaskId), 'RELEASE_TASK_UNCONFIRMED');
      save('app-access-release-state.json', { status: 'requested', target: TARGET, TaskId: released.Data.TaskId, requests: 1 });
    }
    const task = load('app-access-release-state.json');
    check(task.requests === 1 && task.TaskId, 'RELEASE_STATE_UNCONFIRMED');
    stage = 'release_readback';
    let status;
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await call('DescribePermissionsReleaseStatus', { EnvId: TARGET.EnvId, EnvType: 'pre', TaskId: task.TaskId });
      status = result.Data?.TaskStatus;
      if (status === 'SUCCESS') break;
      check(status !== 'FAILED', 'RESOURCE_PERMISSION_RELEASE_FAILED');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    check(status === 'SUCCESS', 'RESOURCE_PERMISSION_RELEASE_PENDING');
    current = await snapshot(manager, client);
    assertProtectedAccess(before, current, 'prod');
    save('app-access-release.json', { status: 'verified', target: TARGET, TaskId: task.TaskId,
      TaskStatus: status, preAccessSha256: digest(accessSemantics(current)), releasedAt: new Date().toISOString(),
      administratorPagesPreserved: true, externalDefaultAppRolePreserved: true,
      nonAdministratorManagementPagesAllowed: false, nonTargetPoliciesPreserved: true,
      applicationRoleListsObservedSynchronous: true, productionPagesReadIndependently: false,
      effectiveRoleModel: 'Current authenticated role catalogues; legacy -3 placeholder retained separately',
      environmentWrites: 0, businessCalls: 0 });
    console.log(JSON.stringify({ status: 'app_access_release_verified', TaskStatus: status, environmentWrites: 0, businessCalls: 0 }));
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'not_verified', stage, code: error.safeCode || error.code || 'SCOPED_ACCESS_OPERATION_UNCONFIRMED',
    completed: state?.completed, parameterMessage: state?.safeParameterMessage, automaticRetry: false,
    environmentWrites: 0, businessCalls: 0 })); process.exitCode = 1;
} finally { client?.close(); }
