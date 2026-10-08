const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const miniprogramRoot = path.join(__dirname, '..', '..', 'miniprogram');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function runtime(relativePath, overrides = {}) {
  const filePath = path.join(miniprogramRoot, relativePath);
  const modules = new Map();
  const calls = { requests: [], navigation: [], storage: [], toasts: [], updates: [], tabUpdates: [], events: [], titles: [], scrolls: [], stopRefresh: 0 };
  const session = { token: 'navigation-test-session', user: { id: 1, nickname: '测试用户', gender: 2 }, env: 'test-environment' };
  let now = Date.UTC(2026, 9, 6);
  let definition;
  let componentDefinition;
  let evaluatingModule = '';
  let currentPagePath = relativePath;
  const pageDefinitions = new Map();
  let timerId = 0;
  const timers = new Map();
  const setDataCallbacks = [];
  class RuntimeDate extends Date {
    constructor(...arguments_) {
      if (arguments_.length) super(...arguments_);
      else super(now);
    }
    static now() { return now; }
  }
  function navigate(method, options) {
    calls.navigation.push({ method, url: options.url, options });
    if (!overrides.manualNavigation) {
      if (options.success) options.success({});
      if (options.complete) options.complete({});
    }
  }
  const services = {
    api: {
      currentUser: () => session.user,
      apiErrorMessage: error => String(error && (error.errMsg || error.message) || error || ''),
      isSessionRecoverableError: error => [401, 40100, 40102].includes(Number(error && error.code))
        || /invalid token|unauthorized|user not found/i.test(String(error && (error.errMsg || error.message) || '')),
      request: (requestPath, options) => {
        calls.requests.push({ path: requestPath, options });
        return overrides.request ? overrides.request(requestPath, options) : Promise.resolve({
          ...session.user,
          profile: { realName: '已保存资料', city: '上海', photos: [] }
        });
      }
    },
    auth: {
      loginByWechat: async () => ({}),
      bindWechatPhone: async () => ({}),
      confirmManualMemberClaim: async () => ({})
    },
    member: { memberApi: {
      referralCard: async () => ({ canShare: false }),
      relationships: async () => ({ list: [], counts: { incoming: 0, mutual: 0 }, total: 0, isPremiumMember: false }),
      interact: async () => ({}),
      list: async () => ({ list: [], total: 0 }),
      inviteOptions: async () => ({ list: [], total: 0, page: 1, pageSize: 100 }),
      showcase: async () => ({ list: [], total: 0 }),
      ...overrides.memberApi
    } },
    matchmaker: { matchmakerApi: {
      dashboard: async () => ({ matchmaker: null }),
      status: async () => ({ matchmaker: null }),
      apply: async () => ({}),
      memberRequests: async () => ({ list: [], total: 0 }),
      inviteCard: async () => ({ inviteCode: '', canShare: false }),
      ...overrides.matchmakerApi
    } },
    salon: { salonApi: {
      list: async () => ({ list: [], total: 0 }),
      myRegistrations: async () => ({ list: [], total: 0 }),
      myEvents: async () => ({ list: [], total: 0 }),
      ...overrides.salonApi
    } },
    chat: { chatApi: {
      listConversations: async () => ({ list: [], total: 0 }),
      getOrCreateConversation: async () => ({ id: 901 }),
      ...overrides.chatApi
    } }
  };
  const wx = {
    getStorageSync: key => key === 'token' ? session.token : key === 'user' ? session.user : undefined,
    setStorageSync: (key, value) => calls.storage.push({ key, value }),
    removeStorageSync() {},
    showToast: options => calls.toasts.push(options.title),
    showModal: options => { if (options.success) options.success({ confirm: true }); },
    switchTab: options => navigate('switchTab', options),
    redirectTo: options => navigate('redirectTo', options),
    navigateTo: options => navigate('navigateTo', options),
    navigateBack() {},
    stopPullDownRefresh: () => { calls.stopRefresh += 1; },
    setNavigationBarTitle: options => calls.titles.push(options.title),
    pageScrollTo: options => calls.scrolls.push(options),
    showLoading() {}, hideLoading() {},
    nextTick: callback => callback()
  };
  const tabBar = { setData: data => calls.tabUpdates.push(data) };
  const context = vm.createContext({
    Page: options => {
      definition = options;
      pageDefinitions.set(evaluatingModule, options);
    },
    Component: options => { componentDefinition = options; },
    wx,
    getApp: () => ({ globalData: session }),
    getCurrentPages: () => [{ route: currentPagePath.replace(/\.js$/, '') }],
    Date: RuntimeDate,
    console: { warn() {}, error() {}, log() {} },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  function load(modulePath) {
    if (modules.has(modulePath)) return modules.get(modulePath).exports;
    const module = { exports: {} };
    modules.set(modulePath, module);
    const localRequire = createRequire(modulePath);
    const require = name => {
      const service = name.match(/(?:^|\/)services\/([^/]+)$/);
      if (service && services[service[1]]) return services[service[1]];
      if (name.endsWith('/utils/local-image')) return {
        resolveImageUrls: async values => values,
        chooseLocalImages: async () => [],
        isImageChooseCancel: () => false
      };
      if (name.endsWith('/chat-voice') || name.endsWith('/utils/chat-voice')) return {
        resolveChatVoiceUrls: async messages => messages,
        voiceDurationText: value => `${Math.max(Number(value || 0), 1)}秒`,
        cancelChatVoiceRecording() {},
        startChatVoiceRecording: async () => {},
        stopChatVoiceRecording: async () => ({ tempFilePath: 'test-voice.mp3', durationSeconds: 2, format: 'mp3', fileSize: 20 }),
        uploadChatVoice: async () => 'cloud://test/chat-voice.mp3'
      };
      const resolved = localRequire.resolve(name);
      return resolved.startsWith(miniprogramRoot) ? load(resolved) : localRequire(name);
    };
    const wrapper = vm.runInContext(`(function (exports, require, module) {\n${fs.readFileSync(modulePath, 'utf8')}\n})`, context, { filename: modulePath });
    const previousModule = evaluatingModule;
    evaluatingModule = modulePath;
    try { wrapper(module.exports, require, module); }
    finally { evaluatingModule = previousModule; }
    return module.exports;
  }
  load(filePath);
  function setData(update, callback) {
    calls.updates.push(structuredClone(update));
    for (const [dataPath, value] of Object.entries(update)) {
      const parts = dataPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      let target = this.data;
      parts.slice(0, -1).forEach((part, index) => {
        if (target[part] === null || typeof target[part] !== 'object') target[part] = /^\d+$/.test(parts[index + 1]) ? [] : {};
        target = target[part];
      });
      target[parts.at(-1)] = structuredClone(value);
    }
    if (callback) {
      if (overrides.manualSetDataCallbacks) setDataCallbacks.push(callback);
      else callback();
    }
  }
  function instantiatePage(pageDefinition) {
    if (!pageDefinition) return undefined;
    return {
      ...Object.fromEntries(Object.entries(pageDefinition).map(([key, value]) => [
        key, typeof value === 'function' ? value : structuredClone(value)
      ])),
      setData,
      getTabBar: () => tabBar
    };
  }
  const page = instantiatePage(definition);
  function recreatePage(pagePath = relativePath) {
    currentPagePath = pagePath;
    const modulePath = path.join(miniprogramRoot, pagePath);
    load(modulePath);
    return instantiatePage(pageDefinitions.get(modulePath));
  }
  const component = componentDefinition && {
    ...componentDefinition.methods,
    data: {
      ...Object.fromEntries(Object.entries(componentDefinition.properties || {}).map(([key, property]) => [key, property.value])),
      ...structuredClone(componentDefinition.data),
      ...(overrides.role ? { role: overrides.role } : {}),
      ...(overrides.active ? { active: overrides.active } : {}),
      ...(overrides.embedded === undefined ? {} : { embedded: overrides.embedded })
    },
    setData,
    triggerEvent: (name, detail) => calls.events.push({ name, detail })
  };
  if (component && componentDefinition.lifetimes && componentDefinition.lifetimes.attached) {
    componentDefinition.lifetimes.attached.call(component);
  }
  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  }
  const flushSetDataCallbacks = () => setDataCallbacks.splice(0).forEach(callback => callback());
  return { page, component, calls, session, services, advance, load, tabBar, recreatePage, flushSetDataCallbacks };
}

module.exports = { runtime, deferred, flush, miniprogramRoot };
