const test = require('node:test');
const assert = require('node:assert/strict');

test('payment environment merge preserves all unrelated merchant and business credentials exactly', async () => {
  const { mergeVariables } = await import('../scripts/configure-wechat-payment-env.mjs');
  const original = { privateKey: 'fixture\r\nprivate-material\n', apiV3Key: 'fixture-key',
    wxPayPublicKeyId: 'fixture-id', JWT_SECRET: 'fixture-jwt', other: '原值' };
  const snapshot = { ...original };
  const result = mergeVariables(original, { PAYMENT_CALLBACK_TOKEN: 'fixture-token', PAYMENT_INTEGRATION_READY: 'false' });
  assert.deepEqual(original, snapshot);
  for (const [key, value] of Object.entries(original)) assert.equal(result[key], value);
  assert.equal(result.PAYMENT_INTEGRATION_READY, 'false');
});

test('payment environment merge rejects inputs that could silently corrupt existing secrets', async () => {
  const { mergeVariables } = await import('../scripts/configure-wechat-payment-env.mjs');
  for (const value of [null, undefined, [], 'string', 1]) {
    assert.throws(() => mergeVariables(value, {}));
    assert.throws(() => mergeVariables({}, value));
  }
  for (const value of [null, undefined, {}, 1, false]) assert.throws(() => mergeVariables({ privateKey: value }, {}));
});
