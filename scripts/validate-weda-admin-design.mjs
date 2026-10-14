import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { operationsLifecycle } from './connect-weda-operations.mjs';

const dependencyRoot=process.argv[2];
if(!dependencyRoot) throw new Error('Supply directory containing validation-only node_modules');
const require=createRequire(resolve(dependencyRoot,'package.json'));
const Ajv=require('ajv');
const postcss=require('postcss');
const root=resolve(import.meta.dirname,'..');
const source=await readFile(resolve(root,'weda-admin/app.cals.json'),'utf8');
const app=JSON.parse(source);
const schema=JSON.parse(await readFile(resolve(root,'weda-admin/vendor/platform-application.schema.json'),'utf8'));
const contracts=JSON.parse(await readFile(resolve(root,'weda-admin/vendor/component-contracts-3.31.0.json'),'utf8'));
const ajv=new Ajv({strict:false,allErrors:true});
const validate=ajv.compile(schema);
const errors=[];
const schemaValid=validate(app);
if(!schemaValid) errors.push(...validate.errors);
// dataForm is an editor property map, not a standalone JSON Schema. Project only
// value constraints. Do not execute x-rules, templates, linkages or form widgets.
const literalKeywords=new Set(['type','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties','minContains','maxContains']);
const mapKeywords=new Set(['properties','patternProperties','definitions','$defs','dependentSchemas']);
const schemaKeywords=new Set(['items','additionalProperties','additionalItems','contains','propertyNames','not','if','then','else','unevaluatedProperties','unevaluatedItems']);
const arrayKeywords=new Set(['allOf','anyOf','oneOf','prefixItems']);
const projectedKeywords=new Set();
const normalization={duplicateAnchorsCoalesced:0,editorEnumOptionsProjected:0,editorBooleanRequiredExcluded:0,unavailableEditorEnumChoicesExcluded:0};
function projectSchema(value){
  if(typeof value==='boolean')return value;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid property value-schema');
  const out={};
  for(const [key,entry] of Object.entries(value)){
    if(literalKeywords.has(key))out[key]=entry;
    else if(key==='$id'||key==='$ref')out[key]=entry;
    else if(key==='enum'){
      // Some chart statistics selectors have no static choices in the control
      // bundle. An editor enum=[] cannot be compiled as JSON Schema; retain its
      // declared type and report that choice membership was not validated.
      if(Array.isArray(entry)&&entry.length===0){normalization.unavailableEditorEnumChoicesExcluded++;continue;}
      // StringEnum editor templates can store {value,label,src} options.
      // They describe string choices, not permissible object-valued inputs.
      const isEditorEnum=value.type==='string'&&Array.isArray(entry)&&entry.every(v=>v&&typeof v==='object'&&typeof v.value==='string');
      out.enum=isEditorEnum?entry.map(v=>v.value):entry;
      if(isEditorEnum)normalization.editorEnumOptionsProjected++;
    }else if(key==='required'){
      if(Array.isArray(entry))out.required=entry;
      else if(typeof entry==='boolean')normalization.editorBooleanRequiredExcluded++;
      else throw new Error('Unexpected required metadata');
    }else if(mapKeywords.has(key))out[key]=Object.fromEntries(Object.entries(entry).map(([k,v])=>[k,projectSchema(v)]));
    else if(schemaKeywords.has(key))out[key]=Array.isArray(entry)?entry.map(projectSchema):projectSchema(entry);
    else if(arrayKeywords.has(key))out[key]=entry.map(projectSchema);
    else if(key==='dependencies')out[key]=Object.fromEntries(Object.entries(entry).map(([k,v])=>[k,Array.isArray(v)?v:projectSchema(v)]));
    else continue;
    projectedKeywords.add(key);
  }
  return out;
}
function valueSchema(raw){
  const projected=projectSchema(raw);
  const anchors=new Map();
  function collect(value){
    if(!value||typeof value!=='object')return;
    if(!Array.isArray(value)&&value.$id){
      const body={...value};delete body.$id;
      const old=anchors.get(value.$id);
      if(old&&JSON.stringify(old)!==JSON.stringify(body))throw new Error(`Conflicting value-schema anchor ${value.$id}`);
      if(old)normalization.duplicateAnchorsCoalesced++;
      else anchors.set(value.$id,body);
    }
    for(const entry of Object.values(value))collect(entry);
  }
  collect(projected);
  const pointer=id=>`#/definitions/__weda_anchor_${id.replace(/~/g,'~0').replace(/\//g,'~1')}`;
  function rewrite(value){
    if(Array.isArray(value))return value.map(rewrite);
    if(!value||typeof value!=='object')return value;
    if(value.$id)return {$ref:pointer(value.$id)};
    const out={};
    for(const [key,entry] of Object.entries(value)){
      if(key==='$ref'){
        if(anchors.has(entry))out[key]=pointer(entry);
        else if(typeof entry==='string'&&entry.startsWith('#/'))out[key]=entry;
        else throw new Error(`Unresolved value-schema reference ${entry}`);
      }else out[key]=rewrite(entry);
    }
    return out;
  }
  const result=rewrite(projected);
  if(anchors.size)result.definitions={...result.definitions,...Object.fromEntries([...anchors].map(([id,body])=>[`__weda_anchor_${id}`,rewrite(body)]))};
  return result;
}
// Separate from the application schema registry; editor anchors such as Node
// are local to each projected attribute, never global schema identifiers.
const valueAjv=new Ajv({strict:false,allErrors:true,validateFormats:false});
const slots=new Map(contracts.map(c=>[c.name,new Set(Object.entries(c.dataForm||{}).filter(([,raw])=>raw.type==='slot').map(([key])=>key))]));
const props=new Map(contracts.map(c=>[c.name,new Map(Object.entries(c.dataForm||{}).filter(([,raw])=>raw.type!=='slot').map(([key,raw])=>{
  try{return [key,valueAjv.compile(valueSchema(raw))];}
  catch(error){throw new Error(`Cannot project ${c.name}.${key}: ${error.message}`);}
}))]));
const iconNames=new Set(contracts.find(c=>c.name==='WdIcon')?.dataForm?.name?.enum||[]);
const pageIds=app.items.map(p=>p.id);
const connectedPage=app.items.find(p=>p.id==='overview');
const connectedHandler=connectedPage?.resources?.find(r=>r.path==='overview/handler/loadCockpit');
const connected=!!connectedHandler;
const operationPages=new Map(app.items.filter(p=>p.id!=='overview').map(p=>[p.id,p.resources?.find(r=>r.path===`${p.id}/handler/operations`)]).filter(([,handler])=>handler));
const operationCommands=new Set(['init','clear','edit','choose','filter','query','reset','previous','next','select','detail','prepare','cancelConfirmation','submit','material','evidence','openPdf','downloadPdf','closeMaterial']);
const operationFields=new Set(['keyword','remark','feedback','source','educationLevel','financialAssetRange','evidenceReference']);
function operationListener(node,pageId){
  if(!operationPages.has(pageId)||!Array.isArray(node.listeners)||node.listeners.length!==1)return false;
  const listener=node.listeners[0],handler=listener.handler,target=handler?.params?.target;
  if(listener.type!=='rematch'||handler?.name!=='operations'||handler?.module!==pageId
    ||listener.eventName!==(node.component==='WdInput'?'change':'tap')||!target||!operationCommands.has(target.command))return false;
  if(Object.keys(handler.params).some(key=>key!=='target')||Object.keys(target).some(key=>!['command','field','index','operation','value'].includes(key)))return false;
  if(target.field!==undefined&&!operationFields.has(target.field))return false;
  if(target.index!==undefined&&(!Number.isInteger(target.index)||target.index<0||target.index>=10))return false;
  if(target.operation!==undefined&&!['approve','reject','revoke','cancel','toggle'].includes(target.operation))return false;
  return Object.values(target).every(value=>typeof value==='string'||typeof value==='number');
}
const statePrefix='$page.dataset.state';
function validBinding(expression){
  return typeof expression==='string'&&expression.includes(statePrefix)
    && !/[;{}=`]|\b(?:new|function|constructor|prototype|__proto__|fetch|require|import)\b/.test(expression.replaceAll('===','').replaceAll('!==',''))
    && !/\w\s*\(/.test(expression.replaceAll(statePrefix,''));
}
let buttons=0,disabled=0,nav=0,texts=0,unsafeLineHeights=0,charts=0,controlledActions=0;
for(const p of app.items){
  const seen=new Set();
  function walk(n){
    if(seen.has(n.id))errors.push(`${p.id}: duplicate ${n.id}`);
    seen.add(n.id);
    const attrs=n.attributes||{};
    if(attrs.class!==undefined&&typeof attrs.class!=='string')errors.push(`${p.id}/${n.id}: class must be a space-separated string`);
    if(attrs.style!==undefined&&(!attrs.style||typeof attrs.style!=='object'||Array.isArray(attrs.style)))errors.push(`${p.id}/${n.id}: style must be an object`);
    if(n.component&&n.component!=='Page'){
      const contract=props.get(n.component);
      if(!contract) errors.push(`Unverified component ${n.component}`);
      else for(const [key,value] of Object.entries(attrs)){
        if(['style','class','commonStyle'].includes(key))continue;
        if(key.startsWith(':')){
          if(!(p.id==='overview'?connected:operationPages.has(p.id))||!contract.has(key.slice(1))||!validBinding(value))errors.push(`${p.id}/${n.id}: unsupported dynamic binding ${key}`);
          continue;
        }
        const check=contract.get(key);
        if(!check)errors.push(`${p.id}/${n.id}: unknown ${key}`);
        else if(!check(value))errors.push({node:`${p.id}/${n.id}`,attribute:key,errors:structuredClone(check.errors)});
      }
      const componentSlots=slots.get(n.component);
      if(componentSlots?.size)for(const child of n.items||[])if(!componentSlots.has(child.id))errors.push(`${p.id}/${n.id}: unknown slot ${child.id}`);
    }
    const lh=attrs.style?.lineHeight;
    if(lh!==undefined && !/^(?:normal|[\d.]+(?:px|rpx|rem|em|%))$/.test(String(lh))){unsafeLineHeights++;errors.push(`${n.id}: unsafe lineHeight ${lh}`);}
    if(n.component==='WdMenuLayout')for(const item of [...(attrs.menu?.menuData||[]),...(attrs.menu?.mobileMenuData||[])]){
      if(item.iconUrl&&!item.iconUrl.startsWith('http')&&!iconNames.has(item.iconUrl))errors.push(`${p.id}/${n.id}: unsupported menu iconUrl for ${item.key}`);
      if(item.type==='route'&&!pageIds.includes(item.path?.replace(/^\//,'').split('?')[0]))errors.push(`${p.id}/${n.id}: invalid menu route ${item.key}`);
    }
    if(n.component==='WdText'){
      texts++;
      if((!attrs.text&&!attrs[':text']) || !lh)errors.push(`${n.id}: missing text or explicit lineHeight`);
      if(attrs.style?.color && attrs.style.color===attrs.style.backgroundColor)errors.push(`${n.id}: invisible text`);
    }
    if(n.component==='WdButton'){
      buttons++;
      if(!attrs.text?.trim())errors.push(`${n.id}: no button label`);
      const target=n.listeners?.[0]?.handler?.params?.pageId;
      if(target){nav++;if(!pageIds.includes(target)||attrs.disabled)errors.push(`${n.id}: invalid navigation`);}
      else if(operationListener(n,p.id)){controlledActions++;if(!validBinding(attrs[':disabled']))errors.push(`${n.id}: controlled button lacks reviewed disabling state`);}
      else{disabled++;if(attrs.disabled!==true || n.listeners?.length)errors.push(`${n.id}: unreviewed active business action`);}
      if(attrs.style.color===attrs.style.backgroundColor)errors.push(`${n.id}: button label invisible`);
    }
    if(n.component==='WdInput'&&attrs.status!=='disabled'&&!(operationListener(n,p.id)&&validBinding(attrs[':inputValue'])&&validBinding(attrs[':status'])))errors.push(`${n.id}: unsupported live filter`);
    if(['Line','Bar','Pie'].includes(n.component)){
      charts++;
      // Unconfigured data-model charts contain built-in demo series. The draft
      // must always take the variable branch with an explicit empty array.
      const field={memberGrowthChart:'memberTrend',revenueTrendChart:'revenueTrend',revenueMixChart:'productPie'}[n.id];
      const expression=field?`${statePrefix}.cockpit ? ${statePrefix}.cockpit.${field} : []`:null;
      const empty=Array.isArray(attrs.datasourceVariable)&&attrs.datasourceVariable.length===0;
      const bound=connected&&p.id==='overview'&&expression!==null&&attrs[':datasourceVariable']===expression;
      if(attrs.dataSourceType!=='variable'||(!empty&&!bound))errors.push(`${p.id}/${n.id}: chart must use empty data or the verified cockpit binding`);
    }
    for(const [key,value]of Object.entries(n.directives||{}))if(key!==':if'||!(p.id==='overview'?connected:operationPages.has(p.id))||!validBinding(value))errors.push(`${p.id}/${n.id}: unsupported conditional directive`);
    for(const child of n.items||[])walk(child);
  }
  walk(p);
}
const style=app.resources.find(r=>r.codeType==='style').code;
postcss.parse(style);
if(/#215c4d|#18312e/i.test(source))errors.push('Legacy green branding remains');
if(/\.database\(|\.collection\(/.test(source))errors.push('Unexpected direct database invocation');
if(connected){
  const runtime=(await readFile(resolve(root,'weda-admin/cockpit-runtime.js'),'utf8')).replace(/\r\n/g,'\n');
  if(connectedHandler.code!=='// HL_COCKPIT_READONLY_V1\n'+runtime)errors.push('Cockpit handler differs from reviewed runtime source');
  if((runtime.match(/\.callFunction\(/g)||[]).length!==1||!runtime.includes("name: 'hlAdminCockpit'"))errors.push('Unexpected cockpit function target');
  const resources=[...app.resources,...app.items.flatMap(p=>p.resources||[])];
  const operationRuntime=operationPages.size?(await readFile(resolve(root,'weda-admin/operations-runtime.js'),'utf8')).replace(/\r\n/g,'\n'):null;
  const reviewedLifecycles=[];
  for(const[pageId,handler]of operationPages){
    if(handler.code!=='// HL_OPERATIONS_V1\n'+operationRuntime)errors.push(`${pageId}: operations handler differs from reviewed source`);
    const lifecycle=app.items.find(page=>page.id===pageId)?.resources?.find(resource=>resource.path===`${pageId}/lifecycle`&&resource.codeType==='lifecycle');
    if(lifecycle?.code!==operationsLifecycle(pageId,operationRuntime))errors.push(`${pageId}: lifecycle must embed the reviewed runtime and retain its owning controller`);
    else reviewedLifecycles.push(lifecycle);
  }
  if(operationRuntime&&((operationRuntime.match(/\.callFunction\(/g)||[]).length!==1||!operationRuntime.includes("name: 'hlAdminOperations'")))errors.push('Unexpected management function target');
  const allowedResources=new Set([connectedHandler,...operationPages.values(),...reviewedLifecycles]);
  if(resources.some(r=>!allowedResources.has(r)&&/callFunction|\.database\(|\.collection\(|\bfetch\s*\(/.test(r.code||'')))errors.push('Unexpected remote invocation outside reviewed handlers');
}else if(/callFunction/.test(source))errors.push('Unexpected business API invocation');
if(nav!==5||pageIds.length!==6||(operationPages.size?operationPages.size!==5||controlledActions<40:buttons!==29||disabled!==24))errors.push('Unexpected action/page counts');
const report={checkedAt:new Date().toISOString(),schemaPackage:'@cloudbase/cals@1.2.25',componentVersion:'gsd-h5-react@3.31.0',schemaValid,schemaAndContractsValid:errors.length===0,componentContractValidation:{mode:'Known attributes and projected dataForm value constraints; not full editor or runtime behavior',validatedKeywords:[...projectedKeywords].filter(k=>!['$id','$ref'].includes(k)).sort(),localReferences:'Identical repeated editor anchors are coalesced into local definitions; conflicting or unresolved anchors fail',slotHandling:'Editor type=slot is not JSON Schema; slot names are checked against CALS child items',normalization,excludedMetadata:['x-* including x-rules and platform rules','editor default values, labels, descriptions and widgets','templates, linkages and action code','boolean required annotations','format annotations; no format validator is installed'],limitations:['Top-level omitted props rely on documented runtime defaults; no defaults are injected','CSS syntax and selected visible-state rules are checked, not full computed style','Rendering, interaction, menu navigation and backend authorization require runtime verification']},errors,pageIds,textCount:texts,buttonCount:buttons,disabledBusinessButtonCount:disabled,navigationButtonCount:nav,unsafeUnitlessLineHeights:unsafeLineHeights,remoteDataCallsPresent:false,businessRecordsPresent:false,appSha256:createHash('sha256').update(source).digest('hex'),visualAndRuntimeVerification:'Recorded separately; static checks do not prove rendered appearance'};
report.remoteDataCallsPresent=connected;
report.allowedReadOnlyFunction=connected?'hlAdminCockpit':null;
report.managementFunctions=operationPages.size?['hlAdminOperations']:[];
report.controlledBusinessButtonCount=controlledActions;
report.chartEmptyDataChecks={components:['Line','Bar','Pie'],chartCount:charts,requiredDataSourceType:'variable',initialDatasourceVariable:[],dynamicData:connected?'Verified overview cockpit bindings only':false,defaultDemoSourceAllowed:false};
if(normalization.unavailableEditorEnumChoicesExcluded)report.componentContractValidation.excludedMetadata.push('Empty editor enum[] choices are unavailable; declared types are validated but choice membership is not');
if(!process.argv.includes('--stdout'))await writeFile(resolve(root,'weda-admin/validation-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(errors.length)process.exitCode=1;
