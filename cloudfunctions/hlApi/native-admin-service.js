'use strict';

const { randomUUID } = require('node:crypto');
const { plain, allowed } = require('../hlAdminOperations/contracts');
const { buildCockpit } = require('../hlAdminCockpit/service');
const { createReadService } = require('../hlAdminOperations/read-service');
const { createMutationService } = require('../hlAdminOperations/mutation-service');
const { createMaterialService } = require('../hlAdminOperations/material-service');
const { createServiceIntakeService } = require('../hlAdminOperations/service-intake-service');

const READS = Object.freeze({
  'matchmakers.list': 'listMatchmakers', 'matchmakers.detail': 'detailMatchmaker',
  'certifications.list': 'listCertifications', 'certifications.detail': 'detailCertification',
  'salons.list': 'listSalons', 'salons.detail': 'detailSalon',
  'plans.list': 'listPlans', 'plans.detail': 'detailPlan',
  'orders.list': 'listOrders', 'orders.detail': 'detailOrder'
});
const SERVICE_READS = Object.freeze(['services.list', 'services.detail']);
const SERVICE_WRITES = Object.freeze(['services.assign', 'services.extend']);
const WRITES = Object.freeze(['matchmakers.review', 'certifications.review', 'salons.review', 'salons.cancel', 'plans.update', ...SERVICE_WRITES]);
const MATERIALS = Object.freeze(['certifications.evidence', 'certifications.material']);
const NATIVE_ADMIN_ACTIONS = Object.freeze(['overview', ...Object.keys(READS), ...SERVICE_READS, ...WRITES, ...MATERIALS, 'operations.prepare']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const authorizedActors = new WeakSet();
const FACTORIES = Object.freeze({ buildCockpit, createReadService, createMutationService, createMaterialService, createServiceIntakeService });

function failure(message, code = 42260) {
  return Object.assign(new Error(message), { code, status: Math.floor(code / 100) });
}
function deny() { throw failure('当前账号没有管理权限', 40360); }
function ownData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) deny();
  return descriptor.value;
}
function positiveInteger(value) {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    && !(typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))) return null;
  return Number(value);
}
function configuredIds(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384) return null;
  const ids = value.split(',').map(part => positiveInteger(part.trim()));
  return ids.some(id => id === null) ? null : new Set(ids);
}

// The caller must first verify the signed ACCESS token and fetch the current
// business user from the server database, on every request. This function does
// not verify JWT signatures and never creates a CloudBase internal identity.
function authorizeNativeAdmin(user, session, env = process.env) {
  if (!plain(user) || !plain(session) || !env || typeof env !== 'object') deny();
  const userId = ownData(session, 'userId');
  if (ownData(session, 'type') !== 'access' || !Number.isSafeInteger(userId) || userId <= 0
    || positiveInteger(ownData(user, 'id')) !== userId || positiveInteger(ownData(user, 'status')) !== 1
    || ownData(user, 'mergedIntoUserId')) deny();
  const currentVersion = ownData(user, 'authVersion'), tokenVersion = ownData(session, 'authVersion');
  const userVersion = currentVersion === undefined ? 1 : positiveInteger(currentVersion);
  const sessionVersion = tokenVersion === undefined ? 1 : positiveInteger(tokenVersion);
  if (!userVersion || !sessionVersion || userVersion !== sessionVersion) deny();
  const ids = configuredIds(ownData(env, 'MINIPROGRAM_ADMIN_USER_IDS'));
  if (!ids || !ids.has(userId)) deny();
  const actor = Object.freeze({ uid: `miniprogram:user:${userId}` });
  authorizedActors.add(actor);
  return actor;
}

function businessRequest(request) {
  allowed(request, ['action', 'args', 'requestId']);
  if (typeof request.action !== 'string' || !NATIVE_ADMIN_ACTIONS.includes(request.action)) {
    throw failure('此管理动作未开放', 40360);
  }
  const args = request.args === undefined ? {} : request.args;
  if (!plain(args) || Reflect.ownKeys(args).some(key => typeof key !== 'string'
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), 'value'))) throw failure('管理参数无效');
  if (request.requestId !== undefined && (typeof request.requestId !== 'string' || !UUID.test(request.requestId))) {
    throw failure('操作重试标识无效');
  }
  if (WRITES.includes(request.action) && request.requestId === undefined) throw failure('请先生成操作确认标识');
  return { action: request.action, args, requestId: request.requestId };
}

function safeFailure(error, requestId) {
  const messages = {
    40360: '当前账号无权执行此管理动作',
    42260: '管理参数无效，请检查后重试', 42250: '统计周期须为7、30或90天',
    40960: '记录已变化，请刷新详情后重新确认', 40460: '管理记录不存在',
    42240: '认证材料参数无效', 40940: '认证材料已变化，请重新选择',
    50340: '认证材料暂时不可用，请稍后重试', 50350: '经营统计暂时不可用，请稍后重试',
    50351: '管理服务暂时不可用，请稍后重试', 50360: '管理操作暂时无法完成，请稍后重试'
  };
  const code = Object.hasOwn(messages, error?.code) ? error.code : 50360;
  return Object.assign(failure(messages[code], code), { requestId });
}

// services is a server-side factory injection seam for isolated tests. No
// request field selects a factory, database, actor, key or storage downloader.
function createNativeAdminService({ db, downloadFile, secrets = {}, now = Date.now, services = {} } = {}) {
  allowed(services, Object.keys(FACTORIES));
  if (Object.values(services).some(factory => typeof factory !== 'function') || typeof now !== 'function') {
    throw failure('管理服务配置无效', 50360);
  }
  const factories = { ...FACTORIES, ...services };
  const currentTime = () => {
    const value = now();
    const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) throw failure('管理服务时间不可用', 50360);
    return time;
  };
  return { async execute(input, identity) {
    const serverRequestId = randomUUID();
    try {
      // An event-supplied lookalike or copied uid cannot become an actor.
      if (!identity || !authorizedActors.has(identity)) deny();
      const request = businessRequest(input);
      const { action, args } = request;
      const actor = { uid: identity.uid, serverRequestId };
      let data;
      if (action === 'operations.prepare') {
        allowed(args, []);
        data = { requestId: randomUUID() };
      } else if (action === 'overview') {
        allowed(args, ['periodDays']);
        const periodDays = args.periodDays === undefined ? 30 : args.periodDays;
        if (![7, 30, 90].includes(periodDays)) throw failure('统计周期须为7、30或90天', 42250);
        data = await factories.buildCockpit(db, { periodDays, now: currentTime() });
      } else if (Object.hasOwn(READS, action)) {
        data = await factories.createReadService({ db, now: currentTime })[READS[action]](args);
      } else if (SERVICE_READS.includes(action) || SERVICE_WRITES.includes(action)) {
        if (SERVICE_WRITES.includes(action)) actor.requestId = request.requestId;
        const service = factories.createServiceIntakeService({ db, now: currentTime });
        data = SERVICE_READS.includes(action) ? await service[action === 'services.list' ? 'list' : 'detail'](args)
          : await service.execute(action, args, actor);
      } else if (WRITES.includes(action)) {
        actor.requestId = request.requestId;
        data = await factories.createMutationService({ db, now: () => new Date(currentTime()) }).execute(action, args, actor);
      } else {
        const materials = factories.createMaterialService({ db, downloadFile, secrets: {
          encryptionKey: secrets.encryptionKey, jwtDerivedKey: secrets.jwtDerivedKey
        }, now: () => new Date(currentTime()).toISOString() });
        data = await materials[action === 'certifications.material' ? 'material' : 'evidence'](args, actor);
      }
      return { data, requestId: serverRequestId };
    } catch (error) { throw safeFailure(error, serverRequestId); }
  } };
}

module.exports = { authorizeNativeAdmin, createNativeAdminService, NATIVE_ADMIN_ACTIONS };
