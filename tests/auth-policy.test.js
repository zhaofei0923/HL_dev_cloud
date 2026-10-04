const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  TOKEN_TTL_SECONDS,
  TOKEN_TYPES,
  createTokenService,
  normalizeWechatPhoneResult,
  resolveJwtSecret,
  resolveWechatOpenid
} = require('../cloudfunctions/hlApi/auth-policy');

const TEST_SECRET = 'test-only-jwt-secret-with-32-plus-characters';

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signRawToken(secret, header, payload) {
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

test('production login requires the CloudBase OPENID context', () => {
  assert.equal(resolveWechatOpenid({ wxContext: { OPENID: 'openid-123' } }), 'openid-123');
  assert.throws(
    () => resolveWechatOpenid({ wxContext: {}, payload: { code: 'temporary-code' } }),
    /OPENID/
  );
});

test('mock login is explicit and never stores the raw wx.login code', () => {
  const openid = resolveWechatOpenid({
    wxContext: {},
    payload: { code: 'temporary-code' },
    allowMockLogin: true
  });

  assert.match(openid, /^mock_[a-f0-9]{24}$/);
  assert.doesNotMatch(openid, /temporary-code/);
});

test('phone authorization reads only the verified server response', () => {
  assert.equal(normalizeWechatPhoneResult({
    phoneInfo: {
      phoneNumber: '+86 13800138000',
      purePhoneNumber: '13800138000',
      countryCode: '86'
    }
  }), '13800138000');
  assert.throws(() => normalizeWechatPhoneResult({ phoneInfo: {} }), /手机号/);
});

test('production requires an explicit strong JWT_SECRET', () => {
  assert.throws(
    () => resolveJwtSecret({ NODE_ENV: 'production' }),
    /JWT_SECRET.*32/
  );
  assert.throws(
    () => resolveJwtSecret({
      NODE_ENV: 'production',
      JWT_SECRET: 'too-short',
      ALLOW_LOCAL_JWT: 'true',
      JWT_DEV_SECRET: TEST_SECRET
    }),
    /JWT_SECRET.*32/
  );
  assert.equal(resolveJwtSecret({
    NODE_ENV: 'production',
    JWT_SECRET: TEST_SECRET
  }), TEST_SECRET);
});

test('development JWT secret requires an explicit local or mock switch', () => {
  assert.throws(
    () => resolveJwtSecret({ JWT_DEV_SECRET: TEST_SECRET }),
    /JWT_SECRET.*32/
  );
  assert.equal(resolveJwtSecret({
    ALLOW_LOCAL_JWT: 'true',
    JWT_DEV_SECRET: TEST_SECRET
  }), TEST_SECRET);
  assert.equal(resolveJwtSecret({
    ALLOW_MOCK_WECHAT_LOGIN: 'true',
    JWT_DEV_SECRET: TEST_SECRET
  }), TEST_SECRET);
  assert.throws(
    () => resolveJwtSecret({ ALLOW_LOCAL_JWT: 'true', JWT_DEV_SECRET: 'too-short' }),
    /JWT_DEV_SECRET.*32/
  );
});

test('runtime token service issues typed three-segment tokens with bounded lifetimes', () => {
  const now = Date.UTC(2026, 8, 13, 8, 0, 0);
  const service = createTokenService({ secret: TEST_SECRET, clock: () => now });

  Object.values(TOKEN_TYPES).forEach(type => {
    const token = service.sign(
      { userId: 7, type: TOKEN_TYPES.ADMIN, iat: 1, exp: 2 },
      { type }
    );
    assert.equal(token.split('.').length, 3);
    const claims = service.verify(token, { expectedType: type });
    assert.equal(claims.type, type);
    assert.equal(claims.iat, Math.floor(now / 1000));
    assert.equal(claims.exp - claims.iat, TOKEN_TTL_SECONDS[type]);
  });
});

test('runtime token verification rejects wrong token types', () => {
  const service = createTokenService({ secret: TEST_SECRET, clock: () => 1_800_000_000_000 });
  const accessToken = service.sign({ userId: 1 }, { type: TOKEN_TYPES.ACCESS });
  const refreshToken = service.sign({ userId: 1 }, { type: TOKEN_TYPES.REFRESH });
  const adminToken = service.sign({ role: 'admin' }, { type: TOKEN_TYPES.ADMIN });

  assert.throws(() => service.verify(refreshToken, { expectedType: TOKEN_TYPES.ACCESS }), /invalid token/);
  assert.throws(() => service.verify(accessToken, { expectedType: TOKEN_TYPES.ADMIN }), /invalid token/);
  assert.throws(() => service.verify(adminToken, { expectedType: TOKEN_TYPES.ACCESS }), /invalid token/);
});

test('runtime token verification rejects malformed segments and invalid signatures safely', () => {
  const service = createTokenService({ secret: TEST_SECRET, clock: () => 1_800_000_000_000 });
  const token = service.sign({ userId: 1 }, { type: TOKEN_TYPES.ACCESS });
  const [header, payload, signature] = token.split('.');
  const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

  assert.throws(() => service.verify(`${header}.${payload}`), /invalid token/);
  assert.throws(() => service.verify(`${header}.${payload}.${signature}.extra`), /invalid token/);
  assert.throws(() => service.verify(`${header}.${payload}.x`), /invalid token/);
  assert.throws(() => service.verify(`${header}.${payload}.${tamperedSignature}`), /invalid token/);
});

test('runtime token verification rejects expired tokens and unsupported headers', () => {
  let now = 1_800_000_000_000;
  const service = createTokenService({ secret: TEST_SECRET, clock: () => now });
  const accessToken = service.sign({ userId: 1 }, { type: TOKEN_TYPES.ACCESS });
  now += TOKEN_TTL_SECONDS.access * 1000;
  assert.throws(
    () => service.verify(accessToken, { expectedType: TOKEN_TYPES.ACCESS }),
    error => error.code === 40100 && error.status === 401 && /expired/.test(error.message)
  );

  const issuedAt = Math.floor(now / 1000);
  const unsupportedHeaderToken = signRawToken(
    TEST_SECRET,
    { alg: 'none', typ: 'JWT' },
    { userId: 1, type: TOKEN_TYPES.ACCESS, iat: issuedAt, exp: issuedAt + 60 }
  );
  assert.throws(() => service.verify(unsupportedHeaderToken), /invalid token/);
});

test('hlApi enforces access and admin token types while preserving login response fields', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'),
    'utf8'
  );
  assert.match(
    source,
    /function requireUser[\s\S]*?expectedType:\s*TOKEN_TYPES\.ACCESS[\s\S]*?return session;/
  );
  assert.match(
    source,
    /function requireAdmin[\s\S]*?expectedType:\s*TOKEN_TYPES\.ADMIN[\s\S]*?return session;/
  );
  assert.match(source, /token:\s*tokenService\.sign\(/);
  assert.match(source, /refreshToken:\s*tokenService\.sign\(/);
  assert.match(source, /user:\s*publicUser\(user\)/);
});

test('cloud function declares the phone-number OpenAPI permission', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'config.json'),
    'utf8'
  ));
  assert.ok(config.permissions.openapi.includes('phonenumber.getPhoneNumber'));
});
