'use strict';

const DAY_MS = 86400000;
const BEIJING_OFFSET = 8 * 3600000;
const SOURCE_MARKERS = new Set(['demo', 'test', 'seed', 'mock', 'sandbox', 'payment_probe']);

function id(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function instant(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) return null;
  const number = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rows(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.filter(row => row && typeof row === 'object' && !Array.isArray(row));
}

function flagged(row) {
  return row.isDemo === true || row.isTest === true
    || ['identitySource', 'dataSource', 'source'].some(key => SOURCE_MARKERS.has(String(row[key] || '').trim().toLowerCase()))
    || /^(?:seed-|mock_)/.test(String(row.openid || ''))
    || row.remark === '虚拟演示会员';
}

function grouped(items, key) {
  const groups = new Map();
  for (const row of items) {
    const reference = id(row[key]);
    if (reference !== null) {
      if (!groups.has(reference)) groups.set(reference, []);
      groups.get(reference).push(row);
    }
  }
  return groups;
}

function text(value, fallback = '未填写') {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : fallback;
}

function visible(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function firstDate(items, now) {
  const dates = items.map(row => instant(row.createdAt));
  // A dated copy cannot establish the first date of an undated legacy copy.
  return dates.length && dates.every(date => date !== null && date <= now)
    ? dates.reduce((earliest, date) => Math.min(earliest, date), Infinity) : null;
}

function dateKey(time) {
  return new Date(time + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function startOfWindow(now, days) {
  return Math.floor((now + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET - (days - 1) * DAY_MS;
}

function identityVerified(projection) {
  if (!projection || typeof projection !== 'object') return null;
  if (typeof projection.identityVerified === 'boolean') return projection.identityVerified;
  if (!Array.isArray(projection.entries)) return null;
  const identities = projection.entries.filter(entry => entry && entry.kind === 'identity');
  return identities.length === 1 && typeof identities[0].verified === 'boolean' ? identities[0].verified : null;
}

async function projectInBatches(items, callback) {
  const projected = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    projected.push(...await Promise.all(items.slice(offset, offset + 8).map(callback)));
  }
  return projected;
}

/**
 * Pure aggregation over complete, safely projected collection snapshots.
 * Source adapters should derive isDemo/isTest before discarding openid/remark.
 * getEntitlement(id, context) returns the existing getEntitlement DTO;
 * getCertification(id, context) returns ownCertificationOverview or
 * publicCertificationFields. Both may return a value or a Promise. This module
 * never reads a database and never reconstructs entitlement/certification rules.
 */
async function buildCockpitMemberStatistics(input = {}, projectors = {}) {
  const now = instant(input.now);
  if (now === null) throw new TypeError('now must be a valid absolute timestamp');
  const days = input.days === undefined ? 30 : input.days;
  if (![7, 30, 90].includes(days)) throw new RangeError('days must be 7, 30 or 90');
  const source = Object.fromEntries(['users', 'members', 'profiles', 'matchmakers', 'certifications', 'presence']
    .map(name => [name, rows(input[name], name)]));
  const start = startOfWindow(now, days), activeStart = startOfWindow(now, 30);
  const excludedSources = new Set();
  for (const [name, items] of Object.entries(source)) {
    for (const row of items) {
      const userId = id(name === 'users' ? row.id : row.userId);
      if (userId !== null && flagged(row)) excludedSources.add(userId);
    }
  }
  const userGroups = grouped(source.users, 'id'), users = new Map();
  let ambiguousUsers = 0;
  for (const [userId, copies] of userGroups) {
    const documentIds = new Set(copies.map(row => row._id).filter(value => typeof value === 'string' && value));
    if (documentIds.size > 1) { ambiguousUsers += 1; continue; }
    if (excludedSources.has(userId) || copies.some(row => Number(row.status) !== 1 || row.mergedIntoUserId)) continue;
    users.set(userId, copies[0]);
  }
  const eligible = items => items.filter(row => users.has(id(row.userId)) && !flagged(row) && !row.mergedIntoUserId);
  const allMembers = eligible(source.members), activeMembers = allMembers.filter(row => Number(row.status) === 1);
  const profiles = eligible(source.profiles), membersByUser = grouped(allMembers, 'userId');
  const activeMembersByUser = grouped(activeMembers, 'userId'), profilesByUser = grouped(profiles, 'userId');
  const certificationsByUser = grouped(eligible(source.certifications), 'userId');
  const memberIds = new Set([...activeMembersByUser.keys(), ...profilesByUser.keys()]);
  if (memberIds.size && (typeof projectors.getEntitlement !== 'function' || typeof projectors.getCertification !== 'function')) {
    throw new TypeError('getEntitlement and getCertification projections are required for member statistics');
  }
  const quality = { missingFirstCreatedAt: 0, unknownEntitlement: 0, unknownIdentityVerification: 0,
    unknownPublicDisplay: 0, ambiguousUsers, ambiguousMatchmakers: 0, missingAssignmentCreatedAt: 0,
    excludedSourceUsers: [...excludedSources].filter(userId => userGroups.has(userId)).length,
    demoDetectionIncomplete: true, trendBasis: 'current_active_archives', knownNewCount: 0, warnings: [] };
  const facts = await projectInBatches([...memberIds].sort((a, b) => a - b), async userId => {
    const memberRows = membersByUser.get(userId) || [], profileRows = profilesByUser.get(userId) || [];
    const certificationRows = certificationsByUser.get(userId) || [];
    const context = { now: new Date(now).toISOString(), user: users.get(userId), members: memberRows,
      profile: profileRows[0] || null, profiles: profileRows,
      certification: certificationRows[0] || null, certifications: certificationRows };
    const [entitlement, certification] = await Promise.all([
      projectors.getEntitlement(userId, context), projectors.getCertification(userId, context)
    ]);
    const firstCreatedAt = firstDate([...memberRows, ...profileRows], now);
    const premium = typeof entitlement?.isPremiumMember === 'boolean' ? entitlement.isPremiumMember : null;
    const verified = identityVerified(certification);
    const displayValues = new Set(profileRows.map(row => visible(row.displayEnabled)));
    const publicDisplay = displayValues.size > 1 ? null : displayValues.has(true);
    return { firstCreatedAt, premium, verified, publicDisplay };
  });
  const dated = facts.filter(fact => fact.firstCreatedAt !== null);
  quality.missingFirstCreatedAt = facts.length - dated.length;
  quality.unknownEntitlement = facts.filter(fact => fact.premium === null).length;
  quality.unknownIdentityVerification = facts.filter(fact => fact.verified === null).length;
  quality.unknownPublicDisplay = facts.filter(fact => fact.publicDisplay === null).length;
  quality.knownNewCount = dated.filter(fact => fact.firstCreatedAt >= start).length;
  const additions = new Map();
  for (const fact of dated) {
    const key = dateKey(fact.firstCreatedAt);
    additions.set(key, (additions.get(key) || 0) + 1);
  }
  let cumulative = dated.filter(fact => fact.firstCreatedAt < start).length;
  const trend = Array.from({ length: days }, (_, index) => {
    const date = dateKey(start + index * DAY_MS), added = additions.get(date) || 0;
    cumulative += added;
    return { date, newCount: quality.missingFirstCreatedAt ? null : added,
      cumulative: quality.missingFirstCreatedAt ? null : cumulative };
  });

  const activeMatchmakers = eligible(source.matchmakers).filter(row => Number(row.status) === 1);
  const conflictingMatchmakerIds = new Set([...grouped(activeMatchmakers, 'id')]
    .filter(([, copies]) => new Set(copies.map(row => id(row.userId))).size > 1).map(([matchmakerId]) => matchmakerId));
  const matchmakerGroups = grouped(activeMatchmakers, 'userId');
  const matchmakerRows = [];
  for (const [userId, copies] of matchmakerGroups) {
    const ids = new Set(copies.map(row => id(row.id)));
    const statuses = new Set(copies.map(row => Number(row.certificationStatus)));
    if (ids.size !== 1 || ids.has(null) || [...ids].some(matchmakerId => conflictingMatchmakerIds.has(matchmakerId))
      || statuses.size !== 1 || ![0, 1, 2].includes(Number(copies[0].certificationStatus))) {
      quality.ambiguousMatchmakers += 1; continue;
    }
    matchmakerRows.push({ ...copies[0], userId });
  }
  const presenceByUser = grouped(eligible(source.presence), 'userId');
  const active30d = matchmakerRows.filter(row => (presenceByUser.get(row.userId) || []).some(presence => {
    const seen = instant(presence.lastSeenAt);
    return seen !== null && seen >= activeStart && seen <= now;
  })).length;
  const approved = matchmakerRows.filter(row => Number(row.certificationStatus) === 2);
  const membersByMatchmaker = grouped(activeMembers, 'matchmakerId');
  const ranking = approved.map(matchmaker => {
    const ownerId = id(matchmaker.id), assigned = grouped(membersByMatchmaker.get(ownerId) || [], 'userId');
    let newAssignments = 0, missingDates = 0;
    for (const copies of assigned.values()) {
      const first = firstDate(copies, now);
      if (first === null) missingDates += 1;
      else if (first >= start) newAssignments += 1;
    }
    quality.missingAssignmentCreatedAt += missingDates;
    const cities = new Set((profilesByUser.get(matchmaker.userId) || []).map(row => text(row.city, '')).filter(Boolean));
    return { sortId: ownerId, name: text(users.get(matchmaker.userId).nickname),
      city: cities.size === 1 ? [...cities][0] : '未填写', memberCount: assigned.size,
      newAssignments: missingDates ? null : newAssignments };
  }).sort((a, b) => b.memberCount - a.memberCount || (b.newAssignments || 0) - (a.newAssignments || 0) || a.sortId - b.sortId)
    .slice(0, 10).map(({ sortId: _sortId, ...safe }) => safe);

  quality.warnings.push('历史演示及测试数据缺少统一来源标记，当前仅排除已明确标记的记录。',
    '新增和累计趋势按当前有效档案回算，不能代表历史在册存量或留存。');
  if (quality.missingFirstCreatedAt) quality.warnings.push('部分会员首次建档时间缺失或无效，新增及趋势暂不可完整统计。');
  if (quality.unknownEntitlement) quality.warnings.push('部分会员有效权益投影缺失，VIP及普通会员数量暂不可完整统计。');
  if (quality.unknownIdentityVerification) quality.warnings.push('部分会员实名认证投影缺失，实名数量暂不可完整统计。');
  if (quality.unknownPublicDisplay) quality.warnings.push('存在冲突的公开展示设置，公开展示数量暂不可完整统计。');
  if (quality.ambiguousUsers || quality.ambiguousMatchmakers) quality.warnings.push('存在冲突的账号或主理人身份记录，已排除并需核查。');
  if (quality.missingAssignmentCreatedAt) quality.warnings.push('部分归属创建时间缺失或无效，对应主理人新增归属显示未知。');
  return {
    members: { total: facts.length, newCount: quality.missingFirstCreatedAt ? null : quality.knownNewCount,
      vip: quality.unknownEntitlement ? null : facts.filter(fact => fact.premium).length,
      ordinary: quality.unknownEntitlement ? null : facts.filter(fact => fact.premium === false).length,
      verified: quality.unknownIdentityVerification ? null : facts.filter(fact => fact.verified).length,
      publicCount: quality.unknownPublicDisplay ? null : facts.filter(fact => fact.publicDisplay).length, trend, quality },
    matchmakers: { approved: approved.length, pending: matchmakerRows.filter(row => Number(row.certificationStatus) === 0).length,
      rejected: matchmakerRows.filter(row => Number(row.certificationStatus) === 1).length, active30d, ranking }
  };
}

module.exports = { buildCockpitMemberStatistics };
