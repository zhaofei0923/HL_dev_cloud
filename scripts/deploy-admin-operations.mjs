import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

const ENV_ID='cloud1-d2gza7q9c8d69c721',REGION='ap-shanghai',NAME='hlAdminOperations',AUDIT='hl_admin_audit_logs';
const [sdkFile,buildDirectory,mode='inspect']=process.argv.slice(2);
if(!sdkFile||!buildDirectory||!['inspect','deploy','verify'].includes(mode))throw new Error('Supply official SDK, build root and inspect/deploy/verify');
const root=resolve(import.meta.dirname,'..'),buildRoot=resolve(buildDirectory),evidenceFile=resolve(root,'output/admin-operations-20261014/deployment.json');
let phase='initialize';
const evidence={envId:ENV_ID,region:REGION,functionName:NAME,startedAt:new Date().toISOString(),mode};
const response=value=>{const result=value?.Response||value;if(!result||result.Error)throw new Error('Official operation failed');return result;};
let client;
try{
  const {getCloudBaseManager}=createRequire(import.meta.url)(resolve(sdkFile));
  const manager=await getCloudBaseManager({cloudBaseOptions:{envId:ENV_ID,region:REGION,site:'domestic'},authStrategy:'fail_fast'});
  const waitActive=async()=>{
    for(let attempt=0;attempt<20;attempt++){
      const detail=await manager.functions.getFunctionDetail(NAME);
      if(detail.Status==='Active')return detail;
      if(/Failed/i.test(detail.Status||''))throw new Error('Function entered a failed state');
      await new Promise(done=>setTimeout(done,2000));
    }
    throw new Error('Function did not become Active');
  };
  const call=async(Action,Param)=>{phase=Action;return response(await manager.commonService().call({Action,Param}));};
  const listing=await manager.functions.getFunctionList(100,0);
  if(!Array.isArray(listing.Functions)||listing.TotalCount>100)throw new Error('Unexpected function list');
  const exists=listing.Functions.some(item=>item.FunctionName===NAME);
  evidence.existedBefore=exists;
  phase='read-source-crypto-configuration';
  // Restrict derivation to the existing certificate encryption domain. Never copy
  // or print the JWT signing secret or any payment credential into this service.
  const original=await manager.functions.getFunctionDetail('hlApi');
  const variables=Object.fromEntries((original.Environment?.Variables||[]).map(item=>[item.Key,item.Value]));
  const envVariables={};
  if(typeof variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY==='string'&&variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY){
    envVariables.MEMBER_CERTIFICATION_ENCRYPTION_KEY=variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY;
  }
  if(typeof variables.JWT_SECRET==='string'&&Buffer.byteLength(variables.JWT_SECRET)>=32){
    envVariables.MEMBER_CERTIFICATION_JWT_DERIVED_KEY='hex:'+createHmac('sha256',Buffer.from(variables.JWT_SECRET))
      .update('hl.member-certification.encryption.jwt-derived.v1','utf8').digest('hex');
  }
  evidence.cryptoReadiness={dedicated:!!envVariables.MEMBER_CERTIFICATION_ENCRYPTION_KEY,legacyDerived:!!envVariables.MEMBER_CERTIFICATION_JWT_DERIVED_KEY,jwtSigningSecretCopied:false};
  if(!Object.keys(envVariables).length)throw new Error('Certificate decryption configuration unavailable');
  phase='inspect-audit-collection';
  const audit=await manager.database.checkCollectionExists(AUDIT);
  evidence.auditExistedBefore=audit.Exists===true;
  if(!audit.Exists&&!['ResourceNotFound','DATABASE_COLLECTION_NOT_EXIST','COLLECTION_NOT_EXIST','not exist','不存在','TableNotExist'].some(part=>String(audit.Msg||'').includes(part)))throw new Error('Audit collection status unknown');
  const rules=async()=>{
    const acl=await call('DescribeDatabaseACL',{EnvId:ENV_ID,CollectionName:AUDIT});
    const safe=await call('DescribeSafeRule',{EnvId:ENV_ID,CollectionName:AUDIT});
    return{aclTag:acl.AclTag,safeRuleTag:safe.AclTag,rule:safe.Rule||''};
  };
  if(audit.Exists)evidence.auditRuleBefore=await rules();
  if(mode==='inspect'){console.log(JSON.stringify(evidence,null,2));}
  else{
    const manifest=JSON.parse(await readFile(resolve(buildRoot,'build-manifest.json'),'utf8'));
    const code=await readFile(resolve(buildRoot,NAME,'index.js'));
    if(manifest.functionName!==NAME||manifest.bundleSha256!==createHash('sha256').update(code).digest('hex'))throw new Error('Built code mismatch');
    evidence.bundleSha256=manifest.bundleSha256;
    if(mode==='deploy'){
      if(audit.Exists&&(evidence.auditRuleBefore.aclTag!=='ADMINONLY'||evidence.auditRuleBefore.safeRuleTag!=='ADMINONLY'))throw new Error('Existing audit ACL must remain protected');
      if(!audit.Exists){
        phase='create-audit-collection';await manager.database.createCollection(AUDIT);
        await call('ModifySafeRule',{EnvId:ENV_ID,CollectionName:AUDIT,AclTag:'ADMINONLY'});
      }
      evidence.auditRuleAfter=await rules();
      if(evidence.auditRuleAfter.aclTag!=='ADMINONLY'||evidence.auditRuleAfter.safeRuleTag!=='ADMINONLY')throw new Error('Audit permission verification failed');
      if(exists){
        phase='check-owned-function';
        const current=await manager.functions.getFunctionDetail(NAME);
        const currentVariables=current.Environment?.Variables||[];
        if(!currentVariables.some(item=>item.Key==='ADMIN_OPERATIONS_OWNER'&&item.Value==='hl-admin-operations-v1'))throw new Error('Existing function not owned by this deployment');
        // Preserve only known service keys; an unexpected key requires review.
        const known=new Set(['ADMIN_OPERATIONS_OWNER','ADMIN_OPERATIONS_BUILD_SHA256',...Object.keys(envVariables)]);
        if(currentVariables.some(item=>!known.has(item.Key)))throw new Error('Existing function has unexpected configuration');
      }
      const func={name:NAME,type:'Event',runtime:'Nodejs20.19',handler:'index.main',timeout:60,installDependency:false,
        envVariables:{...envVariables,ADMIN_OPERATIONS_OWNER:'hl-admin-operations-v1',ADMIN_OPERATIONS_BUILD_SHA256:manifest.bundleSha256}};
      phase=exists?'update-function':'create-function';
      if(exists){
        phase='update-function-code';await manager.functions.updateFunctionCode({func,functionRootPath:buildRoot,deployMode:'zip'});
        phase='wait-code-active';await waitActive();
        phase='update-function-configuration';await manager.functions.updateFunctionConfig(func);
        phase='wait-configuration-active';await waitActive();
      }
      else await manager.functions.createFunction({func,functionRootPath:buildRoot,deployMode:'zip'});
    }
    phase='verify-function';
    const detail=await waitActive();
    if(detail.Status!=='Active'||detail.Runtime!=='Nodejs20.19')throw new Error('Function is not Active');
    const deployedVariables=Object.fromEntries((detail.Environment?.Variables||[]).map(item=>[item.Key,item.Value]));
    const expectedVariables={...envVariables,ADMIN_OPERATIONS_OWNER:'hl-admin-operations-v1',ADMIN_OPERATIONS_BUILD_SHA256:manifest.bundleSha256};
    if(Object.keys(deployedVariables).length!==Object.keys(expectedVariables).length
      ||Object.entries(expectedVariables).some(([key,value])=>deployedVariables[key]!==value))throw new Error('Function build or protected configuration differs from expected');
    evidence.auditRuleAfter=await rules();
    if(evidence.auditRuleAfter.aclTag!=='ADMINONLY'||evidence.auditRuleAfter.safeRuleTag!=='ADMINONLY')throw new Error('Audit permission verification failed');
    evidence.buildMarkerAndConfigurationMatched=true;
    evidence.status=detail.Status;evidence.runtime=detail.Runtime;evidence.modifiedAt=detail.ModTime;
    client=new PaymentMcpClient(resolve(sdkFile,'../cli.cjs'),{envId:ENV_ID,region:REGION,cwd:root,timeoutMs:120000});
    const invocation=await client.call('manageFunctions',{action:'invokeFunction',functionName:NAME,params:{action:'plans.update',args:{planCode:'vip_week',active:true},uid:'forged',role:'administrator',requestId:'denied-verification'}});
    const parse=(v,depth=0)=>{
      if(depth>7)return null;
      if(typeof v==='string'){try{return parse(JSON.parse(v),depth+1);}catch{return null;}}
      if(!v||typeof v!=='object')return null;
      if(Number.isInteger(v.code))return v;
      for(const key of ['result','Result','RetMsg','invokeResult','raw','Response','data']){const found=parse(v[key],depth+1);if(found)return found;}
      return null;
    };
    const denied=parse(invocation);
    if(![40150,40350].includes(denied?.code)||denied?.data)throw new Error('Forged identity denial not verified');
    evidence.forgedIdentityDenied=denied.code;evidence.verifiedAt=new Date().toISOString();
    evidence.actualBusinessWriteExecuted=false;evidence.microAppPublished=false;
    await mkdir(resolve(root,'output/admin-operations-20261014'),{recursive:true});
    await writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
  }
}catch(error){
  console.error(JSON.stringify({phase,code:typeof error.code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(error.code)?error.code:undefined,
    requestId:typeof error.requestId==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(error.requestId)?error.requestId:undefined,
    message:'管理功能部署未完成；未输出凭据、签名地址或业务资料。'}));process.exitCode=1;
}finally{client?.close();}
