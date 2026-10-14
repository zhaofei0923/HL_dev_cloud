'use strict';

const { createHash } = require('node:crypto');
const KINDS = Object.freeze(['identity', 'education', 'vehicle', 'property', 'assets']);
const VERSION_FIELDS = Object.freeze({
  matchmakers: ['id', 'userId', 'status', 'certificationStatus', 'certificationRemark', 'updatedAt'],
  salons: ['id', 'organizerId', 'status', 'eventDate', 'reviewRemark', 'updatedAt'],
  plans: ['planCode', 'title', 'amountFen', 'active', 'productType', 'durationDays', 'serviceCount', 'updatedAt']
});

function error(message, code = 42260) { return Object.assign(new Error(message), { code }); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function canonical(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw error('记录版本无效', 40960);
  return value;
}
function versionFor(resource, row = {}, kind) {
  let body;
  if (resource === 'certifications') {
    if (!KINDS.includes(kind)) throw error('认证类型无效');
    const application = row.applications?.[kind];
    const materialIds = Array.isArray(application?.materialIds) ? [...application.materialIds].sort() : [];
    body = { userId: row.userId, updatedAt: row.updatedAt, kind, application,
      current: row.current?.[kind], materials: materialIds.map(id => {
        const material = row.materials?.[id];
        return material ? Object.fromEntries(['id', 'kind', 'status', 'applicationId', 'fileID', 'mimeType', 'size', 'createdAt']
          .map(key => [key, material[key]])) : { id, missing: true };
      }) };
  } else {
    const fields = VERSION_FIELDS[resource];
    if (!fields) throw error('管理资源无效');
    body = Object.fromEntries(fields.map(key => [key, key === 'planCode' ? (row.planCode || row.code) : row[key]]));
  }
  return 'v1_' + createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

function allowed(value, fields) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw error('管理参数无效');
  return value;
}
function positiveId(value) {
  if (!(Number.isSafeInteger(value) && value > 0)
    && !(typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)))) throw error('记录编号无效');
  return Number(value);
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw error('记录标识无效');
  return value;
}
module.exports = { KINDS, VERSION_FIELDS, versionFor, error, plain, allowed, positiveId, identifier };
