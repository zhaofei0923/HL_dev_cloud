import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';
import { tempCosUploadPlan, repairCodeArguments } from './repair-admin-entry-compatibility.mjs';
import { patchIndex as applyGuestBrowse } from './prepare-review-guest.mjs';
import { parseExactHunks, applyExactHunks } from './prepare-content-security-deployment.mjs';

const SCRIPT = fileURLToPath(import.meta.url), ROOT = resolve(dirname(SCRIPT), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
export const OUTPUT = join(ROOT, 'output/review-content-security-20261021');
const CHANGED = ['config.json', 'index.js', 'salon-policy.js'];
const ADDED = ['content-security.js', 'image-content-security.js'];
const PERMISSIONS = ['security.msgSecCheck', 'security.imgSecCheck'];
export const STORAGE_RULE = Object.freeze({
  read: 'resource.openid == auth.openid || resource.openid == auth.uid',
  write: '(resource.openid == auth.openid || resource.openid == auth.uid) && /^hl_uploads\\//.test(resource.path)'
});
const INTENT = 'deployment-intent.json', REQUEST = 'code-update-request.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const check = (ok,code) => { if (!ok) throw Object.assign(new Error(code), { safeCode:code }); };
const path = name => join(OUTPUT,name);
function read(file) {
  check(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'LOCAL_FILE_UNSAFE_OR_MISSING');
  return readFileSync(file);
}
const artifact = name => read(path(name));
const json = name => JSON.parse(artifact(name).toString('utf8'));
function save(name,bytes) {
  const file = path(name), inside = relative(OUTPUT,file);
  check(inside && !inside.startsWith('..') && !isAbsolute(inside), 'LOCAL_OUTPUT_PATH_INVALID');
  mkdirSync(dirname(file),{recursive:true});
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existsSync(file)) check(read(file).equals(value), 'IMMUTABLE_ARTIFACT_CHANGED');
  else writeFileSync(file,value,{flag:'wx'});
}
const saveJson = (name,value) => save(name,JSON.stringify(value,null,2)+'\n');
function source(bytes) {
  const text = bytes.toString('utf8');
  check(Buffer.from(text).equals(bytes), 'SOURCE_ENCODING_INVALID');
  return text.replace(/\r\n/g,'\n');
}
function downloadURL(value) {
  let url; try { url = new URL(value); } catch { check(false,'DOWNLOAD_URL_INVALID'); }
  check(url.protocol==='https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname),'DOWNLOAD_URL_INVALID');
  return url;
}
async function manager() {
  const {getCloudBaseManager} = createRequire(import.meta.url)(SDK);
  return getCloudBaseManager({cloudBaseOptions:{envId:TARGET.envId,region:TARGET.region,site:'domestic'},authStrategy:'fail_fast'});
}
async function snapshot(api) {
  const before = await api.functions.getFunctionDetail(TARGET.functionName), digests = protectedDigests(before);
  check(before.Status==='Active','FUNCTION_NOT_ACTIVE');
  const address = await api.functions.getFunctionDownloadUrl(TARGET.functionName);
  const response = await fetch(downloadURL(address.Url),{redirect:'error',signal:AbortSignal.timeout(45000)});
  check(response.ok,'DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  check(bytes.length<60*1024*1024 && sha(bytes)===address.CodeSha256,'DOWNLOAD_HASH_MISMATCH');
  const [after,next,storage] = await Promise.all([api.functions.getFunctionDetail(TARGET.functionName),
    api.functions.getFunctionDownloadUrl(TARGET.functionName),api.storage.getStorageAcl({withRule:true})]);
  check(after.Status==='Active' && after.ModTime===before.ModTime && next.CodeSha256===address.CodeSha256,'CONCURRENT_CLOUD_CHANGE');
  assertProtectedUnchanged(digests,protectedDigests(after));
  const baselineStorage=storage.acl==='PRIVATE' && !storage.rule;
  const finalStorage=storage.acl==='CUSTOM' && equal(storage.rule,STORAGE_RULE);
  check(baselineStorage || finalStorage,'STORAGE_RULES_CHANGED');
  return {bytes,files:readZip(bytes),summary:{target:TARGET,codeSha256:sha(bytes),modifiedAt:after.ModTime,status:after.Status,
    runtime:after.Runtime,handler:after.Handler,protectedDigests:digests,storageAcl:storage.acl,
    storageRule:finalStorage?STORAGE_RULE:null}};
}
function exactDiff(before,after) {
  save('index.local-before.js',before); save('index.local-after.js',after);
  const result = spawnSync('git',['diff','--no-index','--no-ext-diff','--no-color','--unified=3','--',
    path('index.local-before.js'),path('index.local-after.js')],{cwd:ROOT,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  check(!result.error && result.status===1 && result.stdout.includes('\n@@ '),'INDEX_DIFF_UNAVAILABLE');
  const patch='--- a/index.js\n+++ b/index.js\n'+result.stdout.slice(result.stdout.indexOf('@@ '));
  save('moderation-reviewed.patch',patch);
  return parseExactHunks(patch);
}
function configPatch(before,local) {
  const original=JSON.parse(source(before)), intended=JSON.parse(source(local));
  check(Array.isArray(original.permissions?.openapi),'BASELINE_OPENAPI_UNCONFIRMED');
  const expected={...original,permissions:{...original.permissions,openapi:[...original.permissions.openapi,
    ...PERMISSIONS.filter(name=>!original.permissions.openapi.includes(name))]}};
  check(equal(expected,intended),'LOCAL_CONFIG_HAS_UNSCOPED_CHANGES');
  return Buffer.from(source(local).replace(/\n/g,before.includes(Buffer.from('\r\n'))?'\r\n':'\n'));
}
function localInputs() {
  return [...CHANGED,...ADDED].map(name=>({path:`cloudfunctions/hlApi/${name}`,sha256:sha(read(join(ROOT,'cloudfunctions/hlApi',name)))}));
}
export function prepare() {
  check(!existsSync(path('candidate-manifest.json')),'CANDIDATE_EXISTS_USE_INSPECT');
  check(!existsSync(path(INTENT)) && !existsSync(path(REQUEST)),'DEPLOYMENT_ALREADY_STARTED');
  const baseline=json('cloud-baseline.json'), bytes=artifact('hlApi.fresh-baseline.zip'), before=readZip(bytes);
  check(equal(baseline.target,TARGET) && sha(bytes)===baseline.codeSha256 && equal(inventory(before),baseline.files),'BASELINE_CHANGED');
  check(ADDED.every(name=>!before.some(file=>file.name===name)),'BASELINE_ALREADY_HAS_MODERATION');
  const head=spawnSync('git',['show','HEAD:cloudfunctions/hlApi/index.js'],{cwd:ROOT,windowsHide:true,maxBuffer:8*1024*1024});
  check(!head.error && head.status===0,'GIT_BASELINE_UNAVAILABLE');
  const localBefore=source(applyGuestBrowse(head.stdout)), localAfter=source(read(join(ROOT,'cloudfunctions/hlApi/index.js')));
  const hunks=exactDiff(localBefore,localAfter), originalIndex=before.find(file=>file.name==='index.js');
  const nextIndex=applyExactHunks(source(originalIndex.bytes),hunks);
  check(applyExactHunks(nextIndex,hunks,true)===source(originalIndex.bytes),'INDEX_REVERSE_PATCH_FAILED');
  const replacements=new Map([['index.js',Buffer.from(nextIndex.replace(/\n/g,originalIndex.bytes.includes(Buffer.from('\r\n'))?'\r\n':'\n'))],
    ['config.json',configPatch(before.find(file=>file.name==='config.json').bytes,read(join(ROOT,'cloudfunctions/hlApi/config.json')))],
    ['salon-policy.js',read(join(ROOT,'cloudfunctions/hlApi/salon-policy.js'))]]);
  const after=before.map(file=>({...file,bytes:replacements.get(file.name)||Buffer.from(file.bytes)}));
  for(const name of ADDED)after.push({name,bytes:read(join(ROOT,'cloudfunctions/hlApi',name)),
    madeBy:originalIndex.madeBy,externalAttributes:originalIndex.externalAttributes});
  for(const file of after.filter(file=>[...CHANGED,...ADDED].includes(file.name)&&file.name.endsWith('.js')))new Script(source(file.bytes),{filename:file.name});
  for(const file of before){const next=after.find(item=>item.name===file.name);
    check(next && next.madeBy===file.madeBy && next.externalAttributes===file.externalAttributes
      && (CHANGED.includes(file.name)||next.bytes.equals(file.bytes)),'UNSCOPED_PACKAGE_CHANGE');}
  const candidate=rootZip(after), candidateInventory=inventory(after);
  check(equal(inventory(readZip(candidate)),candidateInventory),'CANDIDATE_ZIP_ROUNDTRIP_FAILED');
  save('hlApi.moderation.candidate.zip',candidate);
  for(const file of after.filter(file=>!file.name.includes('/')))save(`candidate-root/hlApi/${file.name}`,file.bytes);
  const manifest={status:'candidate_prepared_qa_required',target:TARGET,baselineCodeSha256:sha(bytes),candidateZipSha256:sha(candidate),
    baselineModifiedAt:baseline.modifiedAt,beforeInventory:inventory(before),candidateInventory,changedFiles:CHANGED,addedFiles:ADDED,removedFiles:[],
    sourceFiles:before.length,candidateFiles:after.length,unchangedFiles:before.length-CHANGED.length,
    protectedDigests:baseline.protectedDigests,storageAcl:'PRIVATE',sourceInputs:localInputs(),
    indexHunks:hunks.length,indexReversePatchMatched:true,otherFileBytesAndAttributesPreserved:true,
    permissionRegistration:{required:PERMISSIONS,complete:false,method:'official CLI inc-deploy config.json after code update',codeActionsExpected:2},
    candidateRoot:{path:'output/review-content-security-20261021/candidate-root/hlApi',topLevelSourcesOnly:true,fullDeploymentDirectory:false},
    cloudWrites:0,configurationWrites:0,permissionWrites:0,businessCalls:0};
  saveJson('candidate-manifest.json',manifest);
  return {status:manifest.status,baselineCodeSha256:manifest.baselineCodeSha256,candidateZipSha256:manifest.candidateZipSha256,
    sourceFiles:manifest.sourceFiles,candidateFiles:manifest.candidateFiles,unchangedFiles:manifest.unchangedFiles,cloudWrites:0};
}
export function validatePrepared() {
  const manifest=json('candidate-manifest.json'), candidate=artifact('hlApi.moderation.candidate.zip'), baseline=artifact('hlApi.fresh-baseline.zip');
  check(equal(manifest.target,TARGET)&&sha(candidate)===manifest.candidateZipSha256&&sha(baseline)===manifest.baselineCodeSha256,'CANDIDATE_IDENTITY_CHANGED');
  check(equal(manifest.sourceInputs,localInputs()),'LOCAL_SOURCES_CHANGED_REBUILD_REQUIRED');
  check(equal(inventory(readZip(candidate)),manifest.candidateInventory)&&equal(inventory(readZip(baseline)),manifest.beforeInventory),'PACKAGE_INVENTORY_CHANGED');
  return {manifest,candidate,baseline};
}
export function writeQaProof({logPath,node16ProofPath}={}) {
  check(!existsSync(path(INTENT))&&!existsSync(path(REQUEST)),'QA_LOCK_AFTER_DEPLOY_FORBIDDEN');
  const {manifest}=validatePrepared(), log=read(resolve(ROOT,logPath)), text=log.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'').replace(/\r/g,'');
  const counts={};
  for(const label of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...text.matchAll(new RegExp(`^\\s*(?:[ℹ#]\\s*)?${label}\\s+(\\d+)\\s*$`,'gm'))];
    check(matches.length===1,'CHECK_SUMMARY_INVALID');counts[label]=Number(matches[0][1]);}
  check(counts.tests>=1787&&counts.tests===counts.pass&&['fail','cancelled','skipped','todo'].every(k=>counts[k]===0)
    &&/Verified generated files:/.test(text)&&/Media resources:/.test(text)&&text.trimEnd().endsWith('Verified 7 CloudBase CMS views against hlApi.'),'FULL_CHECK_NOT_CONFIRMED');
  const runtimeBytes=read(resolve(ROOT,node16ProofPath)), runtime=JSON.parse(runtimeBytes.toString());
  check(runtime.passed===true&&runtime.runtime==='v16.13.0'&&runtime.candidateZipSha256===manifest.candidateZipSha256,'NODE16_CANDIDATE_PROOF_INVALID');
  const proof={passed:true,candidateZipSha256:manifest.candidateZipSha256,sourceInputs:manifest.sourceInputs,
    fullCheck:{logPath,sha256:sha(log),testsPassed:counts.pass},node16:{path:node16ProofPath,sha256:sha(runtimeBytes)},businessCalls:0};
  saveJson('release-qa-proof.json',proof);return proof;
}
function assertQa(manifest) {
  const proof=json('release-qa-proof.json');
  check(proof.passed===true&&proof.candidateZipSha256===manifest.candidateZipSha256&&equal(proof.sourceInputs,manifest.sourceInputs)
    &&sha(read(resolve(ROOT,proof.fullCheck.logPath)))===proof.fullCheck.sha256
    &&sha(read(resolve(ROOT,proof.node16.path)))===proof.node16.sha256,'QA_PROOF_CHANGED');
}
function assertBaseline(snapshot,manifest) {
  check(snapshot.summary.codeSha256===manifest.baselineCodeSha256&&snapshot.summary.modifiedAt===manifest.baselineModifiedAt
    &&equal(inventory(snapshot.files),manifest.beforeInventory),'REMOTE_BASELINE_CHANGED');
  check(snapshot.summary.storageAcl==='PRIVATE' && snapshot.summary.storageRule===null,'DEPLOY_REQUIRES_ORIGINAL_PRIVATE_STORAGE');
  assertProtectedUnchanged(manifest.protectedDigests,snapshot.summary.protectedDigests);
}
async function verify(api,prepared,{requireFinalStorage=true}={}) {
  const {manifest}=prepared, live=await snapshot(api);
  assertProtectedUnchanged(manifest.protectedDigests,live.summary.protectedDigests);
  const actualInventory=inventory(live.files);
  let reviewedConfigMetadataOnly=false;
  if(!equal(actualInventory,manifest.candidateInventory)){
    const expectedByName=new Map(manifest.candidateInventory.map(file=>[file.name,file]));
    const actualByName=new Map(actualInventory.map(file=>[file.name,file]));
    const differences={target:TARGET,expectedCandidateSha256:manifest.candidateZipSha256,actualCodeSha256:live.summary.codeSha256,
      added:actualInventory.filter(file=>!expectedByName.has(file.name)),
      removed:manifest.candidateInventory.filter(file=>!actualByName.has(file.name)),
      changed:actualInventory.filter(file=>expectedByName.has(file.name)&&!equal(expectedByName.get(file.name),file))
        .map(file=>({name:file.name,expected:expectedByName.get(file.name),actual:file})),
      noDifferencesAutomaticallyAccepted:true,cloudWrites:0};
    saveJson(`inventory-differences-${live.summary.codeSha256}.json`,differences);
    if(existsSync(path('reviewed-config-metadata.json'))){
      const review=json('reviewed-config-metadata.json');
      const approvedBefore={name:'config.json',bytes:203,
        sha256:'b09d62a623f4099f3c851702c5fa8b91bad77018e8d855942fc3b3b2df0eba30',externalAttributes:2176188448,madeBy:813};
      const approvedAfter={...approvedBefore,externalAttributes:2175008768,madeBy:798};
      reviewedConfigMetadataOnly=review.status==='explicitly_reviewed_and_accepted_by_root'
        &&equal(review.target,TARGET)
        &&review.candidateZipSha256===manifest.candidateZipSha256
        &&review.postCliCodeSha256==='850922890af481317c1ec5a473518a596408e4d0cbd97df4a8e64cc6e3ed027d'
        &&live.summary.codeSha256===review.postCliCodeSha256
        &&equal(review.expectedConfig,approvedBefore)&&equal(review.actualConfig,approvedAfter)
        &&differences.added.length===0&&differences.removed.length===0&&differences.changed.length===1
        &&equal(differences.changed[0],{name:'config.json',expected:approvedBefore,actual:approvedAfter})
        &&actualInventory.length===4055&&review.otherFilesRequiringExactByteAndAttributeMatch===4054;
    }
    check(reviewedConfigMetadataOnly,'DEPLOYED_FILE_BYTES_OR_ATTRIBUTES_DIFFER');
  }
  if(requireFinalStorage)check(live.summary.storageAcl==='CUSTOM'&&equal(live.summary.storageRule,STORAGE_RULE),'FINAL_STORAGE_PROTECTION_NOT_APPLIED');
  save(`hlApi.moderation.readback-${live.summary.codeSha256}.zip`,live.bytes);
  const report={status:'code_verified_permission_registration_separate',target:TARGET,candidateZipSha256:manifest.candidateZipSha256,
    remoteCodeSha256:live.summary.codeSha256,modifiedAt:live.summary.modifiedAt,
    fullFileInventoryMatched:!reviewedConfigMetadataOnly,approvedInventoryMatched:true,allFileBytesMatched:true,
    reviewedConfigMetadataOnly,allOtherFileAttributesMatched:true,
    protectedDigests:live.summary.protectedDigests,environmentUnchanged:true,configurationUnchanged:true,
    storageAcl:live.summary.storageAcl,storageRule:live.summary.storageRule,finalStorageProtectionVerified:live.summary.storageAcl==='CUSTOM',
    permissionRegistrationRequired:true,permissionRegistrationVerified:false,businessCalls:0,credentialsPersisted:false,signedUrlPersisted:false};
  // A subsequent official config-only incremental deploy changes archive SHA and modification time.
  // Store separately so both readbacks remain immutable and auditable.
  saveJson(`verification-${live.summary.codeSha256}-${live.summary.storageAcl}.json`,report);return report;
}
export async function main(mode) {
  check(['prepare','inspect','deploy-code','verify'].includes(mode),'EXPLICIT_MODE_REQUIRED');
  if(mode==='prepare')return prepare();
  const prepared=validatePrepared(),{manifest,candidate}=prepared,api=await manager();
  if(mode==='verify')return verify(api,prepared);
  check(!existsSync(path(INTENT))&&!existsSync(path(REQUEST)),'DEPLOYMENT_STARTED_USE_VERIFY_NO_RESEND');
  const before=await snapshot(api);assertBaseline(before,manifest);
  if(mode==='inspect')return {status:'baseline_and_candidate_matched_not_deployed',target:TARGET,
    candidateZipSha256:manifest.candidateZipSha256,qaProofPresent:existsSync(path('release-qa-proof.json')),cloudWrites:0,businessCalls:0};
  assertQa(manifest);
  const record={target:TARGET,baselineCodeSha256:manifest.baselineCodeSha256,candidateZipSha256:manifest.candidateZipSha256,
    manifestSha256:sha(artifact('candidate-manifest.json')),qaSha256:sha(artifact('release-qa-proof.json')),automaticRetry:false};
  saveJson(INTENT,{...record,startedAt:new Date().toISOString(),environmentWrites:0,storageRuleWrites:0,businessCalls:0});
  const config=api.functions.getFunctionConfig(),auth=await api.functions.scfService.request('GetTempCosInfo',{
    ObjectPath:`${config.appId}/${config.env}/${TARGET.functionName}.zip`});
  const upload=tempCosUploadPlan(config,auth),response=await fetch(upload.url,{method:'PUT',headers:upload.headers,body:candidate,
    redirect:'error',signal:AbortSignal.timeout(45000)});
  check(response.ok,'TEMP_UPLOAD_UNCONFIRMED_NO_AUTOMATIC_RETRY');
  assertBaseline(await snapshot(api),manifest);assertQa(manifest);validatePrepared();
  saveJson(REQUEST,{...record,requestedAt:new Date().toISOString(),codeUpdateRequests:1,permissionRegistrationRequests:0});
  const result=await api.functions.updateFunctionCode(repairCodeArguments(upload.key));
  check(!result.SCFErrorCode,'CODE_UPDATE_REJECTED_USE_VERIFY');
  for(let at=0;at<25;at++){
    const detail=await api.functions.getFunctionDetail(TARGET.functionName);
    assertProtectedUnchanged(manifest.protectedDigests,protectedDigests(detail));
    check(!/Failed|Error/i.test(String(detail.Status)),'CODE_UPDATE_FAILED_USE_VERIFY');
    if(detail.Status==='Active'){
      const address=await api.functions.getFunctionDownloadUrl(TARGET.functionName);
      if(address.CodeSha256===manifest.candidateZipSha256)return verify(api,prepared,{requireFinalStorage:false});
      check(address.CodeSha256===manifest.baselineCodeSha256,'CONCURRENT_CODE_CHANGE');
    }
    await new Promise(done=>setTimeout(done,1500));
  }
  check(false,'CODE_UPDATE_PENDING_USE_VERIFY');
}
if(process.argv[1]&&resolve(process.argv[1])===SCRIPT){
  try{check(process.argv.length===3,'EXPLICIT_MODE_REQUIRED');console.log(JSON.stringify(await main(process.argv[2])));}
  catch(error){console.error(JSON.stringify({status:'unconfirmed',code:error.safeCode||'CONTENT_REVIEW_OPERATION_UNCONFIRMED',
    automaticRetry:false,codeUpdateRequestMarked:existsSync(path(REQUEST)),rawErrorWithheld:true}));process.exitCode=1;}
}
