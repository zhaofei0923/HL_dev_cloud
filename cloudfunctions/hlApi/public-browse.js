'use strict';

// Guest browsing has its own projections and reader. It must never use the
// authenticated salon view (which includes attendee identities), getAll's
// collection-creation fallback, or any login/seed path.
const PUBLIC_STATUSES = Object.freeze(['upcoming', 'ended', 'cancelled']);
const EVENT_FIELDS = Object.freeze({ id: true, title: true, description: true, location: true,
  eventDate: true, maxParticipants: true, currentParticipants: true, price: true, status: true });
const PLAN_FIELDS = Object.freeze({ planCode: true, active: true });
const MAX_EVENTS = 2000;

function error(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function unavailable() {
  return error('公开内容暂时无法加载，请稍后重试', 503, 50301);
}

function missingCollection(err) {
  const diagnostic = [err?.errCode, err?.code, err?.errMsg, err?.message].filter(Boolean).join(' ');
  return /DATABASE_COLLECTION_NOT_EXIST|database collection not exists|Db or Table not exist|collection[^\n]*does not exist/i.test(diagnostic);
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function nonnegative(value, integer = false) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && (!integer || Number.isSafeInteger(number)) ? number : 0;
}

function eventView(row) {
  return { id: Number(row.id), title: text(row.title, 120), description: text(row.description, 8000),
    location: text(row.location, 300), eventDate: text(row.eventDate, 80),
    maxParticipants: nonnegative(row.maxParticipants, true), currentParticipants: nonnegative(row.currentParticipants, true),
    price: nonnegative(row.price), status: row.status, requiresLogin: true };
}

function queryInput(data, fields) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => !fields.includes(key))) {
    throw error('浏览参数无效，请刷新后重试', 400, 40001);
  }
  return data;
}

function pageNumber(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw error('分页参数无效', 400, 40001);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw error('分页参数无效', 400, 40001);
  return result;
}

function createPublicBrowseService({ db, plans, env = {}, now = () => new Date() }) {
  // Only the six code-owned products can appear here; persisted extra fields or
  // historical goods cannot become a public price or a new purchasable product.
  const catalog = plans.filter(plan => ['vip', 'matchmaking'].includes(plan.productType));

  async function read(collection, query, fields, maxRows) {
    const rows = [];
    try {
      for (let skip = 0; skip < maxRows; skip += 100) {
        let ref = db.collection(collection);
        if (query) ref = ref.where(query);
        const result = await ref.field(fields).skip(skip).limit(Math.min(100, maxRows - skip)).get();
        if (!Array.isArray(result?.data)) throw unavailable();
        rows.push(...result.data);
        if (result.data.length < Math.min(100, maxRows - skip)) break;
      }
      return rows;
    } catch (err) {
      if (missingCollection(err)) return [];
      throw unavailable();
    }
  }

  async function listEvents(data) {
    const filters = queryInput(data, ['page', 'pageSize', 'period']);
    const page = pageNumber(filters.page, 1, 1000);
    const pageSize = pageNumber(filters.pageSize, 20, 20);
    const period = filters.period === undefined ? 'upcoming' : filters.period;
    if (!['upcoming', 'past'].includes(period)) throw error('活动时段参数无效', 400, 40001);
    const instant = new Date(now()).getTime();
    if (!Number.isFinite(instant)) throw unavailable();
    const rows = (await read('hl_salon_events', { status: db.command.in(PUBLIC_STATUSES) }, EVENT_FIELDS, MAX_EVENTS))
      .filter(row => Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 && PUBLIC_STATUSES.includes(row.status))
      .filter(row => {
        const startsAt = Date.parse(row.eventDate);
        if (!Number.isFinite(startsAt)) return false;
        const past = row.status === 'ended' || row.status === 'cancelled' || startsAt <= instant;
        return period === 'past' ? past : !past;
      })
      .sort((a, b) => (period === 'past' ? -1 : 1) * (Date.parse(a.eventDate) - Date.parse(b.eventDate))
        || Number(a.id) - Number(b.id));
    return { list: rows.slice((page - 1) * pageSize, page * pageSize).map(eventView), total: rows.length, page, pageSize };
  }

  async function detailEvent(id, data) {
    queryInput(data, []);
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number <= 0) throw error('活动不存在或尚未公开', 404, 40400);
    const rows = await read('hl_salon_events', { id: number, status: db.command.in(PUBLIC_STATUSES) }, EVENT_FIELDS, 1);
    const row = rows.find(event => Number(event.id) === number && PUBLIC_STATUSES.includes(event.status));
    if (!row) throw error('活动不存在或尚未公开', 404, 40400);
    return eventView(row);
  }

  async function servicePlans(data) {
    queryInput(data, []);
    if (String(env.VIP_MEMBERSHIP_CATALOG_READY || '').toLowerCase() !== 'true') return { plans: [] };
    const configured = await read('hl_membership_plans', null, PLAN_FIELDS, 200);
    // An absent catalog is an empty browse result, never an automatic publish.
    if (!configured.length) return { plans: [] };
    const enabled = configured.filter(row => [true, 1, '1', 'true'].includes(row.active)).map(row => row.planCode);
    return { plans: catalog.filter(plan => enabled.includes(plan.planCode))
      .sort((a, b) => b.sortOrder - a.sortOrder)
      .map(plan => ({ planCode: plan.planCode, name: plan.title, priceFen: plan.amountFen,
        durationDays: plan.durationDays, serviceTimes: plan.productType === 'matchmaking' ? plan.serviceCount : 0,
        productType: plan.productType })) };
  }

  return {
    async handle(method, path, data = {}) {
      const detail = /^\/public\/salon\/events\/([1-9]\d{0,15})$/.exec(path);
      if (path !== '/public/salon/events' && path !== '/public/service-plans' && !detail) {
        throw error('公开页面不存在', 404, 40400);
      }
      if (method !== 'GET') throw error('公开内容仅支持浏览', 405, 40500);
      if (detail) return detailEvent(detail[1], data);
      if (path === '/public/salon/events') return listEvents(data);
      return servicePlans(data);
    }
  };
}

module.exports = { createPublicBrowseService };
