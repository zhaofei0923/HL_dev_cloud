'use strict';

function denied() {
  return { allowed: false, ready: false };
}

function configuredUserIds(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384) return null;
  const ids = value.split(',').map(part => part.trim());
  if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) return null;
  return new Set(ids.map(Number));
}

/** The capability controls native navigation only. Every management action
 * separately rechecks the live business account and server-side administrator list. */
function miniprogramAdminEntry(user, session, env = process.env) {
  if (!user || !session || !Number.isSafeInteger(session.userId) || session.userId <= 0
    || Number(user.id) !== session.userId || Number(user.status) !== 1 || user.mergedIntoUserId
    || Number(user.authVersion || 1) !== Number(session.authVersion || 1)) return denied();
  const allowedIds = configuredUserIds(env.MINIPROGRAM_ADMIN_USER_IDS);
  if (!allowedIds || !allowedIds.has(session.userId)) return denied();
  return { allowed: true, ready: true, mode: 'native' };
}

module.exports = { miniprogramAdminEntry, configuredUserIds };
