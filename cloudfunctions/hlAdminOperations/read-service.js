'use strict';

const { KINDS, allowed, positiveId, identifier, versionFor } = require('./contracts');
const { ownCertificationOverview } = require('../hlApi/showcase-policy');
const { activeAttendance, salonAvailability } = require('../hlApi/salon-policy');
const { DEFAULT_MEMBERSHIP_PLANS, RETIRED_MATCHMAKING_PLAN_CODES } = require('../hlApi/vip-membership-service');

const MAX_ROWS = 50000;
const C = Object.freeze({ users: 'hl_users', profiles: 'hl_profiles', members: 'hl_members',
  matchmakers: 'hl_matchmakers', salons: 'hl_salon_events', registrations: 'hl_registrations',
  certifications: 'hl_member_certifications', plans: 'hl_membership_plans', orders: 'hl_payment_orders' });
const fields = names => Object.freeze(Object.fromEntries(['_id', ...names].map(key => [key, true])));
const USER = ['id', 'nickname', 'status', 'mergedIntoUserId'];
const MATCHMAKER = ['id', 'userId', 'status', 'certificationStatus', 'certificationRemark', 'updatedAt',
  'matchmakerNo', 'level', 'parentId', 'teamId', 'hasStore', 'createdAt'];
const SALON = ['id', 'organizerId', 'status', 'eventDate', 'reviewRemark', 'updatedAt', 'title', 'location',
  'maxParticipants', 'currentParticipants', 'createdAt', 'reviewedAt'];
const PLAN = ['id', 'planCode', 'code', 'title', 'amountFen', 'active', 'productType', 'durationDays',
  'serviceCount', 'updatedAt', 'description', 'badge', 'sortOrder', 'createdAt'];
const ORDER = ['id', 'outTradeNo', 'userId', 'planCode', 'planTitle', 'productType', 'amountFen', 'currency',
  'status', 'fulfillmentStatus', 'fulfillmentMessage', 'transactionId', 'paidAt', 'createdAt', 'updatedAt',
  'paymentProvider', 'virtualPaymentEnv', 'confirmationSource', 'reviewReason', 'paymentReviewRequired',
  'refundId', 'refundAmountFen', 'refundedAt', 'refundSource', 'cancelledAt', 'cancelReason', 'isTest', 'isDemo', 'testMode',
  'paymentTestPlanCode', 'paymentTestRunId', 'source', 'dataSource', 'origin'];
const APPLICATION_SUMMARY = ['requestId', 'status', 'source', 'method', 'educationLevel', 'institutionName',
  'submittedAt', 'reviewedAt', 'feedback', 'materialIds'];
const CURRENT_SUMMARY = ['status', 'source', 'level', 'financialAssetRange', 'reviewedAt', 'expiresAt', 'feedback'];
const MATERIAL = ['id', 'kind', 'status', 'applicationId', 'fileID', 'mimeType', 'size', 'createdAt'];
const FIELDS = Object.freeze({ users: fields(USER), userDetail: fields([...USER, 'phone', 'avatarUrl', 'gender', 'createdAt']),
  profiles: fields(['id', 'userId', 'city', 'province']), members: fields(['id', 'userId', 'matchmakerId', 'status', 'createdAt']),
  matchmakers: fields(MATCHMAKER), salons: fields(SALON), salonDetail: fields([...SALON, 'description', 'coverImage', 'price', 'organizerRole']),
  registrations: fields(['id', 'eventId', 'userId', 'status', 'registrationRevision', 'createdAt', 'updatedAt']),
  certifications: fields(['userId', 'createdAt', 'updatedAt', ...KINDS.flatMap(kind => [
    ...APPLICATION_SUMMARY.map(key => `applications.${kind}.${key}`), ...CURRENT_SUMMARY.map(key => `current.${kind}.${key}`)
  ])]), plans: fields(PLAN), orders: fields(ORDER) });
const SALON_STATUSES = ['pending', 'upcoming', 'rejected', 'cancelled', 'ended'];
const CERT_STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'expired', 'unsubmitted'];
const ORDER_STATUSES = ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'];

function fail(status, message) { return Object.assign(new Error(message), { status, code: status * 100 + 60 }); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function numberId(value) { try { return positiveId(value); } catch { return null; } }
function string(value) { return typeof value === 'string' ? value : ''; }
function isTrue(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function pick(row, keys) {
  return Object.fromEntries(keys.filter(key => row && (row[key] === null || ['string', 'boolean', 'number'].includes(typeof row[key])))
    .filter(key => typeof row[key] !== 'number' || Number.isFinite(row[key])).map(key => [key, row[key]]));
}
function choice(value, choices) {
  if (value === undefined || value === '') return '';
  if (!choices.includes(value)) throw fail(422, '筛选条件无效');
  return value;
}
function pageArgs(args, extra = []) {
  allowed(args, ['page', 'pageSize', 'keyword', ...extra]);
  const page = args.page === undefined || args.page === '' ? 1 : positiveId(args.page);
  const pageSize = args.pageSize === undefined || args.pageSize === '' ? 20 : positiveId(args.pageSize);
  if (pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw fail(422, '分页参数无效');
  if (args.keyword !== undefined && (typeof args.keyword !== 'string' || args.keyword.length > 80 || /[\x00-\x1f\x7f]/.test(args.keyword))) {
    throw fail(422, '搜索词须为80字以内文本');
  }
  return { page, pageSize, keyword: string(args.keyword).trim().toLowerCase() };
}
function paginate(rows, page) { return { list: rows.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
  total: rows.length, page: page.page, pageSize: page.pageSize }; }
function matches(keyword, values) { return !keyword || values.some(value => String(value ?? '').toLowerCase().includes(keyword)); }
function userDto(user, detail = false) { return pick(user || {}, detail ? ['id', 'nickname', 'phone', 'avatarUrl', 'gender', 'status', 'createdAt'] : ['id', 'nickname']); }
function activeUser(user) { return !!user && Number(user.status) === 1 && !user.mergedIntoUserId; }
function uniqueIndex(rows, field, { ignoreInvalid = false } = {}) {
  const result = new Map();
  for (const row of rows) {
    const key = numberId(row[field]);
    if (key === null) { if (ignoreInvalid) continue; throw fail(409, '存在无效记录编号，请先核查'); }
    if (result.has(key)) throw fail(409, '存在重复业务编号，请先核查');
    result.set(key, row);
  }
  return result;
}
function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const reference = numberId(row[key]);
    if (reference === null) continue;
    if (!result.has(reference)) result.set(reference, []);
    result.get(reference).push(row);
  }
  return result;
}
function numericOrder(a, b) { return Number(b.id) - Number(a.id); }
function applicationIds(value) {
  if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw fail(409, '认证申请材料引用无效，请重新核查');
  return [...value];
}

function createReadService({ db, now = Date.now } = {}) {
  if (!db || typeof db.collection !== 'function') throw new TypeError('database is required');
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) throw fail(503, '当前时间不可用');
    return time;
  };
  async function scan(name, projection, condition = {}, firstPageOnly = false) {
    const all = [];
    let cursor;
    while (true) {
      let query = db.collection(name);
      const where = { ...condition };
      if (cursor !== undefined && db.command?.gt) where._id = db.command.gt(cursor);
      if (Object.keys(where).length) query = query.where(where);
      query = query.orderBy('_id', 'asc').field(projection);
      if (!db.command?.gt) query = query.skip(all.length);
      const snapshot = await query.limit(100).get();
      if (snapshot?.code || snapshot?.errCode || !Array.isArray(snapshot?.data) || snapshot.data.length > 100) throw fail(503, '列表数据读取失败');
      for (const row of snapshot.data) {
        if (!record(row) || typeof row._id !== 'string' || !row._id || (cursor !== undefined && row._id <= cursor)) {
          throw fail(409, '列表分页状态异常，请重新读取');
        }
        all.push(row); cursor = row._id;
        if (all.length > MAX_ROWS) throw fail(503, '数据超过实时查询上限，请配置索引或预聚合');
      }
      if (firstPageOnly) return { rows: all, complete: snapshot.data.length < 100 };
      if (snapshot.data.length < 100) return all;
    }
  }
  async function related(name, field, ids, projection) {
    const references = [...new Set(ids.map(numberId).filter(id => id !== null))];
    if (!references.length) return [];
    const wanted = new Set(references);
    // Keep the projected scan fallback for adapters without the set operator.
    // Each request owns these reads; no authorization or business data is cached.
    if (typeof db.command?.in !== 'function') {
      return (await scan(name, projection)).filter(row => wanted.has(numberId(row[field])));
    }
    const batches = [];
    for (let offset = 0; offset < references.length; offset += 50) {
      const batch = references.slice(offset, offset + 50);
      const values = batch.flatMap(id => [id, String(id)]), batchIds = new Set(batch);
      batches.push(scan(name, projection, { [field]: db.command.in(values) }).then(rows => {
        if (rows.some(row => !batchIds.has(numberId(row[field])))) throw fail(409, '关联记录归属异常，请重新读取');
        return rows;
      }));
    }
    const all = (await Promise.all(batches)).flat();
    if (all.length > MAX_ROWS) throw fail(503, '数据超过实时查询上限，请配置索引或预聚合');
    return all;
  }
  async function prepareRelated(name, field, projection) {
    // Start small tables alongside the primary scans, retaining one network
    // round for current small datasets. Large tables switch to scoped reads.
    const snapshot = await scan(name, projection, {}, true);
    return ids => {
      if (!snapshot.complete) return related(name, field, ids, projection);
      const wanted = new Set(ids.map(numberId).filter(id => id !== null));
      return snapshot.rows.filter(row => wanted.has(numberId(row[field])));
    };
  }
  async function lookup(name, field, value, projection) {
    const values = typeof value === 'number' ? [value, String(value)] : [value];
    const selectors = values.length > 1 && typeof db.command?.in === 'function' ? [db.command.in(values)] : values;
    const snapshots = await Promise.all(selectors.map(expected => db.collection(name).where({ [field]: expected })
      .orderBy('_id', 'asc').field(projection).limit(2).get()));
    const found = new Map();
    for (const snapshot of snapshots) {
      if (snapshot?.code || snapshot?.errCode || !Array.isArray(snapshot?.data) || snapshot.data.length > 2) throw fail(503, '详情读取失败');
      for (const row of snapshot.data) {
        if (!record(row) || typeof row._id !== 'string' || !row._id
          || (typeof value === 'number' ? numberId(row[field]) !== value : row[field] !== value)) throw fail(409, '详情记录无效');
        found.set(row._id, row);
      }
    }
    if (found.size > 1) throw fail(409, '存在重复业务编号，请先核查');
    return [...found.values()][0] || null;
  }
  async function required(name, field, value, projection) {
    const row = await lookup(name, field, value, projection);
    if (!row) throw fail(404, '记录不存在或已移除');
    return row;
  }
  function location(rows) {
    const cities = new Set(rows.map(row => string(row.city)).filter(Boolean));
    const provinces = new Set(rows.map(row => string(row.province)).filter(Boolean));
    if (cities.size > 1 || provinces.size > 1) throw fail(409, '重复个人资料的所在地不一致，请核查');
    return { city: [...cities][0] || '', province: [...provinces][0] || '' };
  }
  function matchmakerDto(row, user, profiles, memberRows, salons, detail) {
    const place = location(profiles);
    return { ...pick(row, MATCHMAKER), user: userDto(user, detail), city: place.city,
      ...(detail ? { profile: place, version: versionFor('matchmakers', row) } : {}),
      memberCount: memberRows.filter(member => Number(member.status) === 1 && numberId(member.matchmakerId) === numberId(row.id)).length,
      salonCount: salons.filter(salon => numberId(salon.organizerId) === numberId(row.userId)).length,
      canReview: Number(row.status) === 1 && Number(row.certificationStatus) === 0 && activeUser(user) };
  }
  function salonDto(row, user, registrations, detail) {
    const attendees = activeAttendance(registrations.filter(reg => numberId(reg.eventId) === numberId(row.id)));
    const time = clock(), future = Number.isFinite(Date.parse(row.eventDate)) && Date.parse(row.eventDate) > time;
    return { ...pick(row, detail ? [...SALON, 'description', 'coverImage', 'price', 'organizerRole'] : SALON),
      organizer: userDto(user), currentParticipants: attendees.length,
      ...salonAvailability(row, attendees.length, time),
      canApprove: row.status === 'pending' && future,
      canReject: ['pending', 'upcoming'].includes(row.status),
      canCancel: ['pending', 'upcoming', 'rejected'].includes(row.status) && future,
      ...(detail ? { version: versionFor('salons', row) } : {}) };
  }
  function planDto(raw, canonical) {
    const planCode = canonical?.planCode || raw.planCode || raw.code;
    const config = raw || { ...canonical, active: true };
    const shown = canonical ? { ...pick(config, PLAN), ...canonical, active: raw?.active === undefined ? true : isTrue(raw.active),
      description: string(config.description) || canonical.description, badge: string(config.badge) || canonical.badge,
      sortOrder: Number.isFinite(Number(config.sortOrder)) ? Number(config.sortOrder) : canonical.sortOrder,
      createdAt: config.createdAt, updatedAt: config.updatedAt } : pick(config, PLAN);
    return { ...pick(shown, PLAN), code: planCode, planCode, active: isTrue(shown.active),
      configured: !!raw, canUpdate: !!canonical, readOnly: !canonical,
      retired: RETIRED_MATCHMAKING_PLAN_CODES.includes(planCode),
      priceEditable: false, priceLockedReason: '当前套餐采用微信商品对应的固定价格',
      paymentReadyIndependent: true, version: versionFor('plans', config) };
  }
  function planIndex(rows) {
    const index = new Map();
    for (const row of rows) {
      const code = row.planCode || row.code;
      if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) throw fail(409, '套餐编码无效，请先核查');
      if (index.has(code)) throw fail(409, '存在重复套餐编码，请先核查');
      index.set(code, row);
    }
    return index;
  }
  function orderDto(row) {
    const marker = ['source', 'dataSource', 'origin'].some(key => ['demo', 'test', 'probe', 'sandbox'].includes(row[key]));
    const isTest = row.isTest === true || row.isDemo === true || row.testMode === true || marker
      || row.planCode === 'hl_payment_probe' || row.paymentTestPlanCode === 'vip_week' || !!row.paymentTestRunId
      || /^payment_probe_user_/.test(row._id);
    const cancellation = row.cancelReason === 'user_requested' && typeof row.cancelledAt === 'string'
      && row.cancelledAt.length > 0 && Number.isFinite(Date.parse(row.cancelledAt))
      ? { cancelledAt: row.cancelledAt, cancelReason: row.cancelReason } : {};
    return { ...pick(row, ORDER.filter(key => !['paymentTestPlanCode', 'paymentTestRunId', 'source', 'dataSource', 'origin', 'cancelledAt', 'cancelReason'].includes(key))),
      ...cancellation,
      isTest, isSandbox: Number(row.virtualPaymentEnv) === 1,
      fulfillmentStatus: row.fulfillmentStatus || (row.status === 'paid' ? 'fulfilled' : ''),
      fulfillmentMessage: string(row.fulfillmentMessage) };
  }

  return {
    async listMatchmakers(args = {}) {
      const page = pageArgs(args, ['status']);
      if (args.status !== undefined && typeof args.status !== 'number' && typeof args.status !== 'string') throw fail(422, '筛选条件无效');
      const status = args.status === undefined || args.status === '' ? '' : choice(String(args.status), ['0', '1', '2']);
      const [rows, users, readProfiles, readMembers, readSalons] = await Promise.all([
        scan(C.matchmakers, FIELDS.matchmakers), scan(C.users, FIELDS.users),
        prepareRelated(C.profiles, 'userId', FIELDS.profiles), prepareRelated(C.members, 'matchmakerId', FIELDS.members),
        prepareRelated(C.salons, 'organizerId', fields(['id', 'organizerId']))
      ]);
      uniqueIndex(rows, 'id');
      const usersById = uniqueIndex(users, 'id');
      const selected = rows.filter(row => Number(row.status) === 1 && (!status || String(row.certificationStatus) === status)
        && matches(page.keyword, [row.id, row.matchmakerNo, usersById.get(numberId(row.userId))?.nickname])).sort(numericOrder);
      const result = paginate(selected, page);
      const userIds = result.list.map(row => row.userId);
      const [profiles, members, salons] = await Promise.all([
        readProfiles(userIds), readMembers(result.list.map(row => row.id)), readSalons(userIds)
      ]);
      const byUser = groupBy(profiles, 'userId'), membersByMatchmaker = groupBy(members, 'matchmakerId'), salonsByUser = groupBy(salons, 'organizerId');
      return { ...result, list: result.list.map(row => matchmakerDto(row, usersById.get(numberId(row.userId)),
        byUser.get(numberId(row.userId)) || [], membersByMatchmaker.get(numberId(row.id)) || [],
        salonsByUser.get(numberId(row.userId)) || [], false)) };
    },
    async detailMatchmaker(args = {}) {
      allowed(args, ['id']); const id = positiveId(args.id);
      const row = await required(C.matchmakers, 'id', id, FIELDS.matchmakers);
      const userId = positiveId(row.userId);
      const [user, profiles, members, salons] = await Promise.all([
        lookup(C.users, 'id', userId, FIELDS.userDetail), related(C.profiles, 'userId', [userId], FIELDS.profiles),
        related(C.members, 'matchmakerId', [id], FIELDS.members), related(C.salons, 'organizerId', [userId], fields(['id', 'organizerId']))
      ]);
      return matchmakerDto(row, user, profiles.filter(profile => numberId(profile.userId) === userId), members, salons, true);
    },
    async listSalons(args = {}) {
      const page = pageArgs(args, ['status']), status = choice(args.status, SALON_STATUSES);
      const [rows, users, readRegistrations] = await Promise.all([scan(C.salons, FIELDS.salons), scan(C.users, FIELDS.users),
        prepareRelated(C.registrations, 'eventId', FIELDS.registrations)]);
      uniqueIndex(rows, 'id'); const byId = uniqueIndex(users, 'id');
      const result = paginate(rows.filter(row => (!status || row.status === status)
        && matches(page.keyword, [row.id, row.title, row.location, byId.get(numberId(row.organizerId))?.nickname])).sort(numericOrder), page);
      const registrations = await readRegistrations(result.list.map(row => row.id));
      const byEvent = groupBy(registrations, 'eventId');
      return { ...result, list: result.list.map(row => salonDto(row, byId.get(numberId(row.organizerId)), byEvent.get(numberId(row.id)) || [], false)) };
    },
    async detailSalon(args = {}) {
      allowed(args, ['id']); const id = positiveId(args.id);
      const row = await required(C.salons, 'id', id, FIELDS.salonDetail);
      const [organizer, registrations] = await Promise.all([lookup(C.users, 'id', positiveId(row.organizerId), FIELDS.users), related(C.registrations, 'eventId', [id], FIELDS.registrations)]);
      return salonDto(row, organizer, registrations, true);
    },
    async listCertifications(args = {}) {
      const page = pageArgs(args, ['kind', 'status']), kind = choice(args.kind, KINDS), status = choice(args.status, CERT_STATUSES);
      const [records, users, readProfiles] = await Promise.all([scan(C.certifications, FIELDS.certifications), scan(C.users, FIELDS.users),
        prepareRelated(C.profiles, 'userId', FIELDS.profiles)]);
      const byId = uniqueIndex(users, 'id'), all = [];
      for (const row of records) {
        const userId = numberId(row.userId), user = byId.get(userId);
        if (userId === null || row._id !== `user_${userId}`) continue;
        const entries = ownCertificationOverview(row, clock()).entries;
        for (const entry of entries) {
          if (kind && entry.kind !== kind) continue;
          const application = row.applications?.[entry.kind], current = row.current?.[entry.kind];
          if (!application && !current) continue;
          const applicationId = typeof application?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(application.requestId) ? application.requestId : '';
          const canView = !!applicationId && activeUser(user);
          const validMaterials = Array.isArray(application?.materialIds) && application.materialIds.length <= 3
            && new Set(application.materialIds).size === application.materialIds.length
            && application.materialIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id));
          const dto = { userId, kind: entry.kind, applicationId, status: entry.status,
            applicationStatus: string(application?.status), verified: entry.verified, user: userDto(user),
            ...pick(entry, ['source', 'submittedAt', 'reviewedAt', 'expiresAt', 'verifiedEducation', 'verifiedFinancialAssetRange', 'feedback']),
            materialCount: validMaterials ? application.materialIds.length : null, canView,
            canReview: canView && validMaterials && application.status === 'pending', updatedAt: string(row.updatedAt) };
          if ((!status || dto.status === status) && matches(page.keyword, [userId, user?.nickname, entry.kind, application?.institutionName])) all.push(dto);
        }
      }
      all.sort((a, b) => String(b.submittedAt || b.updatedAt).localeCompare(String(a.submittedAt || a.updatedAt)) || b.userId - a.userId || a.kind.localeCompare(b.kind));
      const result = paginate(all, page);
      const profiles = await readProfiles(result.list.map(row => row.userId));
      const byUser = groupBy(profiles, 'userId');
      return { ...result, list: result.list.map(row => {
        const hasProfile = (byUser.get(row.userId) || []).length === 1;
        return { ...row, canView: row.canView && hasProfile, canReview: row.canReview && hasProfile };
      }) };
    },
    async detailCertification(args = {}) {
      allowed(args, ['userId', 'kind', 'applicationId']);
      const userId = positiveId(args.userId), kind = choice(args.kind, KINDS), applicationId = identifier(args.applicationId);
      if (!kind) throw fail(422, '请选择认证类型');
      const base = fields(['userId', 'updatedAt', `applications.${kind}`, `current.${kind}`]);
      const [user, profile, initial] = await Promise.all([lookup(C.users, 'id', userId, FIELDS.userDetail),
        lookup(C.profiles, 'userId', userId, FIELDS.profiles), required(C.certifications, '_id', `user_${userId}`, base)]);
      if (!activeUser(user)) throw fail(403, '认证账号已失效');
      if (!profile || numberId(profile.userId) !== userId) throw fail(409, '认证个人资料已变化，请先核查');
      if (numberId(initial.userId) !== userId) throw fail(403, '认证申请归属不一致');
      if (initial.applications?.[kind]?.requestId !== applicationId) throw fail(409, '认证申请已变化，请重新读取');
      const materialIds = applicationIds(initial.applications[kind].materialIds);
      const projection = fields(['userId', 'updatedAt', `applications.${kind}`, `current.${kind}`,
        ...materialIds.flatMap(id => MATERIAL.map(key => `materials.${id}.${key}`))]);
      const row = await required(C.certifications, '_id', `user_${userId}`, projection);
      if (numberId(row.userId) !== userId) throw fail(403, '认证申请归属不一致');
      const application = row.applications?.[kind];
      if (application?.requestId !== applicationId || JSON.stringify(applicationIds(application.materialIds)) !== JSON.stringify(materialIds)) {
        throw fail(409, '认证申请已变化，请重新读取');
      }
      const materials = materialIds.map(id => {
        const material = row.materials?.[id];
        if (!material || material.id !== id || material.kind !== kind || material.applicationId !== applicationId
          || material.status !== 'bound' || typeof material.fileID !== 'string' || !material.fileID.startsWith('cloud://')) {
          throw fail(409, '认证材料绑定已变化，请重新读取');
        }
        return pick(material, ['id', 'kind', 'mimeType', 'size', 'createdAt']);
      });
      const entry = ownCertificationOverview(row, clock()).entries.find(entry => entry.kind === kind);
      return { userId, kind, applicationId, user: userDto(user, true),
        ...pick(application, ['status', 'source', 'method', 'educationLevel', 'institutionName', 'submittedAt', 'reviewedAt', 'feedback']),
        effectiveStatus: entry.status, verified: entry.verified, current: pick(row.current?.[kind], CURRENT_SUMMARY),
        materialIds, materials, canReview: application.status === 'pending',
        canRevoke: row.current?.[kind]?.status === 'approved', version: versionFor('certifications', row, kind) };
    },
    async listPlans(args = {}) {
      const page = pageArgs(args, ['active']);
      const active = args.active === undefined || args.active === '' ? null : args.active;
      if (active !== null && typeof active !== 'boolean') throw fail(422, '套餐启停筛选须为布尔值');
      const index = planIndex(await scan(C.plans, FIELDS.plans));
      const defaults = new Map(DEFAULT_MEMBERSHIP_PLANS.map(plan => [plan.planCode, plan]));
      const rows = [...DEFAULT_MEMBERSHIP_PLANS.map(plan => planDto(index.get(plan.planCode), plan)),
        ...[...index].filter(([code]) => !defaults.has(code)).map(([, row]) => planDto(row, null))]
        .filter(row => (active === null || row.active === active) && matches(page.keyword, [row.code, row.title]))
        .sort((a, b) => Number(b.sortOrder || 0) - Number(a.sortOrder || 0) || a.code.localeCompare(b.code));
      return paginate(rows, page);
    },
    async detailPlan(args = {}) {
      allowed(args, ['planCode']);
      if (typeof args.planCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(args.planCode)) throw fail(422, '套餐编码无效');
      const index = planIndex(await scan(C.plans, FIELDS.plans));
      const canonical = DEFAULT_MEMBERSHIP_PLANS.find(plan => plan.planCode === args.planCode);
      const raw = index.get(args.planCode);
      if (!raw && !canonical) throw fail(404, '套餐不存在');
      return planDto(raw, canonical);
    },
    async listOrders(args = {}) {
      const page = pageArgs(args, ['status', 'fulfillmentStatus', 'productType', 'userId']);
      const status = choice(args.status, ORDER_STATUSES), fulfillment = choice(args.fulfillmentStatus, ['fulfilled', 'requires_review']);
      const product = choice(args.productType, ['vip', 'matchmaking', 'legacy']);
      const userId = args.userId === undefined || args.userId === '' ? null : positiveId(args.userId);
      const rows = await scan(C.orders, FIELDS.orders), keys = new Set();
      for (const row of rows) {
        if (typeof row.outTradeNo !== 'string' || !row.outTradeNo || keys.has(row.outTradeNo)) throw fail(409, '存在冲突的支付订单号，请先核查');
        keys.add(row.outTradeNo);
      }
      const result = rows.filter(row => (!status || row.status === status)
        && (!fulfillment || (row.fulfillmentStatus || (row.status === 'paid' ? 'fulfilled' : '')) === fulfillment)
        && (!product || (product === 'legacy' ? !row.productType : row.productType === product))
        && (userId === null || numberId(row.userId) === userId)
        && matches(page.keyword, [row.outTradeNo, row.planCode, row.planTitle, row.transactionId])).sort(numericOrder);
      const paged = paginate(result, page);
      return { ...paged, list: paged.list.map(orderDto) };
    },
    async detailOrder(args = {}) {
      allowed(args, ['outTradeNo']); const outTradeNo = identifier(args.outTradeNo);
      const row = await required(C.orders, 'outTradeNo', outTradeNo, FIELDS.orders);
      const user = numberId(row.userId) === null ? null : await lookup(C.users, 'id', numberId(row.userId), FIELDS.users);
      return { ...orderDto(row), user: userDto(user) };
    }
  };
}

module.exports = { createReadService, MAX_ROWS, COLLECTIONS: C, FIELDS };
