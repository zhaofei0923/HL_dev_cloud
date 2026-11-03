const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');
const { normalizeMatchingPreferences, matchingPreferenceScore, matchingPreferencesSummary, OCCUPATIONS, OPTIONS } = require('../cloudfunctions/hlApi/matching-preferences-policy');

const preferences = patch => normalizeMatchingPreferences({ ageMin: 25, ageMax: 34, heightMin: 175,
  occupations: ['金融', 'AI行业'], education: '本科', city: '上海', marriageTimeline: '两年内', hasChildren: '无',
  wantsChildren: '想要', weightMin: 50, weightMax: 75, zodiac: '兔', constellation: '双子座',
  smoking: '不吸烟', drinking: '偶尔喝酒', pets: '养宠物', maritalStatus: '未婚', ...patch });

function pageRuntime(read = async () => ({ preferences: preferences() })) {
  const requests = [];
  const r = runtime('pages/user/preferences.js', { source: true, wx: {
    cloud: { callFunction(options) {
      requests.push(options.data);
      Promise.resolve().then(() => read(options.data, requests.length)).then(data => {
        options.success({ result: { code: 0, data } });
      }, error => options.success({ result: { code: error.code || 40001, message: error.message } }));
    } }
  } });
  return { ...r, requests };
}

const input = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });

test('15 preference dimensions round-trip without hidden fields; unrestricted resets all choices', () => {
  const value = preferences();
  assert.deepEqual(normalizeMatchingPreferences(value), value);
  assert.equal(Object.keys(value).length, 17); // Age and weight each have two bounds.
  assert.equal(normalizeMatchingPreferences({ admin: true }).admin, undefined);
  assert.deepEqual(normalizeMatchingPreferences({}).occupations, []);
  assert.equal(normalizeMatchingPreferences({}).ageMin, null);
  assert.equal(normalizeMatchingPreferences({}).hasChildren, '');
  assert.match(matchingPreferencesSummary(value), /无孩子/);
  assert.match(matchingPreferencesSummary(value), /175cm以上/);
});

test('invalid ranges, options, types and overlong data are rejected', () => {
  for (const invalid of [{ ageMin: 17 }, { ageMax: 101 }, { ageMin: '25' }, { ageMin: 25.5 },
    { ageMin: 35, ageMax: 30 }, { weightMin: 80, weightMax: 60 }, { heightMin: true },
    { occupations: '金融' }, { occupations: ['未定义职业'] }, { city: 'a'.repeat(61) },
    { pets: {} }, { wantsChildren: false }, { drinking: 'anything' }]) {
    assert.throws(() => normalizeMatchingPreferences(invalid), error => error.code === 40001);
  }
  assert.deepEqual(normalizeMatchingPreferences({ occupations: ['金融', '金融'] }).occupations, ['金融']);
});

test('recommendation scores use known matching data, verified education, and never invent unknown fields', () => {
  const value = preferences();
  assert.equal(matchingPreferenceScore({}, value), 0);
  assert.equal(matchingPreferenceScore({ age: 30, height: 180, occupation: '金融', city: '上海市', education: '本科' }, value), 5);
  assert.equal(matchingPreferenceScore({ education: '本科', educationVerified: true, verifiedEducation: '硕士' }, value), 0);
  assert.equal(matchingPreferenceScore({ weightKg: 65 }, value), 1);
  assert.equal(matchingPreferenceScore({}, normalizeMatchingPreferences({})), 0);
});

test('page loads all values and saves the actual typed selections, then reloads them', async () => {
  let stored = preferences();
  const r = pageRuntime(async req => {
    if (req.method === 'PUT') stored = normalizeMatchingPreferences(req.data.preferences);
    return { preferences: stored };
  });
  await r.page.onShow();
  assert.equal(r.page.data.form.heightMin, '175');
  assert.equal(r.page.data.form.city, '上海');
  assert.equal(r.page.data.habitRows.length, 5);
  r.page.onInput(input('ageMin', '28'));
  r.page.onHeight({ detail: { value: '5' } });
  r.page.onOccupation(tap({ value: '医生' }));
  await r.page.savePreferences();
  assert.equal(r.requests[1].path, '/user/matching-preferences');
  assert.equal(r.requests[1].method, 'PUT');
  assert.equal(stored.ageMin, 28); assert.equal(stored.heightMin, 180);
  assert.ok(stored.occupations.includes('医生'));
  assert.equal(r.page.data.dirty, false); assert.match(r.page.data.saveMessage, /已保存/);
  await r.page.loadPreferences(); assert.equal(r.page.data.form.ageMin, '28');
  r.page.resetPreferences(); await r.page.savePreferences();
  assert.deepEqual(stored, normalizeMatchingPreferences({}));
});

test('client bounds prevent invalid saves and failed writes keep the editable draft for retry', async () => {
  let failSave = true;
  const r = pageRuntime(async req => {
    if (req.method === 'PUT') {
      if (failSave) throw new Error('保存失败，请重试');
      return { preferences: req.data.preferences };
    }
    return { preferences: preferences() };
  });
  await r.page.onShow(); r.page.onInput(input('ageMin', '90')); await r.page.savePreferences();
  assert.equal(r.requests.length, 1); assert.match(r.page.data.error, /下限/);
  r.page.onInput(input('ageMin', '29')); await r.page.savePreferences();
  assert.equal(r.page.data.dirty, true); assert.equal(r.page.data.saving, false);
  assert.equal(r.page.data.form.ageMin, '29'); assert.match(r.page.data.error, /失败/);
  failSave = false; await r.page.savePreferences(); assert.equal(r.page.data.dirty, false);
});

test('late responses cannot leak preferences across accounts or modify a hidden page', async () => {
  const pending = deferred();
  const r = pageRuntime(() => pending.promise);
  const load = r.page.onShow(); await flush();
  r.session.token = 'different-session'; r.session.user = { id: 2 };
  pending.resolve({ preferences: preferences({ city: 'PRIVATE_CITY' }) }); await load;
  assert.equal(r.page.data.form.city, '');
  const hidden = pageRuntime(); const hiddenLoad = hidden.page.onShow(); hidden.page.onHide(); await hiddenLoad;
  assert.equal(hidden.page.data.ready, false);
});

test('frontend enum options stay consistent with backend validation', () => {
  const r = pageRuntime();
  const form = r.load(path.resolve('miniprogram/utils/matching-preferences-form.ts'));
  assert.deepEqual(JSON.parse(JSON.stringify(form.PREFERENCE_OPTIONS)), OPTIONS);
  assert.deepEqual([...form.PREFERENCE_OCCUPATIONS].sort(), [...OCCUPATIONS].sort());
});

async function seedRecommendationCaches(r) {
  const cache = r.load(path.resolve('miniprogram/utils/showcase-cache.ts'));
  const scope = cache.showcaseSessionScope(r.session.token, r.session.user, r.session.env);
  const recommend = { page: 1, pageSize: 50, keyword: '', city: '', gender: '', category: 'recommend' };
  const education = { ...recommend, category: 'education' };
  const result = { list: [{ id: 'profile_2', userId: 2 }], total: 1 };
  await cache.requestShowcase(scope, recommend, async () => result);
  await cache.requestShowcase(scope, education, async () => result);
  return { cache, scope, recommend, education };
}

test('successful preference saves and resets expire only recommendation snapshots before their normal TTL', async () => {
  const r = pageRuntime(async req => ({ preferences: req.method === 'PUT' ? req.data.preferences : preferences() }));
  await r.page.onShow();
  for (const reset of [false, true]) {
    const { cache, scope, recommend, education } = await seedRecommendationCaches(r);
    assert.ok(cache.readShowcaseCache(scope, recommend));
    if (reset) r.page.resetPreferences(); else r.page.onInput(input('ageMin', '28'));
    await r.page.savePreferences();
    assert.equal(cache.readShowcaseCache(scope, recommend), null);
    assert.ok(cache.readShowcaseCache(scope, education), 'non-recommendation category stays warm');
  }
});

test('a failed preference save preserves recommendation caches and the editable draft', async () => {
  const r = pageRuntime(async req => {
    if (req.method === 'PUT') throw new Error('暂时无法保存');
    return { preferences: preferences() };
  });
  await r.page.onShow();
  const { cache, scope, recommend } = await seedRecommendationCaches(r);
  r.page.onInput(input('ageMin', '28')); await r.page.savePreferences();
  assert.ok(cache.readShowcaseCache(scope, recommend));
  assert.equal(r.page.data.dirty, true);
});

test('save completion after leaving refreshes only the same account cache and never patches hidden UI', async () => {
  for (const replaced of [false, true]) {
    const pending = deferred();
    const r = pageRuntime(async req => req.method === 'PUT' ? pending.promise : { preferences: preferences() });
    await r.page.onShow();
    let seeded = await seedRecommendationCaches(r);
    r.page.onInput(input('ageMin', '28'));
    const saving = r.page.savePreferences(); await flush(); r.page.onHide();
    if (replaced) {
      r.session.token = 'replacement-session'; r.session.user = { id: 2 };
      seeded = await seedRecommendationCaches(r);
    }
    const updates = r.calls.updates.length;
    pending.resolve({ preferences: preferences({ ageMin: 28 }) }); await saving;
    assert.equal(r.calls.updates.length, updates);
    const snapshot = seeded.cache.readShowcaseCache(seeded.scope, seeded.recommend);
    if (replaced) assert.ok(snapshot, 'the replacement account cache is preserved');
    else assert.equal(snapshot, null, 'same-account recommendation cache expires even after navigation');
  }
});

test('leaving and returning during a preference save retains the write lock until actual settlement', async () => {
  const pending = deferred();
  const r = pageRuntime(async req => req.method === 'PUT' ? pending.promise : { preferences: preferences() });
  await r.page.onShow(); r.page.onInput(input('ageMin', '28'));
  const saving = r.page.savePreferences(); await flush();
  r.page.onHide(); await r.page.onShow();
  assert.equal(r.page.data.saving, true);
  r.page.onInput(input('ageMin', '29'));
  await r.page.savePreferences();
  assert.equal(r.page.data.form.ageMin, '28', 'the pending draft remains locked');
  assert.equal(r.requests.filter(req => req.method === 'PUT').length, 1, 'no second write can race the original request');
  pending.resolve({ preferences: preferences({ ageMin: 28 }) }); await saving;
  assert.equal(r.page.data.saving, false); assert.equal(r.page.data.dirty, false);
  assert.equal(r.page.data.form.ageMin, '28'); assert.match(r.page.data.saveMessage, /已保存/);
});

test('a hidden completed save reloads on return, and a failed returning save releases its write lock for retry', async () => {
  let stored = preferences(); const pending = deferred();
  const r = pageRuntime(async req => {
    if (req.method === 'PUT') { await pending.promise; stored = req.data.preferences; }
    return { preferences: stored };
  });
  await r.page.onShow(); r.page.onInput(input('ageMin', '28'));
  const saving = r.page.savePreferences(); await flush(); r.page.onHide();
  pending.resolve(); await saving; await r.page.onShow();
  assert.equal(r.page.data.form.ageMin, '28'); assert.equal(r.page.data.dirty, false); assert.equal(r.page.data.saving, false);
  const failed = deferred(); let writes = 0;
  const other = pageRuntime(async req => {
    if (req.method === 'PUT' && ++writes === 1) return failed.promise;
    return { preferences: req.method === 'PUT' ? req.data.preferences : preferences() };
  });
  await other.page.onShow(); other.page.onInput(input('ageMin', '29'));
  const firstSave = other.page.savePreferences(); await flush(); other.page.onHide(); await other.page.onShow();
  failed.reject(new Error('保存失败，请重试')); await firstSave;
  assert.equal(other.page.data.saving, false); assert.equal(other.page.data.dirty, true); assert.match(other.page.data.error, /失败/);
  await other.page.savePreferences(); assert.equal(writes, 2); assert.equal(other.page.data.dirty, false);
});
