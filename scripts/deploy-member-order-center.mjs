import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
export const OUTPUT = join(ROOT, 'output/member-order-center-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const BASELINE_SHA256 = 'd573706e29cb1916a352a5b747be2bce151cb9c29d3c0e34d5a9d554cddad2fe';
const APPLE_POLICY_SHA256 = '86f766312145db8e870fe53b34e37ca444ff00d3485954f551532285ae40854b';
const FILE_COUNT = 4050;
const PATCH_IDS = ['memberOrders', 'memberOrdersRoute'];
const PATCH_FILE = 'backend-implementation/function-patches.json';
const MANIFEST_FILE = 'order-center-candidate.json';
const CANDIDATE_FILE = 'hlApi.order-center.zip';
const INTENT_FILE = 'order-center-deployment-intent.json';
const REQUEST_FILE = 'order-center-code-update-request.json';
const SCRIPT_INPUTS = ['deploy-member-order-center.mjs', 'prepare-admin-entry-rebuild.mjs',
  'deploy-admin-entry-compatibility.mjs', 'repair-admin-entry-compatibility.mjs',
  'cloudbase-payment-mcp-client.mjs'].map(name => `scripts/${name}`);
const FIXED_INPUTS = ['hlApi.rollback.zip', 'cloud-baseline.json', 'cloud-index.before.js', PATCH_FILE,
  'official-requirements.json', 'backend-implementation/cloud-query-readiness.json']
  .map(name => `output/member-order-center-20261019/${name}`);
const TEST_INPUTS = ['tests/member-orders-backend.test.js'];
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const location = name => join(OUTPUT, name);
let stage = 'arguments';

function readSafe(path) {
  check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'ARTIFACT_MISSING_OR_UNSAFE');
  return readFileSync(path);
}
const artifact = name => readSafe(location(name));
const json = name => JSON.parse(artifact(name).toString('utf8'));
function save(name, value) {
  writeFileSync(location(name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
function saveBytes(name, bytes) {
  if (existsSync(location(name))) check(sha(artifact(name)) === sha(bytes), 'EXISTING_ARTIFACT_DIFFERS');
  else writeFileSync(location(name), bytes, { flag: 'wx' });
}
function inputs() {
  return [...SCRIPT_INPUTS, ...FIXED_INPUTS, ...TEST_INPUTS].map(path => ({ path, sha256: sha(readSafe(join(ROOT, path))) }));
}

export function patchCloudIndex(bytes, document) {
  check(Buffer.isBuffer(bytes), 'CLOUD_INDEX_MISSING');
  let source = bytes.toString('utf8');
  check(Buffer.from(source).equals(bytes), 'CLOUD_INDEX_ENCODING_INVALID');
  check(document?.source === 'cloudfunctions/hlApi/index.js' && document.scopeOnly === true
    && Array.isArray(document.patches) && digest(document.patches.map(patch => patch.id)) === digest(PATCH_IDS),
  'FUNCTION_PATCH_SCOPE_INVALID');
  for (const patch of document.patches) {
    check(typeof patch.before === 'string' && patch.before.length > 0 && typeof patch.after === 'string'
      && patch.after.length > 0 && sha(patch.before) === patch.beforeSha256 && sha(patch.after) === patch.afterSha256,
    'FUNCTION_PATCH_DIGEST_INVALID');
    const anchors = {
      memberOrders: 'function unresolvedPaymentOrder(order) {',
      memberOrdersRoute: "    if (method === 'GET' && path === '/health') return ok({ status: 'ok' });"
    };
    check(patch.before === anchors[patch.id] && source.split(patch.before).length === 2
      && patch.after.split(patch.before).length === 2 && patch.before !== patch.after
      && (patch.id === 'memberOrders' ? patch.after.endsWith(patch.before) : patch.after.startsWith(patch.before)),
    'FUNCTION_PATCH_ANCHOR_INVALID');
    source = source.replace(patch.before, () => patch.after);
  }
  try { new Script(source, { filename: 'index.js' }); } catch { check(false, 'CANDIDATE_SYNTAX_INVALID'); }
  return Buffer.from(source);
}

export function packageScope(beforeFiles, afterFiles) {
  const before = inventory(beforeFiles), after = inventory(afterFiles);
  check(before.length === after.length && before.every((file, index) => file.name === after[index].name), 'PACKAGE_FILE_LIST_CHANGED');
  const changed = after.filter((file, index) => digest(file) !== digest(before[index])).map(file => file.name);
  check(digest(changed) === digest(['index.js']), 'PACKAGE_CHANGED_OUTSIDE_INDEX');
  const previous = before.find(file => file.name === 'index.js'), current = after.find(file => file.name === 'index.js');
  check(previous.externalAttributes === current.externalAttributes && previous.madeBy === current.madeBy,
    'INDEX_FILE_ATTRIBUTES_CHANGED');
  return { beforeInventory: before, candidateInventory: after, changedFiles: changed, unchangedFiles: before.length - 1 };
}

function baselineInputs() {
  const baseline = json('cloud-baseline.json'), rollback = artifact('hlApi.rollback.zip'), files = readZip(rollback);
  check(digest(baseline.target) === digest(TARGET) && baseline.status === 'Active' && baseline.runtime === 'Nodejs16.13'
    && baseline.handler === 'index.main' && baseline.codeSha256 === BASELINE_SHA256
    && baseline.modifiedAt === '2026-10-19 16:41:08'
    && baseline.protectedDigests?.installDependency === 'FALSE'
    && baseline.protectedDigests.environmentSha256 === '4ad560c034ef8d50b4632cc3091c1e8cf35e4405290247ec17bc1d9ef906faf3'
    && baseline.protectedDigests.configurationSha256 === 'd65d4a4946ffdbcec6891ffd19f2639d88eef833c4ffdd5b12b00dc04912b12b', 'BASELINE_TARGET_INVALID');
  check(sha(rollback) === BASELINE_SHA256 && files.length === FILE_COUNT
    && digest(inventory(files)) === digest(baseline.files), 'BASELINE_PACKAGE_MISMATCH');
  const index = files.find(file => file.name === 'index.js');
  check(index && index.bytes.equals(artifact('cloud-index.before.js')), 'BASELINE_INDEX_MISMATCH');
  check(sha(files.find(file => file.name === 'virtual-payment-policy.js')?.bytes || '') === APPLE_POLICY_SHA256,
    'APPLE_POLICY_BASELINE_CHANGED');
  return { baseline, rollback, files, patchDocument: json(PATCH_FILE) };
}

export function validateCandidate() {
  const manifest = json(MANIFEST_FILE), original = baselineInputs(), candidate = artifact(CANDIDATE_FILE);
  check(digest(manifest.target) === digest(TARGET) && digest(manifest.inputs) === digest(inputs()), 'PREPARED_INPUT_LOCK_CHANGED');
  check(manifest.baselineCodeSha256 === BASELINE_SHA256 && manifest.candidateZipSha256 === sha(candidate)
    && manifest.fileCount === FILE_COUNT && manifest.preservedApplePolicySha256 === APPLE_POLICY_SHA256,
  'CANDIDATE_MANIFEST_MISMATCH');
  const files = readZip(candidate), patchedIndex = patchCloudIndex(original.files.find(file => file.name === 'index.js').bytes,
    original.patchDocument);
  const expected = original.files.map(file => ({ ...file, bytes: file.name === 'index.js' ? patchedIndex : file.bytes }));
  const scope = packageScope(original.files, files);
  check(digest(inventory(expected)) === digest(inventory(files)) && digest(scope) === digest(manifest.scope)
    && sha(patchedIndex) === manifest.candidateIndexSha256
    && patchedIndex.equals(artifact('cloud-index.candidate.js'))
    && digest(manifest.protectedDigests) === digest(original.baseline.protectedDigests), 'CANDIDATE_FILE_PROOF_MISMATCH');
  for (const file of files.filter(file => !file.name.includes('/'))) {
    check(file.bytes.equals(artifact(`candidate-root/${file.name}`)), 'CANDIDATE_ROOT_SOURCE_CHANGED');
  }
  return { ...original, manifest, candidate, files, locks: {
    manifestSha256: sha(artifact(MANIFEST_FILE)), candidateZipSha256: sha(candidate), inputsSha256: digest(inputs())
  } };
}

export function prepare() {
  stage = 'prepare-local-baseline';
  mkdirSync(OUTPUT, { recursive: true });
  check(!existsSync(location(INTENT_FILE)) && !existsSync(location(REQUEST_FILE)), 'DEPLOYMENT_STARTED_USE_VERIFY');
  if (!existsSync(location(MANIFEST_FILE))) {
    const { baseline, files, patchDocument } = baselineInputs();
    const patchedIndex = patchCloudIndex(files.find(file => file.name === 'index.js').bytes, patchDocument);
    const patchedFiles = files.map(file => ({ ...file, bytes: file.name === 'index.js' ? patchedIndex : file.bytes }));
    const candidate = rootZip(patchedFiles), after = readZip(candidate), scope = packageScope(files, after);
    check(digest(inventory(patchedFiles)) === digest(inventory(after)), 'CANDIDATE_ZIP_ROUNDTRIP_FAILED');
    saveBytes(CANDIDATE_FILE, candidate);
    saveBytes('cloud-index.candidate.js', patchedIndex);
    mkdirSync(location('candidate-root'), { recursive: true });
    for (const file of after.filter(file => !file.name.includes('/'))) saveBytes(`candidate-root/${file.name}`, file.bytes);
    save(MANIFEST_FILE, { status: 'prepared_not_deployed', preparedAt: new Date().toISOString(), target: TARGET,
      baselineCodeSha256: BASELINE_SHA256, baselineModifiedAt: baseline.modifiedAt,
      candidateZipSha256: sha(candidate), candidateIndexSha256: sha(patchedIndex), fileCount: files.length,
      preservedApplePolicySha256: APPLE_POLICY_SHA256, protectedDigests: baseline.protectedDigests,
      inputs: inputs(), scope, cloudWrites: 0, paymentCalls: 0, credentialsPersisted: false });
  }
  const { manifest, locks } = validateCandidate();
  return { status: 'prepared_not_deployed', target: TARGET, fileCount: manifest.fileCount,
    changedFiles: manifest.scope.changedFiles, unchangedFiles: manifest.scope.unchangedFiles,
    baselineCodeSha256: BASELINE_SHA256, candidateZipSha256: manifest.candidateZipSha256,
    candidateIndexSha256: manifest.candidateIndexSha256, locks, cloudWrites: 0, paymentCalls: 0, credentialsPersisted: false };
}

function downloadURL(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'DOWNLOAD_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'DOWNLOAD_URL_INVALID');
  return url;
}
async function snapshot(manager, artifacts, deployed = false) {
  const expectedHash = deployed ? artifacts.manifest.candidateZipSha256 : BASELINE_SHA256;
  const expectedInventory = deployed ? artifacts.manifest.scope.candidateInventory : artifacts.baseline.files;
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(before.Status === 'Active', 'FUNCTION_NOT_ACTIVE');
  assertProtectedUnchanged(artifacts.manifest.protectedDigests, protectedDigests(before));
  if (!deployed) check(before.ModTime === artifacts.baseline.modifiedAt, 'BASELINE_MODIFICATION_TIME_CHANGED');
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(address.CodeSha256 === expectedHash, 'REMOTE_CODE_CHANGED');
  const response = await fetch(downloadURL(address.Url), { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'CODE_DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(zip.length <= 60 * 1024 * 1024 && sha(zip) === expectedHash, 'REMOTE_PACKAGE_HASH_CHANGED');
  const files = readZip(zip);
  check(digest(inventory(files)) === digest(expectedInventory), 'REMOTE_PACKAGE_CONTENT_CHANGED');
  const [after, next] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(after.Status === 'Active' && after.ModTime === before.ModTime && next.CodeSha256 === expectedHash, 'CONCURRENT_REMOTE_CHANGE');
  assertProtectedUnchanged(artifacts.manifest.protectedDigests, protectedDigests(after));
  return { zip, files, codeSha256: expectedHash, modifiedAt: after.ModTime };
}

export function assertLocks(artifacts, record) {
  check(record && typeof record === 'object' && record.target && record.locks
    && digest(record.target) === digest(TARGET) && digest(record.locks) === digest(artifacts.locks)
    && record.baselineCodeSha256 === BASELINE_SHA256
    && record.candidateZipSha256 === artifacts.manifest.candidateZipSha256, 'DEPLOYMENT_LOCK_MISMATCH');
}
async function verify(manager, artifacts) {
  const intent = json(INTENT_FILE), request = json(REQUEST_FILE);
  assertLocks(artifacts, intent);
  assertLocks(artifacts, request);
  check(request.codeUpdateRequests === 1 && request.automaticRetry === false, 'SINGLE_UPDATE_EVIDENCE_MISSING');
  stage = 'verify-full-package';
  const code = await snapshot(manager, artifacts, true);
  stage = 'verify-get-health';
  const response = await manager.functions.invokeFunction(TARGET.functionName, { path: '/health', method: 'GET', data: {} });
  let health;
  try { health = JSON.parse(response.RetMsg); } catch { check(false, 'HEALTH_RESPONSE_INVALID'); }
  check(health.code === 0 && health.data?.status === 'ok', 'HEALTH_NOT_VERIFIED');
  const [final, address] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(final.Status === 'Active' && final.ModTime === code.modifiedAt && address.CodeSha256 === code.codeSha256, 'CONCURRENT_HEALTH_CHANGE');
  assertProtectedUnchanged(artifacts.manifest.protectedDigests, protectedDigests(final));
  check(digest(validateCandidate().locks) === digest(artifacts.locks), 'INPUT_CHANGED_DURING_VERIFICATION');
  saveBytes('hlApi.order-center.downloaded.zip', code.zip);
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), target: TARGET, locks: artifacts.locks,
    baselineCodeSha256: BASELINE_SHA256, deployedCodeSha256: code.codeSha256, modifiedAt: code.modifiedAt,
    fileCount: code.files.length, changedFiles: artifacts.manifest.scope.changedFiles, unchangedFiles: FILE_COUNT - 1,
    fullFileContentsAndAttributesMatched: true, preservedApplePolicySha256: APPLE_POLICY_SHA256,
    protectedDigests: artifacts.manifest.protectedDigests, environmentUnchanged: true, configurationUnchanged: true,
    dependencyInstallation: 'FALSE', transport: 'official_sdk_temp_cos', codeUpdateRequests: 1,
    environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0, credentialsPersisted: false, health: { code: 0, status: 'ok' } };
  if (existsSync(location('order-center-verification.json'))) {
    const previous = json('order-center-verification.json');
    check(previous.deployedCodeSha256 === code.codeSha256 && digest(previous.locks) === digest(artifacts.locks), 'EXISTING_VERIFICATION_DIFFERS');
  } else save('order-center-verification.json', report);
  return report;
}

export async function main(mode) {
  check(['prepare', 'inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
  if (mode === 'prepare') return prepare();
  stage = 'validate-locked-artifacts';
  const artifacts = validateCandidate();
  if (mode === 'deploy') check(!existsSync(location(INTENT_FILE)) && !existsSync(location(REQUEST_FILE)), 'ALREADY_REQUESTED_USE_VERIFY_DO_NOT_REPEAT');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') return verify(manager, artifacts);
  stage = 'recheck-active-baseline';
  await snapshot(manager, artifacts);
  check(digest(validateCandidate().locks) === digest(artifacts.locks), 'INPUT_CHANGED_BEFORE_INTENT');
  if (mode === 'inspect') return { status: 'baseline_verified_not_deployed', target: TARGET,
    baselineCodeSha256: BASELINE_SHA256, candidateZipSha256: artifacts.manifest.candidateZipSha256,
    fileCount: FILE_COUNT, unchangedFiles: FILE_COUNT - 1, changedFiles: ['index.js'],
    originalCodeAndConfigurationMatched: true, locks: artifacts.locks, cloudWrites: 0, paymentCalls: 0 };
  const record = { target: TARGET, locks: artifacts.locks, baselineCodeSha256: BASELINE_SHA256,
    candidateZipSha256: artifacts.manifest.candidateZipSha256, baselineModifiedAt: artifacts.baseline.modifiedAt };
  save(INTENT_FILE, { ...record, status: 'deployment_started', startedAt: new Date().toISOString(),
    transport: 'official_sdk_temp_cos', environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0 });
  stage = 'native-temp-cos-authorization';
  const config = manager.functions.getFunctionConfig();
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', {
    ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip`
  });
  const upload = tempCosUploadPlan(config, authorization);
  stage = 'upload-exact-candidate';
  const uploaded = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: artifacts.candidate,
    redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(uploaded.ok, 'TEMP_COS_UPLOAD_FAILED');
  stage = 'recheck-before-single-update';
  await snapshot(manager, artifacts);
  check(digest(validateCandidate().locks) === digest(artifacts.locks), 'INPUT_CHANGED_BEFORE_UPDATE');
  save(REQUEST_FILE, { ...record, requestedAt: new Date().toISOString(), codeUpdateRequests: 1,
    automaticRetry: false, environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0 });
  stage = 'single-code-update';
  const result = await manager.functions.updateFunctionCode(repairCodeArguments(upload.key));
  check(!result.SCFErrorCode, 'UPDATE_REQUEST_REJECTED_NO_AUTOMATIC_RETRY');
  stage = 'wait-active-candidate';
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(artifacts.manifest.protectedDigests, protectedDigests(detail));
    check(!/Failed|Error/i.test(String(detail.Status)), 'UPDATE_FAILED_NO_AUTOMATIC_RETRY');
    if (detail.Status === 'Active') {
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      if (address.CodeSha256 === artifacts.manifest.candidateZipSha256) return verify(manager, artifacts);
    }
    await new Promise(done => setTimeout(done, 1500));
  }
  check(false, 'UPDATE_PENDING_USE_VERIFY_DO_NOT_REPEAT');
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    check(process.argv.length === 3, 'MODE_REQUIRED');
    console.log(JSON.stringify(await main(process.argv[2])));
  } catch (error) {
    console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'ORDER_CENTER_DEPLOYMENT_UNCONFIRMED',
      rawErrorWithheld: true, automaticRetry: false, environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0 }));
    process.exitCode = 1;
  }
}
