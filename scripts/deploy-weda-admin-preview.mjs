import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { TARGET as ACCESS_TARGET, OUTPUT as ACCESS_OUTPUT, PAGE_KEYS, snapshot, assertProtectedAccess,
  assertPreviewAccessSnapshot, assertAppScopedPolicyChanges,
  assertAdministratorAndFixedExternalResourceRoles } from './inspect-weda-admin-access.mjs';

// Native WeDa only. No environment, role, data, or formal-publication writes.
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
export const TARGET = Object.freeze({ envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai',
  appId: 'app-pq2auygx', historyId: 6776440,
  semanticSha256: '86bb3907f7ebd8a6b4b00e0166bb1a2c424476847e16d97666c704d794dc0268' });
const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'output/admin-entry-20261015/weda-preview');
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { safeCode: code }); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const semanticSha256 = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const save = (file, value, exclusive = false) => writeFileSync(join(OUTPUT, file), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
const load = file => JSON.parse(readFileSync(join(OUTPUT, file), 'utf8'));
let stage = 'arguments';

export { assertAdministratorAndFixedExternalResourceRoles as assertApplicationRoles };
export function assertPermissionReleaseProof(proof) {
  check(proof?.target && semanticSha256(proof.target) === semanticSha256(ACCESS_TARGET), 'PERMISSION_RELEASE_TARGET_MISMATCH');
  check(proof.TaskStatus === 'SUCCESS' && typeof proof.TaskId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(proof.TaskId), 'PERMISSION_RELEASE_SUCCESS_REQUIRED');
  return proof.TaskId;
}
export function summarizeActualAccess(current) {
  check(current?.actualRolePages && typeof current.actualRolePages === 'object'
    && !Array.isArray(current.actualRolePages), 'ACTUAL_ROLE_PAGE_EVIDENCE_REQUIRED');
  const roles = Object.entries(current.actualRolePages);
  check(roles.length > 0 && !roles.some(([id]) => id === '-3'), 'ACTUAL_ROLE_MODEL_UNEXPECTED');
  const restricted = roles.filter(([id]) => id !== '-1');
  const denied = restricted.length > 0 && restricted.every(([, role]) => role.allPages === false
    && Array.isArray(role.pages) && role.pages.length === PAGE_KEYS.length
    && PAGE_KEYS.every(key => role.pages.some(page => page.key === key
      && page.id === `${TARGET.appId}-${key}` && page.allowed === false)));
  const legacy = current.pages?.['-3'];
  check(legacy && typeof legacy.allPages === 'boolean' && Array.isArray(legacy.pages), 'LEGACY_ROLE_DISPLAY_EVIDENCE_REQUIRED');
  return { appShellRoles: current.pre.roles.map(role => role.identity),
    actualRoleCount: roles.length, actualNonAdministratorRoleIdentities: restricted.map(([, role]) => role.identity).sort(),
    actualNonAdministratorSixPagesDenied: denied,
    legacyExternalRole: { id: '-3', inActualRoleList: false, allPages: legacy.allPages,
      allowedPageKeys: legacy.pages.filter(page => page.allowed).map(page => page.key).sort(),
      displayUnresolved: true, runtimeAccessVerified: false } };
}
export function previewParameters() {
  return { EnvId: TARGET.envId, Id: TARGET.appId, Mode: 'preview', BuildType: 'web' };
}
export function officialUrls(response) {
  check(response?.Data?.WeAppId === TARGET.appId && Array.isArray(response.Data.Items), 'URL_RESPONSE_TARGET_MISMATCH');
  const result = {};
  for (const envType of ['pre', 'prod']) {
    const matches = response.Data.Items.filter(item => item.EnvType === envType);
    check(matches.length === 1 && matches[0].Active === true, 'URL_CONFIGURATION_UNAVAILABLE');
    const address = new URL(matches[0].Url);
    const expectedPath = `/${TARGET.appId}/${envType === 'pre' ? 'preview' : 'production'}/`;
    check(address.protocol === 'https:' && !address.username && !address.password && !address.search && !address.hash
      && address.hostname.endsWith('.tcloudbaseapp.com') && address.pathname === expectedPath, 'PLATFORM_URL_UNEXPECTED');
    result[envType] = address.href;
  }
  return result;
}
async function accessGate(manager, client, call) {
  const proofPath = join(ACCESS_OUTPUT, 'app-access-release.json');
  check(existsSync(proofPath), 'PERMISSION_RELEASE_PROOF_REQUIRED');
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  const taskId = assertPermissionReleaseProof(proof);
  const release = await call('DescribePermissionsReleaseStatus', { EnvId: TARGET.envId, EnvType: 'pre', TaskId: taskId });
  check(release.Data?.TaskStatus === 'SUCCESS', 'PERMISSION_RELEASE_NOT_SUCCESS');
  const before = JSON.parse(readFileSync(join(ACCESS_OUTPUT, 'app-access-before.json'), 'utf8'));
  const current = await snapshot(manager, client);
  check(current.accessModelVersion === 3, 'ACTUAL_ROLE_MODEL_V3_REQUIRED');
  assertPreviewAccessSnapshot(current);
  const policyEvidence = assertAppScopedPolicyChanges(before, current);
  // These shared guards permit only the reviewed target app policy override.
  // A scoped pre edit may also affect the prod application-role summary;
  // page publication is established separately by the live SUCCESS task above.
  assertProtectedAccess(before, current, 'prod');
  const actualEvidence = summarizeActualAccess(current);
  check(actualEvidence.actualNonAdministratorSixPagesDenied === true, 'ACTUAL_ROLE_PAGES_NOT_DENIED');
  return { permissionsReleaseTaskId: taskId, permissionsReleaseTaskStatus: 'SUCCESS',
    accessModelVersion: current.accessModelVersion, actualRoleCatalogVerified: true,
    ...actualEvidence,
    ...policyEvidence,
    policyProtectionScope: 'Exact non-target policies; only the reviewed target application override is permitted.',
    applicationRoleListsProvePagePublication: false,
    productionPagesReadIndependently: false,
    productionPermissionAssurance: 'App permission ReleaseResourcePermissions task SUCCESS; production page access still requires runtime acceptance.' };
}
async function draftGate(call) {
  const local = JSON.parse(readFileSync(join(ROOT, 'weda-admin/app.cals.json'), 'utf8'));
  check(semanticSha256(local) === TARGET.semanticSha256, 'LOCAL_DESIGN_CHANGED');
  const response = await call('DescribeAppDetail', { EnvId: TARGET.envId, WeAppId: TARGET.appId, Name: TARGET.appId });
  const detail = response.Data;
  check(detail?.Id === TARGET.appId && detail.EnvId === TARGET.envId, 'APPLICATION_TARGET_MISMATCH');
  const history = typeof detail.LatestHistory === 'string' ? JSON.parse(detail.LatestHistory) : detail.LatestHistory;
  check(Number(history?.id ?? history?.Id) === TARGET.historyId, 'LATEST_HISTORY_CHANGED');
  const signed = await call('DescribeAppHistoryPreSignUrl', { HttpMethod: 'get', WeAppsId: TARGET.appId, HisIds: [TARGET.historyId] });
  const row = signed.Data?.[0];
  const address = new URL(row?.DownloadUrl || row?.UploadUrl);
  check(address.protocol === 'https:' && !address.username && !address.password && !address.hash, 'HISTORY_DOWNLOAD_UNAVAILABLE');
  stage = 'read-design';
  const downloaded = await fetch(address, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  check(downloaded.ok, 'HISTORY_DOWNLOAD_FAILED');
  const content = await downloaded.text();
  check(Buffer.byteLength(content) < 10 * 1024 * 1024 && semanticSha256(JSON.parse(content)) === TARGET.semanticSha256, 'CLOUD_DESIGN_DIFFERS');
  return { historyId: TARGET.historyId, semanticSha256: TARGET.semanticSha256,
    lastDeployTime: detail.LastDeployTime || null, lastWebCiStatus: detail.LastWebCiStatus || null };
}
async function verifyPreview(call, buildId, readAccess) {
  check(typeof buildId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(buildId), 'BUILD_ID_INVALID');
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await call('CheckDeployApp', { EnvId: TARGET.envId, Id: TARGET.appId, BuildId: buildId });
    status = response.Status;
    check(typeof status === 'string' && /^[A-Za-z_-]{1,64}$/.test(status), 'BUILD_STATUS_UNRECOGNIZED');
    save('state.json', { status: 'checking', buildId, platformStatus: status, deployRequests: 1, environmentWrites: 0 });
    if (['success', 'releaseSuccess'].includes(status)) break;
    check(!['fail', 'failed', 'reviewFail'].includes(status), 'PREVIEW_BUILD_FAILED');
    check(['building', 'underReview'].includes(status), 'BUILD_STATUS_UNRECOGNIZED');
    console.log(JSON.stringify({ stage: 'check-preview', platformStatus: status }));
    await pause(10000);
  }
  check(['success', 'releaseSuccess'].includes(status), 'PREVIEW_BUILD_NOT_CONFIRMED');
  await draftGate(call);
  const access = await readAccess();
  const urls = officialUrls(await call('DescribeAppCustomDomainDetail', { EnvId: TARGET.envId, WeAppId: TARGET.appId }));
  stage = 'preview-http';
  const response = await fetch(urls.pre, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const html = await response.text();
  check(response.status === 200 && /<html[\s>]/i.test(html) && /<script[\s>]/i.test(html)
    && !/NoSuchKey|404 Not Found/i.test(html), 'PREVIEW_HTTP_NOT_READY');
  const pub = await call('DescribeAppPubUrl', { EnvId: TARGET.envId, WeAppId: TARGET.appId });
  check(pub.Data?.WeAppId === TARGET.appId && pub.Data.Url === urls.prod, 'PRODUCTION_URL_READBACK_DIFFERS');
  const report = { status: 'preview_assets_verified', capturedAt: new Date().toISOString(), envId: TARGET.envId,
    appId: TARGET.appId, historyId: TARGET.historyId, semanticSha256: TARGET.semanticSha256, buildId, platformStatus: status,
    mode: 'preview', buildType: 'web', ...access,
    previewUrl: urls.pre, productionUrl: urls.prod, productionActive: pub.Data.Active === true,
    productionPublicationRequested: false, defaultDomainForTestingOnly: true,
    httpStatus: response.status, previewHtmlSha256: createHash('sha256').update(html).digest('hex'),
    browserLoginVerified: false, businessActionsPerformed: 0, deployRequests: 1,
    environmentWrites: 0, roleWrites: 0, miniProgramEntryUrlConfigured: false };
  save('deployment.json', report);
  save('state.json', { status: 'preview_assets_verified', buildId, deployRequests: 1, environmentWrites: 0 });
  return report;
}
export async function main(mode) {
  check(['inspect', 'preview', 'verify'].includes(mode), 'MODE_REQUIRED');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  const call = async (Action, Param) => {
    stage = Action;
    const raw = await manager.commonService('lowcode', '2021-01-08').call({ Action, Param });
    const result = raw?.Response ?? raw;
    check(result && !result.Error, 'LOWCODE_API_FAILED');
    return result;
  };
  const draft = await draftGate(call);
  const client = new PaymentMcpClient(SDK.replace(/index\.cjs$/, 'cli.cjs'), {
    envId: TARGET.envId, region: TARGET.region, cwd: ROOT });
  try {
    await client.ready;
    const readAccess = () => accessGate(manager, client, call);
    const access = await readAccess();
    if (mode === 'inspect') return { status: 'preview_preflight_verified_not_deployed', envId: TARGET.envId,
      appId: TARGET.appId, ...draft, ...access, cloudWrites: 0 };
    mkdirSync(OUTPUT, { recursive: true });
    if (mode === 'verify') {
      const state = load('state.json');
      check(state.deployRequests === 1 && state.environmentWrites === 0, 'STATE_UNEXPECTED');
      return await verifyPreview(call, state.buildId, readAccess);
    }
    check(!existsSync(join(OUTPUT, 'intent.json')) && !existsSync(join(OUTPUT, 'state.json')), 'PREVIEW_ALREADY_REQUESTED_USE_VERIFY');
    save('intent.json', { envId: TARGET.envId, appId: TARGET.appId, ...draft, ...access, mode: 'preview', buildType: 'web',
      startedAt: new Date().toISOString(), roleChangesRequested: false, environmentChangesRequested: false }, true);
    save('state.json', { status: 'request_pending', deployRequests: 1, environmentWrites: 0 }, true);
    const deployed = await call('DeployApp', previewParameters());
    check(deployed.DeployErrCode === 0 && typeof deployed.BuildId === 'string', 'PREVIEW_REQUEST_NOT_CONFIRMED');
    save('state.json', { status: 'request_returned', buildId: deployed.BuildId, deployRequests: 1, environmentWrites: 0 });
    return await verifyPreview(call, deployed.BuildId, readAccess);
  } finally {
    client.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ status: 'not_verified', stage,
      code: error?.safeCode || (/^[A-Za-z0-9_.-]{1,80}$/.test(error?.code || '') ? error.code : 'PREVIEW_OPERATION_UNCONFIRMED'),
      message: '未输出凭据、签名地址或原始错误；请求一旦发出，仅可使用 verify 回读，不能自动重发。' }));
    process.exitCode = 1;
  });
}
