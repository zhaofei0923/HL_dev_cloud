import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

// Deliberately no deploy/upload/configuration mode in this preparation tool.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'output/review-guest-20261020');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const NODE16 = join(ROOT, 'output/native-admin-20261015/runtime-qa/node-v16.13.0-win-x64/node.exe');
const NODE16_SHA = '7fca04f83b0e2169e41b2e1845e8da0f07d66cf9c3a1b4150767bf3ffddccf62';
// Reviewed explicitly on this task: preserve the cloud's eight existing legacy
// administration-read differences; never import those unrelated HEAD changes.
const REVIEWED_BASELINE = Object.freeze({ codeSha256: 'bf9692aee5d96dceb12e25bb62fa592bd06c533d3131bd68ac83314dc5d550f7',
  indexSha256: '6b42dda8fdb3ae93b0653d94de6b8db68c4bcaed9b0a31b721a1bea3def1e1e4',
  gitHeadIndexSha256: 'a01065b3d20b5b57d6c36695fb2e2bd78f46cf6d75911a36977d6a74d61add2b',
  comparisonSha256: '0bc6f140bf2a248e3054654b440f62852dbe057f7126664b9765a5a15200c278',
  sourceDiffSha256: 'ed28c8723dbb9c320a4e02aca71b7620065aa5e0261ad78d971701848e257d83' });
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const local = relative => join(ROOT, relative);
const output = name => join(OUTPUT, name);
const read = path => { check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'LOCAL_ARTIFACT_UNSAFE'); return readFileSync(path); };
const json = name => JSON.parse(read(output(name)).toString('utf8'));
const text = bytes => { const value = bytes.toString('utf8'); check(Buffer.from(value).equals(bytes), 'SOURCE_ENCODING_INVALID'); return value; };
const normalized = bytes => text(bytes).replace(/\r\n/g, '\n');
function saveBytes(name, bytes) {
  if (existsSync(output(name))) check(read(output(name)).equals(Buffer.from(bytes)), 'IMMUTABLE_ARTIFACT_CHANGED');
  else writeFileSync(output(name), bytes, { flag: 'wx' });
}
const save = (name, value) => saveBytes(name, JSON.stringify(value, null, 2) + '\n');
let stage = 'arguments';

function gitHead(path) {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  check(!result.error && result.status === 0, 'GIT_BASELINE_UNAVAILABLE');
  return result.stdout;
}

export function publicPatches() {
  return [
    { id: 'public-reader-import', before: "const { miniprogramAdminEntry } = require('./admin-entry-policy');",
      after: "const { miniprogramAdminEntry } = require('./admin-entry-policy');\nconst { createPublicBrowseService } = require('./public-browse');" },
    { id: 'public-reader-construction', before: 'const _ = db.command;',
      after: 'const _ = db.command;\nconst publicBrowse = createPublicBrowseService({ db, plans: DEFAULT_MEMBERSHIP_PLANS, env: process.env });' },
    { id: 'public-route-before-initialization', before: "    if (method === 'GET' && path === '/health') return ok({ status: 'ok' });",
      after: "    if (method === 'GET' && path === '/health') return ok({ status: 'ok' });\n\n    // Guests can browse published content without creating an account or\n    // initializing collections/seed data. All existing business routes below\n    // retain their original authentication and authorization requirements.\n    if (path === '/public' || path.startsWith('/public/')) {\n      return ok(await publicBrowse.handle(method, path, data));\n    }" },
    { id: 'public-error-redaction-after-native-admin',
      before: "      console.warn('native_admin_request_failed', { code: nativeCode, requestId });\n      return { code: nativeCode, message, requestId };\n    }",
      after: "      console.warn('native_admin_request_failed', { code: nativeCode, requestId });\n      return { code: nativeCode, message, requestId };\n    }\n    if (failedPath === '/public' || failedPath.startsWith('/public/')) {\n      const safeError = [40001, 40400, 40500, 50301].includes(err?.code)\n        ? err : createHttpError('公开内容暂时无法加载，请稍后重试', 503, 50301);\n      console.error('public browse request failed', safeError.code);\n      return fail(safeError);\n    }" }
  ].map(patch => ({ ...patch, beforeSha256: sha(patch.before), afterSha256: sha(patch.after) }));
}

export function patchIndex(bytes) {
  let source = text(bytes);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const patch of publicPatches()) {
    const before = patch.before.replace(/\n/g, newline), after = patch.after.replace(/\n/g, newline);
    check(source.split(before).length === 2, 'EXACT_PATCH_ANCHOR_CHANGED');
    source = source.replace(before, () => after);
  }
  new Script(source, { filename: 'index.js' });
  return Buffer.from(source);
}

function signedUrl(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'SIGNED_DOWNLOAD_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'SIGNED_DOWNLOAD_URL_INVALID');
  return url;
}

async function managerReadiness() {
  const mcp = new PaymentMcpClient(join(dirname(SDK), 'cli.cjs'), { envId: TARGET.envId, region: TARGET.region, cwd: ROOT });
  try {
    await mcp.ready;
    const schemas = await mcp.request('tools/list', {});
    const functions = schemas.tools?.find(tool => tool.name === 'queryFunctions');
    check(functions && functions.inputSchema, 'OFFICIAL_MCP_FUNCTION_SCHEMA_UNAVAILABLE');
    // Tool schemas contain no credentials. Retain only names, never tool output.
    save('official-mcp-schema-summary.json', { tool: functions.name,
      descriptionSha256: sha(functions.description || ''), inputSchemaSha256: sha(JSON.stringify(functions.inputSchema)) });
  } finally { mcp.close(); }
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  return getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
}

async function snapshot(manager) {
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  const digests = protectedDigests(before);
  check(before.Status === 'Active', 'REMOTE_FUNCTION_NOT_ACTIVE');
  check(digests.installDependency === 'FALSE', 'DEPENDENCY_INSTALL_NOT_DISABLED');
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(/^[a-f0-9]{64}$/.test(address.CodeSha256), 'REMOTE_CODE_DIGEST_UNCONFIRMED');
  const response = await fetch(signedUrl(address.Url), { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok && Number(response.headers.get('content-length')) < 60 * 1024 * 1024, 'REMOTE_DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(sha(zip) === address.CodeSha256, 'REMOTE_CODE_DIGEST_MISMATCH');
  const files = readZip(zip);
  const [after, location] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  assertProtectedUnchanged(digests, protectedDigests(after));
  check(after.Status === 'Active' && before.ModTime === after.ModTime && location.CodeSha256 === address.CodeSha256,
    'CONCURRENT_REMOTE_UPDATE');
  return { zip, files, summary: { target: TARGET, codeSha256: sha(zip), modifiedAt: after.ModTime,
    status: after.Status, runtime: after.Runtime, handler: after.Handler, type: after.Type,
    environmentVariableCount: after.Environment.Variables.length, protectedDigests: digests,
    files: inventory(files), cloudCodeWrites: 0, environmentWrites: 0, permissionWrites: 0, businessCalls: 0,
    signedUrlPersisted: false, rawEnvironmentPersisted: false } };
}

function baseline(remote) {
  saveBytes('hlApi.rollback.zip', remote.zip);
  save('cloud-baseline.json', remote.summary);
  const index = remote.files.find(file => file.name === 'index.js');
  check(index && !remote.files.some(file => file.name === 'public-browse.js'), 'REMOTE_ALREADY_CONTAINS_PUBLIC_READER');
  saveBytes('cloud-index.before.js', index.bytes);
  const head = gitHead('cloudfunctions/hlApi/index.js');
  saveBytes('git-head-index.before.js', head);
  const matchesHead = normalized(index.bytes) === normalized(head);
  save('baseline-parity.json', { normalizedCloudIndexMatchesGitHead: matchesHead,
    cloudIndexSha256: sha(index.bytes), gitHeadIndexSha256: sha(head),
    cloudIndexNormalizedSha256: sha(normalized(index.bytes)), gitHeadIndexNormalizedSha256: sha(normalized(head)) });
  if (!matchesHead) {
    check(remote.summary.codeSha256 === REVIEWED_BASELINE.codeSha256 && sha(index.bytes) === REVIEWED_BASELINE.indexSha256
      && sha(head) === REVIEWED_BASELINE.gitHeadIndexSha256
      && sha(read(output('baseline-comparison.json'))) === REVIEWED_BASELINE.comparisonSha256
      && sha(read(output('baseline-source-diff.patch'))) === REVIEWED_BASELINE.sourceDiffSha256,
    'UNREVIEWED_REMOTE_INDEX_DRIFT_STOP');
    const comparison = json('baseline-comparison.json');
    check(comparison.hunkCount === 8, 'REVIEWED_DRIFT_SCOPE_CHANGED');
    save('reviewed-preserved-baseline-drift.json', { reviewed: true, reviewedBaseline: REVIEWED_BASELINE,
      differenceHunks: 8, areas: ['listOrdersForAdmin', 'adminListParameters', 'dashboard', 'listMatchmakers', 'listSalons'],
      localAdministrationReadEnhancementsExcludedFromCandidate: true, currentCloudImplementationPreserved: true });
  }
  return index;
}

function verifyScope(before, after) {
  const old = inventory(before), next = inventory(after);
  const changed = next.filter(file => old.find(row => row.name === file.name)?.sha256 !== file.sha256).map(row => row.name).sort();
  check(equal(changed, ['index.js', 'public-browse.js']) && after.length === before.length + 1
    && before.every(file => after.some(row => row.name === file.name)), 'CANDIDATE_SCOPE_CHANGED');
  for (const file of before) {
    const preserved = after.find(row => row.name === file.name);
    check(file.externalAttributes === preserved.externalAttributes && file.madeBy === preserved.madeBy
      && (file.name === 'index.js' || file.bytes.equals(preserved.bytes)), 'PROTECTED_PACKAGE_FILE_CHANGED');
  }
  return { before: old, after: next };
}

function prepare(remote) {
  const original = baseline(remote);
  const updated = patchIndex(original.bytes);
  const localIndex = read(local('cloudfunctions/hlApi/index.js'));
  check(normalized(patchIndex(gitHead('cloudfunctions/hlApi/index.js'))) === normalized(localIndex), 'LOCAL_INDEX_CONTAINS_UNSCOPED_CHANGES');
  const publicBytes = read(local('cloudfunctions/hlApi/public-browse.js'));
  new Script(text(publicBytes), { filename: 'public-browse.js' });
  const candidateFiles = remote.files.map(file => ({ ...file, bytes: file.name === 'index.js' ? updated : Buffer.from(file.bytes) }));
  candidateFiles.push({ name: 'public-browse.js', bytes: publicBytes,
    externalAttributes: original.externalAttributes, madeBy: original.madeBy });
  const scope = verifyScope(remote.files, candidateFiles);
  const zip = rootZip(candidateFiles);
  check(equal(inventory(readZip(zip)), scope.after), 'CANDIDATE_ZIP_ROUNDTRIP_CHANGED');
  saveBytes('hlApi.guest-browse.zip', zip);
  save('backend-patches.json', { scopeOnly: true, source: 'cloudfunctions/hlApi/index.js', patches: publicPatches(),
    addedModule: { name: 'public-browse.js', sha256: sha(publicBytes) } });
  const candidateRoot = output('candidate-root');
  mkdirSync(candidateRoot, { recursive: true });
  for (const file of candidateFiles.filter(file => !file.name.includes('/'))) {
    const destination = join(candidateRoot, file.name);
    if (existsSync(destination)) check(read(destination).equals(file.bytes), 'CANDIDATE_ROOT_CHANGED');
    else writeFileSync(destination, file.bytes, { flag: 'wx' });
  }
  const manifest = { target: TARGET, originalRemoteCodeSha256: remote.summary.codeSha256, candidateZipSha256: sha(zip),
    rollbackZipSha256: sha(remote.zip), changedFiles: ['index.js'], addedFiles: ['public-browse.js'], removedFiles: [],
    sourceFileCount: remote.files.length, candidateFileCount: candidateFiles.length, unchangedFiles: remote.files.length - 1,
    beforeInventory: scope.before, candidateInventory: scope.after, protectedDigests: remote.summary.protectedDigests,
    protectedFileDigests: scope.after.filter(file => ['native-admin.bundle.js', 'package.json', 'package-lock.json',
      'membership-payment-policy.js', 'virtual-payment-policy.js', 'payment-merchant-config.json', 'vip-membership-service.js',
      'matchmaker-activation-policy.js', 'matchmaker-activation-service.js'].includes(file.name)),
    localSourceInputs: ['cloudfunctions/hlApi/index.js', 'cloudfunctions/hlApi/public-browse.js', 'tests/public-browse.test.js']
      .map(source => ({ source, sha256: sha(read(local(source))) })),
    backendPatchesSha256: sha(read(output('backend-patches.json'))), scriptSha256: sha(read(fileURLToPath(import.meta.url))),
    preservedBaselineDriftSha256: sha(read(output('reviewed-preserved-baseline-drift.json'))),
    allOtherBytesAndAttributesPreserved: true, cloudCodeWrites: 0, environmentWrites: 0, permissionWrites: 0, businessCalls: 0 };
  save('guest-browse-candidate.json', manifest);
  return manifest;
}

const NODE16_QA = String.raw`'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module'), crypto = require('crypto');
const [root, index, zip] = process.argv.slice(2), tests = [], originalLoad = Module._load;
if (process.version !== 'v16.13.0') process.exit(2);
process.env.HL_API_TEST_PATH = index;
Module._load = function(name, parent, isMain) {
  if (name === 'node:test') return (name, run) => tests.push({ name, run });
  return originalLoad.call(this, name, parent, isMain);
};
(async () => {
  for (const source of ['index.js', 'public-browse.js']) new vm.Script(fs.readFileSync(path.join(path.dirname(index), source), 'utf8'), { filename: source });
  require(path.join(root, 'tests/public-browse.test.js'));
  for (const item of tests) await item.run();
  process.stdout.write(JSON.stringify({ passed: true, runtime: process.version, testsPassed: tests.length,
    candidateZipSha256: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'),
    testedActualCandidateIndexAndModules: true, nodeTestRegistrationShimOnly: true,
    testPolyfills: [], cloudReads: 0, cloudCodeWrites: 0, environmentWrites: 0, businessCalls: 0 }));
})().catch(() => { process.stderr.write(JSON.stringify({ passed: false, runtime: process.version, rawErrorWithheld: true })); process.exitCode = 1; });
`;

function node16Proof(manifest) {
  check(sha(read(NODE16)) === NODE16_SHA, 'VERIFIED_NODE16_BINARY_REQUIRED');
  const checksums = read(join(dirname(NODE16), 'SHASUMS256.txt')).toString('utf8');
  check(checksums.split(/\r?\n/).some(line => line === `${NODE16_SHA}  win-x64/node.exe`), 'NODE16_OFFICIAL_CHECKSUM_MISMATCH');
  saveBytes('node16-candidate-qa.cjs', NODE16_QA);
  const result = spawnSync(NODE16, [output('node16-candidate-qa.cjs'), ROOT, output('candidate-root/index.js'), output('hlApi.guest-browse.zip')],
    { cwd: ROOT, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  let proof;
  try { proof = JSON.parse(result.stdout); } catch { check(false, 'NODE16_QA_FAILED_RAW_ERROR_WITHHELD'); }
  check(!result.error && result.status === 0 && proof.passed === true && proof.testsPassed === 10
    && proof.candidateZipSha256 === manifest.candidateZipSha256, 'NODE16_CANDIDATE_TEST_FAILED');
  save('candidate-node16-proof.json', { ...proof, runtimeBinarySha256: NODE16_SHA,
    runnerSha256: sha(Buffer.from(NODE16_QA)), testSourceSha256: sha(read(local('tests/public-browse.test.js'))) });
  return proof;
}

export function validatePrepared() {
  const manifest = json('guest-browse-candidate.json'), rollback = read(output('hlApi.rollback.zip')),
    candidate = read(output('hlApi.guest-browse.zip'));
  check(equal(manifest.target, TARGET) && sha(rollback) === manifest.originalRemoteCodeSha256
    && sha(candidate) === manifest.candidateZipSha256, 'IMMUTABLE_PACKAGE_CHANGED');
  const before = readZip(rollback), after = readZip(candidate);
  verifyScope(before, after);
  check(equal(inventory(before), manifest.beforeInventory) && equal(inventory(after), manifest.candidateInventory), 'PACKAGE_INVENTORY_CHANGED');
  const original = before.find(file => file.name === 'index.js'), updated = after.find(file => file.name === 'index.js');
  check(patchIndex(original.bytes).equals(updated.bytes)
    && read(local('cloudfunctions/hlApi/public-browse.js')).equals(after.find(file => file.name === 'public-browse.js').bytes), 'PACKAGE_PATCH_CHANGED');
  check(sha(read(fileURLToPath(import.meta.url))) === manifest.scriptSha256
    && sha(read(output('backend-patches.json'))) === manifest.backendPatchesSha256
    && sha(read(output('reviewed-preserved-baseline-drift.json'))) === manifest.preservedBaselineDriftSha256
    && manifest.localSourceInputs.every(file => sha(read(local(file.source))) === file.sha256), 'PREPARATION_INPUT_CHANGED');
  const proof = json('candidate-node16-proof.json');
  check(proof.passed === true && proof.runtime === 'v16.13.0' && proof.candidateZipSha256 === manifest.candidateZipSha256,
    'NODE16_PROOF_MISSING');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const mode = process.argv[2];
  check(['inspect', 'prepare', 'verify'].includes(mode), 'READ_ONLY_MODE_REQUIRED');
  mkdirSync(OUTPUT, { recursive: true });
  stage = 'official-mcp-schema-and-session';
  const manager = await managerReadiness();
  stage = 'read-current-remote-package-and-configuration-digests';
  const remote = await snapshot(manager);
  if (mode === 'verify') {
    const manifest = validatePrepared();
    assertProtectedUnchanged(manifest.protectedDigests, remote.summary.protectedDigests);
    check(remote.summary.codeSha256 === manifest.candidateZipSha256
      && equal(inventory(remote.files), manifest.candidateInventory), 'REMOTE_CANDIDATE_NOT_DEPLOYED_OR_CHANGED');
    console.log(JSON.stringify({ status: 'remote_candidate_verified', candidateZipSha256: manifest.candidateZipSha256,
      fullPackageAndProtectedConfigurationMatched: true, cloudWrites: 0, businessCalls: 0 }));
  } else if (mode === 'inspect') {
    stage = 'compare-remote-index-to-git-head';
    baseline(remote);
    console.log(JSON.stringify({ status: 'remote_baseline_verified_not_deployed', target: TARGET,
      sourceFileCount: remote.files.length, baselineCodeSha256: remote.summary.codeSha256,
      normalizedCloudIndexMatchesGitHead: json('baseline-parity.json').normalizedCloudIndexMatchesGitHead,
      existingAdministrationDifferencesReviewedAndPreserved: true, cloudWrites: 0, businessCalls: 0 }));
  } else {
    stage = 'construct-scoped-candidate';
    const manifest = prepare(remote);
    stage = 'actual-node16-candidate-tests';
    const proof = node16Proof(manifest);
    validatePrepared();
    console.log(JSON.stringify({ status: 'candidate_ready_not_deployed', target: TARGET,
      candidateZipSha256: manifest.candidateZipSha256, changedFiles: manifest.changedFiles, addedFiles: manifest.addedFiles,
      unchangedFiles: manifest.unchangedFiles, runtime: proof.runtime, candidateTestsPassed: proof.testsPassed,
      cloudWrites: 0, businessCalls: 0 }));
  }
} catch (err) {
  console.error(JSON.stringify({ status: 'unconfirmed_not_deployed', stage, code: err.safeCode || 'READ_ONLY_PREPARATION_FAILED',
    rawErrorWithheld: true, cloudCodeWrites: 0, environmentWrites: 0, permissionWrites: 0, businessCalls: 0 }));
  process.exitCode = 1;
}
