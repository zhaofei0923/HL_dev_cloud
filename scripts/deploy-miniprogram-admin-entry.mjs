import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, OUTPUT as COMPAT_OUTPUT, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { OUTPUT, patchAdminEntry } from './prepare-miniprogram-admin-entry-deployment.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const RESULT_DIR = dirname(OUTPUT);
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(stable(value)));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (name, value, exclusive = false) => writeFileSync(join(OUTPUT, name), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
let stage = 'arguments';

export function recoveryGate(recovery, environmentSha256) {
  check(recovery && recovery.status === 'restored_verified' && recovery.healthPassed === true
    && recovery.envId === TARGET.envId && recovery.functionName === TARGET.functionName
    && /^[a-f0-9]{64}$/.test(recovery.configurationSha256 || ''), 'RECOVERY_NOT_VERIFIED');
  check(environmentSha256 === recovery.configurationSha256, 'CURRENT_ENVIRONMENT_DIFFERS_FROM_RECOVERY');
}
export function validateEntryCandidate(manifest, compatibility, candidate) {
  check(digest(manifest.target) === digest(TARGET) && manifest.sourceFileCount === 4046 && manifest.candidateFileCount === 4047
    && manifest.unchangedFiles === 4045 && manifest.removedFiles === 0 && digest(manifest.changedFiles) === digest(['index.js'])
    && digest(manifest.addedFiles) === digest(['admin-entry-policy.js']), 'ENTRY_MANIFEST_SCOPE_MISMATCH');
  check(sha(compatibility) === manifest.compatibilityBaselineZipSha256 && sha(candidate) === manifest.candidateZipSha256, 'ENTRY_ZIP_HASH_MISMATCH');
  const before = readZip(compatibility), after = readZip(candidate);
  check(before.length === 4046 && after.length === 4047 && digest(inventory(before)) === digest(manifest.beforeInventory)
    && digest(inventory(after)) === digest(manifest.candidateInventory), 'ENTRY_INVENTORY_MISMATCH');
  const policy = after.find(file => file.name === 'admin-entry-policy.js');
  check(policy && sha(policy.bytes) === manifest.policySha256
    && digest(inventory(patchAdminEntry(before, { policyBytes: policy.bytes }))) === digest(inventory(after)), 'ENTRY_PATCH_MISMATCH');
  return after;
}
async function download(manager) {
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName), url = new URL(address.Url);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'DOWNLOAD_TARGET_INVALID');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'DOWNLOAD_FAILED');
  return { codeSha256: address.CodeSha256, files: readZip(Buffer.from(await response.arrayBuffer())) };
}
async function baselineSnapshot(manager, manifest, recovery, compatibilityReport) {
  const before = await manager.functions.getFunctionDetail(TARGET.functionName), beforeDigests = protectedDigests(before);
  check(before.Status === 'Active' && before.InstallDependency === 'FALSE', 'FUNCTION_NOT_READY');
  recoveryGate(recovery, beforeDigests.environmentSha256);
  const code = await download(manager), after = await manager.functions.getFunctionDetail(TARGET.functionName);
  const afterDigests = protectedDigests(after);
  recoveryGate(recovery, afterDigests.environmentSha256);
  check(after.Status === 'Active' && before.ModTime === after.ModTime && digest(beforeDigests) === digest(afterDigests), 'CONCURRENT_CLOUD_CHANGE');
  check(code.codeSha256 === compatibilityReport.deployedCodeSha256
    && code.codeSha256 === manifest.compatibilityBaselineZipSha256
    && digest(inventory(code.files)) === digest(manifest.beforeInventory), 'CURRENT_CODE_DIFFERS_FROM_COMPATIBILITY');
  return { detail: after, digests: afterDigests };
}
export async function main(mode) {
  check(['inspect', 'deploy'].includes(mode), 'MODE_REQUIRED');
  stage = 'recovery-gate';
  check(existsSync(join(RESULT_DIR, 'configuration-recovery.json')), 'RECOVERY_NOT_VERIFIED');
  const recovery = json(join(RESULT_DIR, 'configuration-recovery.json'));
  recoveryGate(recovery, recovery.configurationSha256);
  const compatibilityReport = json(join(RESULT_DIR, 'compatibility-deployment.json'));
  check(compatibilityReport.status === 'verified' && compatibilityReport.legacyGetter === true && compatibilityReport.legacyPolicy === true
    && compatibilityReport.envId === TARGET.envId && compatibilityReport.functionName === TARGET.functionName, 'COMPATIBILITY_NOT_VERIFIED');
  stage = 'candidate-validation';
  const manifest = json(join(OUTPUT, 'manifest.json')), candidate = readFileSync(join(OUTPUT, 'hlApi.admin-entry.candidate.zip'));
  const compatibility = readFileSync(join(COMPAT_OUTPUT, 'hlApi.candidate.zip'));
  validateEntryCandidate(manifest, compatibility, candidate);
  const prepared = json(join(OUTPUT, 'preparation-verification.json'));
  check(prepared.candidateZipSha256 === manifest.candidateZipSha256 && Array.isArray(prepared.checks)
    && prepared.checks.length > 0 && prepared.checks.every(check => check.failed === 0 && check.passed > 0), 'PREPARATION_NOT_VERIFIED');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  stage = 'live-baseline';
  const before = await baselineSnapshot(manager, manifest, recovery, compatibilityReport);
  if (mode === 'inspect') return { status: 'entry_preflight_verified_not_deployed', envId: TARGET.envId,
    functionName: TARGET.functionName, restoredEnvironmentMatched: true, compatibilityCodeMatched: true, cloudWrites: 0 };
  check(!existsSync(join(OUTPUT, 'deployment-state.json')) && !existsSync(join(OUTPUT, 'deployment-intent.json')), 'ENTRY_DEPLOYMENT_ALREADY_STARTED');
  save('deployment-intent.json', { envId: TARGET.envId, functionName: TARGET.functionName, startedAt: new Date().toISOString(),
    candidateZipSha256: manifest.candidateZipSha256, originalCodeSha256: compatibilityReport.deployedCodeSha256,
    recoveryConfigurationSha256: recovery.configurationSha256, protectedDigests: before.digests, transport: 'official_sdk_temp_cos' }, true);
  save('deployment-state.json', { status: 'preparing_upload', codeUpdateRequests: 0, environmentWrites: 0 }, true);
  stage = 'temp-cos-authorization';
  const config = manager.functions.getFunctionConfig();
  check(config.env === TARGET.envId && config.namespace === TARGET.envId && /^\d+$/.test(String(config.appId)), 'TEMP_COS_TARGET_MISMATCH');
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', { ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip` });
  const plan = tempCosUploadPlan(config, authorization);
  stage = 'temp-cos-upload';
  const response = await fetch(plan.url, { method: 'PUT', headers: plan.headers, body: candidate, redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok, 'TEMP_COS_UPLOAD_FAILED');
  stage = 'pre-update-recheck';
  const fresh = await baselineSnapshot(manager, manifest, recovery, compatibilityReport);
  check(fresh.detail.ModTime === before.detail.ModTime && digest(fresh.digests) === digest(before.digests), 'CONCURRENT_CLOUD_CHANGE');
  check(sha(readFileSync(join(OUTPUT, 'hlApi.admin-entry.candidate.zip'))) === manifest.candidateZipSha256, 'LOCAL_CANDIDATE_CHANGED');
  stage = 'entry-code-request';
  save('deployment-state.json', { status: 'request_pending', codeUpdateRequests: 1, environmentWrites: 0 });
  const result = await manager.functions.updateFunctionCode(repairCodeArguments(plan.key));
  check(!result.SCFErrorCode, 'ENTRY_CODE_REQUEST_REJECTED');
  save('deployment-state.json', { status: 'request_returned', codeUpdateRequests: 1, environmentWrites: 0 });
  stage = 'wait-entry-active';
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await manager.functions.getFunctionDetail(TARGET.functionName);
    check(!/Failed|Error/i.test(String(current.Status)), 'ENTRY_DEPLOYMENT_FAILED');
    if (current.Status === 'Active') {
      const code = await download(manager);
      if (code.codeSha256 === compatibilityReport.deployedCodeSha256) { await new Promise(done => setTimeout(done, 2000)); continue; }
      stage = 'verify-entry-files';
      check(code.files.length === 4047 && digest(inventory(code.files)) === digest(manifest.candidateInventory), 'ENTRY_DEPLOYED_FILES_MISMATCH');
      const after = await manager.functions.getFunctionDetail(TARGET.functionName), afterDigests = protectedDigests(after);
      check(after.Status === 'Active' && after.ModTime === current.ModTime, 'CONCURRENT_CLOUD_CHANGE');
      assertProtectedUnchanged(before.digests, afterDigests); recoveryGate(recovery, afterDigests.environmentSha256);
      stage = 'health-verification';
      const invocation = await manager.functions.invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });
      const body = JSON.parse(invocation.RetMsg);
      check(body.code === 0 && body.data?.status === 'ok', 'ENTRY_HEALTH_NOT_VERIFIED');
      const report = { status: 'verified', verifiedAt: new Date().toISOString(), envId: TARGET.envId, functionName: TARGET.functionName,
        modifiedAt: after.ModTime, deployedCodeSha256: code.codeSha256, candidateZipSha256: manifest.candidateZipSha256,
        filesVerified: 4047, fileContentsAndAttributesMatched: true, environmentUnchanged: true,
        recoveryConfigurationSha256Matched: true, otherConfigurationUnchanged: true, healthPassed: true,
        transport: 'official_sdk_temp_cos', dependencyInstallation: { before: 'FALSE', after: 'FALSE', installRequested: false },
        codeUpdateRequests: 1, configurationUpdateRequested: false, environmentWriteRequested: false,
        applicationPublished: false, paymentPerformed: false };
      save('deployment.json', report); save('deployment-state.json', { status: 'verified', codeUpdateRequests: 1, verifiedAt: report.verifiedAt });
      return report;
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  check(false, 'ENTRY_DEPLOYMENT_PENDING_NO_AUTOMATIC_RETRY');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 3, 'MODE_REQUIRED'); console.log(JSON.stringify(await main(process.argv[2]))); }
  catch (error) { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'ENTRY_DEPLOYMENT_UNCONFIRMED',
    environmentWriteRequested: false, automaticRetry: false, secretsPrinted: false })); process.exitCode = 1; }
}
