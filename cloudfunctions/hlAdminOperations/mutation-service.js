'use strict';

// This module does not authorize callers or initialize an SDK. Its actor must
// come from the function's server-side authorization, never event.args.
const { createHash, randomUUID } = require('node:crypto');
const { versionFor, allowed, positiveId, identifier, KINDS } = require('./contracts');
const { normalizeCertificationReview, assetCertificationExpiresAt } = require('../hlApi/showcase-policy');
const { salonAvailability } = require('../hlApi/salon-policy');
const { DEFAULT_MEMBERSHIP_PLANS } = require('../hlApi/vip-membership-service');

const COLLECTIONS = Object.freeze({ matchmakers: 'hl_matchmakers', salons: 'hl_salon_events',
  plans: 'hl_membership_plans', certifications: 'hl_member_certifications',
  users: 'hl_users', profiles: 'hl_profiles', audit: 'hl_admin_audit_logs' });
const FIELDS = Object.freeze({
  'matchmakers.review': ['id', 'certificationStatus', 'remark', 'expectedVersion'],
  'certifications.review': ['userId', 'kind', 'applicationId', 'status', 'source', 'evidenceReference',
    'remark', 'feedback', 'educationLevel', 'financialAssetRange', 'expectedVersion'],
  'salons.review': ['id', 'status', 'remark', 'expectedVersion'],
  'salons.cancel': ['id', 'reason', 'expectedVersion'],
  // Catalog prices and product identities are currently fixed by hlApi.
  'plans.update': ['planCode', 'active', 'expectedVersion']
});
function fail(message, code = 42260) {
  return Object.assign(new Error(message), { code, status: Math.floor(code / 100) });
}
function text(value, maximum, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > maximum) throw fail(`${label}无效`);
  return value.trim();
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function normalize(action, args) {
  if (!Object.hasOwn(FIELDS, action)) throw fail('不支持的后台操作');
  allowed(args, FIELDS[action]);
  if (typeof args.expectedVersion !== 'string' || !/^v1_[a-f0-9]{64}$/.test(args.expectedVersion)) {
    throw fail('请先读取详情并提供有效记录版本');
  }
  const base = { expectedVersion: args.expectedVersion };
  if (action === 'plans.update') {
    if (typeof args.planCode !== 'string' || !DEFAULT_MEMBERSHIP_PLANS.some(plan => plan.planCode === args.planCode)) {
      throw fail('仅可管理现行六档固定套餐');
    }
    if (typeof args.active !== 'boolean') throw fail('套餐启停必须为布尔值');
    return { ...base, planCode: args.planCode, active: args.active };
  }
  if (action === 'certifications.review') {
    const userId = positiveId(args.userId);
    if (!KINDS.includes(args.kind)) throw fail('认证类型无效');
    const applicationId = identifier(args.applicationId);
    for (const key of ['status', 'source', 'evidenceReference', 'remark', 'feedback', 'educationLevel', 'financialAssetRange']) {
      if (args[key] !== undefined && typeof args[key] !== 'string') throw fail('认证审核字段必须为文本');
    }
    if (args.educationLevel !== undefined && args.kind !== 'education'
      || args.financialAssetRange !== undefined && args.kind !== 'assets') throw fail('认证审核字段与类型不匹配');
    let review;
    try { review = normalizeCertificationReview({ ...args, applicationId }); }
    catch (_error) { throw fail('认证审核结论、核验来源或凭据无效'); }
    return { ...base, userId, ...review };
  }
  const id = positiveId(args.id);
  if (action === 'matchmakers.review') {
    if (![1, 2].includes(args.certificationStatus)) throw fail('请选择驳回或通过主理人审核');
    return { ...base, id, certificationStatus: args.certificationStatus, remark: text(args.remark, 1000, '审核备注') };
  }
  if (action === 'salons.review') {
    if (!['upcoming', 'rejected'].includes(args.status)) throw fail('沙龙审核结论无效');
    return { ...base, id, status: args.status, remark: text(args.remark, 1000, '审核备注') };
  }
  return { ...base, id, reason: text(args.reason, 500, '取消原因') };
}
async function document(transaction, collection, id) {
  try {
    const result = await transaction.collection(collection).doc(id).get();
    if (!result || result.code || result.errCode) throw result || fail('后台记录读取失败', 50360);
    return result.data ? { ...result.data, _id: id } : null;
  } catch (error) {
    // A missing collection, permissions failure or transport error must abort.
    if (error?.errCode === 'DOCUMENT_NOT_EXIST' || error?.code === 'DOCUMENT_NOT_EXIST') return null;
    throw error;
  }
}
async function unique(db, collection, query) {
  const queries = Array.isArray(query) ? query : [query, ...Object.entries(query)
    .filter(([, value]) => typeof value === 'number').map(([key, value]) => ({ ...query, [key]: String(value) }))];
  const snapshots = await Promise.all(queries.map(where => db.collection(collection).where(where).limit(2).get()));
  const found = new Map();
  snapshots.forEach((snapshot, index) => {
    if (snapshot?.code || snapshot?.errCode) throw snapshot;
    if (!Array.isArray(snapshot?.data) || snapshot.data.length > 2) throw fail('后台记录读取失败', 50360);
    for (const row of snapshot.data) {
      if (!row || typeof row._id !== 'string' || !row._id
        || !Object.entries(queries[index]).every(([key, value]) => row[key] === value)) throw fail('后台记录标识或主键无效', 40960);
      found.set(row._id, row);
    }
  });
  if (found.size > 1) throw fail('记录存在重复主键，请先核对数据', 40960);
  return [...found.values()][0] || null;
}
async function write(ref, method, data) {
  // @cloudbase/node-sdk accepts the document directly. The older wx-server-sdk
  // {data: document} envelope would silently persist the wrong schema here.
  const result = await ref[method](data);
  if (!result || result.code || result.errCode) throw result || fail('后台记录写入失败', 50360);
}
function dataOnly(row) {
  const { _id, _openid, ...data } = row;
  return data;
}
function checkVersion(resource, current, args, kind) {
  if (versionFor(resource, current, kind) !== args.expectedVersion) throw fail('记录已变化，请刷新详情后重新确认', 40960);
}

function createMutationService({ db, now = () => new Date() } = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw fail('事务数据库不可用', 50360);
  return { async execute(action, input, actor) {
    if (!actor || typeof actor.uid !== 'string' || !/^[a-zA-Z0-9_@.:-]{4,128}$/.test(actor.uid)) throw fail('管理员身份无效', 40360);
    if (typeof actor.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(actor.requestId)) throw fail('操作重试标识无效');
    if (actor.serverRequestId !== undefined && (typeof actor.serverRequestId !== 'string'
      || !/^[a-zA-Z0-9_-]{8,128}$/.test(actor.serverRequestId))) throw fail('服务端追踪标识无效');
    const args = normalize(action, input);
    const timestamp = new Date(now()).toISOString();
    const serverRequestId = actor.serverRequestId || randomUUID();
    const auditId = 'op_' + digest(`${actor.uid}\n${actor.requestId}`);
    const fingerprint = digest(JSON.stringify(canonical({ action, args })));
    const resource = action.split('.')[0];
    // SDK transactions support document operations. Resolve a business key here,
    // then reread and validate that exact document inside the atomic transaction.
    let candidate, user, profile;
    if (resource === 'certifications') {
      [user, profile] = await Promise.all([unique(db, COLLECTIONS.users, { id: args.userId }),
        unique(db, COLLECTIONS.profiles, { userId: args.userId })]);
    } else {
      candidate = await unique(db, COLLECTIONS[resource], resource === 'plans'
        ? [{ planCode: args.planCode }, { code: args.planCode }] : { id: args.id });
      if (resource === 'matchmakers' && candidate && Number.isSafeInteger(Number(candidate.userId)) && Number(candidate.userId) > 0) {
        user = await unique(db, COLLECTIONS.users, { id: Number(candidate.userId) });
      }
    }
    const documentId = resource === 'certifications' ? `user_${args.userId}`
      : candidate?._id || (resource === 'plans' ? `plan_${args.planCode}` : null);
    const reviewId = randomUUID();
    return db.runTransaction(async transaction => {
      const previousOperation = await document(transaction, COLLECTIONS.audit, auditId);
      if (previousOperation) {
        if (previousOperation.fingerprint !== fingerprint || previousOperation.actor?.uid !== actor.uid
          || previousOperation.requestId !== actor.requestId || previousOperation.action !== action) {
          throw fail('此操作标识已用于其他内容，请重新发起操作', 40960);
        }
        if (!previousOperation.result) throw fail('操作审计记录不完整，请联系管理员', 40960);
        return previousOperation.result;
      }
      let current = documentId ? await document(transaction, COLLECTIONS[resource], documentId) : null;
      let target, beforeStatus, afterStatus, patch, changedFields;
      if (resource === 'certifications') {
        if (!current || Number(current.userId) !== args.userId) throw fail('当前认证记录不存在或所属会员不一致', 40960);
        checkVersion(resource, current, args, args.kind);
        const application = current.applications?.[args.kind];
        if (!application || application.requestId !== args.applicationId) throw fail('认证申请已变化，请重新核对当前申请', 40960);
        if (args.status !== 'revoked' && application.status !== 'pending') throw fail('当前申请已完成审核', 40960);
        if (args.status === 'revoked' && current.current?.[args.kind]?.status !== 'approved') throw fail('当前认证没有可撤销的通过结论', 40960);
        if (!['pending', 'approved', 'rejected', 'revoked'].includes(application.status)) throw fail('认证申请状态无效', 40960);
        const ids = application.materialIds;
        if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length) throw fail('认证申请材料记录无效', 40960);
        for (const id of ids) {
          const material = current.materials?.[id];
          if (!material || material.kind !== args.kind || material.status !== 'bound' || material.applicationId !== args.applicationId) {
            throw fail('认证材料不属于当前申请，请重新核对', 40960);
          }
        }
        if (!user || !profile) throw fail('待核验会员资料不存在', 40460);
        const [currentUser, currentProfile] = await Promise.all([document(transaction, COLLECTIONS.users, user._id),
          document(transaction, COLLECTIONS.profiles, profile._id)]);
        if (!currentUser || Number(currentUser.id) !== args.userId || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId
          || !currentProfile || Number(currentProfile.userId) !== args.userId) throw fail('会员资料已变化或失效', 40960);
        const { expectedVersion, userId, ...review } = args;
        const reviewed = { ...review, reviewId, reviewedAt: timestamp,
          reviewedBy: { role: 'admin', uid: actor.uid, requestId: serverRequestId },
          ...(args.kind === 'assets' && args.status === 'approved'
            ? { expiresAt: assetCertificationExpiresAt({ reviewedAt: timestamp }) } : {}) };
        const oldSummary = currentProfile.showcaseCertification || {};
        const canonicalConclusion = current.current?.[args.kind];
        const previousApproval = canonicalConclusion
          ? (canonicalConclusion.status === 'approved' ? canonicalConclusion : null)
          : oldSummary[args.kind]?.status === 'approved' ? oldSummary[args.kind] : null;
        const conclusion = args.status === 'rejected' && previousApproval ? previousApproval : reviewed;
        const summary = { ...oldSummary, policyVersion: 1, [args.kind]: { status: conclusion.status, source: conclusion.source || '',
          ...(args.kind === 'education' ? { level: conclusion.level || '' } : {}),
          ...(args.kind === 'assets' ? { financialAssetRange: conclusion.financialAssetRange || '',
            ...(conclusion.reviewedAt ? { reviewedAt: conclusion.reviewedAt } : {}),
            ...(assetCertificationExpiresAt(conclusion) ? { expiresAt: assetCertificationExpiresAt(conclusion) } : {}) } : {}) } };
        patch = { ...dataOnly(current), current: { ...(current.current || {}), [args.kind]: conclusion },
          reviews: [...(current.reviews || []), reviewed],
          applications: { ...(current.applications || {}), [args.kind]: { ...application, status: args.status, reviewedAt: timestamp, feedback: args.feedback } },
          updatedAt: timestamp };
        await write(transaction.collection(COLLECTIONS.certifications).doc(documentId), 'set', patch);
        await write(transaction.collection(COLLECTIONS.profiles).doc(profile._id), 'update', { showcaseCertification: summary, updatedAt: timestamp });
        target = { userId: args.userId, kind: args.kind, applicationId: args.applicationId };
        beforeStatus = application.status; afterStatus = args.status;
        changedFields = ['applications', 'current', 'reviews', 'showcaseCertification'];
      } else {
        if (resource === 'plans') {
          const defaults = DEFAULT_MEMBERSHIP_PLANS.find(plan => plan.planCode === args.planCode);
          if (!current) current = { ...defaults, active: true };
          if ((current.planCode || current.code) !== args.planCode
            || (current.planCode && current.code && current.planCode !== current.code)) throw fail('套餐记录身份或别名存在冲突', 40960);
        } else if (!current) throw fail('记录不存在', 40460);
        if (resource !== 'plans' && Number(current.id) !== args.id) throw fail('记录主键已变化', 40960);
        checkVersion(resource, current, args);
        if (resource === 'matchmakers') {
          if (Number(current.status) !== 1 || Number(current.certificationStatus) !== 0) throw fail('当前主理人记录不在待审核状态', 40960);
          const currentUser = user ? await document(transaction, COLLECTIONS.users, user._id) : null;
          if (!currentUser || Number(currentUser.id) !== Number(current.userId) || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId) {
            throw fail('主理人所属账号已变化或失效', 40960);
          }
          beforeStatus = Number(current.certificationStatus); afterStatus = args.certificationStatus;
          patch = { certificationStatus: args.certificationStatus, certificationRemark: args.remark, updatedAt: timestamp };
          changedFields = ['certificationStatus', 'certificationRemark']; target = { id: args.id };
        } else if (resource === 'salons') {
          const availability = salonAvailability({ ...current, status: 'upcoming' }, null, timestamp);
          const validFuture = Number.isFinite(new Date(current.eventDate || '').getTime()) && !availability.isExpired;
          if (action === 'salons.review') {
            const permitted = args.status === 'upcoming' ? current.status === 'pending' && validFuture
              : ['pending', 'upcoming'].includes(current.status);
            if (!permitted) throw fail('沙龙状态或时间已变化，不能执行此次审核', 40960);
            patch = { status: args.status, reviewRemark: args.remark, reviewedAt: timestamp, updatedAt: timestamp };
            changedFields = ['status', 'reviewRemark', 'reviewedAt'];
          } else {
            if (!['pending', 'upcoming', 'rejected'].includes(current.status) || !validFuture) throw fail('已结束或取消的沙龙不能取消', 40960);
            patch = { status: 'cancelled', cancelReason: args.reason, cancelledAt: timestamp, updatedAt: timestamp };
            changedFields = ['status', 'cancelReason', 'cancelledAt'];
          }
          beforeStatus = current.status; afterStatus = patch.status; target = { id: args.id };
        } else {
          patch = { active: args.active, updatedAt: timestamp };
          changedFields = ['active'];
          // Normalize only an already verified equivalent legacy alias. Existing
          // hlApi catalog reads use planCode, so active would otherwise be ignored.
          if (!current.planCode) { patch.planCode = args.planCode; changedFields.push('planCode'); }
          beforeStatus = current.active === undefined || current.active === true || [1, '1', 'true'].includes(current.active) ? 'active' : 'inactive';
          afterStatus = args.active ? 'active' : 'inactive'; target = { planCode: args.planCode };
        }
        const ref = transaction.collection(COLLECTIONS[resource]).doc(documentId);
        if (resource === 'plans' && !candidate) await write(ref, 'set', { ...dataOnly(current), ...patch, createdAt: timestamp });
        else await write(ref, 'update', patch);
      }
      const result = { action, target, status: afterStatus, changedFields,
        version: versionFor(resource, { ...current, ...patch }, args.kind), updatedAt: timestamp, requestId: actor.requestId,
        ...(resource === 'plans' ? { active: args.active } : {}) };
      // This pre-created ADMINONLY collection also holds the idempotency key.
      // Failure MUST roll back the target writes; never catch or skip it.
      await write(transaction.collection(COLLECTIONS.audit).doc(auditId), 'set', { action, target,
        actor: { uid: actor.uid }, requestId: actor.requestId, serverRequestId, fingerprint,
        beforeStatus, afterStatus, changedFields, createdAt: timestamp, result });
      return result;
    });
  } };
}

module.exports = { createMutationService, COLLECTIONS };
