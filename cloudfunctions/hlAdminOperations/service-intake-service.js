'use strict';

// Native administrator routes authorize before constructing this service.
const { createHash, randomUUID } = require('node:crypto');
const { allowed, positiveId, plain } = require('./contracts');
const { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder } = require('../hlApi/purchase-contract-policy');
const { defaultMemberNo } = require('../hlApi/member-intake-policy');
const C = Object.freeze({ users: 'hl_users', profiles: 'hl_profiles', members: 'hl_members',
  matchmakers: 'hl_matchmakers', packages: 'hl_matchmaking_packages', readiness: 'hl_matchmaking_readiness',
  orders: 'hl_payment_orders', audit: 'hl_admin_audit_logs', counters: 'hl_counters' });
const DAY = 86400000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATUSES = ['pending_assignment', 'pending_contact', 'in_progress', 'expired', 'exhausted', 'refunded', 'needs_review'];
const fail = (message, code = 42260) => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const version = context => 'v1_' + hash(JSON.stringify(canonical(context)));
const validUser = row => !!row && Number(row.status) === 1 && !row.mergedIntoUserId;
const safe = row => row ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_openid')) : null;
const dataOnly = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['_id', '_openid'].includes(key)));
const number = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const remaining = row => number(row.totalCount) !== null && number(row.usedCount) !== null
  && number(row.totalCount) >= number(row.usedCount) ? number(row.totalCount) - number(row.usedCount) : null;
async function document(db, name, id) {
  try {
    const result = await db.collection(name).doc(id).get();
    if (!result || result.code || result.errCode) throw result || fail('服务记录不可用', 50360);
    return result.data ? safe({ ...result.data, _id: id }) : null;
  } catch (error) {
    if (error?.code === 'DOCUMENT_NOT_EXIST' || error?.errCode === 'DOCUMENT_NOT_EXIST') return null;
    throw error;
  }
}
async function write(ref, method, data) {
  const result = await ref[method](data);
  if (!result || result.code || result.errCode) throw result || fail('服务记录写入失败', 50360);
}
async function rows(db, name, condition = {}, fields) {
  const result = [];
  for (let skip = 0; ; skip += 100) {
    let query = db.collection(name).where(condition).orderBy('_id', 'asc').skip(skip).limit(100);
    if (fields) query = query.field(Object.fromEntries(['_id', ...fields].map(key => [key, true])));
    const snapshot = await query.get();
    if (!Array.isArray(snapshot?.data) || snapshot.code || snapshot.errCode || snapshot.data.length > 100) throw fail('服务列表不可用', 50360);
    for (const row of snapshot.data) {
      if (!row || typeof row._id !== 'string' || !row._id || result.some(item => item._id === row._id)) throw fail('服务列表数据冲突', 40960);
      result.push(safe(row));
    }
    if (result.length > 5000) throw fail('服务列表超过查询上限', 50360);
    if (snapshot.data.length < 100) return result;
  }
}
async function numericRows(db, name, field, value, fields) {
  const found = await Promise.all([value, String(value)].map(key => rows(db, name, { [field]: key }, fields)));
  return [...new Map(found.flat().map(row => [row._id, row])).values()].sort((a, b) => a._id.localeCompare(b._id));
}
async function unique(db, name, field, value, fields) {
  const found = await numericRows(db, name, field, value, fields);
  if (found.length > 1) throw fail('服务主键存在重复', 40960);
  return found[0] || null;
}
const USER = ['id', 'nickname', 'status', 'mergedIntoUserId', 'updatedAt'];
const PRINCIPAL = ['id', 'userId', 'status', 'certificationStatus', 'matchmakerNo', 'updatedAt'];
function packageView(row, order, time) {
  const owned = !!order && Number(order.userId) === Number(row.userId) && order.outTradeNo === row.orderNo
    && isDirectPurchaseOrder(order) && order.productType === 'matchmaking';
  const paid = owned && order.status === 'paid' && order.fulfillmentStatus === 'fulfilled';
  const count = remaining(row), expires = Date.parse(row.expireAt || '');
  const refunded = row.status === 'refunded' || order?.status === 'refunded';
  return { id: row.id, planTitle: row.planTitle || row.planCode || '', orderNo: row.orderNo,
    expireAt: row.expireAt, originalExpireAt: row.originalExpireAt || row.expireAt,
    totalCount: row.totalCount, usedCount: row.usedCount, remainingCount: count,
    status: refunded ? 'refunded' : !paid || count === null || !Number.isFinite(expires) ? 'needs_review'
      : count === 0 ? 'exhausted' : expires <= time ? 'expired' : 'active',
    canExtend: paid && !refunded && row.status === 'active' && count > 0 && Number.isFinite(expires) };
}
function view(context, time, detail = false) {
  const { user, intake, members, readiness, principals, principalUsers, packages, orders, profile } = context;
  const active = members.filter(row => Number(row.status) === 1);
  const member = active.length === 1 ? active[0] : null;
  const principal = member && principals.find(row => Number(row.id) === Number(member.matchmakerId));
  const principalUser = principal && principalUsers.find(row => Number(row.id) === Number(principal.userId));
  const assigned = !!principal && validUser(principalUser) && Number(principal.status) === 1 && Number(principal.certificationStatus) === 2;
  const confirmed = assigned && readiness?.confirmed === true && Number(readiness.memberRecordId) === Number(member.id)
    && Number(readiness.matchmakerId) === Number(principal.id) && String(readiness.profileVersion || '') === String(profile?.updatedAt || '');
  const packageViews = packages.map(row => packageView(row, orders.find(order => order.outTradeNo === row.orderNo), time));
  const live = packageViews.some(row => row.status === 'active');
  let status = !validUser(user) || active.length > 1 || !packageViews.length || packageViews.some(row => row.status === 'needs_review') ? 'needs_review'
    : !live ? packageViews.every(row => row.status === 'refunded') ? 'refunded'
      : packageViews.some(row => row.status === 'expired') ? 'expired' : 'exhausted'
      : !assigned ? 'pending_assignment' : !confirmed ? 'pending_contact' : 'in_progress';
  const dto = { userId: Number(intake.userId), user: { id: Number(intake.userId), nickname: user?.nickname || '' },
    status, requestedAt: intake.requestedAt || intake.createdAt, createdAt: intake.createdAt, updatedAt: intake.updatedAt,
    assignment: assigned ? { memberRecordId: Number(member.id), matchmakerId: Number(principal.id),
      nickname: principalUser.nickname || '', matchmakerNo: principal.matchmakerNo || '' } : null,
    contactProgress: !assigned ? '待平台分配主理人' : confirmed ? '主理人已确认服务准备' : '已分配，待主理人联系并确认服务准备',
    packageCount: packageViews.length, remainingCount: packageViews.reduce((sum, row) => sum + (row.remainingCount || 0), 0),
    canAssign: validUser(user) && active.length <= 1 && live && !packageViews.some(row => row.status === 'needs_review'),
    ...(detail ? { version: version(context), packages: packageViews, hasExistingAssignment: !!member,
      principals: principals.filter(row => Number(row.status) === 1 && Number(row.certificationStatus) === 2)
        .map(row => ({ row, user: principalUsers.find(item => Number(item.id) === Number(row.userId)) }))
        .filter(item => validUser(item.user)).map(({ row, user: principalUser }) => ({ id: Number(row.id),
          nickname: principalUser.nickname || '', matchmakerNo: row.matchmakerNo || '' })) } : {}) };
  return dto;
}

function createServiceIntakeService({ db, now = Date.now } = {}) {
  if (!db || typeof db.collection !== 'function') throw fail('服务数据库不可用', 50360);
  const clock = () => {
    const time = new Date(now()).getTime();
    if (!Number.isFinite(time)) throw fail('服务时间不可用', 50360);
    return time;
  };
  async function principalCatalog() {
    const principals = await rows(db, C.matchmakers, {}, PRINCIPAL);
    if (new Set(principals.map(row => positiveId(row.id))).size !== principals.length) throw fail('主理人编号冲突', 40960);
    const principalUsers = [];
    for (const id of [...new Set(principals.map(row => positiveId(row.userId)))]) {
      const row = await unique(db, C.users, 'id', id, USER);
      if (row) principalUsers.push(row);
    }
    return { principals, principalUsers };
  }
  async function contextFor(userId, catalog) {
    const { principals, principalUsers } = catalog || await principalCatalog();
    const [intake, user, members, profile, readiness, index, allocation] = await Promise.all([
      document(db, C.readiness, `intake_user_${userId}`), unique(db, C.users, 'id', userId, USER),
      numericRows(db, C.members, 'userId', userId), unique(db, C.profiles, 'userId', userId, ['userId', 'updatedAt']),
      document(db, C.readiness, `readiness_user_${userId}`), document(db, C.packages, `matchmaking_user_${userId}`),
      document(db, C.counters, `memberAssignmentUser_${userId}`)
    ]);
    if (!intake || intake.kind !== 'service_intake' || Number(intake.userId) !== userId) throw fail('服务接入记录不存在', 40460);
    const ids = index?.packageIds || [];
    if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^package_[a-zA-Z0-9_-]{1,96}$/.test(id))) throw fail('权益索引冲突', 40960);
    const allPackages = await Promise.all(ids.map(id => document(db, C.packages, id)));
    if (allPackages.some(row => !row || Number(row.userId) !== userId || row.id !== row._id)) throw fail('权益归属冲突', 40960);
    const packages = allPackages.filter(row => row.fulfillmentContract === DIRECT_PURCHASE_CONTRACT);
    if (new Set(packages.map(row => row.orderNo)).size !== packages.length) throw fail('权益订单引用冲突', 40960);
    const orders = [];
    for (const row of packages) {
      const matches = await rows(db, C.orders, { outTradeNo: row.orderNo });
      if (matches.length > 1) throw fail('支付订单号冲突', 40960);
      if (matches[0]) orders.push(matches[0]);
    }
    return { intake, user, members, profile, readiness, index, allocation, principals, principalUsers, packages, orders };
  }
  async function list(args = {}) {
    allowed(args, ['page', 'pageSize', 'keyword', 'status']);
    const page = args.page === undefined ? 1 : positiveId(args.page), pageSize = args.pageSize === undefined ? 20 : positiveId(args.pageSize);
    if (pageSize > 100 || !Number.isSafeInteger(page * pageSize) || args.status !== undefined && !STATUSES.includes(args.status)
      || args.keyword !== undefined && (typeof args.keyword !== 'string' || args.keyword.length > 80 || /[\x00-\x1f\x7f]/.test(args.keyword))) throw fail('服务筛选条件无效');
    const keyword = String(args.keyword || '').trim().toLowerCase();
    const intakes = await rows(db, C.readiness, { kind: 'service_intake' }, ['kind', 'userId']);
    if (new Set(intakes.map(row => Number(row.userId))).size !== intakes.length) throw fail('服务接入记录冲突', 40960);
    const catalog = intakes.length ? await principalCatalog() : null;
    const result = [];
    for (const intake of intakes) {
      if (intake._id !== `intake_user_${positiveId(intake.userId)}`) throw fail('服务接入记录标识冲突', 40960);
      const row = view(await contextFor(Number(intake.userId), catalog), clock());
      if ((!args.status || row.status === args.status) && (!keyword || [row.userId, row.user.nickname, row.assignment?.nickname]
        .some(value => String(value || '').toLowerCase().includes(keyword)))) result.push(row);
    }
    result.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || String(a.requestedAt).localeCompare(String(b.requestedAt)));
    return { list: result.slice((page - 1) * pageSize, page * pageSize), total: result.length, page, pageSize };
  }
  async function detail(args) {
    allowed(args, ['userId']);
    return view(await contextFor(positiveId(args.userId)), clock(), true);
  }
  async function execute(action, input, actor) {
    if (!['services.assign', 'services.extend'].includes(action)) throw fail('服务操作无效');
    if (!actor || typeof actor.uid !== 'string' || !/^[a-zA-Z0-9_@.:-]{4,128}$/.test(actor.uid) || !UUID.test(actor.requestId || '')
      || !UUID.test(actor.serverRequestId || '')) throw fail('管理员操作标识无效', 40360);
    allowed(input, action === 'services.assign' ? ['userId', 'matchmakerId', 'expectedVersion', 'reason', 'confirmReassign']
      : ['userId', 'packageId', 'days', 'reason', 'expectedVersion']);
    const userId = positiveId(input.userId);
    if (typeof input.expectedVersion !== 'string' || !/^v1_[a-f0-9]{64}$/.test(input.expectedVersion) || typeof input.reason !== 'string'
      || !input.reason.trim() || input.reason.trim().length > 500 || /[\x00-\x1f\x7f]/.test(input.reason)) throw fail('请提供版本及有效处理原因');
    const args = { ...input, userId, reason: input.reason.trim() };
    if (action === 'services.assign') {
      args.matchmakerId = positiveId(input.matchmakerId);
      if (typeof input.confirmReassign !== 'boolean') throw fail('请明确确认是否更换主理人');
    } else if (typeof input.packageId !== 'string' || !/^package_[a-zA-Z0-9_-]{1,96}$/.test(input.packageId)
      || !Number.isSafeInteger(input.days) || input.days < 1 || input.days > 30) throw fail('延期须选择权益及1至30整数天');
    const auditId = 'op_' + hash(`${actor.uid}\n${actor.requestId}`), fingerprint = hash(JSON.stringify(canonical({ action, args })));
    // An already committed retry must succeed even when the current state changed.
    const previous = await document(db, C.audit, auditId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.actor?.uid !== actor.uid || previous.requestId !== actor.requestId
        || previous.action !== action || !previous.result) throw fail('操作编号已被使用', 40960);
      return previous.result;
    }
    const snapshot = await contextFor(userId), timestamp = new Date(clock()).toISOString();
    if (version(snapshot) !== args.expectedVersion) throw fail('服务记录已变化', 40960);
    return db.runTransaction(async transaction => {
      const committed = await document(transaction, C.audit, auditId);
      if (committed) {
        if (committed.fingerprint !== fingerprint || committed.actor?.uid !== actor.uid || committed.requestId !== actor.requestId
          || committed.action !== action || !committed.result) throw fail('操作编号已被使用', 40960);
        return committed.result;
      }
      const current = {};
      for (const [name, value] of Object.entries(snapshot)) {
        const collection = { intake: C.readiness, readiness: C.readiness, user: C.users, members: C.members, profile: C.profiles,
          index: C.packages, allocation: C.counters, principals: C.matchmakers, principalUsers: C.users, packages: C.packages, orders: C.orders }[name];
        const reread = async row => row ? document(transaction, collection, row._id) : null;
        current[name] = Array.isArray(value) ? await Promise.all(value.map(reread)) : await reread(value);
      }
      if (!snapshot.readiness) current.readiness = await document(transaction, C.readiness, `readiness_user_${userId}`);
      if (!snapshot.allocation) current.allocation = await document(transaction, C.counters, `memberAssignmentUser_${userId}`);
      // Transactional document reads are full rows; compare the same projections.
      current.user = current.user && Object.fromEntries(['_id', ...USER].filter(key => Object.hasOwn(current.user, key)).map(key => [key, current.user[key]]));
      current.profile = current.profile && Object.fromEntries(['_id', 'userId', 'updatedAt'].filter(key => Object.hasOwn(current.profile, key)).map(key => [key, current.profile[key]]));
      current.principals = current.principals.map(row => row && Object.fromEntries(['_id', ...PRINCIPAL].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
      current.principalUsers = current.principalUsers.map(row => row && Object.fromEntries(['_id', ...USER].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
      if (version(current) !== args.expectedVersion || !validUser(current.user)) throw fail('服务资料已变化', 40960);
      const before = view(current, Date.parse(timestamp), true), changes = [], target = { userId };
      if (action === 'services.assign') {
        if (!before.canAssign) throw fail('当前服务不能分配', 40960);
        const principal = current.principals.find(row => Number(row.id) === args.matchmakerId);
        const principalUser = principal && current.principalUsers.find(row => Number(row.id) === Number(principal.userId));
        if (!principal || Number(principal.status) !== 1 || Number(principal.certificationStatus) !== 2 || !validUser(principalUser)
          || Number(principal.userId) === userId) throw fail('主理人已失效或不适用', 40960);
        const active = current.members.filter(row => Number(row.status) === 1);
        let member = active[0];
        const allocation = current.allocation;
        const anchoredMember = allocation && current.members.find(row => row._id === allocation.memberDocumentId);
        if (allocation && (Number(allocation.userId) !== userId || !Number.isSafeInteger(allocation.revision) || allocation.revision <= 0
          || typeof allocation.memberDocumentId !== 'string' || !allocation.memberDocumentId
          || !Number.isSafeInteger(Number(allocation.memberRecordId)) || Number(allocation.memberRecordId) <= 0
          || !Number.isSafeInteger(Number(allocation.matchmakerId)) || Number(allocation.matchmakerId) <= 0
          || !anchoredMember || Number(anchoredMember.userId) !== userId
          || Number(anchoredMember.id) !== Number(allocation.memberRecordId) || Number(anchoredMember.matchmakerId) !== Number(allocation.matchmakerId)
          || member && (allocation.memberDocumentId !== member._id || Number(allocation.memberRecordId) !== Number(member.id)
            || Number(allocation.matchmakerId) !== Number(member.matchmakerId)))) throw fail('会员分配锁记录冲突', 40960);
        if (member && Number(member.matchmakerId) !== args.matchmakerId && !args.confirmReassign) throw fail('更换已有主理人须明确确认', 40960);
        if (member && Number(member.matchmakerId) === args.matchmakerId) throw fail('已由此主理人负责', 40960);
        if (member) {
          member = { ...member, matchmakerId: args.matchmakerId, updatedAt: timestamp };
          await write(transaction.collection(C.members).doc(member._id), 'update', { matchmakerId: args.matchmakerId, updatedAt: timestamp });
        } else {
          const counter = await document(transaction, C.counters, 'memberAdminAtomic');
          if (counter && (!Number.isSafeInteger(counter.value) || counter.value < 0)) throw fail('会员序号不可用', 50360);
          const id = Math.max(counter ? counter.value + 1 : 1, Date.parse(timestamp) * 1000);
          if (!Number.isSafeInteger(id)) throw fail('会员序号不可用', 50360);
          await write(transaction.collection(C.counters).doc('memberAdminAtomic'), 'set', { key: 'memberAdminAtomic', value: id, updatedAt: timestamp });
          member = { _id: 'member_admin_' + randomUUID(), id, memberNo: defaultMemberNo(id, timestamp), userId, matchmakerId: args.matchmakerId, memberType: 'free',
            serviceLevel: '', expireAt: null, status: 1, remark: '平台分配已购人工服务', createdAt: timestamp, updatedAt: timestamp };
          await write(transaction.collection(C.members).doc(member._id), 'set', dataOnly(member));
          current.members.push(member);
        }
        current.members = current.members.map(row => row._id === member._id ? member : row);
        current.readiness = { ...(current.readiness || {}), _id: `readiness_user_${userId}`, userId,
          memberRecordId: member.id, matchmakerId: args.matchmakerId, confirmed: false,
          profileVersion: String(current.profile?.updatedAt || ''), invalidatedReason: 'platform_assignment_changed',
          invalidatedAt: timestamp, updatedAt: timestamp };
        // A later reassignment back to a former principal must never resurrect
        // that principal's historical preparation confirmation.
        await write(transaction.collection(C.readiness).doc(current.readiness._id), 'set', dataOnly(current.readiness));
        const revision = current.allocation?.revision;
        if (current.allocation && (Number(current.allocation.userId) !== userId || !Number.isSafeInteger(revision) || revision <= 0)
          || !Number.isSafeInteger((revision || 0) + 1)) throw fail('会员分配锁记录冲突', 40960);
        current.allocation = { _id: `memberAssignmentUser_${userId}`, userId, memberDocumentId: member._id,
          memberRecordId: member.id, matchmakerId: args.matchmakerId, revision: (revision || 0) + 1, updatedAt: timestamp };
        await write(transaction.collection(C.counters).doc(current.allocation._id), 'set', dataOnly(current.allocation));
        changes.push('assignment', 'readiness.confirmed'); target.matchmakerId = args.matchmakerId;
      } else {
        const packageRow = current.packages.find(row => row.id === args.packageId);
        const packageDto = before.packages.find(row => row.id === args.packageId);
        if (!packageRow || !packageDto?.canExtend) throw fail('当前权益不能延期', 40960);
        if (packageRow.platformDelayExtensionDays !== undefined && (!Number.isSafeInteger(packageRow.platformDelayExtensionDays)
          || packageRow.platformDelayExtensionDays < 0)) throw fail('延期累计记录异常', 40960);
        const expireAt = new Date(Date.parse(packageRow.expireAt) + args.days * DAY).toISOString();
        const patch = { expireAt, originalExpireAt: packageRow.originalExpireAt || packageRow.expireAt,
          platformDelayExtensionDays: Number(packageRow.platformDelayExtensionDays || 0) + args.days, updatedAt: timestamp };
        if (!Number.isSafeInteger(patch.platformDelayExtensionDays) || patch.platformDelayExtensionDays < args.days) throw fail('延期累计记录异常', 40960);
        await write(transaction.collection(C.packages).doc(packageRow._id), 'update', patch);
        current.packages = current.packages.map(row => row.id === args.packageId ? { ...row, ...patch } : row);
        changes.push('expireAt', 'platformDelayExtensionDays'); target.packageId = args.packageId;
      }
      current.intake = { ...current.intake, updatedAt: timestamp, lastAdminOperationId: auditId };
      // This common document serializes competing administrator assignments and extensions.
      await write(transaction.collection(C.readiness).doc(current.intake._id), 'update', { updatedAt: timestamp, lastAdminOperationId: auditId });
      const after = view(current, Date.parse(timestamp), true);
      const result = { action, target, status: after.status, version: after.version, updatedAt: timestamp, requestId: actor.requestId };
      const priorActive = snapshot.members.find(row => Number(row.status) === 1);
      const priorAssignment = priorActive ? { memberRecordId: Number(priorActive.id), matchmakerId: Number(priorActive.matchmakerId) } : null;
      await write(transaction.collection(C.audit).doc(auditId), 'set', { action, target, actor: { uid: actor.uid },
        requestId: actor.requestId, serverRequestId: actor.serverRequestId, fingerprint, reason: args.reason,
        expectedVersion: args.expectedVersion, changedFields: changes, createdAt: timestamp,
        before: { assignment: priorAssignment, packages: before.packages }, after: { assignment: after.assignment, packages: after.packages }, result });
      return result;
    });
  }
  return { list, detail, execute };
}
module.exports = { createServiceIntakeService, SERVICE_INTAKE_COLLECTIONS: C };
