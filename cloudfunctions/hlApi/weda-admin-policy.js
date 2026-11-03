'use strict';

const { normalizeCertificationReview } = require('./showcase-policy');

const WEDA_ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const WEDA_ENV_TYPE = 'prod';
const POLICY_VERSION = 1;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;
const CERTIFICATION_KINDS = Object.freeze(['identity', 'education', 'vehicle', 'property', 'assets']);
const CAPABILITIES = Object.freeze([
  'dashboard.read', 'matchmakers.read', 'matchmakers.review', 'salons.read', 'salons.review', 'salons.cancel',
  'certifications.read', 'membership-plans.read', 'payment-orders.read',
  ...CERTIFICATION_KINDS.flatMap(kind => [
    `certifications.${kind}.evidence.read`, `certifications.${kind}.materials.read`, `certifications.${kind}.review`
  ])
]);

const ACTIONS = Object.freeze({
  'dashboard.read': { capability: 'dashboard.read', method: 'GET', path: '/admin/dashboard', fields: [] },
  'matchmakers.list': { capability: 'matchmakers.read', method: 'GET', path: '/admin/matchmakers', fields: ['page', 'pageSize', 'keyword', 'status'] },
  'matchmakers.review': { capability: 'matchmakers.review', method: 'PUT', fields: ['matchmakerId', 'certificationStatus', 'remark'] },
  'salons.list': { capability: 'salons.read', method: 'GET', path: '/admin/salons', fields: ['page', 'pageSize', 'keyword', 'status'] },
  'salons.review': { capability: 'salons.review', method: 'POST', fields: ['salonId', 'status', 'remark'] },
  'salons.cancel': { capability: 'salons.cancel', method: 'PUT', fields: ['salonId'] },
  'certifications.list': { capability: 'certifications.read', method: 'GET', path: '/admin/member-certifications', fields: ['page', 'pageSize', 'userId'] },
  'certifications.evidence': { method: 'GET', fields: ['userId', 'kind', 'applicationId'] },
  'certifications.material': { method: 'GET', fields: ['userId', 'kind', 'applicationId', 'materialId'] },
  'certifications.review': { method: 'PUT', fields: ['userId', 'kind', 'applicationId', 'status', 'source', 'evidenceReference', 'remark', 'feedback', 'educationLevel', 'financialAssetRange'] },
  'membership-plans.list': { capability: 'membership-plans.read', method: 'GET', path: '/admin/membership-plans', fields: ['page', 'pageSize', 'active'] },
  'payment-orders.list': { capability: 'payment-orders.read', method: 'GET', path: '/admin/payment-orders', fields: ['page', 'pageSize', 'keyword', 'status', 'fulfillmentStatus', 'productType', 'userId'] }
});
const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function invalidInput() { return failure(422, 42240, '管理动作或参数无效'); }
function forbidden() { return failure(403, 40304, '当前账号无权执行此管理动作'); }
function invalidIdentity() { return failure(401, 40100, '请使用已授权的微搭内部账号登录'); }
function invalidConfiguration() { return failure(503, 50340, '管理权限配置尚未就绪'); }
function staleBinding() { return failure(409, 40940, '认证申请或关联材料已变化，请重新读取'); }

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}
function allowedFields(value, fields) {
  if (!plainRecord(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw invalidInput();
}
function text(value, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)
    || (required && !value.trim())) throw invalidInput();
  return value.trim();
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw invalidInput();
  return value;
}
function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw invalidInput();
  }
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,16}$/.test(value))) throw invalidInput();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) throw invalidInput();
  return number;
}
function choice(value, options) {
  if (!options.includes(value)) throw invalidInput();
  return value;
}
function pagination(args) {
  return { page: positiveInteger(args.page, 1, MAX_PAGE), pageSize: positiveInteger(args.pageSize, 20, MAX_PAGE_SIZE) };
}
function optionalText(args, data, key, maximum) {
  if (args[key] !== undefined) data[key] = text(args[key], maximum);
}
function optionalChoice(args, data, key, values) {
  if (args[key] !== undefined && args[key] !== '') data[key] = choice(args[key], values);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Only the platform-supplied custom-API context is supported here:
// https://docs.cloudbase.net/lowcode/datasource/add-methods#自定义代码-context
// Native cloud-function parseContext shapes intentionally require a separate,
// verified adapter. Do not pass caller params, process.env, or SDK fallbacks here.
function trustedIdentity(trustedContext) {
  if (!plainRecord(trustedContext)) throw invalidIdentity();
  const env = ownValue(trustedContext, 'env');
  if (!plainRecord(env)) throw invalidIdentity();
  const uid = ownValue(env, 'uid');
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.trim() !== uid || /[\x00-\x1f\x7f]/.test(uid)
    || ownValue(env, 'isAnonymous') !== false || ownValue(env, 'envId') !== WEDA_ENV_ID
    || ownValue(env, 'envType') !== WEDA_ENV_TYPE || ownValue(env, 'isPreview') !== false) throw invalidIdentity();
  return { uid, envId: WEDA_ENV_ID, envType: WEDA_ENV_TYPE };
}

function operatorFor(identity, serverPermissions) {
  if (!plainRecord(serverPermissions)) throw invalidConfiguration();
  const operator = ownValue(serverPermissions, identity.uid);
  if (!operator) throw forbidden();
  if (!plainRecord(operator) || ownValue(operator, 'enabled') !== true) throw forbidden();
  const capabilities = ownValue(operator, 'capabilities');
  if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string' || !CAPABILITIES.includes(value))) {
    throw invalidConfiguration();
  }
  const displayName = ownValue(operator, 'displayName');
  const wedaUserId = ownValue(operator, 'wedaUserId');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80 || /[\x00-\x1f\x7f]/.test(displayName)
    || (wedaUserId !== undefined && (typeof wedaUserId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(wedaUserId)))) {
    throw invalidConfiguration();
  }
  return { displayName: displayName.trim(), ...(wedaUserId !== undefined ? { wedaUserId } : {}), capabilities };
}

/**
 * Pure draft only; index.js does not load this module.
 * serverPermissions is a server-controlled, verified UID -> operator map, with
 * enabled, displayName, capabilities and optional verified wedaUserId. It defaults
 * to empty, never grants access because a caller claims role=admin, and must be
 * refreshed by the eventual adapter to apply account disabling/revocation.
 * serverRequestId is generated/provided by that adapter, never by caller params.
 * params.requestId is only a bounded, untrusted correlation ID.
 */
function prepareWedaAdminAction(options = {}) {
  if (!plainRecord(options)) throw invalidInput();
  const { trustedContext, params, serverPermissions = {}, serverRequestId } = options;
  const identity = trustedIdentity(trustedContext);
  const operator = operatorFor(identity, serverPermissions);
  allowedFields(params, ['action', 'args', 'requestId']);
  const action = params.action;
  if (typeof action !== 'string' || !ACTION_NAMES.includes(action)) throw forbidden();
  const spec = ACTIONS[action];
  const args = params.args === undefined ? {} : params.args;
  allowedFields(args, spec.fields);
  // All action parameters are scalar; this also excludes nested credential bags.
  for (const value of Object.values(args)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))) throw invalidInput();
  }
  if (typeof serverRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(serverRequestId)) throw invalidConfiguration();
  const clientRequestId = params.requestId === undefined ? undefined : identifier(params.requestId);
  let capability = spec.capability, path = spec.path, data = {}, target = {}, certificationBinding;

  if (['matchmakers.list', 'salons.list', 'certifications.list', 'membership-plans.list', 'payment-orders.list'].includes(action)) {
    data = pagination(args);
  }
  if (action === 'matchmakers.list') {
    optionalText(args, data, 'keyword', 80);
    if (args.status !== undefined && args.status !== '') data.status = choice(args.status, [0, 1, 2, '0', '1', '2']);
  } else if (action === 'matchmakers.review') {
    const matchmakerId = positiveInteger(args.matchmakerId);
    path = `/admin/matchmakers/${matchmakerId}/certification`;
    data.certificationStatus = choice(args.certificationStatus, [0, 1, 2]);
    optionalText(args, data, 'remark', 1000);
    target = { matchmakerId };
  } else if (action === 'salons.list') {
    optionalText(args, data, 'keyword', 80);
    optionalChoice(args, data, 'status', ['pending', 'upcoming', 'ongoing', 'ended', 'cancelled', 'rejected']);
  } else if (action === 'salons.review' || action === 'salons.cancel') {
    const salonId = positiveInteger(args.salonId);
    path = `/admin/salons/${salonId}/${action === 'salons.review' ? 'review' : 'cancel'}`;
    if (action === 'salons.review') {
      data.status = choice(args.status, ['upcoming', 'rejected']);
      optionalText(args, data, 'remark', 1000);
    }
    target = { salonId };
  } else if (action === 'certifications.list') {
    if (args.userId !== undefined && args.userId !== '') data.userId = positiveInteger(args.userId);
  } else if (['certifications.evidence', 'certifications.material', 'certifications.review'].includes(action)) {
    const userId = positiveInteger(args.userId), kind = choice(args.kind, CERTIFICATION_KINDS);
    const applicationId = identifier(args.applicationId);
    certificationBinding = { userId, kind, applicationId };
    target = { ...certificationBinding };
    if (action === 'certifications.evidence') {
      capability = `certifications.${kind}.evidence.read`;
      path = `/admin/member-certifications/${userId}/applications/${kind}/evidence`;
      data = { applicationId };
    } else if (action === 'certifications.material') {
      const materialId = identifier(args.materialId);
      capability = `certifications.${kind}.materials.read`;
      path = `/admin/member-certifications/${userId}/materials/${materialId}`;
      data = { applicationId };
      certificationBinding.materialId = materialId;
      target.materialId = materialId;
    } else {
      capability = `certifications.${kind}.review`;
      path = `/admin/member-certifications/${userId}`;
      const reviewInput = { kind, applicationId, status: args.status };
      for (const key of ['source', 'evidenceReference', 'remark', 'feedback', 'educationLevel', 'financialAssetRange']) {
        optionalText(args, reviewInput, key, key === 'feedback' ? 500 : ['remark', 'evidenceReference'].includes(key) ? 1000 : 80);
      }
      const review = normalizeCertificationReview(reviewInput);
      data = { kind, applicationId, status: review.status, source: review.source, evidenceReference: review.evidenceReference,
        remark: review.remark, feedback: review.feedback,
        ...(kind === 'education' ? { educationLevel: review.level } : {}),
        ...(kind === 'assets' ? { financialAssetRange: review.financialAssetRange } : {}) };
      if ((kind !== 'education' && args.educationLevel !== undefined)
        || (kind !== 'assets' && args.financialAssetRange !== undefined)) throw invalidInput();
    }
  } else if (action === 'membership-plans.list') {
    if (args.active !== undefined && args.active !== '') data.active = choice(args.active, [true, false]);
  } else if (action === 'payment-orders.list') {
    optionalText(args, data, 'keyword', 128);
    optionalChoice(args, data, 'status', ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']);
    optionalChoice(args, data, 'fulfillmentStatus', ['fulfilled', 'requires_review']);
    optionalChoice(args, data, 'productType', ['vip', 'matchmaking', 'legacy']);
    if (args.userId !== undefined && args.userId !== '') data.userId = positiveInteger(args.userId);
  }
  if (!operator.capabilities.includes(capability)) throw forbidden();
  const actor = { provider: 'weda', ...identity, displayName: operator.displayName,
    ...(operator.wedaUserId !== undefined ? { wedaUserId: operator.wedaUserId } : {}) };
  return freeze({ policyVersion: POLICY_VERSION, action, capability, method: spec.method, path, data, actor,
    audit: { serverRequestId, ...(clientRequestId !== undefined ? { clientRequestId } : {}), action, capability, actor: { ...actor }, target },
    ...(certificationBinding ? { certificationBinding } : {}) });
}

/** Run against a fresh server-read hl_member_certifications owner record before
 * evidence/material dispatch. The transaction in the business review must still
 * recheck the same applicationId. A plan alone is not proof of a current binding.
 */
function assertCertificationBinding(plan, record) {
  if (!plainRecord(plan) || !['certifications.evidence', 'certifications.material', 'certifications.review'].includes(plan.action)
    || !plainRecord(plan.certificationBinding)) throw invalidInput();
  const binding = plan.certificationBinding;
  if (!Number.isSafeInteger(binding.userId) || binding.userId <= 0 || !CERTIFICATION_KINDS.includes(binding.kind)
    || typeof binding.applicationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(binding.applicationId)
    || (plan.action === 'certifications.material' && (typeof binding.materialId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(binding.materialId)))) throw invalidInput();
  if (!plainRecord(record) || record.userId !== binding.userId || !plainRecord(record.applications)) throw staleBinding();
  const application = ownValue(record.applications, binding.kind);
  if (!plainRecord(application) || application.requestId !== binding.applicationId) throw staleBinding();
  const ids = application.materialIds;
  if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw staleBinding();
  if (binding.materialId !== undefined && !ids.includes(binding.materialId)) throw staleBinding();
  for (const id of ids) {
    const material = plainRecord(record.materials) ? ownValue(record.materials, id) : undefined;
    if (!plainRecord(material) || material.id !== id || material.kind !== binding.kind
      || material.applicationId !== binding.applicationId || material.status !== 'bound') throw staleBinding();
  }
  return true;
}

module.exports = {
  WEDA_ENV_ID, WEDA_ENV_TYPE, POLICY_VERSION, MAX_PAGE, MAX_PAGE_SIZE, CERTIFICATION_KINDS,
  CAPABILITIES, ACTION_NAMES, prepareWedaAdminAction, assertCertificationBinding
};
