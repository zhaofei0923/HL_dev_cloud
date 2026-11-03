import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT, validatePrepared } from './prepare-review-guest.mjs';
import { TARGET, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const BASE = 'bf9692aee5d96dceb12e25bb62fa592bd06c533d3131bd68ac83314dc5d550f7';
const CANDIDATE = '635527bfb92658a702db59277a068d0d435992b4e835b79ec8f9c830c74e34ba';
const MANIFEST_SHA = '07aa015e628f282e99bc7e4216c13d1e03ef30addeb9ff92076597018d20000e';
const NODE16_PROOF_SHA = '352c37a655c7977088b5082379cb9fd92e85c10e34aac302962bf264138def3c';
const INTENT = 'guest-deployment-intent.json', REQUEST = 'guest-single-code-update-request.json';
const CHECK_PROOF = 'guest-full-check-proof.json', VERIFICATION = 'guest-deployment-verification.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const location = name => join(OUTPUT, name);
function read(path) {
  check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'ARTIFACT_UNSAFE_OR_MISSING');
  return readFileSync(path);
}
const artifact = name => read(location(name));
const json = name => JSON.parse(artifact(name).toString('utf8'));
const save = (name, value) => writeFileSync(location(name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function saveBytes(name, bytes) {
  if (existsSync(location(name))) check(artifact(name).equals(bytes), 'IMMUTABLE_READBACK_ALREADY_DIFFERS');
  else writeFileSync(location(name), bytes, { flag: 'wx' });
}
let stage = 'arguments';

function fullCheckEvidence() {
  const log = artifact('full-check-final.log');
  const text = log.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const lines = [...text.matchAll(new RegExp(`^[^\\S\\r\\n]*(?:[ℹ#][^\\S\\r\\n]*)?${name}[^\\S\\r\\n]+(\\d+)[^\\S\\r\\n]*$`, 'gm'))];
    check(lines.length === 1, 'FULL_CHECK_SUMMARY_UNCONFIRMED');
    counts[name] = Number(lines[0][1]);
  }
  check(counts.tests >= 1744 && counts.pass === counts.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(name => counts[name] === 0), 'FULL_CHECK_NOT_FULLY_PASSED');
  check(/Verified generated files: \d+ JavaScript, \d+ styles, \d+ workspace outputs and \d+ event bindings\./.test(text)
    && /Media resources: \d+ files, [\d.]+ KiB \/ < 200 KiB\./.test(text)
    && text.trimEnd().endsWith('Verified 7 CloudBase CMS views against hlApi.'), 'FULL_CHECK_COMPLETION_UNCONFIRMED');
  const manifest = validatePrepared();
  return { proofType: 'review-guest-full-local-check', command: 'npm run check',
    logPath: 'output/review-guest-20261020/full-check-final.log', logSha256: sha(log),
    summary: { tests: counts.tests, passed: counts.pass, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
    generatedFilesVerified: true, mediaBudgetVerified: true, finalAdminWorkflowCheckVerified: true,
    candidateZipSha256: manifest.candidateZipSha256, candidateNode16ProofSha256: NODE16_PROOF_SHA,
    backendSourceInputs: manifest.localSourceInputs, compilerAndSyntaxStagesReachedFinalCheck: true,
    cloudWrites: 0, businessCalls: 0 };
}

// This helper writes only the named local evidence file. It is not a CLI mode.
export function writeFullCheckProof({ refresh = false } = {}) {
  check(!existsSync(location(INTENT)) && !existsSync(location(REQUEST)), 'DEPLOYMENT_ALREADY_STARTED_PROOF_REFRESH_FORBIDDEN');
  const proof = fullCheckEvidence();
  if (existsSync(location(CHECK_PROOF))) {
    const original = artifact(CHECK_PROOF);
    if (!equal(JSON.parse(original.toString('utf8')), proof)) {
      check(refresh === true, 'FULL_CHECK_PROOF_CHANGED_EXPLICIT_REFRESH_REQUIRED');
      saveBytes(`guest-full-check-proof.${sha(original)}.superseded.json`, original);
      check(!existsSync(location(INTENT)) && !existsSync(location(REQUEST)), 'DEPLOYMENT_ALREADY_STARTED_PROOF_REFRESH_FORBIDDEN');
      writeFileSync(location(CHECK_PROOF), JSON.stringify(proof, null, 2) + '\n');
    }
  } else save(CHECK_PROOF, proof);
  return proof;
}

export function assertPackageScope(before, after, manifest) {
  check(before.length === 4052 && after.length === 4053 && manifest.unchangedFiles === 4051
    && equal(manifest.changedFiles, ['index.js']) && equal(manifest.addedFiles, ['public-browse.js'])
    && equal(manifest.removedFiles, []), 'PACKAGE_SCOPE_CHANGED');
  check(equal(inventory(before), manifest.beforeInventory) && equal(inventory(after), manifest.candidateInventory),
    'PACKAGE_INVENTORY_CHANGED');
  for (const file of before) {
    const row = after.find(candidate => candidate.name === file.name);
    check(row && file.externalAttributes === row.externalAttributes && file.madeBy === row.madeBy
      && (file.name === 'index.js' || file.bytes.equals(row.bytes)), 'PROTECTED_FILE_BYTES_OR_ATTRIBUTES_CHANGED');
  }
  const names = ['native-admin.bundle.js', 'package.json', 'package-lock.json', 'membership-payment-policy.js',
    'virtual-payment-policy.js', 'payment-merchant-config.json', 'vip-membership-service.js',
    'matchmaker-activation-policy.js', 'matchmaker-activation-service.js'];
  for (const name of names) {
    const original = before.find(row => row.name === name), preserved = after.find(row => row.name === name);
    const proof = manifest.protectedFileDigests.find(row => row.name === name);
    if (name === 'package-lock.json' && !original) {
      check(!preserved && !proof, 'PREVIOUSLY_ABSENT_PACKAGE_LOCK_ADDED');
      continue;
    }
    check(original && preserved && proof && original.bytes.equals(preserved.bytes)
      && proof.sha256 === sha(original.bytes) && proof.externalAttributes === preserved.externalAttributes
      && proof.madeBy === preserved.madeBy, 'NAMED_PROTECTED_FILE_LOCK_CHANGED');
  }
}

export function validateDeploymentArtifacts() {
  const manifest = validatePrepared(), baseline = json('cloud-baseline.json');
  const candidate = artifact('hlApi.guest-browse.zip'), rollback = artifact('hlApi.rollback.zip');
  check(equal(manifest.target, TARGET) && equal(baseline.target, TARGET)
    && manifest.originalRemoteCodeSha256 === BASE && baseline.codeSha256 === BASE
    && manifest.rollbackZipSha256 === BASE && sha(rollback) === BASE
    && manifest.candidateZipSha256 === CANDIDATE && sha(candidate) === CANDIDATE
    && sha(artifact('guest-browse-candidate.json')) === MANIFEST_SHA
    && sha(artifact('candidate-node16-proof.json')) === NODE16_PROOF_SHA, 'FIXED_RELEASE_IDENTITY_CHANGED');
  const before = readZip(rollback), after = readZip(candidate);
  assertPackageScope(before, after, manifest);
  check(equal(inventory(before), baseline.files), 'BASELINE_FILE_INVENTORY_CHANGED');
  assertProtectedUnchanged(baseline.protectedDigests, manifest.protectedDigests);
  check(equal(json(CHECK_PROOF), fullCheckEvidence()), 'FULL_CHECK_PROOF_MISSING_OR_CHANGED');
  const runtime = json('candidate-node16-proof.json');
  check(runtime.passed === true && runtime.runtime === 'v16.13.0' && runtime.testsPassed === 10
    && runtime.testedActualCandidateIndexAndModules === true && equal(runtime.testPolyfills, [])
    && runtime.candidateZipSha256 === CANDIDATE, 'ACTUAL_CANDIDATE_NODE16_PROOF_CHANGED');
  const lockedArtifacts = ['guest-browse-candidate.json', 'cloud-baseline.json', 'backend-patches.json',
    'reviewed-preserved-baseline-drift.json', 'candidate-node16-proof.json', CHECK_PROOF,
    'full-check-final.log', 'official-mcp-schema-summary.json'];
  const helperFiles = [SCRIPT, join(ROOT, 'scripts/prepare-review-guest.mjs'),
    join(ROOT, 'scripts/prepare-admin-entry-rebuild.mjs'), join(ROOT, 'scripts/deploy-admin-entry-compatibility.mjs'),
    join(ROOT, 'scripts/repair-admin-entry-compatibility.mjs'), SDK];
  const locks = { target: TARGET, baselineCodeSha256: BASE, candidateZipSha256: CANDIDATE,
    artifacts: lockedArtifacts.map(name => ({ name, sha256: sha(artifact(name)) })),
    sourceInputs: manifest.localSourceInputs,
    helperInputs: helperFiles.map(path => ({ path, sha256: sha(read(path)) })) };
  return { manifest, baseline, candidate, locks };
}

export function assertDeploymentRecord(artifacts, record) {
  check(record && equal(record.target, TARGET) && equal(record.locks, artifacts.locks)
    && record.baselineCodeSha256 === BASE && record.candidateZipSha256 === CANDIDATE,
  'DEPLOYMENT_RECORD_LOCK_MISMATCH');
}

function downloadURL(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'SIGNED_DOWNLOAD_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'SIGNED_DOWNLOAD_URL_INVALID');
  return url;
}

async function snapshot(manager, a, deployed = false) {
  const expected = deployed ? CANDIDATE : BASE, expectedInventory = deployed ? a.manifest.candidateInventory : a.manifest.beforeInventory;
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(before.Status === 'Active' && (deployed || before.ModTime === a.baseline.modifiedAt), 'REMOTE_STATE_CHANGED');
  assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(before));
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(address.CodeSha256 === expected, 'REMOTE_CODE_CHANGED');
  const response = await fetch(downloadURL(address.Url), { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok && Number(response.headers.get('content-length')) < 60 * 1024 * 1024, 'FULL_PACKAGE_DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(zip.length < 60 * 1024 * 1024 && sha(zip) === expected
    && equal(inventory(readZip(zip)), expectedInventory), 'REMOTE_PACKAGE_BYTES_OR_ATTRIBUTES_CHANGED');
  const [after, next] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(after.Status === 'Active' && after.ModTime === before.ModTime && next.CodeSha256 === expected, 'CONCURRENT_REMOTE_UPDATE');
  assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(after));
  return { zip, summary: { target: TARGET, codeSha256: expected, modifiedAt: after.ModTime,
    runtime: after.Runtime, handler: after.Handler, status: after.Status, fileCount: expectedInventory.length,
    fullPackageAndAttributesMatched: true, protectedDigests: protectedDigests(after) } };
}

async function verify(manager, a) {
  const intent = json(INTENT);
  assertDeploymentRecord(a, intent);
  if (!existsSync(location(REQUEST))) {
    const before = await snapshot(manager, a);
    return { status: 'baseline_unchanged_no_code_update_request_marked', target: TARGET,
      baselineCodeSha256: before.summary.codeSha256, automaticRetry: false,
      deploymentIntentExists: true, codeUpdateRequestMarked: false, cloudWrites: 0, businessCalls: 0 };
  }
  const request = json(REQUEST);
  assertDeploymentRecord(a, request);
  check(request.codeUpdateRequests === 1 && request.automaticRetry === false, 'SINGLE_REQUEST_MARKER_INVALID');
  stage = 'verify-full-candidate-package';
  const remote = await snapshot(manager, a, true);
  stage = 'verify-get-health';
  const result = await manager.functions.invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });
  let health;
  try { health = JSON.parse(result.RetMsg); } catch { check(false, 'HEALTH_RESPONSE_INVALID'); }
  check(health.code === 0 && health.data?.status === 'ok', 'HEALTH_UNCONFIRMED');
  const [after, next] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(after.Status === 'Active' && after.ModTime === remote.summary.modifiedAt && next.CodeSha256 === CANDIDATE,
    'CONCURRENT_POST_HEALTH_CHANGE');
  assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(after));
  check(equal(validateDeploymentArtifacts().locks, a.locks), 'LOCAL_INPUT_CHANGED_DURING_VERIFICATION');
  saveBytes('hlApi.guest-browse.downloaded.zip', remote.zip);
  const report = { status: 'verified', target: TARGET, locks: a.locks, baselineCodeSha256: BASE,
    deployedCodeSha256: CANDIDATE, snapshot: remote.summary, changedFiles: ['index.js'], addedFiles: ['public-browse.js'],
    unchangedFiles: 4051, allFileBytesAndAttributesMatched: true, protectedDigests: a.baseline.protectedDigests,
    environmentUnchanged: true, configurationUnchanged: true, dependencyInstallation: 'FALSE',
    transport: 'official_sdk_temp_cos', codeUpdateRequests: 1, automaticRetry: false,
    environmentWrites: 0, permissionWrites: 0, paymentCalls: 0, businessCalls: 0,
    signedUrlPersisted: false, credentialsPersisted: false, health: { code: 0, status: 'ok' } };
  if (existsSync(location(VERIFICATION))) check(equal(json(VERIFICATION), report), 'EXISTING_VERIFICATION_DIFFERS');
  else save(VERIFICATION, report);
  return report;
}

export async function main(mode) {
  check(['inspect', 'deploy', 'verify'].includes(mode), 'EXPLICIT_MODE_REQUIRED');
  stage = 'validate-locked-package-and-test-evidence';
  const a = validateDeploymentArtifacts();
  if (mode !== 'verify') check(!existsSync(location(INTENT)) && !existsSync(location(REQUEST)), 'ALREADY_STARTED_USE_VERIFY_NO_RESEND');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') return verify(manager, a);
  stage = 'verify-current-complete-baseline';
  const before = await snapshot(manager, a);
  check(equal(validateDeploymentArtifacts().locks, a.locks), 'LOCAL_INPUT_CHANGED_BEFORE_INTENT');
  if (mode === 'inspect') return { status: 'ready_not_deployed', target: TARGET, candidateZipSha256: CANDIDATE,
    baselineCodeSha256: BASE, filesBefore: 4052, filesAfter: 4053, protectedConfigurationMatched: true,
    localTestsPassed: json(CHECK_PROOF).summary.passed, actualNode16CandidateTestsPassed: 10, cloudWrites: 0, businessCalls: 0 };
  const record = { target: TARGET, locks: a.locks, baselineCodeSha256: BASE, candidateZipSha256: CANDIDATE,
    baselineModifiedAt: a.baseline.modifiedAt };
  save(INTENT, { ...record, startedAt: new Date().toISOString(), transport: 'official_sdk_temp_cos',
    environmentWrites: 0, permissionWrites: 0, paymentCalls: 0, businessCalls: 0 });
  saveBytes('hlApi.deployment-preflight.zip', before.zip);
  save('guest-deployment-preflight.json', before.summary);
  stage = 'official-temp-cos-authorization';
  const config = manager.functions.getFunctionConfig();
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', {
    ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip`
  });
  const upload = tempCosUploadPlan(config, authorization);
  stage = 'single-candidate-upload';
  const uploaded = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: a.candidate,
    redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(uploaded.ok, 'TEMP_COS_UPLOAD_FAILED_NO_AUTOMATIC_RETRY');
  stage = 'recheck-baseline-before-single-update';
  await snapshot(manager, a);
  check(equal(validateDeploymentArtifacts().locks, a.locks), 'LOCAL_INPUT_CHANGED_BEFORE_UPDATE');
  const args = repairCodeArguments(upload.key);
  check(equal(Object.keys(args.func).sort(), ['handler', 'installDependency', 'name'])
    && args.func.name === TARGET.functionName && args.func.handler === 'index.main' && args.func.installDependency === false,
  'CODE_ONLY_UPDATE_CONTRACT_CHANGED');
  save(REQUEST, { ...record, requestedAt: new Date().toISOString(), codeUpdateRequests: 1, automaticRetry: false,
    installDependency: false, environmentWrites: 0, permissionWrites: 0, paymentCalls: 0, businessCalls: 0 });
  stage = 'single-code-update-no-resend';
  const updated = await manager.functions.updateFunctionCode(args);
  check(!updated.SCFErrorCode, 'CODE_UPDATE_REJECTED_USE_VERIFY_NO_RESEND');
  stage = 'wait-active-candidate';
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(detail));
    check(!/Failed|Error/i.test(String(detail.Status)), 'UPDATE_FAILED_USE_VERIFY_NO_RESEND');
    if (detail.Status === 'Active') {
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      check([BASE, CANDIDATE].includes(address.CodeSha256), 'CONCURRENT_REMOTE_CODE_CHANGE');
      if (address.CodeSha256 === CANDIDATE) return verify(manager, a);
    }
    await new Promise(done => setTimeout(done, 1500));
  }
  check(false, 'UPDATE_PENDING_USE_VERIFY_NO_RESEND');
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    check(process.argv.length === 3, 'EXPLICIT_MODE_REQUIRED');
    console.log(JSON.stringify(await main(process.argv[2])));
  } catch (err) {
    console.error(JSON.stringify({ status: 'unconfirmed', stage, code: err.safeCode || 'GUEST_DEPLOYMENT_UNCONFIRMED',
      rawErrorWithheld: true, automaticRetry: false, codeUpdateRequestMarked: existsSync(location(REQUEST)),
      environmentWrites: 0, permissionWrites: 0, paymentCalls: 0, businessCalls: 0 }));
    process.exitCode = 1;
  }
}
