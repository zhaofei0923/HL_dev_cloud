import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { TARGET, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';
const OUT = 'output/paid-matchmaker-20261019/';
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const BASE = '14ae71ee77bc4e28920f43a9f3252875df57053b33d8551206e400b2d7c719f0';
const CHANGED = ['index.js', 'membership-payment-policy.js', 'purchase-contract-policy.js', 'vip-membership-service.js'];
const ADDED = ['matchmaker-activation-policy.js', 'matchmaker-activation-service.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const read = name => readFileSync(OUT + name);
const json = name => JSON.parse(read(name));
const save = (name, value) => writeFileSync(OUT + name, JSON.stringify(value, null, 2), { flag: 'wx' });
let stage = 'arguments';
function artifacts() {
  const manifest = json('paid-matchmaker-candidate.json'), baseline = json('cloud-baseline.json');
  const rollback = read('hlApi.rollback.zip'), candidate = read('hlApi.paid-matchmaker.zip'), patch = json('backend-patches.json');
  check(equal(manifest.target, TARGET) && baseline.codeSha256 === BASE && sha(rollback) === BASE
    && manifest.originalRemoteCodeSha256 === BASE && manifest.candidateZipSha256 === sha(candidate), 'PACKAGE_IDENTITY_CHANGED');
  const before = readZip(rollback), after = readZip(candidate);
  check(before.length === 4050 && after.length === 4052 && equal(inventory(before), baseline.files)
    && equal(inventory(before), manifest.beforeInventory) && equal(inventory(after), manifest.candidateInventory), 'PACKAGE_INVENTORY_CHANGED');
  check(equal(manifest.changedFiles, CHANGED) && equal(manifest.addedFiles, ADDED) && manifest.removedFiles.length === 0
    && patch.scopeOnly === true && equal(patch.files.map(file => file.name), CHANGED)
    && equal(patch.newFiles.map(file => file.name), ADDED) && sha(read('backend-patches.json')) === manifest.backendPatchesSha256,
  'PATCH_SCOPE_CHANGED');
  const expected = before.map(file => ({ ...file }));
  for (const file of patch.files) {
    const target = expected.find(row => row.name === file.name);
    let source = target.bytes.toString('utf8').replace(/\r\n/g, '\n');
    check(sha(readFileSync(file.source)) === file.localAfterSha256, 'LOCAL_SOURCE_CHANGED');
    for (const change of file.patches) {
      check(sha(change.before) === change.beforeSha256 && sha(change.after) === change.afterSha256
        && source.split(change.before).length === 2, 'EXACT_PATCH_CHANGED');
      source = source.replace(change.before, () => change.after);
    }
    new Script(source, { filename: file.name });
    target.bytes = Buffer.from(source);
  }
  for (const addition of patch.newFiles) {
    const addedBytes = readFileSync(addition.source);
    check(sha(addedBytes) === addition.sha256, 'NEW_MODULE_CHANGED');
    new Script(addedBytes.toString('utf8'), { filename: addition.name });
    expected.push({ name: addition.name, bytes: addedBytes, externalAttributes: addition.externalAttributes, madeBy: addition.madeBy });
  }
  check(equal(inventory(expected), inventory(after)), 'CANDIDATE_CONTENT_OUTSIDE_PATCH');
  assertProtectedUnchanged(baseline.protectedDigests, manifest.protectedDigests);
  const proof = json('candidate-test-proof.json');
  check(proof.candidateZipSha256 === sha(candidate) && proof.actualCandidateTestsPassed === true && proof.localFullCheckPassed === true,
    'TEST_PROOF_MISSING');
  const sourceInputs = [...manifest.localSourceInputs.map(file => file.source), 'scripts/deploy-paid-matchmaker.mjs',
    'tests/membership-payment-backend.test.js', 'tests/matchmaker-activation-service.test.js', 'tests/matchmaker-payment-core.test.js'];
  const locks = { manifestSha256: sha(read('paid-matchmaker-candidate.json')), candidateZipSha256: sha(candidate),
    patchesSha256: sha(read('backend-patches.json')), testProofSha256: sha(read('candidate-test-proof.json')),
    inputs: sourceInputs.map(path => ({ path, sha256: sha(readFileSync(path)) })) };
  return { manifest, baseline, before, after, candidate, locks };
}
async function snapshot(manager, a, deployed = false) {
  const expected = deployed ? a.manifest.candidateZipSha256 : BASE;
  const first = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(first.Status === 'Active' && (deployed || first.ModTime === a.baseline.modifiedAt), 'REMOTE_STATE_CHANGED');
  assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(first));
  const location = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  const url = new URL(location.Url);
  check(location.CodeSha256 === expected && url.protocol === 'https:' && !url.username && !url.password
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'REMOTE_CODE_CHANGED');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok, 'DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(zip.length < 60 * 1024 * 1024 && sha(zip) === expected && equal(inventory(readZip(zip)),
    deployed ? a.manifest.candidateInventory : a.manifest.beforeInventory), 'REMOTE_PACKAGE_CHANGED');
  const [last, code] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName), manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(last.Status === 'Active' && first.ModTime === last.ModTime && code.CodeSha256 === expected, 'CONCURRENT_UPDATE');
  assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(last));
  return { zip, modifiedAt: last.ModTime, codeSha256: expected };
}
async function verify(manager, a) {
  check(equal(json('deployment-intent.json').locks, a.locks) && equal(json('code-update-request.json').locks, a.locks), 'DEPLOYMENT_LOCK_CHANGED');
  stage = 'verify-full-package';
  const remote = await snapshot(manager, a, true);
  const result = await manager.functions.invokeFunction(TARGET.functionName, { method: 'GET', path: '/health', data: {} });
  const health = JSON.parse(result.RetMsg);
  check(health.code === 0 && health.data?.status === 'ok', 'HEALTH_UNCONFIRMED');
  check(equal(artifacts().locks, a.locks), 'INPUT_CHANGED_DURING_DEPLOYMENT');
  writeFileSync(OUT + 'hlApi.paid-matchmaker.downloaded.zip', remote.zip);
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), target: TARGET, locks: a.locks,
    baselineCodeSha256: BASE, deployedCodeSha256: remote.codeSha256, modifiedAt: remote.modifiedAt,
    fileCount: 4052, changedFiles: CHANGED, addedFiles: ADDED, unchangedFiles: 4046,
    fullFileContentsAndAttributesMatched: true, protectedDigests: a.baseline.protectedDigests,
    preservedApplePolicySha256: a.manifest.protectedFileDigests.find(row => row.name === 'virtual-payment-policy.js').sha256,
    environmentUnchanged: true, configurationUnchanged: true, dependencyInstallation: 'FALSE', codeUpdateRequests: 1,
    environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0, credentialsPersisted: false, health: { code: 0, status: 'ok' } };
  writeFileSync(OUT + 'deployment-verification.json', JSON.stringify(report, null, 2));
  return report;
}
try {
  const mode = process.argv[2];
  check(['inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
  const a = artifacts();
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') console.log(JSON.stringify(await verify(manager, a)));
  else {
    check(!existsSync(OUT + 'deployment-intent.json') && !existsSync(OUT + 'code-update-request.json'), 'ALREADY_STARTED_USE_VERIFY');
    stage = 'validate-current-baseline';
    await snapshot(manager, a);
    if (mode === 'inspect') console.log(JSON.stringify({ status: 'ready_not_deployed', candidateZipSha256: a.manifest.candidateZipSha256, cloudWrites: 0 }));
    else {
      save('deployment-intent.json', { startedAt: new Date().toISOString(), target: TARGET, locks: a.locks });
      stage = 'upload-exact-candidate';
      const config = manager.functions.getFunctionConfig();
      const authorization = await manager.functions.scfService.request('GetTempCosInfo', { ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip` });
      const upload = tempCosUploadPlan(config, authorization);
      const sent = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: a.candidate, redirect: 'error', signal: AbortSignal.timeout(45000) });
      check(sent.ok, 'TEMP_COS_UPLOAD_FAILED');
      await snapshot(manager, a);
      check(equal(artifacts().locks, a.locks), 'INPUT_CHANGED_BEFORE_UPDATE');
      save('code-update-request.json', { requestedAt: new Date().toISOString(), target: TARGET, locks: a.locks, codeUpdateRequests: 1, automaticRetry: false });
      stage = 'single-code-update';
      const updated = await manager.functions.updateFunctionCode(repairCodeArguments(upload.key));
      check(!updated.SCFErrorCode, 'UPDATE_REJECTED_NO_RETRY');
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
        assertProtectedUnchanged(a.baseline.protectedDigests, protectedDigests(detail));
        check(!/Failed|Error/i.test(detail.Status), 'UPDATE_FAILED_NO_RETRY');
        if (detail.Status === 'Active' && (await manager.functions.getFunctionDownloadUrl(TARGET.functionName)).CodeSha256 === a.manifest.candidateZipSha256) { ready = true; break; }
        await new Promise(done => setTimeout(done, 1500));
      }
      check(ready, 'UPDATE_PENDING_USE_VERIFY');
      console.log(JSON.stringify(await verify(manager, a)));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'unconfirmed', stage, code: error.safeCode || 'VERIFICATION_INCOMPLETE', rawErrorWithheld: true, automaticRetry: false }));
  process.exitCode = 1;
}
