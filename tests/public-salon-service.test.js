const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { runtime } = require('./helpers/miniprogram-runtime');
const { createPublicBrowseService } = require('../cloudfunctions/hlApi/public-browse');

test('public activity services always omit the account token and preserve voluntary browsing on errors', async () => {
  const calls = [], module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync('miniprogram/services/salon.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    assert.equal(name, './api'); return { request: async (path, options) => { calls.push({ path, options }); return {}; } };
  } });
  await module.exports.salonApi.publicList({ page: 1, pageSize: 30, period: 'upcoming' });
  await module.exports.salonApi.publicDetail('7');
  assert.equal(calls[0].path, '/public/salon/events');
  assert.equal(calls[1].path, '/public/salon/events/7');
  for (const call of calls) {
    assert.equal(call.options.auth, false);
    assert.equal(call.options.showError, false);
    assert.equal(call.options.preserveSessionOnUnauthorized, true);
  }
});

test('the guest activity page satisfies the real public endpoint pagination contract while signed-in pages retain 30 rows', async () => {
  const db = { command: { in: values => values }, collection: () => {
    const ref = { where: () => ref, field: () => ref, skip: () => ref, limit: () => ref,
      get: async () => ({ data: [] }) };
    return ref;
  } };
  const publicService = createPublicBrowseService({ db, plans: [], now: () => '2026-10-20T00:00:00.000Z' });
  for (const guest of [true, false]) {
    const queries = [];
    const instance = runtime('pages/user/salon.js', { source: true, salonApi: {
      publicList: query => {
        queries.push(query);
        return publicService.handle('GET', '/public/salon/events', query);
      },
      list: async query => { queries.push(query); return { list: [], total: 0 }; }
    } });
    if (guest) { instance.session.token = ''; instance.session.user = null; }
    await instance.page.onShow();
    await instance.page.loadPast();
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.pageSize === (guest ? 20 : 30)));
    assert.equal(instance.page.data.listTitle, '往期活动', 'real endpoint parameters must not enter the availability error state');
    assert.equal(instance.page.data.listNote, '查看已结束或取消的活动。');
  }
});
