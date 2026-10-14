'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize, currentIdentity, ENV_ID } = require('../cloudfunctions/hlAdminCockpit/auth');
const UID = 'fixture-internal-uid';
const credentials = { TENCENTCLOUD_SECRETID:'fixture-id', TENCENTCLOUD_SECRETKEY:'fixture-key', TENCENTCLOUD_SESSIONTOKEN:'fixture-token' };
const context = patch => ({ namespace:ENV_ID, environment:{TCB_UUID:UID,TCB_ENV:ENV_ID,TCB_ISANONYMOUS_USER:'false',...patch} });
const user = patch => ({Uid:UID,UserStatus:'ACTIVE',Type:'internalUser',Roles:[{RoleIdentity:'administrator'}],...patch});
const response = value => ({Data:{Total:1,UserList:[value]}});

test('reads only this invocation identity and asks the server for one exact UID', async () => {
  let captured;
  const result=await authorize(context(),async (config,params)=>{captured={config,params};return response(user());},credentials);
  assert.equal(result.uid,UID); assert.deepEqual(captured.params,{EnvId:ENV_ID,PageNo:1,PageSize:2,UidList:[UID]});
  assert.deepEqual(captured.config.credential,{secretId:'fixture-id',secretKey:'fixture-key',token:'fixture-token'});
});

test('anonymous, missing, malformed and cross-environment identity never reaches user lookup', async () => {
  let calls=0;
  for(const value of [{},context({TCB_UUID:undefined}),context({TCB_ISANONYMOUS_USER:'true'}),context({LOGINTYPE:'ANONYMOUS'}),context({TCB_ENV:'other'}),{...context(),namespace:'other'}]) {
    await assert.rejects(authorize(value,async()=>{calls++;return response(user());},credentials));
  }
  assert.equal(calls,0);
  assert.throws(()=>currentIdentity({namespace:ENV_ID,environment:{}}));
});

test('every invocation rechecks active internal administrator state and never inherits previous permission', async () => {
  let calls=0;
  const describe=async()=>{calls++;return response(user(calls===1?{}:{UserStatus:'DISABLED'}));};
  await authorize(context(),describe,credentials);
  await assert.rejects(authorize(context(),describe,credentials),error=>error.code===40350);
  assert.equal(calls,2);
});

test('external users, role removal, ambiguous results and UID mismatches fail closed', async () => {
  for(const value of [response(user({Type:'externalUser'})),response(user({Roles:[]})),response(user({Uid:'another'})),
    {Data:{Total:2,UserList:[user(),user()]}},{Data:{Total:1,UserList:[]}}, {Error:{Code:'AccessDenied'}}]) {
    await assert.rejects(authorize(context(),async()=>value,credentials),error=>error.code===40350);
  }
});

test('temporary credentials and API failures are not converted to an authorized identity', async () => {
  await assert.rejects(authorize(context(),async()=>response(user()),{}),error=>error.code===50351);
  await assert.rejects(authorize(context(),async()=>{throw new Error('CAM denied');},credentials),/CAM denied/);
});
