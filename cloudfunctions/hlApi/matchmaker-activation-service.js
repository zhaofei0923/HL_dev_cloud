'use strict';

const { createHash } = require('node:crypto');
const { assertMatchmakerLifetimeProduct } = require('./matchmaker-activation-policy');
const { assertPurchaseContract } = require('./purchase-contract-policy');

const MAX_ACTIVATION_GRANTS = 20;
const positiveId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const documentId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const orderNumber = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => key !== '_openid').sort().map(key => [key, canonical(value[key])])) : value;

// The order stores this server-created fingerprint. A later administrator
// decision, replacement application, or other changed application cannot be
// overwritten by a delayed successful payment.
function matchmakerActivationSnapshot(row) {
  if (!row || !documentId(row._id)) return '';
  return createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex');
}

function matchmakerActivationEligibility(user, row) {
  if (!user || !positiveId(user.id) || Number(user.status) !== 1 || user.mergedIntoUserId) {
    return { eligible: false, reason: 'account_changed' };
  }
  if (!row || !positiveId(Number(row.id)) || Number(row.userId) !== user.id) {
    return { eligible: false, reason: 'matchmaker_application_changed' };
  }
  if (Number(row.status) !== 1) return { eligible: false, reason: 'matchmaker_inactive' };
  if (Number(row.certificationStatus) === 2) return { eligible: false, reason: 'matchmaker_already_active' };
  if (Number(row.certificationStatus) !== 0) return { eligible: false, reason: 'matchmaker_application_rejected' };
  const grants = grantsFor(row);
  if (!grants) return { eligible: false, reason: 'matchmaker_activation_ledger_invalid' };
  if (grants.length >= MAX_ACTIVATION_GRANTS) return { eligible: false, reason: 'matchmaker_activation_ledger_limit' };
  if (['revoked', 'manual'].includes(row.activationStatus) || row.activationStatus === 'active'
    || grants.some(grant => grant.status === 'active')) {
    return { eligible: false, reason: 'matchmaker_activation_revoked' };
  }
  return { eligible: true, reason: '' };
}

function serviceError(message, status = 409, code = 40907) {
  return Object.assign(new Error(message), { status, code });
}
function assertActivationOrder(order) {
  assertMatchmakerLifetimeProduct(order);
  if (!assertPurchaseContract(order) || !positiveId(order.userId) || !positiveId(order.matchmakerId)
    || !documentId(order.userDocumentId) || !documentId(order.matchmakerDocumentId)
    || !orderNumber(order.outTradeNo) || typeof order.payerOpenid !== 'string' || !order.payerOpenid.trim()
    || typeof order.matchmakerAuthorizationSnapshot !== 'string'
    || !/^[a-f0-9]{64}$/.test(order.matchmakerAuthorizationSnapshot)) {
    throw serviceError('主理人开通订单身份或申请快照无效');
  }
}
function grantsFor(row) {
  const grants = row.activationGrants === undefined ? [] : row.activationGrants;
  if (!Array.isArray(grants) || grants.length > MAX_ACTIVATION_GRANTS
    || grants.some(grant => !grant || !orderNumber(grant.orderNo) || !['active', 'refunded'].includes(grant.status)
      || grant.previousCertificationStatus !== 0 || typeof grant.previousCertificationRemark !== 'string')
    || new Set(grants.map(grant => grant.orderNo)).size !== grants.length) return null;
  return grants;
}

function createMatchmakerActivationService({ db, usersCollection = 'hl_users', matchmakersCollection = 'hl_matchmakers' } = {}) {
  if (!db || typeof db.collection !== 'function') throw serviceError('主理人开通服务暂不可用', 503, 50301);
  async function read(transaction, collection, id) {
    try {
      const result = await transaction.collection(collection).doc(id).get();
      if (!result || result.errCode || result.code) throw result || serviceError('主理人申请读取失败', 503, 50301);
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      return row ? { ...row, _id: id } : null;
    } catch (error) {
      const code = String(error && (error.errCode || error.code) || '');
      const message = String(error && (error.errMsg || error.message) || '');
      if (!/PERMISSION|ACCESS|DATABASE|NETWORK|TIMEOUT|CONNECTION|UNAUTHORIZED|INTERNAL|UNAVAILABLE|ECONN|ETIMEDOUT/i.test(code)
        && (code === 'DOCUMENT_NOT_EXIST'
          || /\bdocument(?:\s+with\s+_id\s+[^\r\n]+?)?\s+(?:does\s+not\s+exist|not\s+(?:exist|found))\b/i.test(message))) return null;
      throw error;
    }
  }
  async function update(transaction, id, patch) {
    const result = await transaction.collection(matchmakersCollection).doc(id).update({ data: patch });
    if (result && (result.errCode || result.code)) throw serviceError('主理人开通状态保存失败', 503, 50301);
  }
  function time(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw serviceError('主理人开通时间无效', 503, 50301);
    return new Date(value).toISOString();
  }
  const review = reason => ({ fulfilled: false, requiresReview: true, reviewReason: reason,
    idempotent: false, matchmaker: null });
  function owns(order, row) {
    return !!row && Number(row.id) === order.matchmakerId && Number(row.userId) === order.userId;
  }
  function paidOwner(order, row) {
    return row.activationSource === 'paid' && row.activationOrderNo === order.outTradeNo && row.activationStatus === 'active';
  }

  async function fulfill(transaction, order, timestamp) {
    assertActivationOrder(order);
    const activatedAt = time(timestamp);
    const user = await read(transaction, usersCollection, order.userDocumentId);
    const row = await read(transaction, matchmakersCollection, order.matchmakerDocumentId);
    if (!user || Number(user.id) !== order.userId || Number(user.status) !== 1 || user.mergedIntoUserId
      || user.openid !== order.payerOpenid) return review('account_changed');
    if (!owns(order, row)) return review('matchmaker_application_changed');
    const grants = grantsFor(row);
    if (!grants) return review('matchmaker_activation_ledger_invalid');
    const existing = grants.find(grant => grant.orderNo === order.outTradeNo);
    if (existing) {
      // An existing grant is a tombstone too: an old callback must never
      // restore access removed by an administrator or a verified refund.
      if (existing.status !== 'active' || !paidOwner(order, row)
        || Number(row.status) !== 1 || Number(row.certificationStatus) !== 2) {
        return { ...review('matchmaker_activation_revoked'), idempotent: true };
      }
      return { fulfilled: true, requiresReview: false, reviewReason: '', idempotent: true, matchmaker: row };
    }
    if (matchmakerActivationSnapshot(row) !== order.matchmakerAuthorizationSnapshot) return review('matchmaker_application_changed');
    const eligibility = matchmakerActivationEligibility(user, row);
    if (!eligibility.eligible) return review(eligibility.reason);
    if (grants.length >= MAX_ACTIVATION_GRANTS) return review('matchmaker_activation_ledger_limit');
    const grant = { orderNo: order.outTradeNo, status: 'active', grantedAt: activatedAt,
      previousCertificationStatus: 0, previousCertificationRemark: String(row.certificationRemark || '') };
    const patch = { certificationStatus: 2, certificationRemark: '付费自动开通（长期有效）',
      activationSource: 'paid', activationStatus: 'active', activationLifetime: true, activationExpireAt: null,
      activationOrderNo: order.outTradeNo, activationPaidAt: activatedAt, activationRefundedAt: null,
      activationGrants: [...grants, grant], updatedAt: activatedAt };
    await update(transaction, row._id, patch);
    return { fulfilled: true, requiresReview: false, reviewReason: '', idempotent: false, matchmaker: { ...row, ...patch } };
  }

  async function refund(transaction, order, timestamp) {
    assertActivationOrder(order);
    const refundedAt = time(timestamp);
    const row = await read(transaction, matchmakersCollection, order.matchmakerDocumentId);
    if (!owns(order, row)) return { ...review('matchmaker_application_changed'), revoked: false };
    const grants = grantsFor(row);
    if (!grants) return { ...review('matchmaker_activation_ledger_invalid'), revoked: false };
    const grant = grants.find(item => item.orderNo === order.outTradeNo);
    if (!grant) {
      if (paidOwner(order, row)) return { ...review('matchmaker_activation_ledger_invalid'), revoked: false };
      // The payment may have been recorded for human review without granting
      // any role. Its refund has no role or membership rights to remove.
      return { fulfilled: false, requiresReview: false, reviewReason: '', idempotent: true, revoked: false, matchmaker: row };
    }
    if (grant.status === 'refunded') return { fulfilled: false, requiresReview: false,
      reviewReason: '', idempotent: true, revoked: false, matchmaker: row };
    const ownActivation = paidOwner(order, row);
    const revokeCertification = ownActivation && Number(row.certificationStatus) === 2;
    const patch = { activationGrants: grants.map(item => item.orderNo === order.outTradeNo
      ? { ...item, status: 'refunded', refundedAt } : item), updatedAt: refundedAt,
    ...(ownActivation ? { activationStatus: 'refunded', activationLifetime: false, activationExpireAt: null, activationRefundedAt: refundedAt } : {}),
    ...(revokeCertification ? { certificationStatus: grant.previousCertificationStatus,
      certificationRemark: grant.previousCertificationRemark } : {}) };
    await update(transaction, row._id, patch);
    return { fulfilled: false, requiresReview: false, reviewReason: '', idempotent: false,
      revoked: revokeCertification, matchmaker: { ...row, ...patch } };
  }

  return { fulfill, refund };
}

module.exports = { createMatchmakerActivationService, matchmakerActivationSnapshot, matchmakerActivationEligibility,
  MAX_ACTIVATION_GRANTS };
