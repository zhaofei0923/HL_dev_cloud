'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../cloudfunctions/hlAdminCockpit/index.js');
const localRequire=createRequire(file);
const ENV='cloud1-d2gza7q9c8d69c721';
function runtime(){
  const calls={queries:0,builds:0};
  let active=true;
  const exported={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports:exported.exports,module:exported,Date,console:{warn(){}},
    require(name){
      if(name==='@cloudbase/node-sdk')return {init:({env})=>{assert.equal(env,ENV);return {database:()=>({})};},parseContext:value=>value};
      if(name==='tencentcloud-sdk-nodejs-tcb')return {tcb:{v20180608:{Client:class {async DescribeUserList(params){calls.queries++;assert.deepEqual(Array.from(params.UidList),['server-uid']);return {Data:{Total:1,UserList:[{Uid:'server-uid',UserStatus:active?'ACTIVE':'DISABLED',Type:'internalUser',Roles:[{RoleIdentity:'administrator'}]}]}};}}}}};
      if(name==='./service')return {buildCockpit:async(_db,options)=>{calls.builds++;return {periodDays:options.periodDays,asOf:'fixture'};}};
      return localRequire(name);
    }});
  return {main:exported.exports.main,calls,revoke(){active=false;}};
}
const context=()=>({namespace:ENV,environment:{TCB_ENV:ENV,TCB_UUID:'server-uid',TCB_ISANONYMOUS_USER:'false',
  TENCENTCLOUD_SECRETID:'id',TENCENTCLOUD_SECRETKEY:'key',TENCENTCLOUD_SESSIONTOKEN:'token'}});
test('client supplied identity and routes cannot authorize a statistical read',async()=>{
  const r=runtime();const result=await r.main({uid:'server-uid',role:'administrator',context:context(),path:'/admin/cockpit'},{});
  assert.equal(result.code,40150);assert.equal(r.calls.builds,0);assert.equal(r.calls.queries,0);
});
test('valid current internal administrator can read only a selected period and revocation takes effect immediately',async()=>{
  const r=runtime();const first=await r.main({periodDays:7,uid:'client-forged'},context());
  assert.equal(first.code,0);assert.equal(first.data.periodDays,7);r.revoke();
  const second=await r.main({periodDays:7},context());assert.equal(second.code,40350);
  assert.equal(r.calls.builds,1);assert.equal(r.calls.queries,2);
});
test('invalid windows are rejected before identity or database calls',async()=>{
  const r=runtime();for(const periodDays of [0,'30',365,{},null])assert.equal((await r.main({periodDays},context())).code,42250);
  assert.equal(r.calls.builds,0);assert.equal(r.calls.queries,0);
});
