const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const helper = import('../scripts/formal-payment-key-probe.mjs');
const input = { appId: 'wx1234567890abcdef', appSecret: 'fixture-app-secret-123456',
  productionAppKey: 'fixture-production-key-123456', openid: 'fixtureWechatOpenid_123456' };

test('formal key probe signs only a fresh production read query and returns no credentials', async () => {
  const { probeFormalPaymentKey } = await helper;
  let tokenCalls = 0, queryCalls = 0;
  const result = await probeFormalPaymentKey(input, {
    randomBytes: size => { assert.equal(size, 12); return Buffer.alloc(12, 7); },
    accessToken: async secret => { tokenCalls++; assert.equal(secret, input.appSecret); return 'fixture_access_token_123456'; },
    request: async (url, body) => {
      queryCalls++;
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.weixin.qq.com');
      assert.equal(parsed.pathname, '/xpay/query_order');
      assert.deepEqual(JSON.parse(body), { openid: input.openid, env: 0, order_id: `HLKP${'07'.repeat(12)}` });
      assert.equal(parsed.searchParams.get('pay_sig'), crypto.createHmac('sha256', input.productionAppKey)
        .update(`/xpay/query_order&${body}`).digest('hex'));
      return { status: 200, data: { errcode: 0, errmsg: '', order: null } };
    }
  });
  assert.deepEqual(result, { signatureVerified: true, env: 0, queryCalls: 1, orderAbsent: true, ordersCreated: 0 });
  assert.equal(tokenCalls, 1);
  assert.equal(queryCalls, 1);
  for (const secret of Object.values(input)) assert.ok(!JSON.stringify(result).includes(secret));
});

test('undocumented absent-order and malformed provider responses never validate a production key', async () => {
  const { classifyFormalKeyProbeResponse } = await helper;
  for (const data of [
    { errcode: 90019, errmsg: '订单不存在' },
    { errcode: 268490002, errmsg: 'unclassified business response' },
    { errcode: 12345, errmsg: 'not found' },
    { errcode: '0' }, null, [], {}
  ]) {
    assert.throws(() => classifyFormalKeyProbeResponse(200, data), { safeCode: 'PRODUCTION_KEY_PROBE_UNCONFIRMED' });
  }
  assert.throws(() => classifyFormalKeyProbeResponse(503, { errcode: 0 }), { safeCode: 'PRODUCTION_KEY_PROBE_UNCONFIRMED' });
  assert.throws(() => classifyFormalKeyProbeResponse(200, { errcode: 0, order: {} }), { safeCode: 'PRODUCTION_QUERY_UNEXPECTED_ORDER' });
  assert.throws(() => classifyFormalKeyProbeResponse(200, { errcode: 268490003 }), { safeCode: 'PRODUCTION_KEY_SIGNATURE_INVALID' });
  assert.throws(() => classifyFormalKeyProbeResponse(200, { errcode: 40001 }), { safeCode: 'PRODUCTION_KEY_TOKEN_REJECTED' });
});

test('probe errors do not expose provider responses, signed URLs or secrets and never retry', async () => {
  const { probeFormalPaymentKey } = await helper;
  let calls = 0;
  await assert.rejects(() => probeFormalPaymentKey(input, {
    accessToken: async () => 'fixture_access_token_123456',
    request: async url => { calls++; throw new Error(`${url} ${input.productionAppKey}`); }
  }), error => error.message === 'PRODUCTION_KEY_PROBE_UNCONFIRMED'
    && !JSON.stringify(error).includes(input.productionAppKey));
  assert.equal(calls, 1);
  await assert.rejects(() => probeFormalPaymentKey(input, {
    accessToken: async () => { throw new Error(input.appSecret); },
    request: async () => { throw new Error('must not query'); }
  }), { safeCode: 'PRODUCTION_KEY_TOKEN_UNAVAILABLE' });
});

test('invalid key and synthetic payer cannot reach the platform', async () => {
  const { probeFormalPaymentKey } = await helper;
  const options = { accessToken: async () => assert.fail('must not call platform') };
  await assert.rejects(() => probeFormalPaymentKey({ ...input, productionAppKey: 'short' }, options),
    { safeCode: 'PRODUCTION_KEY_PROBE_INPUT_INVALID' });
  await assert.rejects(() => probeFormalPaymentKey({ ...input, openid: 'mock_user' }, options),
    { safeCode: 'PRODUCTION_PROBE_USER_INVALID' });
});

for (const businessCode of [90019, 268490002]) test(`${businessCode} requires an identical query with only an invalid pay_sig rejected by official signature code`, async () => {
  const { probeFormalPaymentKey } = await helper;
  let tokenCalls = 0;
  const calls = [];
  const result = await probeFormalPaymentKey(input, {
    accessToken: async () => { tokenCalls++; return 'fixture_access_token_123456'; },
    request: async (url, body) => {
      calls.push({ url: new URL(url), body });
      return { status: 200, data: { errcode: calls.length === 1 ? businessCode : 268490003 } };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(tokenCalls, 1);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].url.origin, calls[1].url.origin);
  assert.equal(calls[0].url.pathname, '/xpay/query_order');
  assert.equal(calls[0].url.pathname, calls[1].url.pathname);
  assert.equal(calls[0].url.searchParams.get('access_token'), calls[1].url.searchParams.get('access_token'));
  assert.notEqual(calls[0].url.searchParams.get('pay_sig'), calls[1].url.searchParams.get('pay_sig'));
  assert.equal(calls[0].url.searchParams.get('pay_sig').slice(1), calls[1].url.searchParams.get('pay_sig').slice(1));
  assert.deepEqual([...calls[0].url.searchParams.keys()], ['access_token', 'pay_sig']);
  assert.match(JSON.parse(calls[0].body).order_id, /^HLKP[a-f0-9]{24}$/);
  assert.equal(JSON.parse(calls[0].body).env, 0);
  assert.deepEqual(result, { signatureVerified: true, env: 0, queryCalls: 2,
    proof: 'differential-signature-check', ordersCreated: 0 });
  assert.ok(!Object.hasOwn(result, 'orderAbsent'));
  for (const secret of Object.values(input)) assert.ok(!JSON.stringify(result).includes(secret));
});

test('same error or any non-signature control result cannot establish key validity and is never retried', async () => {
  const { probeFormalPaymentKey } = await helper;
  for (const control of [
    { status: 200, data: { errcode: 90019 } },
    { status: 200, data: { errcode: 0 } },
    { status: 200, data: { errcode: '268490003' } },
    { status: 200, data: { errcode: 268490002, errmsg: '签名错误' } },
    { status: 503, data: { errcode: 268490003 } },
    { status: 200, data: null }
  ]) {
    let calls = 0;
    await assert.rejects(() => probeFormalPaymentKey(input, {
      accessToken: async () => 'fixture_access_token_123456',
      request: async () => ++calls === 1 ? { status: 200, data: { errcode: 90019 } } : control
    }), { safeCode: 'PRODUCTION_KEY_PROBE_UNCONFIRMED' });
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(() => probeFormalPaymentKey(input, {
    accessToken: async () => 'fixture_access_token_123456',
    request: async url => {
      if (++calls === 1) return { status: 200, data: { errcode: 90019 } };
      throw new Error(url);
    }
  }), { safeCode: 'PRODUCTION_KEY_PROBE_UNCONFIRMED' });
  assert.equal(calls, 2);
});

test('other initial errors never trigger a signature control request', async () => {
  const { probeFormalPaymentKey } = await helper;
  for (const response of [
    { status: 200, data: { errcode: 268490099 } },
    { status: 200, data: { errcode: '90019' } },
    { status: 500, data: { errcode: 90019 } }
  ]) {
    let calls = 0;
    await assert.rejects(() => probeFormalPaymentKey(input, {
      accessToken: async () => 'fixture_access_token_123456',
      request: async () => { calls++; return response; }
    }), { safeCode: 'PRODUCTION_KEY_PROBE_UNCONFIRMED' });
    assert.equal(calls, 1);
  }
});

test('unconfirmed responses retain only numeric diagnostics without provider text or credentials', async () => {
  const { probeFormalPaymentKey } = await helper;
  await assert.rejects(() => probeFormalPaymentKey(input, {
    accessToken: async () => 'fixture_access_token_123456',
    request: async () => ({ status: 200, data: { errcode: 268490099, errmsg: input.productionAppKey } })
  }), error => {
    assert.deepEqual(error.probeDiagnostics, { initial: { httpStatus: 200, providerCode: 268490099 } });
    assert.ok(!JSON.stringify(error).includes(input.productionAppKey));
    return error.safeCode === 'PRODUCTION_KEY_PROBE_UNCONFIRMED';
  });
});
