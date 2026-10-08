'use strict';

const { normalizeMainlandPhone } = require('./account-claim-policy');

function registrationName(user = {}, profile = {}) {
  const names = [profile.realName, user.nickname].map(value => String(value || '').trim());
  return names.find(value => value && value.length <= 40
    && !/^(新用户|微信用户|优质会员|主理人|用户\d+)$/.test(value)) || '';
}

function isPublicRegistrationPhoto(value) {
  return typeof value === 'string'
    && /^cloud:\/\/[^/]+\/hl_uploads\/profile\/[^?#]+\.(?:jpe?g|png|webp|gif|heic)$/i.test(value.trim());
}

function registrationPhotos(user = {}, profile = {}) {
  const photos = Array.isArray(profile.photos) ? profile.photos : [];
  return Array.from(new Set([...photos, user.avatarUrl]
    .filter(isPublicRegistrationPhoto).map(value => value.trim()))).slice(0, 3);
}

function minimumRegistrationStatus(user = {}, profile = {}) {
  const missingFields = [];
  if (!normalizeMainlandPhone(user.phone)) missingFields.push('phone');
  if (!registrationName(user, profile)) missingFields.push('nickname');
  if (!registrationPhotos(user, profile).length) missingFields.push('photo');
  return { complete: missingFields.length === 0, missingFields };
}

function salonAvailability(event = {}, participantCount = null, now = new Date()) {
  const eventTime = new Date(event.eventDate || '').getTime();
  const validDate = Number.isFinite(eventTime);
  const isExpired = validDate && eventTime <= new Date(now).getTime();
  const count = participantCount === null ? Math.max(Number(event.currentParticipants) || 0, 0) : Math.max(Number(participantCount) || 0, 0);
  const limit = Math.max(Number(event.maxParticipants) || 0, 0);
  const isFull = limit > 0 && count >= limit;
  let registrationBlockedReason = '';
  if (event.status === 'cancelled') registrationBlockedReason = 'cancelled';
  else if (event.status === 'ended') registrationBlockedReason = 'ended';
  else if (!validDate) registrationBlockedReason = 'invalid_date';
  else if (isExpired) registrationBlockedReason = 'expired';
  else if (event.status !== 'upcoming') registrationBlockedReason = 'not_open';
  else if (isFull) registrationBlockedReason = 'full';
  const labels = { cancelled: '已取消', ended: '已结束', expired: '已结束',
    invalid_date: '时间待确认', not_open: event.status === 'pending' ? '待审核' : '暂不可报名', full: '已满员' };
  return { canRegister: !registrationBlockedReason, isExpired, isFull,
    statusText: labels[registrationBlockedReason] || '报名中', registrationBlockedReason };
}

function latestAttendanceRows(rows = []) {
  const byUserId = new Map();
  [...rows].sort((a, b) => Number(b.registrationRevision || 0) - Number(a.registrationRevision || 0)
    || (new Date(b.updatedAt || b.createdAt || 0).getTime() || 0)
      - (new Date(a.updatedAt || a.createdAt || 0).getTime() || 0)
      || Number(b.id || 0) - Number(a.id || 0)).forEach(row => {
    const userId = Number(row.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    // Never borrow a prior registration's consent to widen a later record.
    if (!byUserId.has(userId)) byUserId.set(userId, row);
  });
  return Array.from(byUserId.values());
}

function activeAttendance(rows = []) {
  return latestAttendanceRows(rows).filter(row => row.status === 'registered');
}

module.exports = { activeAttendance, latestAttendanceRows, isPublicRegistrationPhoto, minimumRegistrationStatus,
  registrationName, registrationPhotos, salonAvailability };
