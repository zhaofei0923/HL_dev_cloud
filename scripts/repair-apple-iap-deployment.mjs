import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, OUTPUT } from './deploy-apple-iap.mjs';
import { TARGET, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { allowedRepairStatus, tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const path = name => `${OUTPUT}/${name}`;
const json = name => JSON.parse(readFileSync(path(name), 'utf8'));
const save = (name, value) => writeFileSync(path(name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
let stage = 'arguments';

function boundArtifacts() {
  const prepared = validateCandidate(), prior = json('deployment-intent.json'), request = json('deployment-code-update-request.json');
  const diagnostics = json('update-failure-diagnostics.json');
  const baselineModTime = diagnostics.fields?.ModTime;
  check(digest(prior.target) === digest(TARGET) && prior.baselineCodeSha256 === prepared.manifest.originalRemoteCodeSha256
    && prior.targetSha256 === prepared.manifest.candidateZipSha256 && request.targetSha256 === prior.targetSha256
    && request.codeUpdateRequests === 1, 'ORIGINAL_DEPLOYMENT_EVIDENCE_MISMATCH');
  check(diagnostics.fields?.Status === 'UpdateFailed' && typeof baselineModTime === 'string' && !!baselineModTime,
    'KNOWN_FAILED_BASELINE_REQUIRED');
  return { ...prepared, baselineModTime, locks: {
    repairScriptSha256: sha(readFileSync(SCRIPT)), manifestSha256: sha(readFileSync(path('manifest.json'))),
    diagnosticSha256: sha(readFileSync(path('update-failure-diagnostics.json'))),
    originalIntentSha256: sha(readFileSync(path('deployment-intent.json'))),
    originalRequestSha256: sha(readFileSync(path('deployment-code-update-request.json')))
  } };
}

async function downloaded(manager) {
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  let url;
  try { url = new URL(address.Url); } catch { check(false, 'CODE_DOWNLOAD_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'CODE_DOWNLOAD_URL_INVALID');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'CODE_DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(sha(zip) === address.CodeSha256, 'CODE_DOWNLOAD_HASH_MISMATCH');
  return { codeSha256: address.CodeSha256, zip, files: readZip(zip) };
}

async function originalSnapshot(manager, artifacts) {
  const { manifest, baselineModTime } = artifacts;
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(before.Status === 'UpdateFailed' && allowedRepairStatus(before) && before.ModTime === baselineModTime,
    'FAILED_STATUS_OR_MODIFICATION_TIME_CHANGED');
  assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(before));
  const code = await downloaded(manager);
  check(code.codeSha256 === manifest.originalRemoteCodeSha256
    && digest(inventory(code.files)) === digest(manifest.beforeInventory), 'ORIGINAL_BASELINE_CODE_CHANGED');
  const after = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(after.Status === 'UpdateFailed' && allowedRepairStatus(after) && after.ModTime === before.ModTime,
    'CONCURRENT_BASELINE_STATUS_CHANGE');
  assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(after));
  return { modifiedAt: after.ModTime, protectedDigests: protectedDigests(after), codeSha256: code.codeSha256, fileCount: code.files.length };
}

function assertRepairLocks(artifacts, record) {
  check(digest(record.target) === digest(TARGET) && digest(record.locks) === digest(artifacts.locks)
    && record.baselineCodeSha256 === artifacts.manifest.originalRemoteCodeSha256
    && record.candidateZipSha256 === artifacts.manifest.candidateZipSha256
    && record.baselineModifiedAt === artifacts.baselineModTime, 'REPAIR_IMMUTABLE_LOCK_MISMATCH');
}

async function verify(manager, artifacts) {
  const intent = json('repair-intent.json'), request = json('repair-code-update-request.json'), { manifest } = artifacts;
  assertRepairLocks(artifacts, intent);
  check(request.codeUpdateRequests === 1 && request.candidateZipSha256 === manifest.candidateZipSha256,
    'REPAIR_REQUEST_EVIDENCE_MISSING');
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(before.Status === 'Active', 'REPAIRED_FUNCTION_NOT_ACTIVE');
  assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(before));
  const code = await downloaded(manager);
  check(code.codeSha256 === manifest.candidateZipSha256 && code.files.length === manifest.fileCount
    && digest(inventory(code.files)) === digest(manifest.candidateInventory), 'REPAIR_DEPLOYED_PACKAGE_MISMATCH');
  const after = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(after.Status === 'Active' && after.ModTime === before.ModTime, 'CONCURRENT_REPAIR_READBACK_CHANGE');
  assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(after));
  stage = 'repair-health-check';
  const invocation = await manager.functions.invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });
  const health = JSON.parse(invocation.RetMsg);
  check(health.code === 0 && health.data?.status === 'ok', 'REPAIR_HEALTH_NOT_VERIFIED');
  const final = await manager.functions.getFunctionDetail(TARGET.functionName);
  const finalAddress = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(final.Status === 'Active' && final.ModTime === after.ModTime && finalAddress.CodeSha256 === code.codeSha256,
    'CONCURRENT_REPAIR_HEALTH_CHANGE');
  assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(final));
  const backupName = 'hlApi.repair.downloaded.zip';
  if (existsSync(path(backupName))) check(sha(readFileSync(path(backupName))) === code.codeSha256, 'EXISTING_REPAIR_READBACK_MISMATCH');
  else writeFileSync(path(backupName), code.zip, { flag: 'wx' });
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), target: TARGET,
    functionStatus: final.Status, modifiedAt: final.ModTime, deployedCodeSha256: code.codeSha256,
    filesVerified: code.files.length, unchangedFiles: manifest.unchangedFiles, changedFiles: manifest.changedFiles,
    fullFileContentsAndAttributesMatched: true, environmentUnchanged: true, otherConfigurationUnchanged: true,
    dependencyInstallation: { before: 'FALSE', after: final.InstallDependency, installRequested: false },
    health: { code: 0, status: 'ok' }, transport: 'official_sdk_temp_cos', originalFailedRequestPreserved: true,
    repairCodeUpdateRequests: 1, originalCodeUpdateRequests: 1, environmentWrites: 0, permissionsWrites: 0,
    paymentCalls: 0, credentialsPersisted: false };
  if (existsSync(path('repair-verification.json'))) {
    check(json('repair-verification.json').deployedCodeSha256 === code.codeSha256, 'EXISTING_REPAIR_REPORT_MISMATCH');
  } else save('repair-verification.json', report);
  return report;
}

export async function main(mode) {
  check(['inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
  stage = 'repair-immutable-candidate';
  const artifacts = boundArtifacts(), { manifest, candidate } = artifacts;
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') return verify(manager, artifacts);
  stage = 'repair-read-only-baseline';
  const before = await originalSnapshot(manager, artifacts);
  const baselineRecord = { status: 'repair_preflight_passed_not_deployed', checkedAt: new Date().toISOString(), target: TARGET,
    baselineCodeSha256: before.codeSha256, candidateZipSha256: manifest.candidateZipSha256,
    baselineModifiedAt: before.modifiedAt, protectedDigests: before.protectedDigests, filesVerified: before.fileCount,
    locks: artifacts.locks, knownCosTokenFailureOnly: true, cloudWrites: 0 };
  if (mode === 'inspect') {
    if (existsSync(path('repair-baseline.json'))) assertRepairLocks(artifacts, json('repair-baseline.json'));
    else save('repair-baseline.json', baselineRecord);
    return baselineRecord;
  }
  assertRepairLocks(artifacts, json('repair-baseline.json'));
  check(!existsSync(path('repair-intent.json')) && !existsSync(path('repair-code-update-request.json')),
    'REPAIR_ALREADY_REQUESTED_USE_VERIFY_DO_NOT_REPEAT');
  save('repair-intent.json', { ...baselineRecord, status: 'repair_started', startedAt: new Date().toISOString(),
    transport: 'official_sdk_temp_cos', environmentWrites: 0, permissionsWrites: 0, originalFailedRequestPreserved: true });
  stage = 'repair-native-temp-cos-authorization';
  const config = manager.functions.getFunctionConfig();
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', {
    ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip`
  });
  const upload = tempCosUploadPlan(config, authorization);
  stage = 'repair-exact-package-upload';
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: candidate,
    redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok, 'REPAIR_TEMP_COS_UPLOAD_FAILED');
  stage = 'repair-pre-update-recheck';
  await originalSnapshot(manager, artifacts);
  check(digest(boundArtifacts().locks) === digest(artifacts.locks), 'REPAIR_INPUT_CHANGED_BEFORE_UPDATE');
  save('repair-code-update-request.json', { requestedAt: new Date().toISOString(), candidateZipSha256: manifest.candidateZipSha256,
    codeUpdateRequests: 1, environmentWrites: 0, permissionsWrites: 0, automaticRetry: false });
  stage = 'repair-single-code-update';
  const result = await manager.functions.updateFunctionCode(repairCodeArguments(upload.key));
  check(!result.SCFErrorCode, 'REPAIR_UPDATE_REQUEST_REJECTED');
  stage = 'wait-for-repaired-active-code';
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await manager.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(current));
    if (current.Status === 'Active') {
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      if (address.CodeSha256 === manifest.candidateZipSha256) { stage = 'repair-full-package-verification'; return verify(manager, artifacts); }
    }
    const originalFailureStillVisible = current.Status === 'UpdateFailed' && current.ModTime === before.modifiedAt && allowedRepairStatus(current);
    check(originalFailureStillVisible || !/Failed|Error/i.test(String(current.Status)), 'REPAIR_DEPLOYMENT_FAILED_NO_AUTOMATIC_RETRY');
    await new Promise(done => setTimeout(done, 1500));
  }
  check(false, 'REPAIR_PENDING_USE_VERIFY_DO_NOT_REPEAT');
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    check(process.argv.length === 3, 'MODE_REQUIRED');
    console.log(JSON.stringify(await main(process.argv[2])));
  } catch (error) {
    console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'APPLE_IAP_REPAIR_UNCONFIRMED',
      rawErrorWithheld: true, automaticRetry: false, environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0 }));
    process.exitCode = 1;
  }
}
