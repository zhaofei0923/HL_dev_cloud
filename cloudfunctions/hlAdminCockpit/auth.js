'use strict';

const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const REGION = 'ap-shanghai';
function denied(code = 40350) { return Object.assign(new Error('请使用已授权的内部管理员账号查看经营统计'), { code }); }

function currentIdentity(parsed) {
  // parseContext is called on THIS invocation. Do not use a process-global UID.
  const env = parsed && (parsed.environment || parsed.environ);
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw denied(40150);
  const uid = env.TCB_UUID;
  if (typeof uid !== 'string' || !/^[a-zA-Z0-9_@.:-]{4,128}$/.test(uid)
    || env.TCB_ISANONYMOUS_USER === 'true' || env.TCB_ISANONYMOUS_USER === true
    || /anonymous/i.test(String(env.LOGINTYPE || ''))) throw denied(40150);
  if ((parsed.namespace && parsed.namespace !== ENV_ID)
    || (env.TCB_ENV && env.TCB_ENV !== ENV_ID)
    || (!parsed.namespace && env.TCB_ENV !== ENV_ID)) throw denied(40150);
  return { uid, env };
}

function serverCredential(env, infrastructure = process.env) {
  // These are SCF infrastructure credentials, never request body credentials.
  const get = key => typeof env[key] === 'string' && env[key] ? env[key] : infrastructure[key];
  const credential = { secretId: get('TENCENTCLOUD_SECRETID'), secretKey: get('TENCENTCLOUD_SECRETKEY'), token: get('TENCENTCLOUD_SESSIONTOKEN') };
  if (Object.values(credential).some(value => typeof value !== 'string' || !value)) {
    throw Object.assign(new Error('统计身份校验暂不可用'), { code: 50351 });
  }
  return credential;
}

async function authorize(parsed, describeUsers, infrastructure) {
  const identity = currentIdentity(parsed);
  const credential = serverCredential(identity.env, infrastructure);
  const response = await describeUsers({ credential, region: REGION }, {
    EnvId: ENV_ID, PageNo: 1, PageSize: 2, UidList: [identity.uid]
  });
  const data = response && response.Response || response;
  const result = data && data.Data;
  if (data?.Error || !result || result.Total !== 1 || !Array.isArray(result.UserList) || result.UserList.length !== 1) throw denied();
  const user = result.UserList[0];
  if (user.Uid !== identity.uid || user.UserStatus !== 'ACTIVE' || user.Type !== 'internalUser'
    || !Array.isArray(user.Roles) || !user.Roles.some(role => role && role.RoleIdentity === 'administrator')) throw denied();
  return { uid: identity.uid };
}

module.exports = { authorize, currentIdentity, serverCredential, ENV_ID, REGION };
