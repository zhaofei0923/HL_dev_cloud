const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function memberService(result) {
  const file = path.join(__dirname, '..', 'miniprogram', 'services', 'member.js');
  const calls = [];
  const module = { exports: {} };
  const require = name => {
    assert.equal(name, './api');
    return { request: async (url, options) => { calls.push({ url, options }); return result; } };
  };
  const run = vm.runInNewContext(`(function(exports, require, module) { ${fs.readFileSync(file, 'utf8')} })`);
  run(module.exports, require, module);
  return { api: module.exports.memberApi, calls };
}

test('normal recommendations remain compatible with a response without category metadata', async () => {
  const expected = { list: [{ id: 1 }], total: 1 };
  const { api } = memberService(expected);
  assert.equal(await api.showcase({ category: 'recommend' }), expected);
  assert.equal(await api.showcase(), expected);
});

test('specialized categories reject an old or mismatched service response instead of displaying normal members', async () => {
  for (const category of ['popularity', 'education', 'assets']) {
    const legacy = memberService({ list: [{ id: 1, education: '博士' }], total: 1 });
    await assert.rejects(legacy.api.showcase({ category }), /该分类暂不可用/);
    const mismatch = memberService({ category: 'recommend', list: [{ id: 1 }], total: 1 });
    await assert.rejects(mismatch.api.showcase({ category }), /该分类暂不可用/);
  }
});

test('a matching category response and shared filters reach the recommendation page intact', async () => {
  const expected = { category: 'education', list: [{ id: 'profile_88', educationVerified: true }], total: 1 };
  const { api, calls } = memberService(expected);
  const query = { category: 'education', city: '上海', gender: '2', page: 2, pageSize: 50 };
  assert.equal(await api.showcase(query), expected);
  assert.equal(calls[0].url, '/member/showcase');
  assert.equal(calls[0].options.data, query);
});
