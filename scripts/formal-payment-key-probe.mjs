import { createRequire } from 'node:module';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createVirtualPaymentClient, serverPaySig, assertVirtualPayer } = require('../cloudfunctions/hlApi/virtual-payment-policy.js');
const QUERY_URI = '/xpay/query_order';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const failure = code => Object.assign(new Error(code), { safeCode: code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const observedBusinessCodes = [90019, 268490002];
const responseDiagnostic = response => ({
  httpStatus: Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
  providerCode: Number.isSafeInteger(response?.data?.errcode) ? response.data.errcode : null
});

// Official query_order documentation (checked 2026-10-19):
// https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order
// "pay_sig string 是 - 支付签名"; "268490003 签名错误".
// Its error list and linked general error list do not establish 90019 semantics.
// Never infer credential validity from an undocumented code or errmsg text.
// 268490002 was observed with the previously verified sandbox key on 2026-10-19.
// These business responses can only be accepted by probeFormalPaymentKey after an
// otherwise identical deliberately invalid signature is rejected as 268490003.
export function classifyFormalKeyProbeResponse(httpStatus, data) {
  if (httpStatus !== 200 || !record(data) || !Number.isInteger(data.errcode)) {
    throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
  }
  if (data.errcode === 268490003) throw failure('PRODUCTION_KEY_SIGNATURE_INVALID');
  if ([40001, 40014, 42001].includes(data.errcode)) throw failure('PRODUCTION_KEY_TOKEN_REJECTED');
  if (data.errcode !== 0) throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
  if (data.order !== undefined && data.order !== null) throw failure('PRODUCTION_QUERY_UNEXPECTED_ORDER');
  return { signatureVerified: true, env: 0, queryCalls: 1, orderAbsent: true, ordersCreated: 0 };
}

async function officialRequest(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
    const parts = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
      }
      parts.push(value);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(parts, length).toString('utf8')); }
    catch { throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED'); }
    return { status: response.status, data };
  } catch {
    // Network errors may contain the signed URL; never propagate their message.
    throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED');
  }
}

// This helper only obtains an access token and queries a fresh random number.
// It never creates an order, invokes a cashier, delivers goods, or grants rights.
export async function probeFormalPaymentKey({ appId, appSecret, productionAppKey, openid } = {}, options = {}) {
  if (typeof appId !== 'string' || !/^wx[a-f0-9]{16}$/i.test(appId)
    || typeof appSecret !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(appSecret)
    || typeof productionAppKey !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(productionAppKey)) {
    throw failure('PRODUCTION_KEY_PROBE_INPUT_INVALID');
  }
  try { assertVirtualPayer(openid); } catch { throw failure('PRODUCTION_PROBE_USER_INVALID'); }
  const randomBytes = options.randomBytes || cryptoRandomBytes;
  const nonce = randomBytes(12);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw failure('PRODUCTION_QUERY_NUMBER_INVALID');
  const queryNumber = `HLKP${nonce.toString('hex')}`;
  const body = JSON.stringify({ openid, env: 0, order_id: queryNumber });
  let token;
  try {
    const accessToken = options.accessToken || createVirtualPaymentClient({ appId }).accessToken;
    token = await accessToken(appSecret);
  } catch { throw failure('PRODUCTION_KEY_TOKEN_UNAVAILABLE'); }
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{20,512}$/.test(token)) {
    throw failure('PRODUCTION_KEY_TOKEN_UNAVAILABLE');
  }
  const paySig = serverPaySig(QUERY_URI, body, productionAppKey);
  const url = `https://api.weixin.qq.com${QUERY_URI}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`;
  const request = options.request || officialRequest;
  let response;
  try { response = await request(url, body); }
  catch { throw failure('PRODUCTION_KEY_PROBE_UNCONFIRMED'); }
  if (response?.status === 200 && record(response.data) && observedBusinessCodes.includes(response.data.errcode)) {
    // The only changed request field is the first hex digit of pay_sig.
    // This proves the supplied signature passes the signature gate; it does
    // not establish the business meaning of the code or prove order absence.
    const invalidSig = `${paySig[0] === '0' ? '1' : '0'}${paySig.slice(1)}`;
    const controlUrl = url.slice(0, -paySig.length) + invalidSig;
    let control;
    try { control = await request(controlUrl, body); }
    catch { throw Object.assign(failure('PRODUCTION_KEY_PROBE_UNCONFIRMED'), { probeDiagnostics: { initial: responseDiagnostic(response), controlTransportFailed: true } }); }
    if (control?.status !== 200 || !record(control.data) || control.data.errcode !== 268490003) {
      throw Object.assign(failure('PRODUCTION_KEY_PROBE_UNCONFIRMED'), { probeDiagnostics: { initial: responseDiagnostic(response), control: responseDiagnostic(control) } });
    }
    return { signatureVerified: true, env: 0, queryCalls: 2,
      proof: 'differential-signature-check', ordersCreated: 0 };
  }
  try { return classifyFormalKeyProbeResponse(response?.status, response?.data); }
  catch (error) { error.probeDiagnostics = { initial: responseDiagnostic(response) }; throw error; }
}
