const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const apiPath = path.join(__dirname, '..', 'miniprogram', 'services', 'api.ts');
const apiSource = ts.transpileModule(fs.readFileSync(apiPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 }
}).outputText;

function runtime() {
  const session = { token: 'fixture-private-token', env: 'fixture-private-environment', user: { id: 1 } };
  const storage = new Map([['token', session.token], ['user', session.user]]);
  const calls = { functions: [], removed: [], redirects: [], toasts: [], logs: [] };
  const module = { exports: {} };
  vm.runInNewContext(apiSource, {
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, '../config/cloud');
      return { CLOUD_ENV_ID: 'fixture-default-environment', CLOUD_FUNCTION_NAME: 'fixture-private-api' };
    },
    getApp: () => ({ globalData: session }),
    console: Object.fromEntries(['log', 'info', 'warn', 'error'].map(name => [name, (...args) => calls.logs.push(args)])),
    wx: {
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => { calls.removed.push(key); storage.delete(key); },
      redirectTo: options => calls.redirects.push(options.url),
      showToast: options => calls.toasts.push(options.title),
      cloud: { callFunction: options => calls.functions.push(options) }
    }
  }, { filename: apiPath });
  return { api: module.exports, session, storage, calls };
}

async function rejectedUpload(raw, expected, options = {}) {
  const { api, session, storage, calls } = runtime();
  const pending = api.request('/user/certification-materials', {
    method: 'POST', data: { contentBase64: 'fixture-private-document' }, ...options
  });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.message, expected);
    assert.equal(error.raw, raw);
    assert.equal(error.path, '/user/certification-materials');
    assert.equal(api.apiErrorMessage(error), expected);
    return true;
  });
  assert.equal(calls.functions.length, 1);
  calls.functions[0].fail(raw);
  await rejected;
  assert.equal(calls.functions.length, 1, 'a failed write must not be retried automatically');
  assert.equal(session.token, 'fixture-private-token');
  assert.equal(session.user.id, 1);
  assert.equal(storage.get('token'), 'fixture-private-token');
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.redirects, []);
  assert.deepEqual(calls.toasts, options.showError === false ? [] : [expected]);
  const publicOutput = JSON.stringify({ toasts: calls.toasts, logs: calls.logs });
  assert.doesNotMatch(publicOutput, /fixture-private|https?:|contentBase64|stack-secret/);
}

test('cloud callFunction network and TLS failures describe the connection without blaming deployment', async () => {
  for (const detail of ['request:fail network disconnected', 'request:fail ssl hand shake error']) {
    await rejectedUpload({ errMsg: `cloud.callFunction:fail ${detail} https://fixture-private.example/?token=fixture-private-token` },
      '网络连接失败，请切换网络后重试');
  }
});

test('cloud callFunction timeout keeps a safe numeric error code from the SDK message', async () => {
  await rejectedUpload({ errMsg: 'cloud.callFunction:fail Error: errCode: -501002 request timeout stack-secret' },
    '请求超时，请稍后重试（错误码 -501002）');
});

test('only an explicit missing function is classified as unavailable and the numeric SDK code wins', async () => {
  await rejectedUpload({ errCode: -501000, errMsg: 'cloud.callFunction:fail FUNCTIONS_NOT_FOUND function fixture-private-api not found' },
    '服务暂不可用，请稍后重试（错误码 -501000）');
  await rejectedUpload({ errMsg: 'cloud.callFunction:fail function fixture-private-api not found' },
    '服务暂不可用，请稍后重试');
});

test('cloud callFunction payload errors offer a file-size action and retain a safe semantic code', async () => {
  for (const errCode of ['EXCEED_REQUEST_SIZE_LIMIT', 'EXCEED_REQUEST_SIZE']) {
    await rejectedUpload({ errCode, errMsg: `cloud.callFunction:fail ${errCode} contentBase64=fixture-private-document` },
      `提交内容过大，请缩小文件后重试（错误码 ${errCode}）`);
  }
});

test('cloud callFunction permission failures preserve the account and respect silent requests', async () => {
  await rejectedUpload({ errCode: -601004, errMsg: 'cloud.callFunction:fail permission denied fixture-private-environment' },
    '当前服务暂不可访问，请重新进入小程序后重试（错误码 -601004）', { showError: false });
});

test('unknown execution failures stay neutral and untrusted error-code values never reach users', async () => {
  await rejectedUpload({ errMsg: 'cloud.callFunction:fail -404006 empty poll result base resp.' },
    '请求未完成，请重试（错误码 -404006）');
  await rejectedUpload({ errCode: -504002, errMsg: 'cloud.callFunction:fail functions execute fail | errMsg: dependency not found stack-secret' },
    '请求未完成，请重试（错误码 -504002）');
  await rejectedUpload({ errCode: 'fixture-private-token https://fixture-private.example', errMsg: 'cloud.callFunction:fail stack-secret' },
    '请求未完成，请重试');
});
