const test = require('node:test');
const assert = require('node:assert/strict');
const { merchantQueryDiagnostic } = require('../scripts/wechat-merchant-probe-policy.cjs');

test('merchant probe accepts only verified provider errors without disclosing the raw request', () => {
  const secret = 'fixture-signed-request-private-value';
  const result = { verified: true, status: 404, error: JSON.stringify({ code: 'ORDER_NOT_EXIST', message: secret }),
    errRaw: { request: { headers: { Authorization: secret } } } };
  const safe = merchantQueryDiagnostic(result);
  assert.deepEqual(safe, { authenticated: true, status: 404, code: 'ORDER_NOT_EXIST' });
  assert.ok(!JSON.stringify(safe).includes(secret));
  for (const patch of [{ code: 'ORDER_NOT_EXIST' }, { data: { code: 'ORDER_NOT_EXIST' } }]) {
    assert.deepEqual(merchantQueryDiagnostic({ verified: true, status: 404, ...patch }), safe);
  }
});

test('merchant probe requires agreed known error evidence and does not turn malformed failures into success', () => {
  for (const result of [null, undefined, {}, { status: 404 }, { status: '404', code: 'ORDER_NOT_EXIST' },
    { status: 404, error: 'not-json-secret' }, { status: 404, code: 'private-material' },
    { status: 404, code: 'SIGN_ERROR', data: { code: 'ORDER_NOT_EXIST' } },
    { status: 200, data: { code: 'ORDER_NOT_EXIST' } },
    { status: 404, code: 'ORDER_NOT_EXIST' },
    { verified: false, status: 404, data: { code: 'ORDER_NOT_EXIST' } }]) assert.equal(merchantQueryDiagnostic(result).authenticated, false);
  assert.deepEqual(merchantQueryDiagnostic({ verified: true, status: 401, error: '{"code":"SIGN_ERROR","message":"private-material"}' }),
    { authenticated: false, status: 401, code: 'SIGN_ERROR' });
  assert.deepEqual(merchantQueryDiagnostic({ status: 404, data: { code: 'ORDER_NOT_EXIST' } }),
    { authenticated: false, status: 404, code: 'PAYMENT_PREFLIGHT_FAILED' });
});
