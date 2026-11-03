const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMemberLocation, memberDistanceText, currentLocation, LOCATION_TTL_MS } = require('../cloudfunctions/hlApi/member-location-policy');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

test('location keeps coarse positions, expires and never invents a distance', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  const a = normalizeMemberLocation({ enabled: true, latitude: 31.234567, longitude: 121.473821 }, now);
  assert.equal(a.latitude, 31.23); assert.equal(a.longitude, 121.47);
  assert.equal(memberDistanceText(a, a, +now), '距你约3公里内');
  assert.equal(memberDistanceText(a, { ...a, latitude: 32.23 }, +now), '距你约111公里');
  assert.equal(currentLocation(a, +now + LOCATION_TTL_MS + 1), false);
  assert.equal(memberDistanceText(a, null, +now), '');
  assert.equal(normalizeMemberLocation({ enabled: false }), null);
  for (const latitude of [NaN, Infinity, 91, '31', null]) {
    assert.throws(() => normalizeMemberLocation({ enabled: true, latitude, longitude: 121 }), /定位信息无效/);
  }
});

test('location is requested only after explicit consent, saves once and can be cleared', async () => {
  let locations = 0;
  const writes = [];
  const r = runtime('pages/user/members.js', { source: true, request: async (path, options) => {
    assert.equal(path, '/user/location');
    if (options.method === 'PUT') writes.push(options.data);
    return { enabled: options.data?.enabled === true };
  }, wx: { showModal: options => options.success({ confirm: true }),
    getLocation: options => { locations++; options.success({ latitude: 31.234, longitude: 121.47 }); } } });
  await r.page.onShow();
  assert.equal(locations, 0);
  await r.page.toggleLocation();
  assert.equal(locations, 1); assert.equal(r.page.data.locationEnabled, true);
  assert.equal(writes[0].enabled, true);
  await r.page.toggleLocation();
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1])), { enabled: false });
  assert.equal(locations, 1); assert.equal(r.page.data.locationEnabled, false);
});

test('declined or late device location never writes a different session location', async () => {
  let writes = 0;
  let locationCallback;
  const r = runtime('pages/user/members.js', { source: true,
    request: async (_path, options) => { if (options.method === 'PUT') writes++; return { enabled: false }; },
    wx: { showModal: options => options.success({ confirm: false }), getLocation: options => { locationCallback = options; } } });
  await r.page.onShow();
  await r.page.toggleLocation();
  assert.equal(locationCallback, undefined); assert.equal(writes, 0);
  const pending = deferred();
  const late = runtime('pages/user/members.js', { source: true,
    request: async (_path, options) => { if (options.method === 'PUT') writes++; return { enabled: false }; },
    wx: { showModal: options => options.success({ confirm: true }), getLocation: options => pending.promise.then(options.success) } });
  await late.page.onShow();
  const enabling = late.page.toggleLocation();
  await flush();
  late.session.token = 'different-session';
  pending.resolve({ latitude: 31, longitude: 121 });
  await enabling;
  assert.equal(writes, 0);
});
