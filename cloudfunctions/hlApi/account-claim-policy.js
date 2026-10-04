'use strict';

const crypto = require('node:crypto');

const CLAIM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_SECRET_BYTES = 32;
const CLAIM_TOKEN_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const MANUAL_OPENID_PATTERN = /^manual_\d+$/;

function isManualIdentity(openid) {
  return MANUAL_OPENID_PATTERN.test(String(openid || '').trim());
}

function createClaimToken(memberId, randomBytes = crypto.randomBytes) {
  const normalizedMemberId = Number(memberId);
  if (!Number.isSafeInteger(normalizedMemberId) || normalizedMemberId <= 0) {
    throw new TypeError('memberId must be a positive integer');
  }
  const secret = randomBytes(CLAIM_SECRET_BYTES).toString('base64url');
  return `${normalizedMemberId}.${secret}`;
}

function parseClaimToken(token) {
  const value = String(token || '').trim();
  const match = value.match(CLAIM_TOKEN_PATTERN);
  if (!match) return null;
  const memberId = Number(match[1]);
  if (!Number.isSafeInteger(memberId) || memberId <= 0) return null;
  return { memberId, token: value };
}

function hashClaimToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function claimTokenMatches(token, expectedHash) {
  const parsed = parseClaimToken(token);
  const expected = String(expectedHash || '');
  if (!parsed || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actualBuffer = Buffer.from(hashClaimToken(parsed.token), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function claimExpiresAt(now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError('invalid claim clock');
  return new Date(timestamp + CLAIM_INVITE_TTL_MS).toISOString();
}

function isClaimExpired(expiresAt, now = Date.now()) {
  const expiry = new Date(expiresAt || '').getTime();
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  return !Number.isFinite(expiry) || !Number.isFinite(timestamp) || expiry <= timestamp;
}

function maskName(value) {
  const name = String(value || '').trim();
  if (!name) return '会员';
  if (name.length === 1) return `${name}*`;
  return `${name.slice(0, 1)}${'*'.repeat(Math.min(name.length - 1, 3))}`;
}

function maskPhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  if (phone.length < 7) return '已留存';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizeMainlandPhone(value) {
  let phone = String(value || '').trim().replace(/[\s()-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  return /^1[3-9]\d{9}$/.test(phone) ? phone : '';
}

function maskMemberNo(value) {
  const memberNo = String(value || '').trim();
  if (!memberNo) return '待生成';
  const visible = memberNo.slice(-4);
  return `${'*'.repeat(Math.max(memberNo.length - visible.length, 2))}${visible}`;
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'string' ? !value.trim() : false;
}

function fillTargetProfileBlanks(target = {}, source = {}, fields = []) {
  const patch = {};
  fields.forEach(field => {
    if (isBlank(target[field]) && !isBlank(source[field])) patch[field] = source[field];
  });
  return patch;
}

function archivedMergedOpenid(userId, openid) {
  const digest = crypto.createHash('sha256')
    .update(`${Number(userId)}:${String(openid || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `merged_${Number(userId)}_${digest}`;
}

module.exports = {
  CLAIM_INVITE_TTL_MS,
  archivedMergedOpenid,
  claimExpiresAt,
  claimTokenMatches,
  createClaimToken,
  fillTargetProfileBlanks,
  hashClaimToken,
  isClaimExpired,
  isManualIdentity,
  maskMemberNo,
  maskName,
  maskPhone,
  normalizeMainlandPhone,
  parseClaimToken
};
