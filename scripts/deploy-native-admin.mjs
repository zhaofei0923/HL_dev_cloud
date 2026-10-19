import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { OUTPUT, BASELINE_SHA256, BOOTSTRAP_GUARD, checkedNativePatch, patchNativeAdmin, assertBundleArtifact } from './prepare-native-admin-deployment.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { recoveryGate } from './deploy-miniprogram-admin-entry.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const RECOVERY = join(ROOT, 'output/admin-entry-20261015/configuration-recovery.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (ok, safeCode) => { if (!ok) throw Object.assign(new Error(safeCode), { safeCode }); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, data, exclusive = false) => writeFileSync(join(OUTPUT, name), JSON.stringify(data, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
let stage = 'arguments';

function artifact(name) {
  const path = join(OUTPUT, name), stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink(), 'NATIVE_ARTIFACT_INVALID');
  return readFileSync(path);
}
export function validateNativeArtifacts() {
  const manifest = JSON.parse(artifact('manifest.json'));
  const rollback = artifact('hlApi.rollback.zip'), candidate = artifact('hlApi.native-admin.candidate.zip');
  check(digest(manifest.target) === digest(TARGET) && manifest.baselineZipSha256 === BASELINE_SHA256
    && manifest.rollbackZipSha256 === BASELINE_SHA256 && sha(rollback) === BASELINE_SHA256
    && manifest.candidateZipSha256 === sha(candidate), 'NATIVE_HASH_OR_TARGET_MISMATCH');
  check(manifest.sourceFileCount === 4047 && manifest.candidateFileCount === 4048 && manifest.dependencyFilesPreserved === 4031
    && manifest.unchangedFiles === 4045 && manifest.removedFiles === 0
    && digest(manifest.changedFiles) === digest(['admin-entry-policy.js', 'index.js'])
    && digest(manifest.addedFiles) === digest(['native-admin.bundle.js']), 'NATIVE_SCOPE_MISMATCH');
  check(manifest.runtime === 'Nodejs16.13' && manifest.buildTarget === 'node16.13'
    && manifest.nativeSdk?.name === '@cloudbase/node-sdk' && manifest.nativeSdk.version === '3.18.3', 'NATIVE_RUNTIME_SDK_MISMATCH');
  check(manifest.nativeBootstrapGuard === true && manifest.bootstrapGuardSha256 === sha(BOOTSTRAP_GUARD), 'NATIVE_BOOTSTRAP_GUARD_MISSING');
  const before = readZip(rollback), after = readZip(candidate);
  check(digest(inventory(before)) === digest(manifest.beforeInventory)
    && digest(inventory(after)) === digest(manifest.candidateInventory), 'NATIVE_INVENTORY_MISMATCH');
  const index = readFileSync(join(ROOT, 'cloudfunctions/hlApi/index.js'));
  const policy = readFileSync(join(ROOT, 'cloudfunctions/hlApi/admin-entry-policy.js'));
  check(sha(index) === manifest.localIndexSha256 && sha(policy) === manifest.policySha256, 'NATIVE_PATCH_INPUT_CHANGED');
  const bundle = after.find(file => file.name === 'native-admin.bundle.js')?.bytes;
  check(bundle && sha(bundle) === manifest.bundleSha256, 'NATIVE_BUNDLE_HASH_MISMATCH');
  assertBundleArtifact(bundle, JSON.parse(artifact('bundle-metafile.json')));
  const patch = checkedNativePatch(index, policy);
  check(digest(inventory(patchNativeAdmin(before, patch, bundle))) === digest(inventory(after)), 'NATIVE_IMMUTABLE_PATCH_MISMATCH');
  check(manifest.bundleInputs.length > 0 && manifest.bundleInputs.every(input => input.virtual
    ? input.path === 'native-optional-logger:supports-color' && input.sha256 === sha('module.exports = false;\n')
    : existsSync(input.path) && sha(readFileSync(input.path)) === input.sha256), 'NATIVE_BUNDLE_SOURCE_CHANGED');
  check(manifest.bundleInputs.filter(input => input.virtual).length === 1, 'NATIVE_VIRTUAL_INPUT_MISMATCH');
  check(sha(readFileSync(manifest.nativeSdk.packagePath)) === manifest.nativeSdk.packageSha256, 'NATIVE_SDK_CHANGED');
  const sdkPackage = json(manifest.nativeSdk.packagePath);
  check(sdkPackage.name === '@cloudbase/node-sdk' && sdkPackage.version === '3.18.3', 'NATIVE_SDK_VERSION_CHANGED');
  // The generated artifact must be explicitly reviewed for the existing runtime.
  const compatibility = JSON.parse(artifact('runtime-compatibility.json'));
  check(compatibility.passed === true && compatibility.runtime === 'Nodejs16.13'
    && compatibility.candidateZipSha256 === manifest.candidateZipSha256
    && compatibility.bundleSha256 === manifest.bundleSha256, 'NATIVE_RUNTIME_NOT_VERIFIED');
  return { manifest, candidate, before, after };
}
async function download(manager) {
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName), url = new URL(address.Url);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'NATIVE_DOWNLOAD_TARGET_INVALID');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'NATIVE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  check(bytes.length <= 60 * 1024 * 1024 && sha(bytes) === address.CodeSha256, 'NATIVE_DOWNLOAD_HASH_MISMATCH');
  return { codeSha256: address.CodeSha256, files: readZip(bytes) };
}
async function snapshot(manager, recovery) {
  const before = await manager.functions.getFunctionDetail(TARGET.functionName), protectedBefore = protectedDigests(before);
  check(before.Status === 'Active' && before.InstallDependency === 'FALSE', 'NATIVE_FUNCTION_NOT_READY');
  recoveryGate(recovery, protectedBefore.environmentSha256);
  const code = await download(manager);
  const after = await manager.functions.getFunctionDetail(TARGET.functionName), digests = protectedDigests(after);
  check(after.Status === 'Active' && before.ModTime === after.ModTime && digest(protectedBefore) === digest(digests), 'NATIVE_CONCURRENT_CLOUD_CHANGE');
  recoveryGate(recovery, digests.environmentSha256);
  return { detail: after, digests, code };
}
function assertBaseline(current, manifest) {
  check(current.code.codeSha256 === BASELINE_SHA256
    && digest(inventory(current.code.files)) === digest(manifest.beforeInventory), 'NATIVE_CLOUD_BASELINE_CHANGED');
}
async function verify(manager, manifest, recovery, baseline) {
  const current = await snapshot(manager, recovery);
  assertProtectedUnchanged(baseline, current.digests);
  check(current.code.codeSha256 === manifest.candidateZipSha256 && current.code.files.length === 4048
    && digest(inventory(current.code.files)) === digest(manifest.candidateInventory), 'NATIVE_DEPLOYED_FILES_MISMATCH');
  const health = await manager.functions.invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });
  const body = JSON.parse(health.RetMsg);
  check(body.code === 0 && body.data?.status === 'ok', 'NATIVE_HEALTH_FAILED');
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), ...TARGET, runtime: 'Nodejs16.13',
    modifiedAt: current.detail.ModTime, deployedCodeSha256: current.code.codeSha256,
    candidateZipSha256: manifest.candidateZipSha256, filesVerified: 4048, dependencyFilesPreserved: 4031,
    allFileContentsAndAttributesMatched: true, environmentUnchanged: true, otherConfigurationUnchanged: true,
    recoveryConfigurationSha256Matched: true, healthPassed: true, codeUpdateRequests: 1,
    environmentWrites: 0, dependencyInstallationRequested: false, applicationPublished: false, paymentPerformed: false };
  save('deployment.json', report); save('deployment-state.json', { status: 'verified', codeUpdateRequests: 1, verifiedAt: report.verifiedAt });
  return report;
}
export async function main(mode) {
  check(['inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
  stage = 'native-candidate-validation';
  const { manifest, candidate } = validateNativeArtifacts(), recovery = json(RECOVERY);
  recoveryGate(recovery, recovery.configurationSha256);
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') {
    const intent = json(join(OUTPUT, 'deployment-intent.json'));
    check(intent.candidateZipSha256 === manifest.candidateZipSha256 && digest(intent.target) === digest(TARGET), 'NATIVE_INTENT_MISMATCH');
    stage = 'native-deployment-readback';
    return verify(manager, manifest, recovery, intent.protectedDigests);
  }
  stage = 'native-live-baseline';
  const before = await snapshot(manager, recovery); assertBaseline(before, manifest);
  if (mode === 'inspect') return { status: 'native_preflight_verified_not_deployed', ...TARGET, restoredEnvironmentMatched: true,
    baselineCodeMatched: true, runtime: before.detail.Runtime, candidateZipSha256: manifest.candidateZipSha256, cloudWrites: 0 };
  check(!existsSync(join(OUTPUT, 'deployment-state.json')) && !existsSync(join(OUTPUT, 'deployment-intent.json')), 'NATIVE_DEPLOYMENT_ALREADY_REQUESTED_VERIFY_FIRST');
  save('deployment-intent.json', { target: TARGET, candidateZipSha256: manifest.candidateZipSha256,
    originalCodeSha256: BASELINE_SHA256, protectedDigests: before.digests, startedAt: new Date().toISOString(), transport: 'official_sdk_temp_cos' }, true);
  save('deployment-state.json', { status: 'preparing_upload', codeUpdateRequests: 0, environmentWrites: 0 }, true);
  stage = 'native-temp-cos-upload';
  const config = manager.functions.getFunctionConfig();
  check(config.env === TARGET.envId && config.namespace === TARGET.envId && /^\d+$/.test(String(config.appId)), 'NATIVE_UPLOAD_TARGET_INVALID');
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', { ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip` });
  const plan = tempCosUploadPlan(config, authorization);
  const upload = await fetch(plan.url, { method: 'PUT', headers: plan.headers, body: candidate, redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(upload.ok, 'NATIVE_TEMP_COS_UPLOAD_FAILED');
  stage = 'native-pre-update-recheck';
  const fresh = await snapshot(manager, recovery); assertBaseline(fresh, manifest);
  check(fresh.detail.ModTime === before.detail.ModTime && digest(fresh.digests) === digest(before.digests), 'NATIVE_CONCURRENT_CLOUD_CHANGE');
  validateNativeArtifacts();
  stage = 'native-code-update-request';
  save('deployment-state.json', { status: 'request_pending', codeUpdateRequests: 1, environmentWrites: 0 });
  const response = await manager.functions.updateFunctionCode(repairCodeArguments(plan.key));
  check(!response.SCFErrorCode, 'NATIVE_CODE_UPDATE_REJECTED');
  save('deployment-state.json', { status: 'request_returned', codeUpdateRequests: 1, environmentWrites: 0 });
  for (let attempt = 0; attempt < 30; attempt++) {
    stage = 'native-wait-active';
    const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
    check(!/Failed|Error/i.test(String(detail.Status)), 'NATIVE_DEPLOYMENT_FAILED');
    if (detail.Status === 'Active') {
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      if (address.CodeSha256 !== BASELINE_SHA256) {
        stage = 'native-verify-readback';
        return verify(manager, manifest, recovery, before.digests);
      }
    }
    await new Promise(done => setTimeout(done, 1500));
  }
  check(false, 'NATIVE_DEPLOYMENT_PENDING_NO_AUTOMATIC_RETRY');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 3, 'MODE_REQUIRED'); console.log(JSON.stringify(await main(process.argv[2]))); }
  catch (error) { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'NATIVE_DEPLOYMENT_UNCONFIRMED',
    automaticRetry: false, environmentWrites: 0, secretsPrinted: false })); process.exitCode = 1; }
}
