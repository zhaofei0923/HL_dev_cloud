const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const photo = 'cloud://fixture/hl_uploads/profile/20261007/self.jpg';
const displayPhoto = 'https://fixture.example/self.jpg';
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function minimum(completed = false, values = {}) {
  return { completed, missingFields: completed ? [] : ['phone', 'nickname', 'photo'],
    user: { id: 1, nickname: '新用户', phone: '', avatarUrl: '', ...values },
    profile: { realName: '', photos: [] }, phoneStatus: 'filled' };
}

// Compile only the owned page into memory, so verification does not regenerate shared JS.
function runtime(pageName, overrides = {}) {
  const filePath = path.join(__dirname, '..', 'miniprogram', 'pages',
    pageName === 'index' ? 'index' : 'user', `${pageName}.ts`);
  const source = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const session = { token: overrides.loggedOut ? '' : 'fixture-token', env: 'fixture-env',
    user: overrides.loggedOut ? null : { id: 1, nickname: '已有账号', currentRole: 'user', matchmakerId: 999 } };
  const calls = { requests: [], functions: [], removed: [], logins: [], photos: [], storage: [], navigation: [], member: [], registration: [] };
  const storage = new Map([['token', session.token], ['user', session.user]]);
  const timers = [];
  let definition;
  const scope = () => session.token ? `${session.env}:${session.user && session.user.id}:${session.token}` : '';
  let api = {
    currentUser: () => session.user,
    apiErrorMessage: error => String(error && (error.message || error.errMsg) || ''),
    request: (requestPath, options = {}) => {
      calls.requests.push({ path: requestPath, options: structuredClone(options) });
      return Promise.resolve().then(() => overrides.request
        ? overrides.request(requestPath, options, calls.requests.length, session) : minimum());
    }
  };
  const localImage = {
    chooseLocalImages: async (count, options) => {
      calls.photos.push({ count, options });
      return overrides.choosePhotos ? overrides.choosePhotos() : [{ fileID: photo, displayUrl: displayPhoto }];
    },
    isImageChooseCancel: error => /cancel/i.test(String(error && error.message || '')),
    resolveImageUrls: async values => values.map(value => value === photo ? displayPhoto : value)
  };
  const memberApi = {
    resolveMatchmakerInvite: async data => { calls.member.push({ action: 'resolve', data }); return { nickname: '主理人', alreadyAssigned: false }; },
    acceptMatchmakerInvite: async data => { calls.member.push({ action: 'accept', data }); return { invite: { nickname: '主理人' }, alreadyAssigned: false }; },
    requestMatchmaker: async data => { calls.member.push({ action: 'request', data }); return { status: 'pending' }; }
  };
  const context = {
    module: { exports: {} }, exports: {},
    Page: page => { definition = page; },
    require: name => {
      if (name.endsWith('/services/api')) return api;
      if (name.endsWith('/services/auth')) return {
        loginByWechat: async role => {
          calls.logins.push(role);
          if (overrides.login) await overrides.login(session);
          else { session.token = 'logged-in-fixture-token'; session.user = { id: 1, nickname: '新用户', currentRole: 'user' }; }
          return { token: session.token, user: session.user };
        }
      };
      if (name.endsWith('/utils/page-session')) return { pageSessionScope: scope };
      if (name.endsWith('/utils/local-image')) return localImage;
      if (name.endsWith('/services/member')) return { memberApi };
      if (name.endsWith('/services/salon')) return { salonApi: { register: async id => calls.registration.push(id) } };
      if (name.endsWith('/utils/invite')) return require('../miniprogram/utils/invite');
      throw new Error(`Unmocked import ${name}`);
    },
    getApp: () => ({ globalData: session }),
    wx: {
      getStorageSync: key => overrides.realApi ? storage.get(key) : session[key],
      setStorageSync: (key, value) => { calls.storage.push({ key, value: structuredClone(value) }); storage.set(key, value); },
      removeStorageSync: key => { calls.removed.push(key); storage.delete(key); },
      switchTab: options => calls.navigation.push({ method: 'switchTab', url: options.url }),
      redirectTo: options => calls.navigation.push({ method: 'redirectTo', url: options.url }),
      showToast() {}, setClipboardData() {},
      cloud: { callFunction: options => calls.functions.push(options) }
    },
    console: { warn() {} },
    setTimeout: callback => { timers.push(callback); return timers.length; }
  };
  if (overrides.realApi) {
    const apiPath = path.join(__dirname, '..', 'miniprogram', 'services', 'api.ts');
    const apiSource = ts.transpileModule(fs.readFileSync(apiPath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    const apiModule = { exports: {} };
    vm.runInNewContext(apiSource, { ...context, module: apiModule, exports: apiModule.exports,
      require: name => {
        assert.equal(name, '../config/cloud');
        return { CLOUD_ENV_ID: 'fixture-default-env', CLOUD_FUNCTION_NAME: 'fixture-api' };
      }
    }, { filename: apiPath });
    api = apiModule.exports;
  }
  vm.runInNewContext(source, context, { filename: filePath });
  const page = { ...definition, data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, structuredClone(update)); } };
  return { page, api, session, storage, calls, runTimers: () => timers.splice(0).forEach(callback => callback()) };
}

async function indexEntry(instance, eventId = '301') {
  instance.page.onLoad({ register: '1', eventId });
  await instance.page.onShow();
}
function input(value) { return { detail: { value } }; }
function fill(page) {
  page.onRegistrationPhone(input('13800138000'));
  page.onRegistrationName(input('小陈'));
  page.setData({ photoFileId: photo, photoDisplayUrl: displayPhoto });
}

test('shared salon signup uses the real login entry, saves all minimum fields and returns for explicit registration', async () => {
  const instance = runtime('index', { loggedOut: true, request: (_path, options) => options.method === 'PUT'
    ? minimum(true, { nickname: options.data.nickname, phone: options.data.phone, avatarUrl: options.data.photos[0] }) : minimum() });
  await indexEntry(instance);
  assert.equal(instance.page.data.loggedIn, false);
  assert.equal(instance.calls.requests.length, 0);
  await instance.page.login();
  assert.deepEqual(instance.calls.logins, ['user']);
  assert.equal(instance.page.data.loggedIn, true);
  assert.equal(instance.page.data.nickname, '', 'the placeholder login name is not completed registration');
  assert.equal(instance.calls.navigation.length, 0);
  await instance.page.chooseRegistrationPhoto();
  assert.deepEqual(structuredClone(instance.calls.photos), [{ count: 1, options: { crop: true } }]);
  instance.page.onRegistrationPhone(input('13800138000'));
  instance.page.onRegistrationName(input('小陈'));
  await instance.page.saveRegistration();
  assert.deepEqual(instance.calls.requests.at(-1), { path: '/user/minimum-registration', options: {
    method: 'PUT', showError: false, data: { phone: '13800138000', nickname: '小陈', photos: [photo] },
    unauthorizedRedirect: '/pages/index/index?register=1&eventId=301'
  } });
  assert.equal(instance.session.user.avatarUrl, photo);
  assert.equal(instance.calls.storage.at(-1).value.nickname, '小陈');
  assert.deepEqual(instance.calls.navigation, [{ method: 'redirectTo', url: '/pages/user/salon-detail?id=301&registrationReady=1' }]);
  assert.equal(instance.calls.registration.length, 0, 'saving a profile must not register before the activity confirmation');
  assert.equal(instance.calls.member.length, 0, 'saving a profile must not bind a matchmaker');
});

test('minimum registration requires a phone, real chosen name and uploaded profile photo without claiming phone verification', async () => {
  const instance = runtime('index');
  await indexEntry(instance);
  for (const invalid of [
    { phone: '123' }, { nickname: '' }, { nickname: '新用户' }, { nickname: '用户0001' },
    { photoFileId: '/assets/members/avatar-female-1.png' }, { photoFileId: 'wxfile://tmp/photo.jpg' }
  ]) {
    fill(instance.page);
    instance.page.setData(invalid);
    await instance.page.saveRegistration();
    assert.ok(instance.page.data.errorText);
  }
  assert.equal(instance.calls.requests.length, 1);
  instance.page.setData({ phoneStatus: 'verified' });
  instance.page.onRegistrationPhone(input('13900139000'));
  assert.equal(instance.page.data.phoneStatus, 'filled');
  assert.equal(instance.calls.storage.length, 0);
});

test('completed existing accounts return directly without changing their matchmaker, writing a profile or logging in again', async () => {
  const instance = runtime('index', { request: () => minimum(true) });
  await indexEntry(instance, '302');
  assert.equal(instance.session.user.matchmakerId, 999);
  assert.equal(instance.calls.logins.length, 0);
  assert.equal(instance.calls.storage.length, 0);
  assert.equal(instance.calls.requests.length, 1);
  assert.equal(instance.calls.requests[0].options.method, undefined);
  assert.equal(instance.calls.navigation[0].url, '/pages/user/salon-detail?id=302&registrationReady=1');
});

test('registration read and write failures retain the event and form for a deduplicated retry', async () => {
  const saving = deferred();
  let reads = 0;
  let writes = 0;
  const instance = runtime('index', { request: (_path, options) => {
    if (options.method === 'PUT') { writes += 1; return writes === 1 ? saving.promise : minimum(true); }
    reads += 1;
    if (reads === 1) throw new Error('network read failed');
    return minimum();
  } });
  await indexEntry(instance);
  assert.ok(instance.page.data.errorText);
  assert.equal(instance.page.data.eventId, '301');
  await instance.page.retryRegistration();
  assert.equal(reads, 2);
  fill(instance.page);
  const first = instance.page.saveRegistration();
  await flush();
  await instance.page.saveRegistration();
  assert.equal(writes, 1);
  saving.reject(new Error('network write failed'));
  await first;
  assert.equal(instance.page.data.phone, '13800138000');
  assert.equal(instance.page.data.nickname, '小陈');
  assert.equal(instance.page.data.photoFileId, photo);
  assert.equal(instance.page.data.saving, false);
  assert.equal(instance.calls.navigation.length, 0);
  await instance.page.saveRegistration();
  assert.equal(writes, 2);
  assert.equal(instance.calls.navigation[0].url, '/pages/user/salon-detail?id=301&registrationReady=1');
});

test('returning from the photo picker keeps draft input and a photo error permits another upload', async () => {
  let reads = 0;
  let uploads = 0;
  const instance = runtime('index', {
    request: () => { reads += 1; return minimum(); },
    choosePhotos: () => {
      uploads += 1;
      if (uploads === 1) throw new Error('upload failed');
      return [{ fileID: photo, displayUrl: displayPhoto }];
    }
  });
  await indexEntry(instance);
  fill(instance.page);
  await instance.page.chooseRegistrationPhoto();
  assert.equal(instance.page.data.photoUploading, false);
  assert.ok(instance.page.data.errorText);
  await instance.page.chooseRegistrationPhoto();
  await instance.page.onShow();
  assert.equal(reads, 1);
  assert.equal(instance.page.data.nickname, '小陈');
  assert.equal(instance.page.data.photoFileId, photo);
});

test('an old registration read, save or photo selection cannot populate another session', async () => {
  for (const operation of ['read', 'save', 'photo']) {
    const pending = deferred();
    let reads = 0;
    const instance = runtime('index', {
      request: (_path, options) => {
        if (options.method === 'PUT') return pending.promise;
        reads += 1;
        return operation === 'read' && reads === 1 ? pending.promise : minimum(false, { id: instance.session.user.id, nickname: '新账号' });
      },
      choosePhotos: () => pending.promise
    });
    instance.page.onLoad({ register: '1', eventId: '301' });
    const reading = instance.page.onShow();
    await flush();
    let older = reading;
    if (operation !== 'read') {
      await reading;
      fill(instance.page);
      older = operation === 'save' ? instance.page.saveRegistration() : instance.page.chooseRegistrationPhoto();
      await flush();
    }
    instance.session.token = 'different-fixture-token';
    instance.session.user = { id: 2, nickname: '新账号', currentRole: 'user' };
    await instance.page.onShow();
    if (operation === 'photo') pending.resolve([{ fileID: photo, displayUrl: displayPhoto }]);
    else pending.resolve(minimum(operation === 'save', { id: 1, nickname: '旧账号', phone: '13800138000', avatarUrl: photo }));
    await older;
    assert.equal(instance.page.data.nickname, '新账号');
    assert.equal(instance.page.data.photoFileId, '');
    assert.equal(instance.session.user.id, 2);
    assert.equal(instance.calls.storage.length, 0);
    assert.equal(instance.calls.navigation.length, 0);
  }
});

test('invalid activity targets cannot trigger login, a registration write or a matchmaker binding', async () => {
  const instance = runtime('index', { loggedOut: true });
  await indexEntry(instance, '../other?id=1');
  await instance.page.login();
  await instance.page.saveRegistration();
  assert.equal(instance.calls.logins.length, 0);
  assert.equal(instance.calls.requests.length, 0);
  assert.ok(instance.page.data.errorText);
  for (const options of [
    { code: 'HLABCD', eventId: '../../other', source: 'salonShare' },
    { code: 'HLABCD', source: 'salonShare' }
  ]) {
    const invite = runtime('matchmaker-invite');
    await invite.page.onLoad(options);
    await invite.page.loadInvite();
    assert.equal(invite.calls.member.length, 0);
    assert.equal(invite.calls.requests.length, 0);
    assert.ok(invite.page.data.errorText);
  }
});

test('legacy salon invitations redirect incomplete or logged-out users to the same activity registration entry', async () => {
  for (const loggedOut of [false, true]) {
    const instance = runtime('matchmaker-invite', { loggedOut });
    await instance.page.onLoad({ code: 'HLABCD', source: 'salonShare', eventId: '301', autoRegister: '1' });
    assert.equal(instance.calls.navigation[0].url, '/pages/index/index?register=1&eventId=301');
    assert.equal(instance.calls.logins.length, 0);
    assert.equal(instance.calls.member.length, 0);
    assert.equal(instance.calls.registration.length, 0);
  }
});

test('legacy salon invitations for complete users only return to explicit confirmation and never rebind any account', async () => {
  for (const assigned of [true, false]) {
    const instance = runtime('matchmaker-invite', { request: () => minimum(true) });
    if (!assigned) delete instance.session.user.matchmakerId;
    const before = structuredClone(instance.session.user);
    await instance.page.onLoad({ code: 'HLABCD', source: 'salonShare', eventId: '301', autoRegister: '1' });
    assert.equal(instance.calls.navigation[0].url, '/pages/user/salon-detail?id=301&registrationReady=1');
    assert.deepEqual(instance.session.user, before);
    assert.equal(instance.calls.member.length, 0);
    assert.equal(instance.calls.registration.length, 0);
    assert.equal(instance.calls.requests.length, 1);
  }
});

test('legacy activity profile reads deduplicate, retry after failure and ignore late changed-session responses', async () => {
  const pending = deferred();
  let reads = 0;
  const instance = runtime('matchmaker-invite', { request: () => {
    reads += 1;
    return reads === 1 ? Promise.reject(new Error('network failed')) : pending.promise;
  } });
  await instance.page.onLoad({ eventId: '301', source: 'salonShare' });
  assert.ok(instance.page.data.errorText);
  const retry = instance.page.loadInvite();
  const duplicate = instance.page.loadInvite();
  await flush();
  assert.equal(reads, 2);
  instance.session.token = 'new-fixture-token';
  instance.session.user = { id: 2 };
  pending.resolve(minimum(true));
  await Promise.all([retry, duplicate]);
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.calls.member.length, 0);
  assert.equal(instance.calls.registration.length, 0);
});

test('returning to an activity invite in a new session supersedes an older status read', async () => {
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const instance = runtime('matchmaker-invite', { request: () => {
    reads += 1;
    return reads === 1 ? old.promise : latest.promise;
  } });
  const loading = instance.page.onLoad({ eventId: '301', source: 'salonShare' });
  await flush();
  instance.session.token = 'new-fixture-token';
  instance.session.user = { id: 2 };
  const returned = instance.page.onShow();
  await flush();
  assert.equal(reads, 2);
  latest.resolve(minimum(false, { id: 2 }));
  await returned;
  old.resolve(minimum(true));
  await loading;
  assert.deepEqual(instance.calls.navigation, [{ method: 'redirectTo', url: '/pages/index/index?register=1&eventId=301' }]);
  assert.equal(instance.page.data.loading, false);
  assert.equal(instance.calls.member.length, 0);
});

test('ordinary login and non-activity matchmaker sharing retain their existing behavior', async () => {
  const loggedIn = runtime('index');
  loggedIn.page.onLoad({});
  await loggedIn.page.onShow();
  assert.equal(loggedIn.calls.requests.length, 0);
  assert.equal(loggedIn.calls.navigation[0].url, '/pages/user/members');
  const loggedOut = runtime('index', { loggedOut: true });
  loggedOut.page.onLoad({});
  await loggedOut.page.login();
  assert.deepEqual(loggedOut.calls.logins, ['user']);
  assert.equal(loggedOut.calls.navigation[0].url, '/pages/user/members');
  const invite = runtime('matchmaker-invite');
  await invite.page.onLoad({ code: 'HLABCD', source: 'matchmakerShare' });
  assert.deepEqual(invite.calls.member.map(row => row.action), ['resolve', 'accept']);
  assert.equal(invite.calls.requests.length, 0);
  invite.runTimers();
  assert.equal(invite.calls.navigation[0].url, '/pages/user/profile');
  assert.equal(invite.page.onShareAppMessage().path, '/pages/user/matchmaker-invite?code=HLABCD&source=matchmakerShare');
});

function unauthorized(callback) {
  callback.success({ result: { code: 40100, message: 'invalid token', data: null } });
}

test('real API 401 callbacks clear the expired token and preserve activity entry on minimum-profile reads and saves', async () => {
  for (const operation of ['read', 'save', 'invite']) {
    const instance = runtime(operation === 'invite' ? 'matchmaker-invite' : 'index', { realApi: true });
    let pending;
    if (operation === 'invite') {
      pending = instance.page.onLoad({ source: 'salonShare', eventId: '301' });
    } else {
      instance.page.onLoad({ register: '1', eventId: '301' });
      pending = instance.page.onShow();
    }
    await flush();
    if (operation === 'save') {
      instance.calls.functions[0].success({ result: { code: 0, data: minimum() } });
      await pending;
      fill(instance.page);
      pending = instance.page.saveRegistration();
      await flush();
    }
    const callback = instance.calls.functions.at(-1);
    assert.equal(callback.data.path, '/user/minimum-registration');
    assert.equal(callback.data.method, operation === 'save' ? 'PUT' : 'GET');
    unauthorized(callback);
    await pending;
    assert.deepEqual(instance.calls.removed, ['token', 'user']);
    assert.equal(instance.session.token, '');
    assert.equal(instance.session.user, null);
    assert.equal(instance.storage.has('token'), false);
    assert.equal(instance.storage.has('user'), false);
    assert.deepEqual(instance.calls.navigation, [{ method: 'redirectTo', url: '/pages/index/index?register=1&eventId=301' }]);
    assert.equal(instance.page.data.eventId, '301');
    assert.equal(instance.calls.member.length, 0);
    assert.equal(instance.calls.registration.length, 0);
    if (operation === 'read') {
      const login = instance.page.login();
      await flush();
      instance.calls.functions.at(-1).success({ result: { code: 0, data: minimum(true) } });
      await login;
      assert.deepEqual(instance.calls.logins, ['user']);
      assert.equal(instance.calls.navigation.at(-1).url, '/pages/user/salon-detail?id=301&registrationReady=1');
      assert.equal(instance.calls.navigation.some(row => row.url === '/pages/user/members'), false);
    }
  }
});

test('real API optional unauthorized redirects preserve default behavior and explicit session preservation', async () => {
  for (const preserve of [false, true]) {
    const instance = runtime('index', { realApi: true });
    const pending = instance.api.request('/fixture', preserve ? {
      preserveSessionOnUnauthorized: true, unauthorizedRedirect: '/pages/index/index?register=1&eventId=301'
    } : {});
    const rejected = assert.rejects(pending, error => error.code === 40100);
    unauthorized(instance.calls.functions[0]);
    await rejected;
    assert.deepEqual(instance.calls.navigation, preserve ? [] : [{ method: 'redirectTo', url: '/pages/index/index' }]);
    assert.equal(instance.session.token, preserve ? 'fixture-token' : '');
    assert.deepEqual(instance.calls.removed, preserve ? [] : ['token', 'user']);
  }
  const instance = runtime('index', { realApi: true });
  const pending = instance.api.request('/fixture', { unauthorizedRedirect: '/pages/index/index?register=1&eventId=301' });
  const rejected = assert.rejects(pending, error => error.code === 40300);
  instance.calls.functions[0].success({ result: { code: 40300, message: 'forbidden', data: null } });
  await rejected;
  assert.equal(instance.session.token, 'fixture-token');
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.calls.removed.length, 0);
});

test('real API late 401 callbacks with an activity redirect cannot clear or navigate a newer account or environment', async () => {
  for (const change of ['token', 'environment', 'both']) {
    const instance = runtime('index', { realApi: true });
    const pending = instance.api.request('/user/minimum-registration', {
      unauthorizedRedirect: '/pages/index/index?register=1&eventId=301'
    });
    const rejected = assert.rejects(pending, error => error.code === 40100);
    if (change !== 'environment') instance.session.token = 'new-fixture-token';
    if (change !== 'token') instance.session.env = 'another-fixture-env';
    instance.session.user = { id: 2 };
    instance.storage.set('token', instance.session.token);
    instance.storage.set('user', instance.session.user);
    const currentToken = instance.session.token;
    unauthorized(instance.calls.functions[0]);
    await rejected;
    assert.equal(instance.session.token, currentToken);
    assert.equal(instance.session.user.id, 2);
    assert.equal(instance.storage.get('user').id, 2);
    assert.equal(instance.calls.removed.length, 0);
    assert.equal(instance.calls.navigation.length, 0);
  }
});

test('sharing an activity invite without a matchmaker code retains the activity even after a read failure', async () => {
  const instance = runtime('matchmaker-invite', { request: () => { throw new Error('network failed'); } });
  await instance.page.onLoad({ eventId: '7', source: 'salonShare' });
  assert.ok(instance.page.data.errorText);
  assert.equal(instance.page.data.code, '');
  const card = instance.page.onShareAppMessage();
  assert.equal(card.path, '/pages/user/salon-detail?id=7&source=salonShare');
  assert.equal(instance.calls.member.length, 0);
  assert.equal(instance.calls.registration.length, 0);
});
