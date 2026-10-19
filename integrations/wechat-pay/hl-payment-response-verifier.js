'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const HOST = 'api.mch.weixin.qq.com';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_AGE_SECONDS = 300;
const SIGNATURE_HEADERS = ['wechatpay-serial', 'wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-signature'];

function safeError(code = 'PAYMENT_RESPONSE_INVALID', status = 502) {
  const error = new Error('微信支付通信或应答核验失败');
  error.code = code;
  error.status = status;
  return error;
}

function headerMap(headers, rawHeaders) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw safeError();
  const result = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(result, lower)) throw safeError();
    if (SIGNATURE_HEADERS.includes(lower) || lower === 'request-id') {
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw safeError();
      result[lower] = value;
    }
  }
  if (rawHeaders !== undefined) {
    if (!Array.isArray(rawHeaders) || rawHeaders.length % 2) throw safeError();
    const seen = new Set();
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index], value = rawHeaders[index + 1];
      if (typeof name !== 'string') throw safeError();
      const lower = name.toLowerCase();
      if (!SIGNATURE_HEADERS.includes(lower) && lower !== 'request-id') continue;
      if (seen.has(lower) || typeof value !== 'string' || result[lower] !== value) throw safeError();
      seen.add(lower);
    }
    if (SIGNATURE_HEADERS.some(name => !seen.has(name))) throw safeError();
  }
  return result;
}

function createWechatPayVerifier({ publicKey, publicKeyId, now = Date.now } = {}) {
  let key;
  try {
    const pem = typeof publicKey === 'string' ? publicKey.replace(/\\n/g, '\n').trim() : '';
    if (!/^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/.test(pem)
      || typeof publicKeyId !== 'string' || !/^PUB_KEY_ID_[A-Za-z0-9_-]{1,118}$/.test(publicKeyId)
      || typeof now !== 'function') throw safeError();
    key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw safeError();
  } catch (_) {
    throw safeError('PAYMENT_PUBLIC_KEY_CONFIG_INVALID', 503);
  }
  const signatureBytes = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
  return function verify({ headers, rawHeaders, rawBody } = {}) {
    try {
      const values = headerMap(headers, rawHeaders);
      const timestamp = values['wechatpay-timestamp'], nonce = values['wechatpay-nonce'];
      const signature = values['wechatpay-signature'];
      if (values['wechatpay-serial'] !== publicKeyId || !/^[1-9]\d{8,12}$/.test(timestamp || '')
        || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce || '') || typeof signature !== 'string'
        || signature.startsWith('WECHATPAY/SIGNTEST/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw safeError();
      const seconds = Number(timestamp), reference = Number(now()) / 1000;
      if (!Number.isSafeInteger(seconds) || !Number.isFinite(reference)
        || Math.abs(reference - seconds) > MAX_AGE_SECONDS) throw safeError();
      const bytes = Buffer.from(signature, 'base64');
      if (bytes.length !== signatureBytes || bytes.toString('base64') !== signature) throw safeError();
      if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) throw safeError();
      const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
      if (body.length > MAX_BODY_BYTES) throw safeError();
      const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from('\n')]);
      if (!crypto.verify('RSA-SHA256', message, key, bytes)) throw safeError();
      return true;
    } catch (_) {
      throw safeError();
    }
  };
}

function allowedRequest(method, address, merchantId) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.hash) throw safeError();
    const create = method === 'POST' && url.pathname === '/v3/pay/transactions/jsapi' && !url.search;
    const query = method === 'GET' && /^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]{8,32}$/.test(url.pathname)
      && url.search === `?mchid=${merchantId}`;
    if (!create && !query) throw safeError();
    return url.pathname + url.search;
  } catch (_) {
    throw safeError('PAYMENT_REQUEST_NOT_ALLOWED', 403);
  }
}

function createVerifiedWechatPayTransport({ merchantId, publicKeyId, verify,
  requestImpl = https.request, timeoutMs = 8000 } = {}) {
  if (typeof merchantId !== 'string' || !/^\d{6,32}$/.test(merchantId)
    || typeof publicKeyId !== 'string' || !/^PUB_KEY_ID_[A-Za-z0-9_-]{1,118}$/.test(publicKeyId)
    || typeof verify !== 'function' || typeof requestImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw safeError('PAYMENT_TRANSPORT_CONFIG_INVALID', 503);

  async function send(method, address, params, suppliedHeaders) {
    const path = allowedRequest(method, address, merchantId);
    const authorization = suppliedHeaders && suppliedHeaders.Authorization;
    if (typeof authorization !== 'string' || !/^WECHATPAY2-SHA256-RSA2048 /.test(authorization)
      || /[\r\n]/.test(authorization) || authorization.length > 4096) throw safeError('PAYMENT_REQUEST_NOT_ALLOWED', 403);
    let body = '';
    try { if (method === 'POST') body = JSON.stringify(params); } catch (_) { throw safeError(); }
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw safeError();
    const headers = { Authorization: authorization, Accept: 'application/json', 'Accept-Encoding': 'identity',
      'Content-Type': 'application/json', 'User-Agent': 'HL-WeChatPay/1.0', 'Wechatpay-Serial': publicKeyId };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
      let request, timer, settled = false;
      function fail(code = 'PAYMENT_TRANSPORT_FAILED', status = 502) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // No upstream errors, request objects, headers or keys enter the error.
        try { request && request.destroy(); } catch (_) {}
        reject(safeError(code, status));
      }
      function finish(result) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(result);
      }
      try {
        request = requestImpl({ protocol: 'https:', hostname: HOST, port: 443, path, method, headers,
          rejectUnauthorized: true, timeout: timeoutMs }, response => {
          let length = 0, ended = false;
          const chunks = [];
          const status = response.statusCode;
          if (!Number.isInteger(status) || status < 100 || status > 599) { fail(); return; }
          const encoding = response.headers && response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') { fail('PAYMENT_RESPONSE_INVALID'); return; }
          response.on('data', chunk => {
            if (settled) return;
            let bytes;
            try { bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); } catch (_) { fail(); return; }
            length += bytes.length;
            if (length > MAX_BODY_BYTES) { fail('PAYMENT_RESPONSE_TOO_LARGE'); return; }
            chunks.push(bytes);
          });
          response.on('error', () => fail());
          response.on('aborted', () => fail());
          response.on('close', () => { if (!ended) fail(); });
          response.on('end', () => {
            ended = true;
            if (settled) return;
            const rawBody = Buffer.concat(chunks);
            try {
              verify({ headers: response.headers, rawHeaders: response.rawHeaders, rawBody });
            } catch (_) {
              if (status < 200 || status >= 300) {
                finish({ status, verified: false, data: { code: 'UNVERIFIED_WECHAT_ERROR' } });
              } else fail('PAYMENT_RESPONSE_INVALID');
              return;
            }
            let data;
            try {
              // Decode only after exact-byte verification. Invalid UTF-8 is
              // rejected rather than normalized into a different JSON body.
              const text = rawBody.toString('utf8');
              if (!Buffer.from(text, 'utf8').equals(rawBody)) throw safeError();
              data = JSON.parse(text);
              if (!data || typeof data !== 'object' || Array.isArray(data)) throw safeError();
            } catch (_) { fail('PAYMENT_RESPONSE_INVALID'); return; }
            const requestId = response.headers && (response.headers['request-id'] || response.headers['Request-ID']);
            const metadata = typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {};
            finish({ status, data, verified: true, ...metadata });
          });
        });
        request.on('error', () => fail());
        request.on('timeout', () => fail('PAYMENT_TRANSPORT_TIMEOUT', 503));
        if (settled) { request.destroy(); return; }
        timer = setTimeout(() => fail('PAYMENT_TRANSPORT_TIMEOUT', 503), timeoutMs);
        if (body) request.write(body);
        request.end();
      } catch (_) { fail(); }
    });
  }
  return Object.freeze({ post: (url, params, headers) => send('POST', url, params, headers),
    get: (url, headers) => send('GET', url, null, headers) });
}

function installVerifiedWechatPayTransport({ sdk, payConfig = {}, verifyMode } = {}) {
  if (verifyMode !== 'publickey' || !sdk || typeof sdk.createHttp !== 'function') {
    throw safeError('PAYMENT_VERIFY_MODE_UNSUPPORTED', 503);
  }
  const verify = createWechatPayVerifier({ publicKey: payConfig.mchWechatpayPublicKey,
    publicKeyId: payConfig.mchWechatpayPublicKeyId });
  sdk.createHttp(createVerifiedWechatPayTransport({ merchantId: payConfig.mchId,
    publicKeyId: payConfig.mchWechatpayPublicKeyId, verify }));
  return verify;
}

module.exports = { createWechatPayVerifier, createVerifiedWechatPayTransport, installVerifiedWechatPayTransport };
