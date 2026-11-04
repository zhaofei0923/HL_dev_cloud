import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '..');
const OUTPUT = join(ROOT, 'output/ifu-optimization-20261103');
const BASELINE = '850922890af481317c1ec5a473518a596408e4d0cbd97df4a8e64cc6e3ed027d';
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const CHANGED = ['index.js', 'relationship-policy.js'];
const ADDED = ['matching-preferences-policy.js', 'member-location-policy.js', 'member-relationship-service.js'];
const sha = b => createHash('sha256').update(b).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { safeCode: code }); };
const location = name => join(OUTPUT, name);
const bytes = name => readFileSync(location(name));
const json = name => JSON.parse(bytes(name));
const save = (name, value) => writeFileSync(location(name), JSON.stringify(value, null, 2)+'\n', { flag:'wx' });
let stage = 'arguments';

function inputLocks() {
  const paths = ['scripts/deploy-ifu-optimization.mjs', 'scripts/prepare-admin-entry-rebuild.mjs',
    'scripts/deploy-admin-entry-compatibility.mjs', 'scripts/repair-admin-entry-compatibility.mjs',
    ...[...CHANGED, ...ADDED].map(name => `cloudfunctions/hlApi/${name}`),
    'output/ifu-optimization-20261103/cloud-index.candidate.js',
    'output/ifu-optimization-20261103/cloud-index.scope-report.json'];
  return paths.map(path => ({ path, sha256:sha(readFileSync(join(ROOT, path))) }));
}

function plannedFiles(original) {
  const result = original.map(file => ({ ...file, bytes: CHANGED.includes(file.name)
    ? file.name === 'index.js' ? bytes('cloud-index.candidate.js') : readFileSync(join(ROOT,'cloudfunctions/hlApi',file.name)) : file.bytes }));
  const template = original.find(file => file.name === 'index.js');
  for (const name of ADDED) {
    check(!original.some(file=>file.name===name), 'ADDED_FILE_ALREADY_EXISTS');
    result.push({ ...template, name, bytes:readFileSync(join(ROOT,'cloudfunctions/hlApi',name)) });
  }
  return result;
}

export function validate() {
  const baseline=json('cloud-baseline.json'), original=readZip(bytes('hlApi.rollback.zip'));
  check(equal(baseline.target,TARGET) && baseline.codeSha256===BASELINE
    && sha(bytes('hlApi.rollback.zip'))===BASELINE && baseline.status==='Active'
    && equal(inventory(original),baseline.files), 'BASELINE_PROOF_INVALID');
  const manifest=json('candidate-manifest.json'), candidate=bytes('hlApi.candidate.zip'), files=readZip(candidate);
  check(equal(manifest.target,TARGET) && manifest.baselineCodeSha256===BASELINE
    && equal(manifest.inputLocks,inputLocks()) && manifest.candidateZipSha256===sha(candidate)
    && equal(inventory(files),manifest.candidateInventory) && equal(inventory(files),inventory(plannedFiles(original))),
  'CANDIDATE_LOCK_CHANGED');
  check(equal(manifest.changedFiles,CHANGED) && equal(manifest.addedFiles,ADDED) && files.length===original.length+ADDED.length,
    'PACKAGE_SCOPE_INVALID');
  for (const file of original) {
    const after=files.find(next=>next.name===file.name);
    check(after && file.externalAttributes===after.externalAttributes && file.madeBy===after.madeBy
      && (CHANGED.includes(file.name)||file.bytes.equals(after.bytes)), 'PROTECTED_PACKAGE_FILE_CHANGED');
  }
  for (const file of files.filter(file=>!file.name.includes('/'))) {
    check(file.bytes.equals(bytes(`candidate-root/${file.name}`)), 'CANDIDATE_RUNTIME_SOURCE_CHANGED');
  }
  return { baseline, original, manifest, candidate, files };
}

export function prepare() {
  check(!existsSync(location('deployment-intent.json')), 'DEPLOYMENT_STARTED_USE_VERIFY');
  const baseline=json('cloud-baseline.json'), rollback=bytes('hlApi.rollback.zip'), original=readZip(rollback);
  check(baseline.codeSha256===BASELINE && sha(rollback)===BASELINE && equal(inventory(original),baseline.files), 'BASELINE_PROOF_INVALID');
  const files=plannedFiles(original), candidate=rootZip(files);
  check(equal(inventory(readZip(candidate)),inventory(files)), 'ZIP_ROUNDTRIP_MISMATCH');
  for (const file of files.filter(file=>!file.name.includes('/') && file.name.endsWith('.js'))) new Script(file.bytes.toString('utf8'),{filename:file.name});
  const rootFiles=files.filter(file=>!file.name.includes('/'));
  for (const file of rootFiles.filter(file=>file.name.endsWith('.js') && file.name!=='native-admin.bundle.js')) {
    for (const match of file.bytes.toString('utf8').matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
      check(rootFiles.some(next=>[match[1],`${match[1]}.js`,`${match[1]}.json`].includes(next.name)), 'LOCAL_MODULE_MISSING');
    }
  }
  if (!existsSync(location('candidate-manifest.json'))) {
    writeFileSync(location('hlApi.candidate.zip'),candidate,{flag:'wx'});
    mkdirSync(location('candidate-root'),{recursive:true});
    for (const file of rootFiles) writeFileSync(location(`candidate-root/${file.name}`),file.bytes,{flag:'wx'});
    save('candidate-manifest.json',{status:'prepared_not_deployed',preparedAt:new Date().toISOString(),target:TARGET,
      baselineCodeSha256:BASELINE,candidateZipSha256:sha(candidate),fileCount:files.length,changedFiles:CHANGED,addedFiles:ADDED,
      removedFiles:[],unchangedFiles:original.length-CHANGED.length,protectedDigests:baseline.protectedDigests,
      inputLocks:inputLocks(),candidateInventory:inventory(files),environmentWrites:0,paymentCalls:0});
  }
  return validate().manifest;
}

async function manager() {
  // Direct HTTPS was verified after the inherited localhost proxy failed TLS.
  // This affects this process only; never alter system proxy or TLS verification.
  for (const key of ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','all_proxy','CLOUDBASE_TCB_CLOUDAPI_PROXY']) delete process.env[key];
  return createRequire(import.meta.url)(SDK).getCloudBaseManager({cloudBaseOptions:{envId:TARGET.envId,region:TARGET.region,site:'domestic'},authStrategy:'fail_fast'});
}

async function snapshot(api, artifacts, deployed=false) {
  const expected=deployed?artifacts.manifest.candidateZipSha256:BASELINE;
  const before=await api.functions.getFunctionDetail(TARGET.functionName);
  check(before.Status==='Active','FUNCTION_NOT_ACTIVE');
  assertProtectedUnchanged(artifacts.baseline.protectedDigests,protectedDigests(before));
  if (!deployed) check(before.ModTime===artifacts.baseline.modifiedAt,'BASELINE_MODIFIED');
  const address=await api.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(address.CodeSha256===expected,'REMOTE_CODE_CHANGED');
  const url=new URL(address.Url);
  check(url.protocol==='https:' && !url.username && !url.password && !url.hash
    && /\.(myqcloud\.com|tencentcos\.cn)$/.test(url.hostname),'DOWNLOAD_TARGET_INVALID');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(45000)});
  check(response.ok,'PACKAGE_DOWNLOAD_FAILED');
  const zip=Buffer.from(await response.arrayBuffer());
  check(zip.length<=60*1024*1024 && sha(zip)===expected,'DOWNLOAD_HASH_MISMATCH');
  const files=readZip(zip);
  check(equal(inventory(files),deployed?artifacts.manifest.candidateInventory:artifacts.baseline.files),'PACKAGE_CONTENTS_MISMATCH');
  const [after,next]=await Promise.all([api.functions.getFunctionDetail(TARGET.functionName),api.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(after.Status==='Active' && after.ModTime===before.ModTime && next.CodeSha256===expected,'CONCURRENT_REMOTE_CHANGE');
  assertProtectedUnchanged(artifacts.baseline.protectedDigests,protectedDigests(after));
  return {zip,modifiedAt:after.ModTime,codeSha256:expected};
}

function runtimeProof(artifacts) {
  const proof=json('candidate-node16-proof.json');
  check(proof.passed===true && proof.runtime==='v16.13.0'
    && proof.candidateZipSha256===artifacts.manifest.candidateZipSha256
    && proof.testedActualCandidateIndexAndModules===true && proof.testsPassed>0,'TARGET_RUNTIME_NOT_VERIFIED');
  return sha(bytes('candidate-node16-proof.json'));
}

async function verify(api, artifacts) {
  stage='verify-full-package';
  const state=json('single-code-update-request.json');
  check(state.candidateZipSha256===artifacts.manifest.candidateZipSha256 && state.codeUpdateRequests===1,'UPDATE_PROOF_INVALID');
  const cloud=await snapshot(api,artifacts,true);
  stage='health-and-auth-smoke';
  const health=JSON.parse((await api.functions.invokeFunction(TARGET.functionName,{path:'/health',method:'GET',data:{}})).RetMsg);
  check(health.code===0 && health.data?.status==='ok','HEALTH_CHECK_FAILED');
  const unauth=JSON.parse((await api.functions.invokeFunction(TARGET.functionName,{path:'/member/orders',method:'GET',data:{}})).RetMsg);
  check([401,40100,40102].includes(unauth.code),'UNAUTHENTICATED_ORDER_ACCESS_NOT_REJECTED');
  const detail=await api.functions.getFunctionDetail(TARGET.functionName), address=await api.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(detail.Status==='Active' && detail.ModTime===cloud.modifiedAt && address.CodeSha256===cloud.codeSha256,'POST_SMOKE_CLOUD_CHANGED');
  assertProtectedUnchanged(artifacts.baseline.protectedDigests,protectedDigests(detail));
  validate();
  const report={status:'verified',verifiedAt:new Date().toISOString(),target:TARGET,runtime:detail.Runtime,modifiedAt:cloud.modifiedAt,
    baselineCodeSha256:BASELINE,deployedCodeSha256:cloud.codeSha256,changedFiles:CHANGED,addedFiles:ADDED,
    files:artifacts.files.length,unchangedFiles:artifacts.manifest.unchangedFiles,fullFileContentsAndAttributesMatched:true,
    environmentUnchanged:true,configurationUnchanged:true,dependencyInstallation:'FALSE',codeUpdateRequests:1,
    paymentCalls:0,businessWrites:0,health:{code:health.code,status:health.data.status},unauthenticatedOrders:{code:unauth.code},
    protectedDigests:artifacts.baseline.protectedDigests,runtimeProofSha256:runtimeProof(artifacts)};
  if (!existsSync(location('deployment-verification.json'))) {
    writeFileSync(location('hlApi.deployed.downloaded.zip'),cloud.zip,{flag:'wx'});
    save('deployment-verification.json',report);
  }
  return report;
}

export async function main(mode) {
  check(['prepare','inspect','deploy','verify'].includes(mode),'MODE_REQUIRED');
  if (mode==='prepare') { const m=prepare(); return {status:m.status,target:TARGET,changedFiles:CHANGED,addedFiles:ADDED,
    candidateZipSha256:m.candidateZipSha256,files:m.fileCount,unchangedFiles:m.unchangedFiles}; }
  const artifacts=validate(), proofSha=runtimeProof(artifacts);
  stage='authenticate'; const api=await manager();
  if (mode==='verify') return verify(api,artifacts);
  stage='recheck-baseline'; await snapshot(api,artifacts);
  if (mode==='inspect') return {status:'ready_not_deployed',target:TARGET,candidateZipSha256:artifacts.manifest.candidateZipSha256};
  check(!existsSync(location('deployment-intent.json')) && !existsSync(location('single-code-update-request.json')),'ALREADY_STARTED_USE_VERIFY');
  validate();
  save('deployment-intent.json',{target:TARGET,startedAt:new Date().toISOString(),baselineCodeSha256:BASELINE,
    candidateZipSha256:artifacts.manifest.candidateZipSha256,runtimeProofSha256:proofSha,environmentWrites:0});
  stage='temp-cos-authorization';
  const config=api.functions.getFunctionConfig();
  const auth=await api.functions.scfService.request('GetTempCosInfo',{ObjectPath:`${config.appId}/${config.env}/${TARGET.functionName}.zip`});
  const upload=tempCosUploadPlan(config,auth);
  stage='upload-candidate';
  const uploaded=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:artifacts.candidate,redirect:'error',signal:AbortSignal.timeout(45000)});
  check(uploaded.ok,'CANDIDATE_UPLOAD_FAILED');
  stage='recheck-before-update'; await snapshot(api,artifacts); validate();
  check(runtimeProof(artifacts)===proofSha,'RUNTIME_PROOF_CHANGED');
  save('single-code-update-request.json',{target:TARGET,requestedAt:new Date().toISOString(),candidateZipSha256:artifacts.manifest.candidateZipSha256,
    codeUpdateRequests:1,automaticRetry:false,environmentWrites:0});
  stage='single-code-update';
  const result=await api.functions.updateFunctionCode(repairCodeArguments(upload.key));
  check(!result.SCFErrorCode,'UPDATE_REJECTED_USE_VERIFY');
  stage='wait-active';
  for (let attempt=0;attempt<30;attempt++) {
    const detail=await api.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(artifacts.baseline.protectedDigests,protectedDigests(detail));
    check(!/Failed|Error/i.test(String(detail.Status)),'UPDATE_FAILED_USE_VERIFY');
    if (detail.Status==='Active' && (await api.functions.getFunctionDownloadUrl(TARGET.functionName)).CodeSha256===artifacts.manifest.candidateZipSha256) return verify(api,artifacts);
    await new Promise(done=>setTimeout(done,1500));
  }
  check(false,'UPDATE_PENDING_USE_VERIFY');
}

if (process.argv[1] && resolve(process.argv[1])===SCRIPT) {
  try { check(process.argv.length===3,'MODE_REQUIRED'); process.stdout.write(JSON.stringify(await main(process.argv[2]))+'\n'); }
  catch (error) { process.stderr.write(JSON.stringify({status:'incomplete',stage,code:error.safeCode||'DEPLOYMENT_UNCONFIRMED',
    rawErrorWithheld:true,automaticRetry:false})+'\n'); process.exitCode=1; }
}
