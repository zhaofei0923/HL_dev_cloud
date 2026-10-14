import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const ENV_ID='cloud1-d2gza7q9c8d69c721',REGION='ap-shanghai',NAME='hlAdminCockpit';
const [mcpBin,buildDirectory,mode='inspect']=process.argv.slice(2);
if(!mcpBin||!buildDirectory||!['inspect','deploy','verify'].includes(mode))throw new Error('Supply official MCP binary, built function root and inspect/deploy/verify');
const root=resolve(import.meta.dirname,'..'),buildRoot=resolve(buildDirectory);
const manifest=JSON.parse(await readFile(resolve(buildRoot,'build-manifest.json'),'utf8'));
const bytes=await readFile(resolve(buildRoot,NAME,'index.js'));
if(manifest.functionName!==NAME||createHash('sha256').update(bytes).digest('hex')!==manifest.bundleSha256)throw new Error('Build identity or hash mismatch');
const c=new PaymentMcpClient(mcpBin,{envId:ENV_ID,region:REGION,cwd:root,timeoutMs:120000});
const evidence={envId:ENV_ID,region:REGION,functionName:NAME,startedAt:new Date().toISOString(),bundleSha256:manifest.bundleSha256};
const extract=v=>v?.data?.functionDetail;
let phase='list-functions';
try{
  const listed=await c.call('queryFunctions',{action:'listFunctions',limit:100,offset:0});
  const list=listed.data?.functions||listed.data?.functionList||listed.data?.raw?.Functions;
  if(!Array.isArray(list))throw new Error('Unknown function listing shape');
  const existing=list.find(x=>(x.FunctionName||x.name||x.Name)===NAME);
  evidence.existedBefore=!!existing;
  if(mode==='inspect'){
    console.log(JSON.stringify({...evidence,functionCount:list.length,listKeys:Object.keys(listed.data||{})},null,2));
  }else{
    if(mode==='deploy'){
      // An existing function is only updated after its current build marker is known.
      if(existing){
        const prior=extract(await c.call('queryFunctions',{action:'getFunctionDetail',functionName:NAME}));
        const marker=prior?.Environment?.Variables?.find(x=>x.Key==='COCKPIT_BUILD_SHA256');
        if(!marker?.ValueLength)throw new Error('Existing function has no cockpit ownership marker');
      }
      const action=existing?'updateFunctionCode':'createFunction';
      // The official MCP defaults to a separate COS upload. Our self-contained
      // bundle is below the SDK's compressed 1.5 MB limit, so use its explicit
      // ZIP transport without cloud dependency installation or extra resources.
      const {getCloudBaseManager}=createRequire(import.meta.url)(resolve(dirname(mcpBin),'index.cjs'));
      phase='initialize-official-manager';
      const manager=await getCloudBaseManager({cloudBaseOptions:{envId:ENV_ID,region:REGION,site:'domestic'},authStrategy:'fail_fast'});
      const func={name:NAME,type:'Event',runtime:'Nodejs20.19',handler:'index.main',timeout:60,
        envVariables:{COCKPIT_BUILD_SHA256:manifest.bundleSha256},installDependency:false};
      phase=action;
      const changed=existing
        ?await manager.functions.updateFunctionCode({func,functionRootPath:buildRoot,deployMode:'zip'})
        :await manager.functions.createFunction({func,functionRootPath:buildRoot,deployMode:'zip'});
      evidence.operation=action;evidence.transport='official-sdk-zip';evidence.operationResultKeys=Object.keys(changed||{});
    }
    phase='verify-active';let detail;
    for(let i=0;i<12;i++){
      detail=extract(await c.call('queryFunctions',{action:'getFunctionDetail',functionName:NAME}));
      if(detail?.Status==='Active')break;
      if(detail?.Status==='CreateFailed'||detail?.Status==='UpdateFailed')throw new Error('Function deployment failed');
      await new Promise(done=>setTimeout(done,3000));
    }
    if(detail?.Status!=='Active')throw new Error('Function is not Active');
    evidence.status=detail.Status;evidence.runtime=detail.Runtime;evidence.modifiedAt=detail.ModTime;
    evidence.requestId=detail.RequestId;
    const download=await c.call('queryFunctions',{action:'getFunctionDownloadUrl',functionName:NAME});
    evidence.cloudCodeSha256=download.data?.codeSha256;
    const denied=await c.call('manageFunctions',{action:'invokeFunction',functionName:NAME,
      params:{periodDays:30,uid:'forged-client-user',role:'administrator'}});
    // Only bounded status metadata is printed/stored, never user information.
    const data=denied.data||{};
    function business(value,depth=0){
      if(depth>6)return null;
      if(typeof value==='string'){try{return business(JSON.parse(value),depth+1);}catch{return null;}}
      if(!value||typeof value!=='object')return null;
      if(Number.isInteger(value.code))return value;
      for(const key of ['result','Result','RetMsg','invokeResult','raw','Response']){
        const found=business(value[key],depth+1);if(found)return found;
      }
      return null;
    }
    const result=business(data);
    evidence.denialResponseCode=result?.code;
    evidence.invocationResultKeys=Object.keys(data);
    // The management invocation has no end-user identity; it must not return statistics.
    if(![40150,40350].includes(result?.code)||result?.data)throw new Error('Function identity denial was not verified');
    evidence.verifiedAt=new Date().toISOString();
    await writeFile(resolve(root,'output/cockpit-20261014/function-deployment.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
  }
}catch(error){console.error(JSON.stringify({message:'驾驶舱云函数操作未完成；未输出凭据。',phase,
  code:typeof error.code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(error.code)?error.code:undefined,
  requestId:typeof error.requestId==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(error.requestId)?error.requestId:undefined,
  reason:error.message?.startsWith('Unknown')||error.message?.startsWith('Function')||error.message?.startsWith('Existing')?error.message:undefined}));process.exitCode=1;}
finally{c.close();}
