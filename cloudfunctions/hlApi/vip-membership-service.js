'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isPremiumMembership } = require('./relationship-policy');
const { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder, assertPurchaseContract } = require('./purchase-contract-policy');
const { MATCHMAKER_LIFETIME_PLAN, assertMatchmakerLifetimeProduct } = require('./matchmaker-activation-policy');

const DAY_MS = 86400000;
const VIP_COLLECTIONS = Object.freeze({
  entitlements: 'hl_vip_entitlements',
  vipEntitlements: 'hl_vip_entitlements',
  matchmakingPackages: 'hl_matchmaking_packages',
  matchmakingRequests: 'hl_matchmaking_requests',
  matchmakingReadiness: 'hl_matchmaking_readiness',
  memberVisits: 'hl_member_visits',
  memberPrivacy: 'hl_member_privacy',
  wechatExchanges: 'hl_wechat_exchanges',
  onlineSubscriptions: 'hl_online_subscriptions',
  memberPresence: 'hl_member_presence'
});
const DEFAULT_MEMBERSHIP_PLANS = Object.freeze([
  { planCode: 'vip_week', title: 'VIP周卡', productType: 'vip', membershipTier: 'vip', amountFen: 6160, durationDays: 7, serviceCount: 0, sortOrder: 70 },
  { planCode: 'vip_month', title: 'VIP月卡', productType: 'vip', membershipTier: 'vip', amountFen: 19800, durationDays: 30, serviceCount: 0, sortOrder: 60 },
  { planCode: 'vip_quarter', title: 'VIP季卡', productType: 'vip', membershipTier: 'vip', amountFen: 39800, durationDays: 90, serviceCount: 0, sortOrder: 50 },
  { planCode: 'vip_year', title: 'VIP年卡', productType: 'vip', membershipTier: 'vip', amountFen: 69800, durationDays: 365, serviceCount: 0, sortOrder: 40 },
  { planCode: 'matchmaking_double', title: '人工牵线2次', productType: 'matchmaking', amountFen: 298000, durationDays: 30, serviceCount: 2, sortOrder: 30 },
  { planCode: 'matchmaking_month_6', title: '人工牵线1个月', productType: 'matchmaking', amountFen: 698000, durationDays: 30, serviceCount: 6, sortOrder: 20 }
].map(plan => Object.freeze({ ...plan, active: false, description: '', badge: '' })));
// Retired product IDs remain valid on immutable historical orders/packages,
// but must never become purchasable again through persisted catalog rows.
const RETIRED_MATCHMAKING_PLAN_CODES = Object.freeze([
  'matchmaking_month', 'matchmaking_quarter', 'matchmaking_halfyear', 'matchmaking_single', 'matchmaking_month_3'
]);
const CAPABILITIES = Object.freeze(['chat', 'exchangeWechat', 'unlimitedSwipe', 'advancedFilter', 'onlineReminder',
  'exclusiveSupport', 'memberBadge', 'likedMe', 'visitors', 'invisibleVisit', 'specialZones']);

function fail(message, status = 403, code = 40302) {
  return Object.assign(new Error(message), { status, code });
}
function userId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('用户编号无效', 400, 40001);
  return id;
}
function instant(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(`${raw}T16:00:00.000Z`);
  return Date.parse(raw);
}
function iso(value) { return new Date(value).toISOString(); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 32); }
function pairKey(a, b) { return [userId(a), userId(b)].sort((x, y) => x - y).join('_'); }
function bool(value, label) {
  if (typeof value !== 'boolean') throw fail(`${label}参数无效`, 400, 40001);
  return value;
}
function publicPackage(row, now) {
  const remainingCount = Math.max(0, Number(row.totalCount || 0) - Number(row.usedCount || 0));
  const status = row.status === 'refunded' ? 'refunded' : instant(row.expireAt) <= now ? 'expired'
    : remainingCount ? 'active' : 'exhausted';
  return { id: String(row.id || row._id), planTitle: String(row.planTitle || ''), startAt: row.startAt,
    expireAt: row.expireAt, totalCount: Number(row.totalCount || 0), usedCount: Number(row.usedCount || 0), remainingCount, status };
}
function publicRequest(row) {
  return { id: String(row.id), memberUserId: Number(row.memberUserId), targetUserId: Number(row.targetUserId),
    matchmakerId: Number(row.matchmakerId), status: row.status, memberConsent: row.memberConsent === true,
    targetConsent: row.targetConsent === true, serviceConfirmed: row.serviceConfirmed === true,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.serviceConfirmedAt ? { serviceConfirmedAt: row.serviceConfirmedAt } : {}),
    ...(row.connectedAt ? { connectedAt: row.connectedAt } : {}),
    ...(row.conversationId ? { conversationId: Number(row.conversationId) } : {}) };
}
function publicExchange(row, actorId) {
  const result = { id: String(row.id), requesterId: Number(row.requesterId), recipientId: Number(row.recipientId),
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.status === 'accepted' && row.requesterConsent === true && row.recipientConsent === true) {
    result.wechat = Number(actorId) === Number(row.requesterId)
      ? { mine: row.requesterWechatId, peer: row.recipientWechatId }
      : { mine: row.recipientWechatId, peer: row.requesterWechatId };
  }
  return result;
}
function wechatId(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 64 || /[\x00-\x1f\x7f]/.test(result)) throw fail('请填写有效微信号', 400, 40001);
  return result;
}
function vipProjection(record) {
  let expiry = instant(record.legacyExpireAt) || 0;
  const grants = [...(record.grants || [])].sort((a, b) => instant(a.grantedAt) - instant(b.grantedAt)
    || String(a.orderNo).localeCompare(String(b.orderNo)));
  const schedule = [];
  for (const grant of grants) {
    const durationMs = grant.status === 'refunded' ? Number(grant.retainedDurationMs || 0) : Number(grant.durationDays) * DAY_MS;
    const start = Math.max(expiry, instant(grant.grantedAt));
    expiry = start + durationMs;
    schedule.push({ ...grant, startAt: iso(start), expireAt: iso(expiry) });
  }
  return { lifetime: record.legacyLifetime === true, expireAt: record.legacyLifetime === true ? null : expiry ? iso(expiry) : null, grants: schedule };
}

function createVipMembershipService(dependencies = {}) {
  const { db, getAll, getOne, getById, assertPublicTarget, assertMatchmaker, connectPair, notify, canContact, hasFormalPair } = dependencies;
  const C = { users: 'hl_users', members: 'hl_members', profiles: 'hl_profiles', matchmakers: 'hl_matchmakers', ...VIP_COLLECTIONS };
  const clock = () => {
    const value = dependencies.now ? dependencies.now() : new Date();
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) throw fail('时间服务暂不可用', 503, 50301);
    return time;
  };
  if (!db || !getAll || !getOne || !getById) throw new Error('VIP service requires database read helpers');
  function logTransactionFailure(error, phase) {
    if (error && Number.isInteger(error.status)) return;
    const diagnostic = [error && error.errMsg, error && error.message].filter(value => typeof value === 'string').join(' ');
    const markers = ['ResourceUnavailable.TransactionConflict', 'ResourceUnavailable.TransactionNotExist',
      'ResourceUnavailable.TransactionTimeout', 'ResourceUnavailable.TransactionAborted',
      'DATABASE_TRANSACTION_CONFLICT', 'DATABASE_TRANSACTION_FAIL', 'DATABASE_REQUEST_FAILED',
      'DATABASE_PERMISSION_DENIED', 'DATABASE_COLLECTION_NOT_EXIST'].filter(marker => diagnostic.includes(marker) || error && error.code === marker);
    const providerCode = ['ResourceUnavailable.TransactionConflict', 'ResourceUnavailable.TransactionNotExist',
      'ResourceUnavailable.TransactionTimeout', 'ResourceUnavailable.TransactionAborted']
      .find(code => diagnostic.includes(`[${code}]`));
    // Never emit the SDK message: it can contain document and transaction IDs.
    console.warn('vip transaction failure', { phase,
      ...(Number.isSafeInteger(error && error.errCode) ? { errCode: error.errCode } : {}),
      errorType: error && ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error.name) ? error.name : 'Error', markers,
      ...(providerCode ? { providerCode } : {}),
      transactionConflictText: /\b(?:transaction|write)\s+(?:is\s+)?conflict(?:ed)?\b|事务冲突/i.test(diagnostic),
      transactionExpiredText: /\btransaction\s+(?:does\s+not\s+exist|not\s+(?:exist|found)|expired)|事务过期/i.test(diagnostic),
      timeoutText: /\b(?:timeout|timed\s+out)\b|超时/i.test(diagnostic) });
  }
  async function runTransaction(callback) {
    try { return await db.runTransaction(async transaction => {
      try { return await callback(transaction); }
      catch (error) {
        const wrappedConflict = error && error.errCode === -501001
          && [error.errMsg, error.message].some(value => typeof value === 'string'
            && value.includes('[ResourceUnavailable.TransactionConflict]'));
        if (error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' || wrappedConflict)) {
          // wx-server-sdk 2.4 drops the symbolic conflict code in doc operations.
          // Restore that code so the underlying SDK applies its bounded retries.
          const retryable = Object.assign(new Error('database transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
          console.warn('vip transaction retry', { category: 'database_transaction_conflict',
            ...(typeof error.errCode === 'number' ? { errCode: error.errCode } : {}) });
          throw retryable;
        }
        logTransactionFailure(error, 'callback');
        throw error;
      }
    }); } catch (error) {
      logTransactionFailure(error, 'transaction');
      throw error;
    }
  }
  async function optional(ref) {
    try {
      const result = await ref.get();
      return (Array.isArray(result.data) ? result.data[0] : result.data) || null;
    } catch (error) {
      const codes = [error && error.errCode, error && error.code].filter(value => value !== undefined && value !== null).map(String);
      const message = [error && error.errMsg, error && error.message].filter(value => typeof value === 'string').join(' ');
      // A missing row is normal. Permission, database and transport failures must
      // stay errors even when their diagnostic text also mentions a missing row.
      if (codes.some(code => /PERMISSION|ACCESS_DENIED|DATABASE|NETWORK|TIMEOUT|CONNECTION|UNAUTHORIZED|INTERNAL|UNAVAILABLE|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(code))) throw error;
      if (codes.includes('DOCUMENT_NOT_EXIST')
        || /\bdocument(?:\s+with\s+_id\s+[^\r\n]+?)?\s+(?:does\s+not\s+exist|not\s+(?:exist|found))\b/i.test(message)) return null;
      throw error;
    }
  }
  async function document(collection, id, transaction) {
    return optional((transaction || db).collection(collection).doc(String(id)));
  }
  async function save(transaction, collection, id, data) {
    const clean = { ...data };
    delete clean._id;
    await transaction.collection(collection).doc(String(id)).set({ data: clean });
    return { ...clean, _id: String(id) };
  }
  async function activeUser(id, transaction) {
    const user = await getById(C.users, userId(id));
    const current = transaction && user ? await document(C.users, user._id, transaction) : user;
    if (!current || Number(current.id) !== Number(id) || Number(current.status) !== 1 || current.mergedIntoUserId) {
      throw fail('账号不可用', 403, 40304);
    }
    return current;
  }
  async function accessible(actorId, targetId, transaction) {
    if (Number(actorId) === Number(targetId)) throw fail('不能选择自己', 400, 40001);
    await activeUser(actorId, transaction);
    await activeUser(targetId, transaction);
    if (!assertPublicTarget) throw fail('访问校验暂不可用', 503, 50301);
    return assertPublicTarget(Number(actorId), Number(targetId), transaction);
  }
  async function legacyBaseline(id, transaction) {
    const rows = await getAll(C.members, { userId: userId(id), status: 1 }, 1000);
    let lifetime = false, expiry = 0;
    for (const snapshot of rows) {
      const row = transaction ? await document(C.members, snapshot._id, transaction) : snapshot;
      if (!row || Number(row.status) !== 1 || Number(row.userId) !== Number(id) || !isPremiumMembership(row, new Date(clock()))) continue;
      if (row.expireAt === null || row.expireAt === undefined || String(row.expireAt).trim() === '') lifetime = true;
      else expiry = Math.max(expiry, instant(row.expireAt) || 0);
    }
    return { legacyLifetime: lifetime, legacyExpireAt: expiry ? iso(expiry) : null };
  }
  async function getEntitlement(id, options = {}) {
    id = userId(id);
    await activeUser(id, options.transaction);
    const now = options.now ? new Date(options.now).getTime() : clock();
    const record = await document(C.vipEntitlements, `vip_user_${id}`, options.transaction);
    const projection = record ? vipProjection(record) : await legacyBaseline(id, options.transaction);
    const lifetime = record ? projection.lifetime : projection.legacyLifetime;
    const expireAt = record ? projection.expireAt : projection.legacyExpireAt;
    const active = lifetime === true || instant(expireAt) > now;
    return { active, isPremiumMember: active, membershipTier: active ? 'vip' : 'free',
      expireAt: expireAt || null, lifetime: lifetime === true, source: record ? 'vip' : active ? 'legacy' : 'none',
      entitlements: Object.fromEntries(CAPABILITIES.map(key => [key, active])) };
  }
  async function requireVip(id, transaction) {
    const entitlement = await getEntitlement(id, { transaction });
    if (!entitlement.active) throw fail('开通VIP后可使用此权益');
    return entitlement;
  }
  async function preserveLegacyEntitlement(id) {
    id = userId(id);
    await activeUser(id);
    if (await document(C.vipEntitlements, `vip_user_${id}`)) return { preserved: false, existing: true };
    const baseline = await legacyBaseline(id);
    if (!baseline.legacyLifetime && !(instant(baseline.legacyExpireAt) > clock())) return { preserved: false, existing: false };
    return runTransaction(async transaction => {
      await activeUser(id, transaction);
      if (await document(C.vipEntitlements, `vip_user_${id}`, transaction)) return { preserved: false, existing: true };
      const trusted = await legacyBaseline(id, transaction);
      if (!trusted.legacyLifetime && !(instant(trusted.legacyExpireAt) > clock())) return { preserved: false, existing: false };
      const timestamp = iso(clock());
      await save(transaction, C.vipEntitlements, `vip_user_${id}`, { userId: id, ...trusted,
        lifetime: trusted.legacyLifetime, expireAt: trusted.legacyLifetime ? null : trusted.legacyExpireAt,
        grants: [], createdAt: timestamp, updatedAt: timestamp });
      return { preserved: true, existing: false };
    });
  }
  async function freezeLegacyEntitlement(id, transaction, timestamp = iso(clock())) {
    id = userId(id);
    const key = `vip_user_${id}`;
    if (await document(C.vipEntitlements, key, transaction)) return { preserved: false, existing: true };
    const baseline = await legacyBaseline(id, transaction);
    await save(transaction, C.vipEntitlements, key, { userId: id, ...baseline,
      lifetime: baseline.legacyLifetime, expireAt: baseline.legacyLifetime ? null : baseline.legacyExpireAt,
      grants: [], createdAt: timestamp, updatedAt: timestamp });
    return { preserved: baseline.legacyLifetime || instant(baseline.legacyExpireAt) > clock(), existing: false };
  }
  async function ensureIndependentEntitlement(id) {
    id = userId(id);
    await activeUser(id);
    if (await document(C.vipEntitlements, `vip_user_${id}`)) return { preserved: false, existing: true };
    return runTransaction(async transaction => {
      await activeUser(id, transaction);
      return freezeLegacyEntitlement(id, transaction);
    });
  }
  function trustedOrder(order) {
    const id = userId(order.userId);
    const orderNo = String(order.outTradeNo || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(orderNo)) throw fail('订单编号无效', 409, 40907);
    if (order.productType === 'matchmaker' || order.planCode === MATCHMAKER_LIFETIME_PLAN.planCode) {
      try { assertMatchmakerLifetimeProduct(order); assertPurchaseContract(order); }
      catch { throw fail('主理人开通订单规则无效', 409, 40907); }
      return { id, orderNo, durationDays: 0, serviceCount: 0 };
    }
    if (!['vip', 'matchmaking'].includes(order.productType)) throw fail('订单服务分类无效', 409, 40907);
    const durationDays = Number(order.durationDays);
    if (!Number.isSafeInteger(durationDays) || durationDays <= 0 || durationDays > 3650) throw fail('订单期限无效', 409, 40907);
    const serviceCount = Number(order.serviceCount || 0);
    if (order.productType === 'matchmaking' && (!Number.isSafeInteger(serviceCount) || serviceCount <= 0 || serviceCount > 1000)) {
      throw fail('订单牵线次数无效', 409, 40907);
    }
    return { id, orderNo, durationDays, serviceCount };
  }
  async function recordServiceIntake(transaction, id, orderNo, timestamp, firstConfirmedAt = timestamp) {
    const key = `intake_user_${id}`;
    const previous = await document(C.matchmakingReadiness, key, transaction);
    if (previous && (previous.kind !== 'service_intake' || Number(previous.userId) !== id
      || !Array.isArray(previous.orderNos))) throw fail('牵线服务受理记录异常，请联系工作人员', 409, 40906);
    const orderNos = previous ? previous.orderNos : [];
    if (orderNos.includes(orderNo) && previous.createdAt && previous.requestedAt) return;
    await save(transaction, C.matchmakingReadiness, key, { ...previous, kind: 'service_intake', userId: id,
      orderNos: orderNos.includes(orderNo) ? orderNos : [...orderNos, orderNo],
      createdAt: previous && previous.createdAt || firstConfirmedAt,
      requestedAt: previous && previous.requestedAt || firstConfirmedAt, updatedAt: timestamp });
  }
  async function fulfillOrder(transaction, order, timestamp = iso(clock())) {
    const { id, orderNo, durationDays, serviceCount } = trustedOrder(order);
    await activeUser(id, transaction);
    if (order.productType === 'matchmaker') {
      if (typeof dependencies.fulfillMatchmaker !== 'function') throw fail('主理人开通服务暂不可用', 503, 50301);
      return dependencies.fulfillMatchmaker(transaction, order, timestamp);
    }
    if (order.productType === 'vip') {
      const key = `vip_user_${id}`;
      const existing = await document(C.vipEntitlements, key, transaction);
      const base = existing || { userId: id, ...await legacyBaseline(id, transaction), grants: [], createdAt: timestamp };
      const previous = (base.grants || []).find(grant => grant.orderNo === orderNo);
      if (previous) return { ...await getEntitlement(id, { transaction, now: timestamp }), idempotent: true };
      if ((base.grants || []).length >= 1000) throw fail('会员订单过多，请联系工作人员', 409, 40906);
      const projection = vipProjection({ ...base, grants: [...(base.grants || []),
        { orderNo, durationDays, grantedAt: timestamp, status: 'active' }] });
      await save(transaction, C.vipEntitlements, key, { ...base, ...projection, updatedAt: timestamp });
      const active = projection.lifetime || instant(projection.expireAt) > new Date(timestamp).getTime();
      return { active, isPremiumMember: active, membershipTier: active ? 'vip' : 'free', expireAt: projection.expireAt,
        lifetime: projection.lifetime, idempotent: false };
    }
    const key = `package_${hash(orderNo)}`;
    const previous = await document(C.matchmakingPackages, key, transaction);
    if (previous) {
      if (Number(previous.userId) !== id || previous.orderNo !== orderNo) throw fail('牵线权益归属异常', 409, 40906);
      if (isDirectPurchaseOrder(previous)) {
        await recordServiceIntake(transaction, id, orderNo, timestamp, previous.createdAt || previous.startAt || timestamp);
      }
      return { package: publicPackage(previous, new Date(timestamp).getTime()), idempotent: true };
    }
    const indexKey = `matchmaking_user_${id}`;
    const index = await document(C.matchmakingPackages, indexKey, transaction) || { userId: id, packageIds: [] };
    if (index.packageIds.length >= 1000) throw fail('牵线套餐过多，请联系工作人员', 409, 40906);
    const row = { id: key, userId: id, orderNo, planCode: String(order.planCode || ''), planTitle: String(order.planTitle || ''),
      ...(isDirectPurchaseOrder(order) ? { productType: 'matchmaking', fulfillmentContract: DIRECT_PURCHASE_CONTRACT } : {}),
      startAt: timestamp, expireAt: iso(new Date(timestamp).getTime() + durationDays * DAY_MS), totalCount: serviceCount,
      originalTotalCount: serviceCount, usedCount: 0, status: 'active', createdAt: timestamp, updatedAt: timestamp };
    // A later human-service dossier can carry the historical `paid` label.
    // Freeze its pre-purchase legacy baseline so that label cannot grant VIP.
    await freezeLegacyEntitlement(id, transaction, timestamp);
    await save(transaction, C.matchmakingPackages, key, row);
    await save(transaction, C.matchmakingPackages, indexKey, { ...index, packageIds: [...index.packageIds, key], updatedAt: timestamp });
    if (isDirectPurchaseOrder(row)) await recordServiceIntake(transaction, id, orderNo, timestamp);
    return { package: publicPackage(row, new Date(timestamp).getTime()), idempotent: false };
  }
  async function refundOrder(transaction, order, timestamp = iso(clock())) {
    const { id, orderNo } = trustedOrder(order);
    if (order.productType === 'matchmaker') {
      if (typeof dependencies.refundMatchmaker !== 'function') throw fail('主理人退款处理暂不可用', 503, 50301);
      return dependencies.refundMatchmaker(transaction, order, timestamp);
    }
    if (order.productType === 'vip') {
      const key = `vip_user_${id}`;
      const record = await document(C.vipEntitlements, key, transaction);
      if (!record) return { revoked: false, idempotent: true };
      const current = vipProjection(record);
      const grant = current.grants.find(item => item.orderNo === orderNo);
      if (!grant || grant.status === 'refunded') return { revoked: false, idempotent: true };
      const retainedDurationMs = record.legacyLifetime ? 0
        : Math.max(0, Math.min(Number(grant.durationDays) * DAY_MS, new Date(timestamp).getTime() - instant(grant.startAt)));
      const grants = current.grants.map(item => item.orderNo === orderNo
        ? { ...item, status: 'refunded', retainedDurationMs, refundedAt: timestamp } : item);
      const projection = vipProjection({ ...record, grants });
      await save(transaction, C.vipEntitlements, key, { ...record, ...projection, updatedAt: timestamp });
      return { revoked: true, expireAt: projection.expireAt, lifetime: projection.lifetime, idempotent: false };
    }
    const key = `package_${hash(orderNo)}`;
    const row = await document(C.matchmakingPackages, key, transaction);
    if (!row || row.status === 'refunded') return { revoked: false, idempotent: true };
    if (Number(row.userId) !== id || row.orderNo !== orderNo) throw fail('牵线权益归属异常', 409, 40906);
    const updated = { ...row, totalCount: Number(row.usedCount || 0), refundedCount: Math.max(0, row.totalCount - row.usedCount),
      status: 'refunded', refundedAt: timestamp, updatedAt: timestamp };
    await save(transaction, C.matchmakingPackages, key, updated);
    return { revoked: true, package: publicPackage(updated, new Date(timestamp).getTime()), idempotent: false };
  }
  async function packageRows(id, transaction) {
    const index = await document(C.matchmakingPackages, `matchmaking_user_${userId(id)}`, transaction);
    if (!index) return [];
    const rows = [];
    for (const key of index.packageIds || []) {
      const row = await document(C.matchmakingPackages, key, transaction);
      if (row && Number(row.userId) === Number(id)) rows.push(row);
    }
    return rows;
  }
  async function packages(id) {
    await activeUser(id);
    const rows = (await packageRows(id)).sort((a, b) => instant(a.expireAt) - instant(b.expireAt));
    return { list: rows.map(row => publicPackage(row, clock())), total: rows.length };
  }
  // Only an authenticated administrative route may call this bookkeeping action.
  // It keeps the successful connection intact and returns the debit to its original package.
  async function restoreCredit(requestId, data, reviewerLabel) {
    if (typeof requestId !== 'string' || !/^request_[a-zA-Z0-9_-]{1,64}$/.test(requestId)) {
      throw fail('牵线记录编号无效', 400, 40001);
    }
    function auditText(value, maximum, label) {
      if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw fail(`${label}无效`, 400, 40001);
      const text = value.trim();
      if (!text || text.length > maximum) throw fail(`${label}无效`, 400, 40001);
      return text;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('审核信息无效', 400, 40001);
    const caseId = auditText(data.caseId, 128, '审核编号');
    const reason = auditText(data.reason, 500, '审核原因');
    const reviewer = auditText(reviewerLabel, 120, '审核人员');
    return runTransaction(async transaction => {
      const request = await document(C.matchmakingRequests, requestId, transaction);
      if (!request || request.id !== requestId) throw fail('牵线记录不存在', 404, 40400);
      if (request.status !== 'connected' || typeof request.packageId !== 'string'
        || !/^package_[a-zA-Z0-9_-]{1,96}$/.test(request.packageId)) {
        throw fail('仅已成功建联并扣次的记录可审核恢复', 409, 40909);
      }
      const ownerId = userId(request.memberUserId);
      const indexKey = `matchmaking_user_${ownerId}`;
      const packageRow = await document(C.matchmakingPackages, request.packageId, transaction);
      const index = await document(C.matchmakingPackages, indexKey, transaction);
      if (!packageRow || String(packageRow.id || packageRow._id) !== request.packageId
        || Number(packageRow.userId) !== ownerId || !index || Number(index.userId) !== ownerId
        || !Array.isArray(index.packageIds) || !index.packageIds.includes(request.packageId)) {
        throw fail('原牵线套餐归属异常，请人工核查', 409, 40906);
      }
      const previous = request.creditRestoration;
      if (previous) {
        if (previous.caseId !== caseId) throw fail('该牵线记录已通过其他审核恢复', 409, 40909);
        return { request: publicRequest(request), package: publicPackage(packageRow, clock()),
          creditRestoration: { ...previous }, idempotent: true };
      }
      const usedCount = Number(packageRow.usedCount);
      const totalCount = Number(packageRow.totalCount);
      const sequence = index.creditRestorationSequence === undefined ? 0 : Number(index.creditRestorationSequence);
      if (packageRow.status === 'refunded' || packageRow.refundedAt) throw fail('已退款套餐不能恢复次数', 409, 40909);
      if (!Number.isSafeInteger(totalCount) || totalCount <= 0 || !Number.isSafeInteger(usedCount)
        || usedCount <= 0 || usedCount > totalCount || !Number.isSafeInteger(sequence)
        || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
        throw fail('原牵线扣次账本异常，请人工核查', 409, 40906);
      }
      const now = clock();
      const timestamp = iso(now);
      const creditRestoration = { caseId, reason, reviewer, restoredAt: timestamp };
      const updatedPackage = { ...packageRow, usedCount: usedCount - 1, updatedAt: timestamp };
      const updatedRequest = { ...request, creditRestoration, updatedAt: timestamp };
      await save(transaction, C.matchmakingPackages, request.packageId, updatedPackage);
      await save(transaction, C.matchmakingPackages, indexKey, { ...index,
        creditRestorationSequence: sequence + 1, lastCreditRestorationCaseId: caseId, updatedAt: timestamp });
      await save(transaction, C.matchmakingRequests, requestId, updatedRequest);
      return { request: publicRequest(updatedRequest), package: publicPackage(updatedPackage, now),
        creditRestoration, idempotent: false };
    });
  }
  async function assignment(id, transaction) {
    const rows = await getAll(C.members, { userId: userId(id), status: 1 }, 100);
    for (const snapshot of rows) {
      const row = transaction ? await document(C.members, snapshot._id, transaction) : snapshot;
      if (row && Number(row.status) === 1 && Number(row.userId) === Number(id)) return row;
    }
    return null;
  }
  function defaultProfileComplete(user, profile) {
    const row = { ...user, ...(profile || {}) };
    const fields = ['realName', 'gender', 'age', 'height', 'city', 'nativePlace', 'education', 'occupation',
      'incomeRange', 'maritalStatus', 'houseStatus', 'carStatus', 'selfIntro', 'partnerRequirement'];
    return fields.every(field => String(row[field] || '').trim()) && Array.isArray(row.photos) && row.photos.length > 0;
  }
  async function readinessContext(id, transaction) {
    const user = await activeUser(id, transaction);
    const profileSnapshot = await getOne(C.profiles, { userId: Number(id) });
    const profile = transaction && profileSnapshot ? await document(C.profiles, profileSnapshot._id, transaction) : profileSnapshot;
    const member = await assignment(id, transaction);
    const mmSnapshot = member ? await getById(C.matchmakers, member.matchmakerId) : null;
    const mm = transaction && mmSnapshot ? await document(C.matchmakers, mmSnapshot._id, transaction) : mmSnapshot;
    let profileComplete;
    if (dependencies.getProfileCompletion) {
      const completion = await dependencies.getProfileCompletion(user, profile || {});
      profileComplete = completion === true || Number(completion) === 100 || completion && Number(completion.percent) === 100;
    } else profileComplete = defaultProfileComplete(user, profile);
    let activeAssignment = !!member && !!mm && Number(mm.status) === 1 && Number(mm.certificationStatus) === 2;
    let matchmakerUser = null;
    if (activeAssignment) {
      try { matchmakerUser = await activeUser(mm.userId, transaction); }
      catch (error) { if (error.status === 403) activeAssignment = false; else throw error; }
    }
    const record = await document(C.matchmakingReadiness, `readiness_user_${id}`, transaction);
    const matchmakerConfirmed = !!record && record.confirmed === true && activeAssignment
      && Number(record.memberRecordId) === Number(member.id) && Number(record.matchmakerId) === Number(member.matchmakerId)
      && String(record.profileVersion || '') === String(profile && profile.updatedAt || '');
    const ready = profileComplete && activeAssignment && matchmakerConfirmed;
    return { user, profile, member, mm, matchmakerUser, view: { ready: !!ready, profileComplete: !!profileComplete,
      matchmakerConfirmed: !!matchmakerConfirmed, activeAssignment, matchmakerId: member ? Number(member.matchmakerId) : null,
      reason: !profileComplete ? 'profile_incomplete' : !activeAssignment ? 'matchmaker_required'
        : !matchmakerConfirmed ? 'matchmaker_confirmation_required' : '' } };
  }
  async function getMatchmakingReadiness(id) { return (await readinessContext(userId(id))).view; }
  function matchmakingProgressView(packageList, context, intake) {
    const { profileComplete, activeAssignment: assigned, matchmakerConfirmed } = context.view;
    const activePackages = packageList.filter(row => row.status === 'active');
    const purchased = packageList.length > 0;
    const remainingCount = activePackages.reduce((sum, row) => sum + row.remainingCount, 0);
    const earliestExpireAt = activePackages.map(row => row.expireAt).filter(value => Number.isFinite(instant(value)))
      .sort((a, b) => instant(a) - instant(b))[0] || null;
    const firstPackageAt = packageList.map(row => row.startAt).filter(value => Number.isFinite(instant(value)))
      .sort((a, b) => instant(a) - instant(b))[0] || null;
    const requestedAt = intake && Number.isFinite(instant(intake.requestedAt)) ? intake.requestedAt : firstPackageAt;
    const status = !purchased ? 'not_purchased' : activePackages.length
      ? !profileComplete ? 'needs_profile' : !assigned ? 'awaiting_assignment' : !matchmakerConfirmed ? 'awaiting_contact' : 'ready'
      : packageList.some(row => row.status === 'exhausted') ? 'exhausted'
        : packageList.some(row => row.status === 'expired') ? 'expired' : 'refunded';
    return { status, purchased, profileComplete, assigned, matchmakerConfirmed,
      matchmakerId: assigned ? Number(context.mm.id) : null,
      matchmakerUserId: assigned ? Number(context.mm.userId) : null,
      matchmakerName: assigned ? String(context.matchmakerUser.nickname || context.mm.name || context.mm.realName || '主理人') : '',
      requestedAt, remainingCount, earliestExpireAt };
  }
  async function getMatchmakingProgress(id) {
    id = userId(id);
    const [packageList, context, intake] = await Promise.all([packages(id), readinessContext(id),
      document(C.matchmakingReadiness, `intake_user_${id}`)]);
    return matchmakingProgressView(packageList.list, context, intake);
  }
  async function assertMatchmakingReady(id, transaction) {
    const context = await readinessContext(userId(id), transaction);
    if (!context.view.ready) throw fail('请先完善档案并由主理人确认服务准备情况', 409, 40903);
    return context.view;
  }
  async function confirmReadiness(actorId, data) {
    const memberUserId = userId(data.memberUserId);
    if (!assertMatchmaker) throw fail('服务确认暂不可用', 503, 50301);
    const actor = await assertMatchmaker(Number(actorId), memberUserId);
    const confirmed = bool(data.confirmed, '确认');
    return runTransaction(async transaction => {
      await activeUser(actorId, transaction);
      const context = await readinessContext(memberUserId, transaction);
      if (!context.member || Number(context.member.matchmakerId) !== Number(actor.id) || !context.view.activeAssignment) {
        throw fail('会员服务关系已变化', 409, 40906);
      }
      if (confirmed && !context.view.profileComplete) throw fail('会员档案尚未完整', 409, 40903);
      await save(transaction, C.matchmakingReadiness, `readiness_user_${memberUserId}`, { userId: memberUserId,
        memberRecordId: Number(context.member.id), matchmakerId: Number(actor.id), confirmed,
        profileVersion: String(context.profile && context.profile.updatedAt || ''), confirmedBy: Number(actorId), updatedAt: iso(clock()) });
      return { ...context.view, matchmakerConfirmed: confirmed, ready: confirmed && context.view.profileComplete, reason: confirmed ? '' : 'matchmaker_confirmation_required' };
    });
  }
  async function createRequest(actorId, data) {
    const memberUserId = userId(data.memberUserId || actorId), targetUserId = userId(data.targetUserId);
    const selfRequest = Number(actorId) === memberUserId;
    const context = await readinessContext(memberUserId);
    if (!assertMatchmaker) throw fail('牵线服务暂不可用', 503, 50301);
    const mm = selfRequest ? context.mm : await assertMatchmaker(Number(actorId), memberUserId);
    if (!mm || !context.view.ready) throw fail('请先完善档案并由主理人确认服务准备情况', 409, 40903);
    await accessible(memberUserId, targetUserId);
    await assertMatchmakingReady(memberUserId);
    const id = `request_${randomUUID().replace(/-/g, '')}`;
    const slotId = `pair_${pairKey(memberUserId, targetUserId)}`;
    const timestamp = iso(clock());
    return runTransaction(async transaction => {
      await activeUser(actorId, transaction);
      await accessible(memberUserId, targetUserId, transaction);
      const own = await assignment(memberUserId, transaction);
      if (!own || Number(own.matchmakerId) !== Number(mm.id)) throw fail('会员服务关系已变化', 409, 40906);
      await assertMatchmakingReady(memberUserId, transaction);
      const slot = await document(C.matchmakingRequests, slotId, transaction);
      const previous = slot && slot.requestId ? await document(C.matchmakingRequests, slot.requestId, transaction) : null;
      if (previous && ['pending', 'connected'].includes(previous.status)) {
        if (Number(previous.matchmakerId) !== Number(mm.id)) throw fail('该对象已有其他主理人在处理牵线', 409, 40906);
        if (!selfRequest && previous.status === 'pending' && previous.serviceConfirmed !== true) {
          const approved = { ...previous, serviceConfirmed: true, serviceConfirmedAt: timestamp, updatedAt: timestamp };
          await save(transaction, C.matchmakingRequests, previous.id, approved);
          return publicRequest(approved);
        }
        return publicRequest(previous);
      }
      if (!hasFormalPair) throw fail('配对校验暂不可用', 503, 50301);
      if (await hasFormalPair(memberUserId, targetUserId, transaction)) throw fail('双方已建立联系，请跟进现有服务', 409, 40909);
      const rows = await packageRows(memberUserId, transaction);
      if (!rows.some(row => publicPackage(row, clock()).status === 'active')) throw fail('牵线次数不足或套餐已到期', 409, 40909);
      const row = { id, memberUserId, targetUserId, memberRecordId: Number(own.id), matchmakerId: Number(mm.id),
        matchmakerUserId: Number(mm.userId), requestedByUserId: Number(actorId),
        note: String(data.note || '').trim().slice(0, 500), status: 'pending', serviceConfirmed: !selfRequest,
        ...(!selfRequest ? { serviceConfirmedAt: timestamp } : {}),
        memberConsent: false, targetConsent: false, createdAt: timestamp, updatedAt: timestamp };
      await save(transaction, C.matchmakingRequests, id, row);
      await save(transaction, C.matchmakingRequests, slotId, { requestId: id, updatedAt: timestamp });
      return publicRequest(row);
    });
  }
  async function requestForActor(actorId, id, transaction, includeMatchmaker = false) {
    await activeUser(actorId, transaction);
    const row = await document(C.matchmakingRequests, id, transaction);
    if (!row || row.id !== id || ![row.memberUserId, row.targetUserId, ...(includeMatchmaker ? [row.matchmakerUserId] : [])].map(Number).includes(Number(actorId))) {
      throw fail('牵线记录不存在', 404, 40400);
    }
    return row;
  }
  async function respondRequest(actorId, id, data) {
    const accepted = bool(data.accepted, '同意');
    return runTransaction(async transaction => {
      const row = await requestForActor(actorId, id, transaction);
      if (row.status !== 'pending') return publicRequest(row);
      if (accepted && row.serviceConfirmed !== true) throw fail('请等待主理人审核牵线申请', 409, 40903);
      if (!accepted) {
        const updated = { ...row, status: 'rejected', updatedAt: iso(clock()),
          [Number(actorId) === Number(row.memberUserId) ? 'memberConsent' : 'targetConsent']: false };
        await save(transaction, C.matchmakingRequests, id, updated);
        return publicRequest(updated);
      }
      await accessible(row.memberUserId, row.targetUserId, transaction);
      const own = await assignment(row.memberUserId, transaction);
      if (!own || Number(own.id) !== Number(row.memberRecordId) || Number(own.matchmakerId) !== Number(row.matchmakerId)) {
        throw fail('会员服务关系已变化', 409, 40906);
      }
      if (!assertMatchmaker) throw fail('服务校验暂不可用', 503, 50301);
      const currentMm = await assertMatchmaker(Number(row.matchmakerUserId), Number(row.memberUserId), transaction);
      if (Number(currentMm.id) !== Number(row.matchmakerId)) throw fail('会员服务关系已变化', 409, 40906);
      const timestamp = iso(clock());
      const consentField = Number(actorId) === Number(row.memberUserId) ? 'memberConsent' : 'targetConsent';
      const updated = { ...row, [consentField]: accepted, status: accepted ? 'pending' : 'rejected', updatedAt: timestamp };
      if (updated.memberConsent && updated.targetConsent && accepted) {
        await assertMatchmakingReady(row.memberUserId, transaction);
        if (!hasFormalPair) throw fail('配对校验暂不可用', 503, 50301);
        if (await hasFormalPair(row.memberUserId, row.targetUserId, transaction)) {
          throw fail('双方已建立联系，请跟进现有服务', 409, 40909);
        }
        // Both requests and the owner index participate in the same transaction.
        // The index serializes distinct simultaneous requests before package debit.
        const ownerIndexKey = `matchmaking_user_${row.memberUserId}`;
        const index = await document(C.matchmakingPackages, ownerIndexKey, transaction);
        const rows = await packageRows(row.memberUserId, transaction);
        const available = rows.filter(packageRow => publicPackage(packageRow, clock()).status === 'active')
          .sort((a, b) => instant(a.expireAt) - instant(b.expireAt) || String(a.id).localeCompare(String(b.id)));
        const selected = available[0];
        if (!selected) throw fail('牵线次数不足或套餐已到期', 409, 40909);
        if (!connectPair) throw fail('建立联系暂不可用', 503, 50301);
        const connection = await connectPair({ userAId: row.memberUserId, userBId: row.targetUserId,
          matchmakerId: row.matchmakerId, requestId: row.id, transaction });
        if (!connection || !connection.matchRecordId || !connection.conversationId) throw fail('建立联系未完成，请稍后重试', 503, 50301);
        await save(transaction, C.matchmakingPackages, selected.id, { ...selected, usedCount: Number(selected.usedCount || 0) + 1, updatedAt: timestamp });
        await save(transaction, C.matchmakingPackages, ownerIndexKey, { ...index, updatedAt: timestamp, lastRequestId: row.id });
        Object.assign(updated, { status: 'connected', packageId: selected.id, connectedAt: timestamp,
          matchRecordId: Number(connection.matchRecordId), conversationId: Number(connection.conversationId) });
      }
      await save(transaction, C.matchmakingRequests, id, updated);
      return publicRequest(updated);
    });
  }
  async function approveRequest(actorId, id) {
    if (!assertMatchmaker) throw fail('服务审核暂不可用', 503, 50301);
    return runTransaction(async transaction => {
      const row = await requestForActor(actorId, id, transaction, true);
      if (Number(actorId) !== Number(row.matchmakerUserId)) throw fail('仅所属主理人可审核申请', 403, 40304);
      const mm = await assertMatchmaker(Number(actorId), Number(row.memberUserId), transaction);
      if (Number(mm.id) !== Number(row.matchmakerId)) throw fail('会员服务关系已变化', 409, 40906);
      await assertMatchmakingReady(row.memberUserId, transaction);
      await accessible(row.memberUserId, row.targetUserId, transaction);
      if (row.status !== 'pending' || row.serviceConfirmed === true) return publicRequest(row);
      const timestamp = iso(clock());
      const updated = { ...row, serviceConfirmed: true, serviceConfirmedAt: timestamp, updatedAt: timestamp };
      await save(transaction, C.matchmakingRequests, id, updated);
      return publicRequest(updated);
    });
  }
  async function cancelRequest(actorId, id) {
    return runTransaction(async transaction => {
      const row = await requestForActor(actorId, id, transaction, true);
      if (row.status !== 'pending') return publicRequest(row);
      if (Number(actorId) === Number(row.matchmakerUserId)) {
        if (!assertMatchmaker) throw fail('服务校验暂不可用', 503, 50301);
        const mm = await assertMatchmaker(Number(actorId), Number(row.memberUserId), transaction);
        if (Number(mm.id) !== Number(row.matchmakerId)) throw fail('无权取消该牵线', 403, 40304);
      }
      const updated = { ...row, status: 'cancelled', updatedAt: iso(clock()) };
      await save(transaction, C.matchmakingRequests, id, updated);
      return publicRequest(updated);
    });
  }
  async function requests(id) {
    await activeUser(id);
    const groups = await Promise.all(['memberUserId', 'targetUserId', 'matchmakerUserId'].map(field => getAll(C.matchmakingRequests, { [field]: Number(id) }, 1000)));
    const ownRows = [...new Map(groups.flat().filter(row => row.id).map(row => [row.id, row])).values()]
      .sort((a, b) => instant(b.createdAt) - instant(a.createdAt));
    const list = [];
    for (const row of ownRows) {
      if ([Number(row.memberUserId), Number(row.targetUserId)].includes(Number(id))) list.push(publicRequest(row));
      else if (assertMatchmaker) {
        try {
          const mm = await assertMatchmaker(Number(id), Number(row.memberUserId));
          if (Number(mm.id) === Number(row.matchmakerId)) list.push(publicRequest(row));
        } catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
    }
    return { list, total: list.length };
  }
  async function privacy(id) {
    const entitlement = await getEntitlement(id);
    const row = await document(C.memberPrivacy, `privacy_user_${userId(id)}`);
    return { invisible: entitlement.active && row && row.invisible === true || false };
  }
  async function setPrivacy(id, data) {
    const invisible = bool(data.invisible, '隐身');
    return runTransaction(async transaction => {
      await requireVip(id, transaction);
      await save(transaction, C.memberPrivacy, `privacy_user_${userId(id)}`, { userId: Number(id), invisible, updatedAt: iso(clock()) });
      return { invisible };
    });
  }
  async function recordVisit(id, targetId) {
    id = userId(id); targetId = userId(targetId);
    if (id === targetId) return { recorded: false };
    await accessible(id, targetId);
    const dateKey = iso(clock() + 8 * 3600000).slice(0, 10);
    return runTransaction(async transaction => {
      await accessible(id, targetId, transaction);
      const setting = await document(C.memberPrivacy, `privacy_user_${id}`, transaction);
      const entitlement = await getEntitlement(id, { transaction });
      if (setting && setting.invisible === true && entitlement.active) return { recorded: false };
      const key = `visit_${id}_${targetId}_${dateKey}`;
      const previous = await document(C.memberVisits, key, transaction);
      await save(transaction, C.memberVisits, key, { id: key, visitorUserId: id, targetUserId: targetId,
        visitedAt: iso(clock()), createdAt: previous && previous.createdAt || iso(clock()) });
      return { recorded: true };
    });
  }
  async function visitors(id, data = {}) {
    await requireVip(id);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('请填写有效分页参数', 400, 40001);
    const integer = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) throw fail('请填写有效分页参数', 400, 40001);
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result <= 0) throw fail('请填写有效分页参数', 400, 40001);
      return result;
    };
    const page = integer(data.page, 1), pageSize = integer(data.pageSize, 20);
    const offset = (page - 1) * pageSize;
    if (pageSize > 50 || !Number.isSafeInteger(offset)) throw fail('请填写有效分页参数', 400, 40001);
    const rows = (await getAll(C.memberVisits, { targetUserId: userId(id) }, Infinity)).sort((a, b) => instant(b.visitedAt) - instant(a.visitedAt));
    const latest = new Map();
    for (const row of rows) {
      const visitorId = Number(row.visitorUserId);
      if (Number.isSafeInteger(visitorId) && visitorId > 0 && visitorId !== Number(id) && !latest.has(visitorId)) latest.set(visitorId, row);
    }
    let eligible;
    let views;
    if (dependencies.visitorViews) {
      views = await dependencies.visitorViews(Number(id), [...latest.keys()]);
      if (!views || typeof views.get !== 'function') throw fail('来访资料暂不可用', 503, 50301);
      eligible = [...latest.values()].filter(row => Number(views.get(Number(row.visitorUserId))?.visitorUserId) === Number(row.visitorUserId));
    } else {
      eligible = [];
      for (const row of latest.values()) {
        try { await accessible(id, row.visitorUserId); eligible.push(row); }
        catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
    }
    const selected = eligible.slice(offset, offset + pageSize);
    const list = await Promise.all(selected.map(async row => {
      const visitorUserId = Number(row.visitorUserId);
      const view = views ? views.get(visitorUserId) : await activeUser(visitorUserId);
      const avatarUrl = typeof view.avatarUrl === 'string' && view.avatarUrl ? { avatarUrl: view.avatarUrl } : {};
      return { id: String(row.id), visitorUserId, visitedAt: row.visitedAt,
        displayName: String(views ? view.displayName || '会员' : view.nickname || '会员'), ...avatarUrl };
    }));
    if (dependencies.resolveVisitorPage && list.length) {
      const resolved = await dependencies.resolveVisitorPage(list);
      if (!Array.isArray(resolved) || resolved.length !== list.length) throw fail('来访照片暂不可用', 503, 50301);
      return { list: list.map((row, index) => ({ ...row, ...(typeof resolved[index]?.avatarUrl === 'string' ? { avatarUrl: resolved[index].avatarUrl } : {}) })),
        total: eligible.length, page, pageSize };
    }
    return { list, total: eligible.length, page, pageSize };
  }
  async function exchangeForActor(id, key, transaction) {
    await activeUser(id, transaction);
    const row = await document(C.wechatExchanges, key, transaction);
    if (!row || row.id !== key || ![Number(row.requesterId), Number(row.recipientId)].includes(Number(id))) throw fail('微信交换记录不存在', 404, 40400);
    await accessible(row.requesterId, row.recipientId, transaction);
    return row;
  }
  async function createExchange(id, data) {
    const targetId = userId(data.targetUserId), contact = wechatId(data.wechatId);
    await requireVip(id);
    await accessible(id, targetId);
    if (!canContact || !(await canContact(Number(id), targetId))) throw fail('请先互相喜欢或完成牵线后交换微信', 403, 40300);
    const key = `exchange_${pairKey(id, targetId)}`;
    return runTransaction(async transaction => {
      await requireVip(id, transaction);
      await accessible(id, targetId, transaction);
      if (!(await canContact(Number(id), targetId, transaction))) throw fail('双方联系关系已变化', 403, 40300);
      const previous = await document(C.wechatExchanges, key, transaction);
      if (previous && ['pending', 'accepted'].includes(previous.status)) return publicExchange(previous, id);
      const timestamp = iso(clock());
      const row = { id: key, requesterId: Number(id), recipientId: targetId, requesterWechatId: contact,
        recipientWechatId: '', requesterConsent: true, recipientConsent: false, status: 'pending', createdAt: timestamp, updatedAt: timestamp };
      await save(transaction, C.wechatExchanges, key, row);
      return publicExchange(row, id);
    });
  }
  async function respondExchange(id, key, data) {
    const accepted = bool(data.accepted, '同意');
    return runTransaction(async transaction => {
      const row = await exchangeForActor(id, key, transaction);
      if (Number(row.recipientId) !== Number(id)) throw fail('仅接收方可回应微信交换', 403, 40304);
      if (row.status !== 'pending') return publicExchange(row, id);
      const updated = { ...row, recipientConsent: accepted, recipientWechatId: accepted ? wechatId(data.wechatId) : '',
        status: accepted ? 'accepted' : 'rejected', updatedAt: iso(clock()) };
      await save(transaction, C.wechatExchanges, key, updated);
      return publicExchange(updated, id);
    });
  }
  async function exchanges(id) {
    await activeUser(id);
    const groups = await Promise.all(['requesterId', 'recipientId'].map(field => getAll(C.wechatExchanges, { [field]: Number(id) }, 1000)));
    const rows = [...new Map(groups.flat().map(row => [row.id, row])).values()].sort((a, b) => instant(b.createdAt) - instant(a.createdAt));
    const list = [];
    for (const row of rows) {
      try { await accessible(row.requesterId, row.recipientId); list.push(publicExchange(row, id)); }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    return { list, total: list.length };
  }
  async function onlineSubscriptions(id) {
    await activeUser(id);
    const rows = await getAll(C.onlineSubscriptions, { userId: Number(id), active: true }, 100);
    const list = [];
    for (const row of rows) {
      try { await accessible(id, row.targetUserId); list.push({ targetUserId: Number(row.targetUserId), active: true }); }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    return { list, total: list.length };
  }
  async function setOnlineSubscription(id, data) {
    const targetId = userId(data.targetUserId), active = bool(data.active, '订阅');
    if (active) {
      await requireVip(id); await accessible(id, targetId);
      if (!canContact || !(await canContact(Number(id), targetId))) throw fail('请先互相喜欢或完成牵线后订阅上线提醒', 403, 40300);
    }
    else await activeUser(id);
    return runTransaction(async transaction => {
      if (active) {
        await requireVip(id, transaction); await accessible(id, targetId, transaction);
        if (!canContact || !(await canContact(Number(id), targetId, transaction))) throw fail('双方联系关系已变化', 403, 40300);
      }
      const key = `subscription_${userId(id)}_${targetId}`;
      await save(transaction, C.onlineSubscriptions, key, { id: key, userId: Number(id), targetUserId: targetId, active, updatedAt: iso(clock()) });
      return { targetUserId: targetId, active };
    });
  }
  async function touchPresence(id) {
    id = userId(id);
    await activeUser(id);
    const subscriptionRows = await getAll(C.onlineSubscriptions, { targetUserId: id, active: true }, 1000);
    return runTransaction(async transaction => {
      const user = await activeUser(id, transaction);
      const key = `presence_user_${id}`;
      const previous = await document(C.memberPresence, key, transaction);
      const timestamp = iso(clock()), dateKey = iso(clock() + 8 * 3600000).slice(0, 10);
      const onlineTransition = !previous || instant(previous.lastSeenAt) <= clock() - 5 * 60000;
      const notifiedByUser = previous && previous.notificationDate === dateKey ? { ...(previous.notifiedByUser || {}) } : {};
      const notifications = [];
      if (onlineTransition && notify) {
        for (const snapshot of subscriptionRows) {
          const subscription = await document(C.onlineSubscriptions, snapshot._id, transaction);
          if (!subscription || !subscription.active || Number(subscription.targetUserId) !== id || notifiedByUser[subscription.userId]) continue;
          try {
            await requireVip(subscription.userId, transaction);
            await accessible(subscription.userId, id, transaction);
            if (!canContact || !(await canContact(Number(subscription.userId), id, transaction))) continue;
            notifications.push({ receiverId: Number(subscription.userId), senderId: id,
              messageType: 'online_reminder', content: `${String(user.nickname || '你关注的会员')}上线了。`, transaction });
            notifiedByUser[subscription.userId] = true;
          } catch (error) { if (![403, 404].includes(error.status)) throw error; }
        }
      }
      for (const notification of notifications) await notify(notification);
      await save(transaction, C.memberPresence, key, { userId: id, lastSeenAt: timestamp, notificationDate: dateKey, notifiedByUser });
      return { online: true };
    });
  }
  async function overview(id) {
    const entitlement = await getEntitlement(id);
    const [packageList, context, intake, setting, subscriptions] = await Promise.all([packages(id), readinessContext(id),
      document(C.matchmakingReadiness, `intake_user_${userId(id)}`), privacy(id), onlineSubscriptions(id)]);
    return { ...entitlement, vipMembership: entitlement.active
      ? { tier: 'vip', expireAt: entitlement.expireAt, lifetime: entitlement.lifetime } : null,
      matchmakingPackages: packageList.list, matchmakingReadiness: context.view,
      matchmakingProgress: matchmakingProgressView(packageList.list, context, intake), privacy: setting, onlineSubscriptions: subscriptions.list };
  }
  async function handleRoute(id, method, path, data = {}) {
    if (path === '/member/vip/overview' && method === 'GET') return overview(id);
    if (path === '/member/vip/privacy' && method === 'GET') return privacy(id);
    if (path === '/member/vip/privacy' && method === 'POST') return setPrivacy(id, data);
    if (path === '/member/vip/visitors' && method === 'GET') return visitors(id, data);
    if (path === '/member/vip/visits' && method === 'POST') return recordVisit(id, data.targetUserId);
    if (path === '/member/vip/wechat-exchanges' && method === 'GET') return exchanges(id);
    if (path === '/member/vip/wechat-exchanges' && method === 'POST') return createExchange(id, data);
    const exchangeMatch = path.match(/^\/member\/vip\/wechat-exchanges\/(exchange_\d+_\d+)(\/respond)?$/);
    if (exchangeMatch && method === 'GET' && !exchangeMatch[2]) return publicExchange(await exchangeForActor(id, exchangeMatch[1]), id);
    if (exchangeMatch && method === 'POST' && exchangeMatch[2]) return respondExchange(id, exchangeMatch[1], data);
    if (path === '/member/vip/online-subscriptions' && method === 'GET') return onlineSubscriptions(id);
    if (path === '/member/vip/online-subscriptions' && method === 'POST') return setOnlineSubscription(id, data);
    if (path === '/member/vip/presence' && method === 'POST') return touchPresence(id);
    if (path === '/member/matchmaking/packages' && method === 'GET') return packages(id);
    if (path === '/member/matchmaking/readiness' && method === 'GET') {
      const targetId = data.memberUserId === undefined ? userId(id) : userId(data.memberUserId);
      if (targetId !== Number(id)) {
        if (!assertMatchmaker) throw fail('服务校验暂不可用', 503, 50301);
        await assertMatchmaker(Number(id), targetId);
      }
      return getMatchmakingReadiness(targetId);
    }
    if (path === '/member/matchmaking/readiness' && method === 'POST') return confirmReadiness(id, data);
    if (path === '/member/matchmaking/requests' && method === 'GET') return requests(id);
    if (path === '/member/matchmaking/requests' && method === 'POST') return createRequest(id, data);
    const requestMatch = path.match(/^\/member\/matchmaking\/requests\/(request_[a-zA-Z0-9_-]{1,64})\/(respond|cancel|approve)$/);
    if (requestMatch && method === 'POST') return requestMatch[2] === 'respond'
      ? respondRequest(id, requestMatch[1], data) : requestMatch[2] === 'approve'
        ? approveRequest(id, requestMatch[1]) : cancelRequest(id, requestMatch[1]);
    return undefined;
  }
  return { getEntitlement, overview, fulfillOrder, refundOrder, preserveLegacyEntitlement, ensureIndependentEntitlement, restoreCredit, packages, getMatchmakingReadiness, getMatchmakingProgress,
    assertMatchmakingReady, handleRoute, recordVisit, touchPresence };
}

module.exports = { createVipMembershipService, VIP_COLLECTIONS, DEFAULT_MEMBERSHIP_PLANS, RETIRED_MATCHMAKING_PLAN_CODES };
