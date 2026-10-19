import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { buildNativeBundle, verifyNode16Bundle, assertBundleArtifact } from './prepare-native-admin-deployment.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = join(ROOT, 'output/native-admin-20261015/backend-candidate-v3');
const OUT = join(ROOT, 'output/native-admin-performance-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const BASE = '62dee136a78df0d5469f686239eceeeb386db177bdbe2a803cee9194f7265a7c';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
let stage = 'arguments';

export function replaceManagementBundle(files, bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && files.filter(file => file.name === 'native-admin.bundle.js').length === 1, 'BUNDLE_LAYOUT_INVALID');
  return files.map(file => ({ ...file, bytes: file.name === 'native-admin.bundle.js' ? bytes : file.bytes }));
}
export function assertInputScope(before, after) {
  const prior = new Map(before.map(input => [input.path, input.sha256]));
  const allowed = new Set(['cloudfunctions/hlAdminOperations/read-service.js', 'cloudfunctions/hlAdminCockpit/service.js'].map(name => resolve(ROOT, name)));
  const changed = after.filter(input => prior.get(input.path) !== input.sha256).map(input => input.path);
  check(changed.length > 0 && changed.every(path => allowed.has(path)) && before.length === after.length
    && before.every(input => after.some(next => next.path === input.path)), 'UNRELATED_BUNDLE_SOURCE_CHANGE');
  return changed;
}
function validate() {
  const manifest = json(join(OUT, 'manifest.json'));
  const rollback = readFileSync(join(OUT, 'hlApi.rollback.zip')), candidate = readFileSync(join(OUT, 'hlApi.performance.zip'));
  check(sha(rollback) === BASE && sha(candidate) === manifest.candidateSha256, 'ARTIFACT_HASH_MISMATCH');
  const before = readZip(rollback), after = readZip(candidate);
  const bundle = after.find(file => file.name === 'native-admin.bundle.js')?.bytes;
  check(bundle && sha(bundle) === manifest.bundleSha256, 'BUNDLE_HASH_MISMATCH');
  check(JSON.stringify(inventory(replaceManagementBundle(before, bundle))) === JSON.stringify(inventory(after)), 'UNRELATED_PACKAGE_CHANGE');
  const oldManifest = json(join(OLD, 'manifest.json'));
  assertInputScope(oldManifest.bundleInputs, manifest.bundleInputs);
  check(manifest.bundleInputs.every(input => input.virtual || sha(readFileSync(input.path)) === input.sha256), 'SOURCE_CHANGED_AFTER_BUILD');
  const runtime = json(join(OUT, 'runtime-compatibility.json'));
  check(runtime.passed && runtime.bundleSha256 === manifest.bundleSha256, 'RUNTIME_CHECK_REQUIRED');
  assertBundleArtifact(bundle, json(join(OUT, 'bundle-metafile.json')));
  return { manifest, candidate, after };
}
async function prepare() {
  check(!existsSync(join(OUT, 'manifest.json')), 'CANDIDATE_ALREADY_PREPARED');
  const rollback = readFileSync(join(OLD, 'hlApi.native-admin.candidate.zip'));
  check(sha(rollback) === BASE, 'BASELINE_HASH_MISMATCH');
  const oldManifest = json(join(OLD, 'manifest.json')), bundle = await buildNativeBundle();
  const changedInputs = assertInputScope(oldManifest.bundleInputs, bundle.inputs);
  const runtime = verifyNode16Bundle(bundle.bytes), before = readZip(rollback);
  const after = replaceManagementBundle(before, bundle.bytes), candidate = rootZip(after);
  check(JSON.stringify(inventory(readZip(candidate))) === JSON.stringify(inventory(after)), 'ZIP_ROUNDTRIP_FAILED');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'hlApi.rollback.zip'), rollback, { flag: 'wx' });
  writeFileSync(join(OUT, 'hlApi.performance.zip'), candidate, { flag: 'wx' });
  save('bundle-metafile.json', bundle.metafile); save('runtime-compatibility.json', runtime);
  const manifest = { target: TARGET, baselineSha256: BASE, candidateSha256: sha(candidate), bundleSha256: sha(bundle.bytes),
    fileCount: after.length, changedPackageFiles: ['native-admin.bundle.js'], changedInputs, bundleInputs: bundle.inputs,
    protectedOtherFiles: before.length - 1, environmentWrites: 0, runtime: 'Nodejs16.13' };
  save('manifest.json', manifest);
  return { status: 'prepared', candidateSha256: manifest.candidateSha256, changedInputs, runtimeTestsPassed: runtime.testCasesPassed };
}
async function snapshot(manager, expectedHash, expectedProtected) {
  const detail = await manager.functions.getFunctionDetail(TARGET.functionName), protectedState = protectedDigests(detail);
  check(detail.Status === 'Active' && detail.InstallDependency === 'FALSE', 'FUNCTION_NOT_ACTIVE');
  assertProtectedUnchanged(expectedProtected, protectedState);
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(address.CodeSha256 === expectedHash, 'LIVE_CODE_CHANGED');
  return { detail, protectedState, address };
}
async function verify(manager, manifest, protectedState) {
  const state = await snapshot(manager, manifest.candidateSha256, protectedState), url = new URL(state.address.Url);
  check(url.protocol === 'https:' && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'DOWNLOAD_TARGET_INVALID');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok, 'DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  check(sha(bytes) === manifest.candidateSha256 && JSON.stringify(inventory(readZip(bytes))) === JSON.stringify(inventory(validate().after)), 'DEPLOYED_PACKAGE_MISMATCH');
  await snapshot(manager, manifest.candidateSha256, protectedState);
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), target: TARGET, codeSha256: manifest.candidateSha256,
    changedFiles: ['native-admin.bundle.js'], filesVerified: manifest.fileCount, protectedOtherFiles: manifest.protectedOtherFiles,
    environmentUnchanged: true, otherConfigurationUnchanged: true, codeUpdateRequests: 1, environmentWrites: 0, businessMutations: 0 };
  save('deployment.json', report);
  return report;
}
async function deploy(mode) {
  const { manifest, candidate } = validate(), baseline = json(join(OUT, 'before.json'));
  check(baseline.status === 'passed' && baseline.codeSha256 === BASE, 'BASELINE_MEASUREMENT_REQUIRED');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') {
    const intent = json(join(OUT, 'deployment-intent.json'));
    check(intent.candidateSha256 === manifest.candidateSha256, 'INTENT_MISMATCH');
    return verify(manager, manifest, baseline.protectedDigests);
  }
  stage = 'preflight';
  const before = await snapshot(manager, BASE, baseline.protectedDigests);
  if (mode === 'inspect') return { status: 'preflight_passed', candidateSha256: manifest.candidateSha256, cloudWrites: 0 };
  check(!existsSync(join(OUT, 'deployment-intent.json')), 'DEPLOY_ALREADY_REQUESTED_VERIFY_FIRST');
  save('deployment-intent.json', { target: TARGET, baselineSha256: BASE, candidateSha256: manifest.candidateSha256,
    changedFiles: ['native-admin.bundle.js'], startedAt: new Date().toISOString(), environmentWrites: 0 });
  stage = 'temp-code-upload';
  const config = manager.functions.getFunctionConfig();
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', { ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip` });
  const plan = tempCosUploadPlan(config, authorization);
  const upload = await fetch(plan.url, { method: 'PUT', headers: plan.headers, body: candidate, redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(upload.ok, 'CODE_UPLOAD_FAILED');
  stage = 'pre-update-recheck';
  const current = await snapshot(manager, BASE, baseline.protectedDigests);
  check(current.detail.ModTime === before.detail.ModTime, 'CONCURRENT_CHANGE');
  validate();
  save('code-update-request.json', { requestedAt: new Date().toISOString(), codeUpdateRequests: 1, environmentWrites: 0 });
  stage = 'code-update';
  const result = await manager.functions.updateFunctionCode(repairCodeArguments(plan.key));
  check(!result.SCFErrorCode, 'CODE_UPDATE_REJECTED');
  for (let attempt = 0; attempt < 25; attempt++) {
    const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
    check(!/Failed|Error/i.test(detail.Status), 'DEPLOYMENT_FAILED');
    if (detail.Status === 'Active') {
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      if (address.CodeSha256 === manifest.candidateSha256) return verify(manager, manifest, baseline.protectedDigests);
    }
    await new Promise(done => setTimeout(done, 1500));
  }
  check(false, 'DEPLOYMENT_PENDING_VERIFY_DO_NOT_REPEAT');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    check(process.argv.length === 3 && ['prepare', 'inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
    console.log(JSON.stringify(await (mode === 'prepare' ? prepare() : deploy(mode))));
  } catch (error) { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'PERFORMANCE_DEPLOYMENT_FAILED',
    rawErrorWithheld: true, automaticRetry: false, environmentWrites: 0 })); process.exitCode = 1; }
}
