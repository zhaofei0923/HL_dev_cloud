const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  createWechatPayVerifier, createVerifiedWechatPayTransport, installVerifiedWechatPayTransport,
} = require('../integrations/wechat-pay/hl-payment-response-verifier');

// Ephemeral offline keys exercise genuine RSA, without merchant credentials.
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const publicKeyId = 'PUB_KEY_ID_offline_protocol_test';
const merchantId = '1118515135';
const fixedNow = 1791500000000;
const verify = createWechatPayVerifier({ publicKey, publicKeyId, now: () => fixedNow });
const queryUrl = `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/HLM202610090000000001?mchid=${merchantId}`;
const createUrl = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
const suppliedHeaders = { Authorization: 'WECHATPAY2-SHA256-RSA2048 offline-test-only', 'X-Untrusted': 'do-not-forward' };

function envelope(body = '{"trade_state":"NOTPAY"}', options = {}) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const timestamp = options.timestamp || String(fixedNow / 1000);
  const nonce = options.nonce || 'offlineNonce_123';
  const signature = crypto.sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from('\n')]), options.key || keys.privateKey).toString('base64');
  const headers = {
    'wechatpay-serial': options.serial || publicKeyId, 'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce, 'wechatpay-signature': signature, 'request-id': 'OFFLINE-REQUEST-123',
  };
  return { headers, rawHeaders: Object.entries(headers).flat(), rawBody };
}

function mockHttp(reply, action = null) {
  const state = { calls: 0, destroyed: false, writes: [], ended: false };
  function requestImpl(options, callback) {
    state.calls++;
    state.options = options;
    const request = new EventEmitter();
    request.write = body => state.writes.push(body);
    request.destroy = () => { state.destroyed = true; };
    request.end = () => {
      state.ended = true;
      setImmediate(() => {
        if (action === 'requestError') { request.emit('error', new Error('secret-upstream-error')); return; }
        if (action === 'requestTimeout') { request.emit('timeout'); return; }
        if (action === 'hang') return;
        const response = new EventEmitter();
        response.statusCode = reply.status || 200;
        response.headers = reply.headers;
        response.rawHeaders = reply.rawHeaders;
        callback(response);
        if (typeof action === 'function') { action(response, request, state); return; }
        const bytes = reply.rawBody;
        response.emit('data', bytes.subarray(0, 5));
        response.emit('data', bytes.subarray(5));
        response.emit('end');
        response.emit('close');
      });
    };
    return request;
  }
  return { state, transport: createVerifiedWechatPayTransport({ merchantId, publicKeyId, verify, requestImpl, timeoutMs: action === 'hang' ? 15 : 1000 }) };
}

function controlledFailure(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.message, '微信支付通信或应答核验失败');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'status']);
  return true;
}

test('RSA verifier accepts exact raw bytes, mixed-case headers and both public PEM envelopes', () => {
  const valid = envelope('{ "trade_state": "NOTPAY", "amount": {"total": 1}}');
  assert.equal(verify(valid), true);
  const mixed = Object.fromEntries(Object.entries(valid.headers).map(([name, value]) => [name.toUpperCase(), value]));
  assert.equal(verify({ ...valid, headers: mixed }), true);
  for (const pem of [publicKey.replace(/\n/g, '\\n'), keys.publicKey.export({ type: 'pkcs1', format: 'pem' })]) {
    assert.equal(createWechatPayVerifier({ publicKey: pem, publicKeyId, now: () => fixedNow })(valid), true);
  }
});

test('signature verification rejects normalization, tampering, a different key and signature test traffic', () => {
  const valid = envelope('{"trade_state":"NOTPAY","total":1}');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const candidate of [
    { ...valid, rawBody: '{ "trade_state":"NOTPAY","total":1}' },
    { ...valid, rawBody: '{"total":1,"trade_state":"NOTPAY"}' },
    { ...valid, rawBody: '{"trade_state":"SUCCESS","total":1}' },
    { ...valid, rawBody: undefined }, { ...valid, rawBody: {} },
    envelope(valid.rawBody, { key: other.privateKey }),
    { ...valid, headers: { ...valid.headers, 'wechatpay-signature': 'WECHATPAY/SIGNTEST/123' } },
    { ...valid, headers: { ...valid.headers, 'wechatpay-signature': valid.headers['wechatpay-signature'].replace(/=$/, '') } },
  ]) assert.throws(() => verify(candidate), error => controlledFailure(error, 'PAYMENT_RESPONSE_INVALID'));
});

test('key ID, timestamp, nonce and signature headers are mandatory and unambiguous', () => {
  const valid = envelope();
  const badHeaders = [
    { ...valid.headers, 'wechatpay-serial': 'PUB_KEY_ID_other' },
    { ...valid.headers, 'wechatpay-serial': '' },
    { ...valid.headers, 'wechatpay-timestamp': 'NaN' },
    { ...valid.headers, 'wechatpay-timestamp': `${fixedNow / 1000}junk` },
    { ...valid.headers, 'wechatpay-timestamp': '01791500000' },
    { ...valid.headers, 'wechatpay-nonce': '' },
    { ...valid.headers, 'wechatpay-nonce': 'line\nbreak' },
    { ...valid.headers, 'wechatpay-signature': 'bad-base64' },
    { ...valid.headers, 'wechatpay-timestamp': [String(fixedNow / 1000)] },
    { ...valid.headers, 'Wechatpay-Timestamp': String(fixedNow / 1000) },
  ];
  for (const name of ['wechatpay-serial', 'wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-signature']) {
    const headers = { ...valid.headers }; delete headers[name]; badHeaders.push(headers);
  }
  for (const headers of badHeaders) assert.throws(() => verify({ rawBody: valid.rawBody, headers }));
  assert.throws(() => verify({ ...valid, rawHeaders: [...valid.rawHeaders, 'Wechatpay-Serial', publicKeyId] }));
  assert.throws(() => verify({ ...valid, rawHeaders: ['Wechatpay-Serial', publicKeyId] }));
  assert.throws(() => verify({ ...valid, rawHeaders: ['Wechatpay-Serial'] }));
  assert.throws(() => verify({ ...valid, rawHeaders: {} }));
});

test('fresh signed timestamps at the five-minute boundary pass while stale and future replays fail', () => {
  for (const age of [-300, 0, 300]) assert.equal(verify(envelope('{}', { timestamp: String(fixedNow / 1000 + age) })), true);
  for (const age of [-301, 301]) assert.throws(() => verify(envelope('{}', { timestamp: String(fixedNow / 1000 + age) })));
  const invalidClock = createWechatPayVerifier({ publicKey, publicKeyId, now: () => NaN });
  assert.throws(() => invalidClock(envelope()));
});

test('invalid/weak/private/certificate keys and unsupported verification modes fail closed without key material', () => {
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const pem of ['', 'invalid-secret', weak.publicKey.export({ type: 'spki', format: 'pem' }),
    ec.publicKey.export({ type: 'spki', format: 'pem' }), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey + keys.privateKey.export({ type: 'pkcs8', format: 'pem' })]) {
    assert.throws(() => createWechatPayVerifier({ publicKey: pem, publicKeyId }), error => controlledFailure(error, 'PAYMENT_PUBLIC_KEY_CONFIG_INVALID'));
  }
  for (const verifyMode of ['certificate', '', undefined]) {
    assert.throws(() => installVerifiedWechatPayTransport({ sdk: { createHttp() {} }, verifyMode }), { code: 'PAYMENT_VERIFY_MODE_UNSUPPORTED' });
  }
});

test('chunked query response is verified before parsing and exposes only safe provenance metadata', async () => {
  const { state, transport } = mockHttp(envelope());
  const result = await transport.get(queryUrl, suppliedHeaders);
  assert.deepEqual(result, { status: 200, verified: true, data: { trade_state: 'NOTPAY' }, requestId: 'OFFLINE-REQUEST-123' });
  assert.equal(state.options.hostname, 'api.mch.weixin.qq.com');
  assert.equal(state.options.protocol, 'https:');
  assert.equal(state.options.port, 443);
  assert.equal(state.options.rejectUnauthorized, true);
  assert.equal(state.options.headers['Wechatpay-Serial'], publicKeyId);
  assert.equal(state.options.headers['Accept-Encoding'], 'identity');
  assert.equal(state.options.headers.Authorization, suppliedHeaders.Authorization);
  assert.equal(state.options.headers['X-Untrusted'], undefined);
  assert.equal(state.writes.length, 0);
  assert.equal(state.destroyed, false);
  assert.ok(!JSON.stringify(result).includes('offline-test-only'));
});

test('JSAPI transport sends exact JSON bytes under the retained SDK authorization', async () => {
  const { state, transport } = mockHttp(envelope('{"prepay_id":"offline-prepay"}'));
  const params = { appid: 'wx1234567890abcdef', mchid: merchantId, amount: { total: 1, currency: 'CNY' } };
  const result = await transport.post(createUrl, params, suppliedHeaders);
  assert.equal(result.verified, true);
  assert.equal(result.data.prepay_id, 'offline-prepay');
  assert.deepEqual(state.writes, [JSON.stringify(params)]);
  assert.equal(state.options.headers['Content-Length'], Buffer.byteLength(JSON.stringify(params)));
});

test('signed non-2xx merchant errors preserve verified error codes for read-only readiness checks', async () => {
  const reply = { ...envelope('{"code":"ORDER_NOT_EXIST","message":"offline only"}'), status: 404 };
  const { transport } = mockHttp(reply);
  const result = await transport.get(queryUrl, suppliedHeaders);
  assert.equal(result.status, 404);
  assert.equal(result.verified, true);
  assert.equal(result.data.code, 'ORDER_NOT_EXIST');
  assert.equal(result.requestId, 'OFFLINE-REQUEST-123');
});

test('unsigned, malformed or tampered errors never preserve unverified authentication/error claims', async () => {
  const body = '{"code":"ORDER_NOT_EXIST","message":"secret-unverified-diagnostic"}';
  for (const reply of [
    { headers: {}, rawHeaders: [], rawBody: Buffer.from(body), status: 404 },
    { ...envelope('{}'), rawBody: Buffer.from(body), status: 404 },
    { ...envelope(body), headers: {}, status: 401 },
  ]) {
    const { transport } = mockHttp(reply);
    const result = await transport.get(queryUrl, suppliedHeaders);
    assert.deepEqual(result, { status: reply.status, verified: false, data: { code: 'UNVERIFIED_WECHAT_ERROR' } });
    assert.ok(!JSON.stringify(result).includes('ORDER_NOT_EXIST'));
    assert.ok(!JSON.stringify(result).includes('secret-unverified-diagnostic'));
  }
});

test('successful HTTP responses reject missing signature headers and modified raw bodies', async () => {
  const valid = envelope();
  for (const reply of [
    { headers: {}, rawHeaders: [], rawBody: valid.rawBody },
    { ...valid, rawBody: Buffer.from('{ "trade_state":"NOTPAY"}') },
    { ...valid, headers: { ...valid.headers, 'wechatpay-signature': 'WECHATPAY/SIGNTEST/probe' } },
    { ...valid, headers: { ...valid.headers, 'wechatpay-serial': 'PUB_KEY_ID_other' } },
  ]) {
    const { state, transport } = mockHttp(reply);
    await assert.rejects(transport.get(queryUrl, suppliedHeaders), error => controlledFailure(error, 'PAYMENT_RESPONSE_INVALID'));
    assert.equal(state.destroyed, true);
  }
});

test('signed invalid JSON, arrays and invalid UTF-8 fail rather than being normalized after verification', async () => {
  for (const body of ['not-json', 'null', '[]', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    const { transport } = mockHttp(envelope(body));
    await assert.rejects(transport.get(queryUrl, suppliedHeaders), { code: 'PAYMENT_RESPONSE_INVALID' });
  }
  const reply = envelope(); reply.headers['request-id'] = '<script>invalid ID</script>';
  reply.rawHeaders = Object.entries(reply.headers).flat();
  const result = await mockHttp(reply).transport.get(queryUrl, suppliedHeaders);
  assert.equal(result.requestId, undefined);
});

test('off-host requests, alternate merchant/operations and malformed authorization are rejected before network access', async () => {
  const { state, transport } = mockHttp(envelope());
  for (const url of [
    queryUrl.replace('https:', 'http:'), queryUrl.replace('api.mch.weixin.qq.com', 'example.com'),
    queryUrl.replace('api.mch.weixin.qq.com', 'api.mch.weixin.qq.com.attacker.example'),
    queryUrl.replace('https://', 'https://user@'), `${queryUrl}#fragment`,
    queryUrl.replace(`mchid=${merchantId}`, 'mchid=1234567890'), `${queryUrl}&other=1`,
    queryUrl.replace('out-trade-no/HLM202610090000000001', 'id/123456'),
    queryUrl.replace('out-trade-no/HLM202610090000000001', 'out-trade-no/..%2Fother'),
    'https://api.mch.weixin.qq.com/v3/certificates',
  ]) await assert.rejects(transport.get(url, suppliedHeaders), { code: 'PAYMENT_REQUEST_NOT_ALLOWED' });
  for (const url of [createUrl + '?other=1', createUrl.replace('/jsapi', '/native'), queryUrl]) {
    await assert.rejects(transport.post(url, {}, suppliedHeaders), { code: 'PAYMENT_REQUEST_NOT_ALLOWED' });
  }
  for (const Authorization of ['', 'Bearer secret', `${suppliedHeaders.Authorization}\r\nInjected: secret`]) {
    await assert.rejects(transport.get(queryUrl, { Authorization }), { code: 'PAYMENT_REQUEST_NOT_ALLOWED' });
  }
  assert.equal(state.calls, 0);
});

test('request and response body limits reject overflow and destroy the live connection', async () => {
  const { state, transport } = mockHttp(envelope(), response => {
    response.emit('data', Buffer.alloc(128 * 1024));
    response.emit('data', Buffer.alloc(128 * 1024));
    response.emit('data', Buffer.alloc(1));
    response.emit('end');
  });
  await assert.rejects(transport.get(queryUrl, suppliedHeaders), { code: 'PAYMENT_RESPONSE_TOO_LARGE' });
  assert.equal(state.destroyed, true);
  const before = state.calls;
  await assert.rejects(transport.post(createUrl, { tooLarge: 'x'.repeat(16 * 1024) }, suppliedHeaders), { code: 'PAYMENT_RESPONSE_INVALID' });
  assert.equal(state.calls, before);
  const circular = {}; circular.loop = circular;
  await assert.rejects(transport.post(createUrl, circular, suppliedHeaders), { code: 'PAYMENT_RESPONSE_INVALID' });
  assert.equal(state.calls, before);
});

test('hard deadline and request timeout actually destroy hanging requests with controlled errors', async () => {
  for (const action of ['hang', 'requestTimeout']) {
    const { state, transport } = mockHttp(envelope(), action);
    await assert.rejects(transport.get(queryUrl, suppliedHeaders), error => controlledFailure(error, 'PAYMENT_TRANSPORT_TIMEOUT'));
    assert.equal(state.destroyed, true);
  }
});

test('request errors, interrupted/invalid response streams and unsupported compression terminate safely', async () => {
  const actions = [
    'requestError', response => response.emit('error', new Error('secret-response-error')),
    response => response.emit('aborted'), response => response.emit('close'),
    response => response.emit('data', {}),
  ];
  for (const action of actions) {
    const { state, transport } = mockHttp(envelope(), action);
    await assert.rejects(transport.get(queryUrl, suppliedHeaders), error => controlledFailure(error, 'PAYMENT_TRANSPORT_FAILED'));
    assert.equal(state.destroyed, true);
  }
  const reply = envelope(); reply.headers['content-encoding'] = 'gzip';
  const { state, transport } = mockHttp(reply);
  await assert.rejects(transport.get(queryUrl, suppliedHeaders), { code: 'PAYMENT_RESPONSE_INVALID' });
  assert.equal(state.destroyed, true);
});

test('synchronous transport faults and invalid setup do not retain raw SDK or request details', async () => {
  const transport = createVerifiedWechatPayTransport({ merchantId, publicKeyId, verify,
    requestImpl() { throw new Error('secret-request-headers-or-key'); } });
  await assert.rejects(transport.get(queryUrl, suppliedHeaders), error => controlledFailure(error, 'PAYMENT_TRANSPORT_FAILED'));
  for (const timeoutMs of [0, 8001, Infinity]) {
    assert.throws(() => createVerifiedWechatPayTransport({ merchantId, publicKeyId, verify, timeoutMs }), { code: 'PAYMENT_TRANSPORT_CONFIG_INVALID' });
  }
});
