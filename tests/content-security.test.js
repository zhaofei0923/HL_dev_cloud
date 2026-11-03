const test = require('node:test');
const assert = require('node:assert/strict');
const { createContentSecurityService } = require('../cloudfunctions/hlApi/content-security');

function harness(respond = async () => ({ errCode: 0, result: { suggest: 'pass', label: 100 } })) {
  const calls = [], logs = [];
  const cloud = { openapi: { security: { msgSecCheck: async data => { calls.push(data); return respond(data, calls.length); } } } };
  const service = createContentSecurityService({ cloud, logger: record => logs.push(record) });
  return { ...service, calls, logs };
}

function rejectsWith(status, code) {
  return failure => {
    assert.equal(failure.status, status);
    assert.equal(failure.statusCode, status);
    assert.equal(failure.code, code);
    return true;
  };
}

test('v2 checks use the caller OpenID, selected scene, and explicit pass verdict', async () => {
  const instance = harness();
  await instance.assertText({ openid: 'trusted-openid', scene: 2, content: ' 正常内容 ' });
  assert.deepEqual(instance.calls, [{ openid: 'trusted-openid', version: 2, scene: 2, content: '正常内容' }]);
  assert.deepEqual(instance.logs, [{ status: 'pass', code: 0 }]);
});

test('SDK camelCase, HTTP snake_case, and omitted success codes are supported', async () => {
  for (const response of [
    { errCode: 0, result: { suggest: 'pass' } },
    { errcode: 0, result: { suggest: 'pass' } },
    { errCode: 0, errcode: '0', result: { suggest: 'pass' } },
    { result: { suggest: 'pass' } }
  ]) await harness(async () => response).assertText({ openid: 'user', content: 'hello' });
});

test('risky, review, returned 87014, and thrown 87014 block content with safe errors', async () => {
  for (const response of [
    { errCode: 0, result: { suggest: 'risky' } },
    { errcode: 0, result: { suggest: 'review' } },
    { errcode: 87014, errmsg: 'private rejected text' },
    { errCode: 0, errcode: 87014, result: { suggest: 'pass' } }
  ]) {
    const instance = harness(async () => response);
    await assert.rejects(instance.assertText({ openid: 'user', content: 'private rejected text' }), rejectsWith(400, 40061));
    assert.ok(!JSON.stringify(instance.logs).includes('private'));
  }
  const instance = harness(async () => { throw { errCode: 87014, errMsg: 'private rejected text' }; });
  await assert.rejects(instance.assertText({ openid: 'user', content: 'private rejected text' }), failure => {
    rejectsWith(400, 40061)(failure);
    assert.ok(!failure.message.includes('private'));
    assert.equal(failure.cause, undefined);
    return true;
  });
});

test('malformed or conflicting response codes and missing verdicts fail closed', async () => {
  const cases = [null, undefined, [], 'pass', {}, { errcode: 0 }, { result: {} },
    { result: { suggest: 'unknown' } }, { result: { suggest: 'PASS' } },
    { errCode: 0, errcode: 40013, result: { suggest: 'pass' } },
    { errcode: 0, errCode: 40013, result: { suggest: 'pass' } },
    { errCode: null, result: { suggest: 'pass' } },
    { errCode: false, result: { suggest: 'pass' } },
    { errCode: '', result: { suggest: 'pass' } },
    { errcode: 'unavailable', result: { suggest: 'pass' } }];
  for (const response of cases) {
    const instance = harness(async () => response);
    await assert.rejects(instance.assertText({ openid: 'user', content: 'text' }), rejectsWith(503, 50361));
  }
});

test('API failures, missing OpenID, invalid scene, and missing SDK never allow text', async () => {
  const instance = harness(async () => { throw new Error('secret API diagnostic and user content'); });
  await assert.rejects(instance.assertText({ openid: 'user', content: 'text' }), failure => {
    rejectsWith(503, 50361)(failure);
    assert.ok(!failure.message.includes('secret'));
    return true;
  });
  assert.deepEqual(instance.logs, [{ status: 'unavailable' }]);
  for (const openid of [undefined, null, '', ' ', 123, 'invalid openid']) {
    const local = harness();
    await assert.rejects(local.assertText({ openid, content: 'text' }), rejectsWith(503, 50361));
    assert.equal(local.calls.length, 0);
  }
  for (const scene of [0, 5, '1', null]) {
    await assert.rejects(harness().assertText({ openid: 'user', scene, content: 'text' }), rejectsWith(503, 50361));
  }
  await assert.rejects(createContentSecurityService().assertText({ openid: 'user', content: 'text' }), rejectsWith(503, 50361));
});

test('long Unicode text is checked in bounded overlapping chunks without splitting characters', async () => {
  const instance = harness();
  const body = '😀'.repeat(2500) + '跨边界文本' + '好'.repeat(2499);
  await instance.assertText({ openid: 'user', scene: 3, content: body });
  assert.equal(instance.calls.length, 3);
  assert.ok(instance.calls.every(call => Array.from(call.content).length <= 2500));
  const chunks = instance.calls.map(call => Array.from(call.content));
  assert.deepEqual(chunks[0].slice(-128), chunks[1].slice(0, 128));
  const recovered = chunks[0].join('') + chunks.slice(1).map(chunk => chunk.slice(128).join('')).join('');
  assert.equal(recovered, body);
  assert.ok(instance.calls.some(call => call.content.includes('跨边界文本')));
});

test('all chunks must pass and processing stops at the first failing chunk', async () => {
  const instance = harness(async (_data, number) => ({ errcode: 0, result: { suggest: number === 2 ? 'review' : 'pass' } }));
  await assert.rejects(instance.assertText({ openid: 'user', content: 'a'.repeat(8000) }), rejectsWith(400, 40061));
  assert.equal(instance.calls.length, 2);
  const partial = harness(async (_data, number) => number === 2 ? { errCode: 0 } : { errCode: 0, result: { suggest: 'pass' } });
  await assert.rejects(partial.assertText({ openid: 'user', content: 'a'.repeat(8000) }), rejectsWith(503, 50361));
  assert.equal(partial.calls.length, 2);
});

test('empty optional text is skipped but title and nickname cannot bypass detection', async () => {
  const instance = harness();
  await instance.assertText({ content: '  ' });
  assert.equal(instance.calls.length, 0);
  await instance.assertText({ openid: 'user', title: '活动标题', nickname: '昵称', content: '' });
  assert.equal(instance.calls[0].content, '活动标题\n昵称');
});

test('non-string content and excessive aggregate input are rejected before API calls', async () => {
  for (const input of [{ content: {} }, { content: ['text'] }, { title: 42 }, { nickname: false },
    { content: 'a'.repeat(19001) }, { content: '😀'.repeat(19001) },
    { title: 'a'.repeat(10000), content: 'b'.repeat(10000) }]) {
    const instance = harness();
    await assert.rejects(instance.assertText({ openid: 'user', ...input }), rejectsWith(400, 40062));
    assert.equal(instance.calls.length, 0);
  }
  const bounded = harness();
  await bounded.assertText({ openid: 'user', content: 'a'.repeat(19000) });
  assert.equal(bounded.calls.length, 8);
});

test('safe evidence contains only status, optional trace ID and numeric code', async () => {
  const instance = harness(async () => ({ errCode: 0, traceId: 'trace-123', result: { suggest: 'pass' }, detail: [{ content: 'private' }] }));
  await instance.assertText({ openid: 'private-user', content: 'private content' });
  assert.deepEqual(instance.logs, [{ status: 'pass', traceId: 'trace-123', code: 0 }]);
  const unsafeTrace = harness(async () => ({ errcode: 0, trace_id: 'private content\n', result: { suggest: 'pass' } }));
  await unsafeTrace.assertText({ openid: 'user', content: 'text' });
  assert.deepEqual(unsafeTrace.logs, [{ status: 'pass', code: 0 }]);
  const service = createContentSecurityService({ cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } }, logger: () => { throw new Error('logger unavailable'); } });
  await service.assertText({ openid: 'user', content: 'text' });
});

test('custom application error factory keeps the same safe HTTP contract', async () => {
  const factoryCalls = [];
  const service = createContentSecurityService({ cloud: {}, error: (message, status, code) => {
    factoryCalls.push({ message, status, code });
    return new Error(message);
  } });
  await assert.rejects(service.assertText({ openid: 'user', content: 'text' }), rejectsWith(503, 50361));
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].code, 50361);
});
