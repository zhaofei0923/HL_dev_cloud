'use strict';

const LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeMemberLocation(data, now = new Date()) {
  if (data.enabled === false) return null;
  const { latitude, longitude } = data;
  if (data.enabled !== true || typeof latitude !== 'number' || typeof longitude !== 'number'
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('定位信息无效，请重新开启定位'), { status: 400, code: 40001 });
  }
  // Retain only a coarse grid, never the precise coordinates supplied by the device.
  return { latitude: Math.round(latitude * 100) / 100, longitude: Math.round(longitude * 100) / 100,
    updatedAt: now.toISOString() };
}

function currentLocation(location, now = Date.now()) {
  const updatedAt = Date.parse(location?.updatedAt || '');
  return !!location && typeof location.latitude === 'number' && typeof location.longitude === 'number'
    && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)
    && Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180
    && Number.isFinite(updatedAt) && updatedAt <= now && now - updatedAt <= LOCATION_TTL_MS;
}

function memberDistanceText(viewer, target, now = Date.now()) {
  if (!currentLocation(viewer, now) || !currentLocation(target, now)) return '';
  const rad = degrees => degrees * Math.PI / 180;
  const latDelta = rad(target.latitude - viewer.latitude);
  const lngDelta = rad(target.longitude - viewer.longitude);
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(rad(viewer.latitude)) * Math.cos(rad(target.latitude)) * Math.sin(lngDelta / 2) ** 2;
  const km = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  return km < 3 ? '距你约3公里内' : `距你约${Math.round(km)}公里`;
}

module.exports = { LOCATION_TTL_MS, normalizeMemberLocation, currentLocation, memberDistanceText };
