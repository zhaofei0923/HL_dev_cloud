'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const { tcb } = require('tencentcloud-sdk-nodejs-tcb');
const { randomUUID } = require('node:crypto');
const { authorize, ENV_ID } = require('../hlAdminCockpit/auth');
const { allowed, identifier } = require('./contracts');
const { createReadService } = require('./read-service');
const { createMutationService } = require('./mutation-service');
const { createMaterialService } = require('./material-service');

const app = cloudbase.init({ env: ENV_ID });
const READS = Object.freeze({
  'matchmakers.list': 'listMatchmakers', 'matchmakers.detail': 'detailMatchmaker',
  'certifications.list': 'listCertifications', 'certifications.detail': 'detailCertification',
  'salons.list': 'listSalons', 'salons.detail': 'detailSalon',
  'plans.list': 'listPlans', 'plans.detail': 'detailPlan', 'orders.list': 'listOrders', 'orders.detail': 'detailOrder'
});
const WRITES = Object.freeze(['matchmakers.review', 'certifications.review', 'salons.review', 'salons.cancel', 'plans.update']);
const MATERIALS = Object.freeze(['certifications.evidence', 'certifications.material']);
// Official Weda cloud-sdk injects these into data before app.callFunction.
// They are caller-controlled transport metadata, never authorization inputs.
const SDK_METADATA = Object.freeze(['wedaAppId', 'userAgent', 'referrer', 'envType', 'wedaTarget', 'x-cloud-sdk-version']);
const describeUsers = (config, params) => new tcb.v20180608.Client(config).DescribeUserList(params);

exports.main = async (event = {}, context = {}) => {
  const serverRequestId = randomUUID();
  try {
    let parsed;
    try { parsed = cloudbase.parseContext(context); }
    catch { return { code: 40150, message: '请使用已授权的内部管理员账号登录', requestId: serverRequestId }; }
    const identity = await authorize(parsed, describeUsers);
    allowed(event, ['action', 'args', 'requestId', ...SDK_METADATA]);
    if (SDK_METADATA.some(key => event[key] !== undefined && event[key] !== null
      && (typeof event[key] !== 'string' || event[key].length > 4096))) {
      return { code: 42260, message: '调用元数据格式无效', requestId: serverRequestId };
    }
    if (typeof event.action !== 'string' || !(Object.hasOwn(READS, event.action) || WRITES.includes(event.action) || MATERIALS.includes(event.action))) {
      return { code: 40360, message: '此管理动作未开放', requestId: serverRequestId };
    }
    const args = event.args === undefined ? {} : event.args;
    const db = app.database({ throwOnCode: true });
    const actor = { uid: identity.uid, serverRequestId };
    let data;
    if (Object.hasOwn(READS, event.action)) data = await createReadService({ db })[READS[event.action]](args);
    else if (WRITES.includes(event.action)) {
      actor.requestId = identifier(event.requestId);
      data = await createMutationService({ db }).execute(event.action, args, actor);
    } else {
      const materials = createMaterialService({ db, downloadFile: input => app.downloadFile(input), secrets: {
        encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY,
        jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY
      } });
      data = await materials[event.action === 'certifications.material' ? 'material' : 'evidence'](args, actor);
    }
    return { code: 0, data, requestId: serverRequestId };
  } catch (failure) {
    const code = [40150, 40350, 42260, 40960, 40460, 40360, 50360, 42240, 40940, 50340, 50351].includes(failure?.code) ? failure.code : 50360;
    const safeMessage = [42260, 40960, 40460, 42240, 40940].includes(code)
      ? String(failure.message || '').slice(0, 160) : [40150, 40350, 40360].includes(code)
        ? '请使用已授权的内部管理员账号操作' : '管理操作暂时无法完成，请稍后重试';
    console.warn('admin_operation_failed', { code, requestId: serverRequestId });
    return { code, message: safeMessage, requestId: serverRequestId };
  }
};
exports.ACTIONS = Object.freeze([...Object.keys(READS), ...WRITES, ...MATERIALS]);
