'use strict';

const crypto = require('node:crypto');

const TOKEN_TYPES = Object.freeze({
  ACCESS: 'access',
  REFRESH: 'refresh',
  ADMIN: 'admin'
});

const TOKEN_TTL_SECONDS = Object.freeze({
  [TOKEN_TYPES.ACCESS]: 24 * 60 * 60,
  [TOKEN_TYPES.REFRESH]: 30 * 24 * 60 * 60,
  [TOKEN_TYPES.ADMIN]: 2 * 60 * 60
});

const TOKEN_ALGORITHM = 'HS256';
const MAX_TOKEN_LENGTH = 8192;
const MAX_CLOCK_SKEW_SECONDS = 60;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function createPolicyError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function invalidToken(message = 'invalid token') {
  return createPolicyError(message, 401, 40100);
}

function invalidConfiguration(message) {
  return createPolicyError(message, 500, 50010);
}

function requireStrongSecret(value, name) {
  const secret = typeof value === 'string' ? value : '';
  if (secret.length < 32 || !secret.trim()) {
    throw invalidConfiguration(`${name} must contain at least 32 characters`);
  }
  return secret;
}

function explicitLocalJwtEnabled(env) {
  return env.ALLOW_LOCAL_JWT === 'true'
    || env.ALLOW_LOCAL_JWT === true
    || env.ALLOW_MOCK_WECHAT_LOGIN === 'true'
    || env.ALLOW_MOCK_WECHAT_LOGIN === true;
}

function resolveJwtSecret(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const productionSecret = source.JWT_SECRET;
  if (productionSecret !== undefined && productionSecret !== null && String(productionSecret).length > 0) {
    return requireStrongSecret(String(productionSecret), 'JWT_SECRET');
  }

  const productionMode = String(source.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (productionMode || !explicitLocalJwtEnabled(source)) {
    throw invalidConfiguration('JWT_SECRET with at least 32 characters is required');
  }

  return requireStrongSecret(String(source.JWT_DEV_SECRET || ''), 'JWT_DEV_SECRET');
}

function epochSeconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw invalidConfiguration('token clock returned an invalid time');
  return Math.floor(milliseconds / 1000);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSegment(segment) {
  if (!segment || !BASE64URL_SEGMENT.test(segment)) throw invalidToken();
  let decoded;
  try {
    decoded = Buffer.from(segment, 'base64url');
  } catch (err) {
    throw invalidToken();
  }
  if (!decoded.length || decoded.toString('base64url') !== segment) throw invalidToken();
  return decoded;
}

function decodeJsonSegment(segment) {
  try {
    const value = JSON.parse(decodeSegment(segment).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidToken();
    return value;
  } catch (err) {
    if (err && err.code === 40100) throw err;
    throw invalidToken();
  }
}

function normalizeTokenType(type) {
  const normalized = String(type || '');
  if (!Object.values(TOKEN_TYPES).includes(normalized)) throw invalidToken();
  return normalized;
}

function createTokenService(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const secret = settings.secret === undefined
    ? resolveJwtSecret(settings.env || process.env)
    : requireStrongSecret(String(settings.secret), 'JWT secret');
  const clock = typeof settings.clock === 'function' ? settings.clock : Date.now;
  const key = Buffer.from(secret, 'utf8');

  function sign(payload, signOptions = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('token payload must be an object');
    }
    const type = normalizeTokenType(signOptions.type || payload.type);
    const issuedAt = epochSeconds(clock);
    const claims = {
      ...payload,
      type,
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS[type]
    };
    const header = encodeJson({ alg: TOKEN_ALGORITHM, typ: 'JWT' });
    const body = encodeJson(claims);
    const signingInput = `${header}.${body}`;
    const signature = crypto.createHmac('sha256', key).update(signingInput).digest('base64url');
    return `${signingInput}.${signature}`;
  }

  function verify(token, verifyOptions = {}) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
      throw invalidToken();
    }
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(segment => !segment)) throw invalidToken();
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const expectedSignature = crypto.createHmac('sha256', key).update(signingInput).digest();
    const suppliedSignature = decodeSegment(signatureSegment);
    if (
      suppliedSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw invalidToken();
    }

    const header = decodeJsonSegment(headerSegment);
    if (header.alg !== TOKEN_ALGORITHM || header.typ !== 'JWT') throw invalidToken();

    const claims = decodeJsonSegment(payloadSegment);
    const type = normalizeTokenType(claims.type);
    if (verifyOptions.expectedType !== undefined && type !== String(verifyOptions.expectedType)) {
      throw invalidToken();
    }
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat) {
      throw invalidToken();
    }
    const currentTime = epochSeconds(clock);
    if (claims.iat > currentTime + MAX_CLOCK_SKEW_SECONDS) throw invalidToken();
    if (claims.exp <= currentTime) throw invalidToken('token expired');
    return claims;
  }

  return { sign, verify };
}

function resolveWechatOpenid({ wxContext = {}, payload = {}, allowMockLogin = false } = {}) {
  const openid = String(wxContext.OPENID || '').trim();
  if (openid) return openid;

  if (allowMockLogin === true) {
    const code = String(payload.code || '').trim();
    if (!code) throw new Error('mock login code is required');
    const digest = crypto.createHash('sha256').update(code).digest('hex').slice(0, 24);
    return `mock_${digest}`;
  }

  throw new Error('CloudBase OPENID context is required');
}

function normalizeWechatPhoneResult(result = {}) {
  const phoneInfo = result.phoneInfo || (result.data && result.data.phoneInfo) || {};
  const rawPhone = phoneInfo.purePhoneNumber || phoneInfo.phoneNumber || '';
  let phone = String(rawPhone).replace(/[\s()-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  if (!/^\d{6,20}$/.test(phone)) throw new Error('未获取到有效手机号');
  return phone;
}

module.exports = {
  TOKEN_TTL_SECONDS,
  TOKEN_TYPES,
  createTokenService,
  normalizeWechatPhoneResult,
  resolveJwtSecret,
  resolveWechatOpenid
};
