import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { patchIndex as applyGuestBrowse } from './prepare-review-guest.mjs';

// This tool is deliberately offline: no manager, upload, invocation, or deploy
// operation is available. A historical archive is not a fresh cloud baseline.
const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
export const OUTPUT = join(ROOT, 'output/content-security-20261021/deployment-offline');
const HISTORICAL = join(ROOT, 'output/review-guest-20261020');
const BASELINE_SHA = '635527bfb92658a702db59277a068d0d435992b4e835b79ec8f9c830c74e34ba';
const NODE16 = join(ROOT, 'output/native-admin-20261015/runtime-qa/node-v16.13.0-win-x64/node.exe');
const NODE16_SHA = '7fca04f83b0e2169e41b2e1845e8da0f07d66cf9c3a1b4150767bf3ffddccf62';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeRelative = path => relative(ROOT, path).replace(/\\/g, '/');
function read(path) {
  check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'INPUT_FILE_UNSAFE_OR_MISSING');
  return readFileSync(path);
}
function text(bytes) {
  const source = bytes.toString('utf8');
  check(Buffer.from(source).equals(bytes), 'SOURCE_ENCODING_INVALID');
  check(!source.replace(/\r\n/g, '').includes('\r'), 'SOURCE_NEWLINE_INVALID');
  return source.replace(/\r\n/g, '\n');
}
function save(name, value) {
  const path = resolve(OUTPUT, name), inside = relative(OUTPUT, path);
  check(inside && !inside.startsWith('..') && !isAbsolute(inside), 'OUTPUT_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (existsSync(path)) check(read(path).equals(bytes), 'IMMUTABLE_OFFLINE_OUTPUT_CHANGED');
  else writeFileSync(path, bytes, { flag: 'wx' });
  return bytes;
}
const saveJson = (name, value) => save(name, JSON.stringify(value, null, 2) + '\n');

export function parseExactHunks(diff) {
  const lines = diff.replace(/\r\n/g, '\n').split('\n'), hunks = [];
  let at = 0;
  while (at < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]);
    if (!header) { at += 1; continue; }
    const oldLines = [], newLines = [], changes = [];
    at += 1;
    while (at < lines.length && !lines[at].startsWith('@@ ')) {
      const line = lines[at++];
      if (line === '' && at === lines.length) break;
      check([' ', '+', '-'].includes(line[0]), 'PATCH_BODY_INVALID');
      if (line[0] !== '+') oldLines.push(line.slice(1));
      if (line[0] !== '-') newLines.push(line.slice(1));
      if (line[0] !== ' ') changes.push(line);
    }
    check(oldLines.length === Number(header[2] ?? 1) && newLines.length === Number(header[4] ?? 1)
      && oldLines.length > 0 && newLines.length > 0 && changes.length > 0, 'PATCH_COUNTS_INVALID');
    hunks.push({ before: oldLines.join('\n') + '\n', after: newLines.join('\n') + '\n', changes });
  }
  check(hunks.length > 0, 'PATCH_EMPTY');
  return hunks;
}

export function applyExactHunks(source, hunks, reverse = false) {
  let result = source;
  for (const hunk of reverse ? [...hunks].reverse() : hunks) {
    const before = reverse ? hunk.after : hunk.before, after = reverse ? hunk.before : hunk.after;
    check(before && result.split(before).length === 2, 'PATCH_EXACT_CONTEXT_NOT_UNIQUE');
    result = result.replace(before, () => after);
  }
  return result;
}

function diffSources(name, before, after) {
  save(`${name}.before.js`, before); save(`${name}.after.js`, after);
  const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--',
    join(OUTPUT, `${name}.before.js`), join(OUTPUT, `${name}.after.js`)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  check(!result.error && result.status === 1 && result.stdout.includes('\n@@ '), 'SOURCE_DIFF_UNAVAILABLE');
  const diff = '--- a/index.js\n+++ b/index.js\n' + result.stdout.slice(result.stdout.indexOf('@@ '));
  save(`${name}.patch`, diff);
  return { diff, hunks: parseExactHunks(diff) };
}

export function patchConfig(original, local) {
  const before = JSON.parse(text(original)), intended = JSON.parse(text(local));
  check(Array.isArray(before.permissions?.openapi) && !before.permissions.openapi.includes('security.msgSecCheck'),
    'BASELINE_OPENAPI_PERMISSION_UNEXPECTED');
  const expected = { ...before, permissions: { ...before.permissions,
    openapi: [...before.permissions.openapi, 'security.msgSecCheck'] } };
  check(equal(expected, intended), 'LOCAL_CONFIG_CONTAINS_UNSCOPED_CHANGES');
  return Buffer.from(text(local).replace(/\n/g, original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'));
}

const NODE16_RUNNER = String.raw`'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),Module=require('module'),crypto=require('crypto');
const [root,candidateRoot,zip]=process.argv.slice(2), tests=[], originalLoad=Module._load;
if(process.version!=='v16.13.0')process.exit(2);
process.env.HL_API_TEST_PATH=path.join(candidateRoot,'index.js');
Module._load=function(name,parent,isMain){
  if(name==='node:test')return(name,run)=>tests.push({name,run});
  if(name==='../cloudfunctions/hlApi/content-security'&&parent&&parent.filename===path.join(root,'tests/content-security.test.js'))
    return originalLoad.call(this,path.join(candidateRoot,'content-security.js'),parent,isMain);
  return originalLoad.call(this,name,parent,isMain);
};
(async()=>{
  for(const source of ['index.js','content-security.js','public-browse.js'])new vm.Script(fs.readFileSync(path.join(candidateRoot,source),'utf8'),{filename:source});
  require(path.join(root,'tests/content-security.test.js'));
  require(path.join(root,'tests/public-browse.test.js'));
  for(const item of tests)await item.run();
  process.stdout.write(JSON.stringify({passed:true,runtime:process.version,testsPassed:tests.length,
    testedCandidateContentModule:true,testedCandidateIndexAndPublicReader:true,nodeTestRegistrationShimOnly:true,
    testPolyfills:[],cloudWrites:0,businessCalls:0,candidateZipSha256:crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}));
})().catch(()=>{process.stderr.write(JSON.stringify({passed:false,runtime:process.version,rawErrorWithheld:true}));process.exitCode=1;});
`;

const CURRENT_RUNNER = String.raw`'use strict';
const fs=require('fs'),path=require('path'),Module=require('module');
const candidateRoot=process.env.HL_CONTENT_CANDIDATE_ROOT;
if(!candidateRoot||!fs.existsSync(path.join(candidateRoot,'content-security.js')))throw new Error('CANDIDATE_ROOT_REQUIRED');
const original=Module._resolveFilename;
Module._resolveFilename=function(name,parent,...rest){
 if(name==='../cloudfunctions/hlApi/content-security'&&parent&&parent.filename===path.resolve('tests/content-security.test.js'))
  return original.call(this,path.join(candidateRoot,'content-security.js'),parent,...rest);
 return original.call(this,name,parent,...rest);
};
`;

function candidateQa(manifest) {
  const candidateRoot = join(OUTPUT, 'candidate-root/hlApi');
  save('candidate-module-hook.cjs', CURRENT_RUNNER);
  const current = spawnSync(process.execPath, ['--require', join(OUTPUT, 'candidate-module-hook.cjs'), '--test',
    'tests/content-security.test.js', 'tests/public-browse.test.js', 'tests/salon-registration.test.js',
    'tests/member-assignment-concurrency.test.js', 'tests/showcase-categories-backend.test.js'],
  { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, HL_API_TEST_PATH: join(candidateRoot, 'index.js'), HL_CONTENT_CANDIDATE_ROOT: candidateRoot } });
  save('candidate-current-node-tests.log', current.stdout + current.stderr);
  check(!current.error && current.status === 0, 'CURRENT_NODE_CANDIDATE_TESTS_FAILED');
  const passed = /(?:ℹ|#) pass (\d+)/.exec(current.stdout), failed = /(?:ℹ|#) fail (\d+)/.exec(current.stdout);
  check(passed && Number(passed[1]) >= 125 && failed && Number(failed[1]) === 0, 'CANDIDATE_TEST_SUMMARY_UNCONFIRMED');
  saveJson('candidate-current-node-proof.json', { passed: true, runtime: process.version, testsPassed: Number(passed[1]),
    testedActualCandidateIndexAndModules: true, cloudWrites: 0, businessCalls: 0,
    candidateZipSha256: manifest.candidateZipSha256, logSha256: sha(read(join(OUTPUT, 'candidate-current-node-tests.log'))) });
  check(sha(read(NODE16)) === NODE16_SHA, 'VERIFIED_NODE16_BINARY_REQUIRED');
  check(read(join(dirname(NODE16), 'SHASUMS256.txt')).toString('utf8').split(/\r?\n/)
    .includes(`${NODE16_SHA}  win-x64/node.exe`), 'NODE16_OFFICIAL_CHECKSUM_MISMATCH');
  save('node16-candidate-qa.cjs', NODE16_RUNNER);
  const legacy = spawnSync(NODE16, [join(OUTPUT, 'node16-candidate-qa.cjs'), ROOT, candidateRoot,
    join(OUTPUT, 'hlApi.content-security.candidate.zip')],
  { cwd: ROOT, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  let proof;
  try { proof = JSON.parse(legacy.stdout); } catch { check(false, 'NODE16_PROOF_UNAVAILABLE'); }
  check(!legacy.error && legacy.status === 0 && proof.passed && proof.testsPassed === 21
    && proof.candidateZipSha256 === manifest.candidateZipSha256, 'NODE16_CANDIDATE_TEST_FAILED');
  saveJson('candidate-node16-proof.json', { ...proof, runtimeBinarySha256: NODE16_SHA,
    runnerSha256: sha(Buffer.from(NODE16_RUNNER)) });
  return { currentNodeTestsPassed: Number(passed[1]), node16TestsPassed: proof.testsPassed };
}

export function validateOfflinePrepared() {
  const manifest = JSON.parse(read(join(OUTPUT, 'manifest.json')));
  check(manifest.currentLiveBaselineVerified === false && manifest.readyForDeployment === false
    && manifest.cloudWrites === 0 && manifest.configurationWrites === 0 && manifest.businessCalls === 0,
  'OFFLINE_STATUS_CHANGED');
  const baseline = read(join(OUTPUT, 'hlApi.historical.rollback.zip'));
  const candidate = read(join(OUTPUT, 'hlApi.content-security.candidate.zip'));
  check(sha(baseline) === BASELINE_SHA && sha(candidate) === manifest.candidateZipSha256, 'OFFLINE_ARCHIVE_CHANGED');
  const before = readZip(baseline), after = readZip(candidate);
  check(equal(inventory(before), manifest.beforeInventory) && equal(inventory(after), manifest.candidateInventory),
    'OFFLINE_FILE_INVENTORY_CHANGED');
  for (const input of manifest.sourceInputs) check(sha(read(join(ROOT, input.path))) === input.sha256, 'LOCAL_SOURCE_CHANGED');
  const hunks = parseExactHunks(read(join(OUTPUT, 'moderation-only.patch')).toString('utf8'));
  const previousIndex = before.find(file => file.name === 'index.js').bytes;
  const nextIndex = after.find(file => file.name === 'index.js').bytes;
  check(applyExactHunks(text(previousIndex), hunks) === text(nextIndex)
    && applyExactHunks(text(nextIndex), hunks, true) === text(previousIndex), 'PATCH_REVERSIBILITY_CHANGED');
  check(after.find(file => file.name === 'content-security.js').bytes.equals(read(join(ROOT, 'cloudfunctions/hlApi/content-security.js')))
    && after.find(file => file.name === 'config.json').bytes.equals(patchConfig(
      before.find(file => file.name === 'config.json').bytes, read(join(ROOT, 'cloudfunctions/hlApi/config.json')))),
  'CANDIDATE_INPUTS_CHANGED');
  for (const proofName of ['candidate-current-node-proof.json', 'candidate-node16-proof.json']) {
    const proof = JSON.parse(read(join(OUTPUT, proofName)));
    check(proof.passed === true && proof.candidateZipSha256 === manifest.candidateZipSha256, 'QA_PROOF_CHANGED');
  }
  return manifest;
}

export function prepareOffline() {
  check(!existsSync(join(OUTPUT, 'manifest.json')), 'OUTPUT_ALREADY_EXISTS_USE_VERIFY');
  const historicalProof = read(join(HISTORICAL, 'guest-deployment-verification.json'));
  const verified = JSON.parse(historicalProof);
  const baseline = read(join(HISTORICAL, 'hlApi.guest-browse.downloaded.zip'));
  check(verified.status === 'verified' && equal(verified.target, TARGET) && verified.deployedCodeSha256 === BASELINE_SHA
    && verified.environmentUnchanged === true && verified.configurationUnchanged === true
    && sha(baseline) === BASELINE_SHA, 'HISTORICAL_DEPLOYED_BASELINE_UNCONFIRMED');
  const before = readZip(baseline);
  check(before.length === 4053 && !before.some(file => file.name === 'content-security.js'), 'HISTORICAL_PACKAGE_UNEXPECTED');
  const index = before.find(file => file.name === 'index.js'), config = before.find(file => file.name === 'config.json');
  check(index && config, 'HISTORICAL_SOURCE_MISSING');
  const head = spawnSync('git', ['show', 'HEAD:cloudfunctions/hlApi/index.js'],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  check(!head.error && head.status === 0, 'LOCAL_GIT_BASELINE_UNAVAILABLE');
  const localBefore = text(applyGuestBrowse(head.stdout));
  const localAfter = text(read(join(ROOT, 'cloudfunctions/hlApi/index.js')));
  mkdirSync(OUTPUT, { recursive: true });
  const moderation = diffSources('moderation-only', localBefore, localAfter);
  const nextIndexText = applyExactHunks(text(index.bytes), moderation.hunks);
  const newline = index.bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const nextIndex = Buffer.from(nextIndexText.replace(/\n/g, newline));
  const reversed = Buffer.from(applyExactHunks(nextIndexText, moderation.hunks, true).replace(/\n/g, newline));
  check(reversed.equals(index.bytes), 'INDEX_REVERSE_PATCH_NOT_BYTE_IDENTICAL');
  new Script(nextIndexText, { filename: 'candidate/index.js' });
  const driftBefore = diffSources('preserved-admin-drift-before', localBefore, text(index.bytes));
  const driftAfter = diffSources('preserved-admin-drift-after', localAfter, nextIndexText);
  const driftChanges = patch => patch.hunks.flatMap(hunk => hunk.changes);
  check(driftBefore.hunks.length > 0 && driftAfter.hunks.length === driftBefore.hunks.length
    && equal(driftChanges(driftBefore), driftChanges(driftAfter)), 'LEGACY_ADMINISTRATION_DRIFT_CHANGED');
  const nextConfig = patchConfig(config.bytes, read(join(ROOT, 'cloudfunctions/hlApi/config.json')));
  const moduleBytes = read(join(ROOT, 'cloudfunctions/hlApi/content-security.js'));
  new Script(text(moduleBytes), { filename: 'candidate/content-security.js' });
  const after = before.map(file => ({ ...file, bytes: file.name === 'index.js' ? nextIndex
    : file.name === 'config.json' ? nextConfig : Buffer.from(file.bytes) }));
  after.push({ name: 'content-security.js', bytes: moduleBytes,
    madeBy: index.madeBy, externalAttributes: index.externalAttributes });
  const oldInventory = inventory(before), nextInventory = inventory(after);
  const changed = nextInventory.filter(file => oldInventory.find(old => old.name === file.name)?.sha256 !== file.sha256)
    .map(file => file.name).sort();
  check(equal(changed, ['config.json', 'content-security.js', 'index.js']) && after.length === before.length + 1,
    'CANDIDATE_SCOPE_CHANGED');
  for (const file of before) {
    const next = after.find(candidate => candidate.name === file.name);
    check(next && file.madeBy === next.madeBy && file.externalAttributes === next.externalAttributes
      && (['index.js', 'config.json'].includes(file.name) || file.bytes.equals(next.bytes)), 'PROTECTED_PACKAGE_FILE_CHANGED');
  }
  const candidate = rootZip(after);
  check(equal(inventory(readZip(candidate)), nextInventory), 'ZIP_ROUNDTRIP_CHANGED');
  save('hlApi.historical.rollback.zip', baseline);
  save('hlApi.content-security.candidate.zip', candidate);
  saveJson('patch-reverse-proof.json', { exactContextMatching: true, moderationHunks: moderation.hunks.length,
    originalIndexSha256: sha(index.bytes), reversePatchedIndexSha256: sha(reversed), reversePatchByteIdentical: true,
    preservedAdministrationDriftHunks: driftBefore.hunks.length, administrationRemovedAddedLinesIdentical: true,
    configChange: { onlyAppendedOpenapiPermission: 'security.msgSecCheck', otherFieldsUnchanged: true } });
  const symlinks = after.filter(file => ((file.externalAttributes >>> 16) & 0xf000) === 0xa000);
  // The ZIP is authoritative. Never turn Unix executable links into ordinary
  // files or a partially recreated Windows dependency tree and call it deployable.
  const topLevel = after.filter(file => !file.name.includes('/'));
  for (const file of topLevel) {
    check(((file.externalAttributes >>> 16) & 0xf000) !== 0xa000, 'ROOT_SOURCE_IS_SYMLINK');
    save(`candidate-root/hlApi/${file.name}`, file.bytes);
  }
  const inputNames = ['cloudfunctions/hlApi/index.js', 'cloudfunctions/hlApi/config.json',
    'cloudfunctions/hlApi/content-security.js', 'tests/content-security.test.js', 'tests/public-browse.test.js',
    'tests/salon-registration.test.js', 'tests/member-assignment-concurrency.test.js',
    'tests/showcase-categories-backend.test.js', 'scripts/prepare-content-security-deployment.mjs',
    'scripts/prepare-admin-entry-rebuild.mjs', 'scripts/prepare-review-guest.mjs'];
  const manifest = { status: 'offline_candidate_requires_fresh_live_baseline', preparedAt: new Date().toISOString(), target: TARGET,
    currentLiveBaselineVerified: false, readyForDeployment: false, historicalDeployedCodeSha256: BASELINE_SHA,
    historicalVerificationSha256: sha(historicalProof), candidateZipSha256: sha(candidate),
    changedFiles: ['config.json', 'index.js'], addedFiles: ['content-security.js'], removedFiles: [],
    sourceFileCount: before.length, candidateFileCount: after.length, unchangedFiles: before.length - 2,
    beforeInventory: oldInventory, candidateInventory: nextInventory, allOtherFileBytesAndAttributesPreserved: true,
    preservedAdministrationDriftHunks: driftBefore.hunks.length, exactPatchContexts: true, reversePatchByteIdentical: true,
    configChangeOnlyAppendedOpenapiPermission: 'security.msgSecCheck',
    authoritativeCandidateArchive: safeRelative(join(OUTPUT, 'hlApi.content-security.candidate.zip')),
    candidateDirectory: { path: safeRelative(join(OUTPUT, 'candidate-root/hlApi')), topLevelSourcesOnly: true,
      deployable: false, materializedFiles: topLevel.length, unixSymlinksPreservedInArchiveOnly: symlinks.map(file => file.name) },
    protectedDigestsFromHistoricalProofOnly: verified.protectedDigests,
    sourceInputs: inputNames.map(path => ({ path, sha256: sha(read(join(ROOT, path))) })),
    cloudWrites: 0, configurationWrites: 0, permissionWrites: 0, businessCalls: 0, rawCredentialsPersisted: false,
    requiredBeforeDeployment: ['Fresh live full-code download and matching baseline SHA256',
      'Fresh live configuration/environment digest comparison', 'WeChat OpenAPI permission registration',
      'Verified upload of full archive retaining dependencies and symbolic-link attributes',
      'Post-deployment package/configuration readback and real WeChat content-check validation'] };
  saveJson('manifest.json', manifest);
  const qa = candidateQa(manifest);
  validateOfflinePrepared();
  return { status: manifest.status, output: safeRelative(OUTPUT), currentLiveBaselineVerified: false,
    readyForDeployment: false, candidateZipSha256: manifest.candidateZipSha256, sourceFiles: before.length,
    candidateFiles: after.length, unchangedFiles: manifest.unchangedFiles, preservedUnixLinks: symlinks.length, ...qa,
    cloudWrites: 0, businessCalls: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    check(process.argv.length === 3 && ['prepare', 'verify'].includes(process.argv[2]), 'EXPLICIT_OFFLINE_MODE_REQUIRED');
    if (process.argv[2] === 'prepare') console.log(JSON.stringify(prepareOffline()));
    else {
      const manifest = validateOfflinePrepared();
      console.log(JSON.stringify({ status: 'offline_artifacts_verified_not_deployed', currentLiveBaselineVerified: false,
        readyForDeployment: false, candidateZipSha256: manifest.candidateZipSha256, cloudWrites: 0, businessCalls: 0 }));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'offline_preparation_unconfirmed', code: error.safeCode || 'OFFLINE_PREPARATION_FAILED',
      currentLiveBaselineVerified: false, readyForDeployment: false, rawErrorWithheld: true, cloudWrites: 0, businessCalls: 0 }));
    process.exitCode = 1;
  }
}
