'use strict';

const { buildCockpitMemberStatistics } = require('../hlApi/cockpit-member-statistics');
const { aggregateRevenueStatistics } = require('../hlApi/cockpit-revenue-statistics');
const { createVipMembershipService } = require('../hlApi/vip-membership-service');
const { ownCertificationOverview, publicCertificationFields } = require('../hlApi/showcase-policy');

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const MAX_ROWS = 50000;
const COLLECTIONS = Object.freeze({
  users: 'hl_users', members: 'hl_members', profiles: 'hl_profiles', matchmakers: 'hl_matchmakers',
  certifications: 'hl_member_certifications', presence: 'hl_member_presence',
  entitlements: 'hl_vip_entitlements', orders: 'hl_payment_orders'
});
const fields = names => Object.fromEntries(['_id', ...names].map(name => [name, true]));
const SOURCE_FIELDS = ['isDemo', 'isTest', 'identitySource', 'dataSource', 'source'];
const FIELDS = Object.freeze({
  users: fields(['id', 'status', 'mergedIntoUserId', 'nickname', 'createdAt', 'openid', ...SOURCE_FIELDS]),
  members: fields(['id', 'userId', 'matchmakerId', 'status', 'createdAt', 'expireAt', 'memberType', 'membershipTier', 'remark', ...SOURCE_FIELDS]),
  profiles: fields(['userId', 'status', 'createdAt', 'displayEnabled', 'city', 'province',
    'showcaseCertification.policyVersion', 'showcaseCertification.identity.status', 'showcaseCertification.identity.source', ...SOURCE_FIELDS]),
  matchmakers: fields(['id', 'userId', 'status', 'certificationStatus', 'createdAt', ...SOURCE_FIELDS]),
  certifications: fields(['userId', 'current.identity.status', 'current.identity.source']),
  presence: fields(['userId', 'lastSeenAt']),
  entitlements: fields(['userId', 'legacyLifetime', 'legacyExpireAt', 'lifetime', 'expireAt', 'grants']),
  orders: fields(['outTradeNo', 'userId', 'status', 'paymentProvider', 'merchantId', 'appId', 'currency',
    'amountFen', 'transactionId', 'paidAt', 'payerOpenid', 'confirmationSource', 'fulfillmentStatus',
    'virtualPaymentEnv', 'virtualPaymentOfferId', 'virtualPaidAttemptNo', 'virtualPaymentAttempts',
    'duplicateVirtualPayments', 'refundId', 'refundAmountFen', 'refundedAt', 'refundSource', 'reviewReason',
    'planCode', 'planTitle', 'productType', 'durationDays', 'serviceCount',
    'paymentTestPlanCode', 'paymentTestRunId', 'isTest', 'isDemo', 'testMode', 'source', 'dataSource', 'origin', 'createdAt'])
});

function problem(message, code = 50350) { return Object.assign(new Error(message), { code }); }

function periodFor(now, days) {
  const start = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET - (days - 1) * DAY;
  return { days, startAt: new Date(start).toISOString(), endAt: new Date(now).toISOString(), timeZone: 'Asia/Shanghai' };
}

async function readSnapshot(db, name, projection) {
  const result = [];
  let cursor;
  while (true) {
    let query = db.collection(name);
    if (cursor !== undefined) query = query.where({ _id: db.command.gt(cursor) });
    const snapshot = await query.orderBy('_id', 'asc').field(projection).limit(100).get();
    if (!snapshot || !Array.isArray(snapshot.data)) throw problem('统计数据读取失败，请稍后重试');
    const batch = snapshot.data;
    if (batch.length > 100) throw problem('统计数据读取异常');
    for (const row of batch) {
      if (!row || typeof row._id !== 'string' || (cursor !== undefined && row._id <= cursor)) {
        throw problem('统计分页状态异常，请重新读取');
      }
      result.push(row);
      cursor = row._id;
      if (result.length > MAX_ROWS) throw problem('统计规模已超过当前实时聚合上限，请配置预聚合');
    }
    if (batch.length < 100) return result;
  }
}

function cachedVipService(snapshot, now) {
  const tables = new Map(Object.keys(COLLECTIONS).map(key => [COLLECTIONS[key], snapshot[key]]));
  const matches = (row, query) => !query || Object.entries(query).every(([key, value]) => row[key] === value);
  const read = async (name, query) => (tables.get(name) || []).filter(row => matches(row, query));
  // Expose reads only. A future entitlement implementation cannot silently write.
  const db = { collection(name) { return { doc(key) { return { async get() {
    return { data: (tables.get(name) || []).find(row => row._id === key) || null };
  } }; } }; } };
  return createVipMembershipService({ db, now: () => new Date(now), getAll: read,
    getOne: async (name, query) => (await read(name, query))[0] || null,
    getById: async (name, id) => (tables.get(name) || []).find(row => Number(row.id) === Number(id)) || null });
}

function maskName(value) {
  const chars = [...String(value || '').trim()];
  return chars.length ? `${chars[0]}${chars.length > 1 ? '**' : '*'}` : '未填写';
}

async function buildCockpit(db, { periodDays = 30, now = Date.now() } = {}) {
  if (![7, 30, 90].includes(periodDays) || !Number.isFinite(now)) throw problem('统计周期须为7、30或90天', 42250);
  const snapshot = Object.fromEntries(await Promise.all(Object.entries(COLLECTIONS).map(async ([key, name]) =>
    [key, await readSnapshot(db, name, FIELDS[key])])));
  const vip = cachedVipService(snapshot, now);
  // Existing certification APIs address doc(user_${id}) and check its owner.
  // An archive/import sharing userId must never overwrite that authoritative row.
  const certificationMap = new Map(snapshot.certifications.map(row => [row._id, row]));
  const ignoredCertificationUsers = new Set(), mismatchedCertificationUsers = new Set(), conflictingProfileUsers = new Set();
  const certificationRowsByUser = new Map(), profileRowsByUser = new Map();
  for (const row of snapshot.certifications) {
    const id = Number(row.userId);
    if (!certificationRowsByUser.has(id)) certificationRowsByUser.set(id, []);
    certificationRowsByUser.get(id).push(row);
  }
  for (const row of snapshot.profiles) {
    // /user/profile queries a numeric userId; there is no fixed profile document key.
    if (typeof row.userId !== 'number') continue;
    if (!profileRowsByUser.has(row.userId)) profileRowsByUser.set(row.userId, []);
    profileRowsByUser.get(row.userId).push(row);
  }
  function certificationFor(id) {
    const documentId = `user_${id}`;
    if ((certificationRowsByUser.get(id) || []).some(row => row._id !== documentId)) ignoredCertificationUsers.add(id);
    const canonical = certificationMap.get(documentId);
    if (canonical) {
      if (Number(canonical.userId) !== id) { mismatchedCertificationUsers.add(id); return null; }
      return ownCertificationOverview(canonical, now);
    }
    const projections = (profileRowsByUser.get(id) || []).map(profile => publicCertificationFields(profile, now));
    // The legacy API reads one matching profile. If duplicate profiles disagree,
    // do not invent which unsorted database row is the authoritative one.
    if (new Set(projections.map(value => value.identityVerified)).size > 1) {
      conflictingProfileUsers.add(id); return null;
    }
    return projections[0] || publicCertificationFields({}, now);
  }
  const projected = await buildCockpitMemberStatistics({ ...snapshot, now, days: periodDays }, {
    getEntitlement: id => vip.getEntitlement(id, { now }),
    getCertification: certificationFor
  });
  Object.assign(projected.members.quality, { ignoredNonCanonicalCertificationUsers: ignoredCertificationUsers.size,
    mismatchedCertificationOwnerUsers: mismatchedCertificationUsers.size, conflictingProfileCertificationUsers: conflictingProfileUsers.size });
  if (ignoredCertificationUsers.size) projected.members.quality.warnings.push('已忽略非规范认证文档，优先使用本人规范认证记录；缺失时沿用已有公开档案认证投影。');
  if (mismatchedCertificationUsers.size) projected.members.quality.warnings.push('部分规范认证记录与账号归属不一致，相关实名状态显示未知。');
  if (conflictingProfileUsers.size) projected.members.quality.warnings.push('部分重复档案的实名投影存在冲突，相关实名状态显示未知。');
  const revenue = aggregateRevenueStatistics({ orders: snapshot.orders, now, days: periodDays });
  projected.matchmakers.ranking = projected.matchmakers.ranking.map(row => ({ ...row, name: maskName(row.name) }));
  const warnings = [...projected.members.quality.warnings];
  if (!revenue.quality.complete) warnings.push('部分交易证据不完整，受影响收款指标未汇总为确定金额。');
  warnings.push('会员趋势按当前有效档案回算，不代表历史每天在册人数。');
  warnings.push('退款按平台处理时间归期；净收款未扣手续费。');
  return { version: 1, asOf: new Date(now).toISOString(), period: periodFor(now, periodDays),
    ...projected, revenue, quality: { warnings, snapshotConsistency: 'read_window',
      note: '统计采用一次读取窗口，业务并发更新时结果可能短暂变化。' } };
}

module.exports = { buildCockpit, readSnapshot, periodFor, maskName, COLLECTIONS, FIELDS, MAX_ROWS };
