'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { assertPaymentConfig } = require('../integrations/wechat-pay/hl-payment-config-policy');

// Ephemeral test keys have no relationship to the configured payment merchant.
const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const merchant = { merchantId: '1900000001', appId: 'wx0123456789abcdef' };
const token = 'fixture-internal-credential-32-chars-only';

function configuration(patch = {}) {
  return {
    merchant: { ...merchant },
    env: { PAYMENT_CALLBACK_TOKEN: token },
    payConfig: {
      mchId: merchant.merchantId,
      appId: merchant.appId,
      mchAPIv3Key: '0123456789abcdefABCDEF0123456789',
      mchSerialNo: '1DDE55AD98ED71D6EDD4A4A16996DE7B47773A8C',
      mchPrivateKey: merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      mchWechatpayPublicKey: platformKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      mchWechatpayPublicKeyId: 'PUB_KEY_ID_00000000000000000000000000000000',
      jsapiNotifyUrl: 'https://fixture.integration-callback.tcloudbase.com/wechatpay/order',
      ...patch
    }
  };
}

function rejected(input, fields) {
  assert.throws(() => assertPaymentConfig(input), error => {
    assert.equal(error.code, 'PAYMENT_CONFIG_INVALID');
    assert.deepEqual(error.fields, fields);
    assert.equal(error.message, `支付配置无效: ${fields.join(', ')}`);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('accepts actual payConfig mapping with unrelated merchant and WeChat RSA keys', () => {
  assert.equal(assertPaymentConfig(configuration()), true);
});

test('accepts legitimate PEM containers, CRLF and template literal newline encoding', () => {
  const privatePkcs1 = merchantKeys.privateKey.export({ type: 'pkcs1', format: 'pem' });
  const publicPkcs1 = platformKeys.publicKey.export({ type: 'pkcs1', format: 'pem' });
  for (const encode of [value => value, value => value.replace(/\n/g, '\r\n'),
    value => value.replace(/\n/g, '\\n')]) {
    assert.equal(assertPaymentConfig(configuration({
      mchPrivateKey: encode(privatePkcs1), mchWechatpayPublicKey: encode(publicPkcs1)
    })), true);
  }
});

test('checks merchant identity against the registered project rather than only syntax', () => {
  rejected(configuration({ mchId: '1900000002' }), ['merchantId']);
  rejected(configuration({ appId: 'wxfedcba9876543210' }), ['appId']);
  rejected({ ...configuration(), merchant: {} }, ['merchantId', 'appId']);
  rejected(configuration({ mchId: Number(merchant.merchantId) }), ['merchantId']);
});

test('APIv3 keys require exactly 32 ASCII alphanumeric characters without silent trimming', () => {
  for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(31) + '!',
    'a'.repeat(31) + '中', 'a'.repeat(31) + ' ', 1234]) {
    rejected(configuration({ mchAPIv3Key: value }), ['apiV3Key']);
  }
  assert.equal(assertPaymentConfig(configuration({ mchAPIv3Key: '1'.repeat(32) })), true);
});

test('serials and public-key IDs do not impose an undocumented fixed length', () => {
  for (const value of ['01', 'aBcD'.repeat(8), 'AB'.repeat(20)]) {
    assert.equal(assertPaymentConfig(configuration({ mchSerialNo: value })), true);
  }
  for (const value of ['', 'serial=AB12', 'AB:12', ' AB12', 'G'.repeat(40)]) {
    rejected(configuration({ mchSerialNo: value }), ['merchantSerialNumber']);
  }
  assert.equal(assertPaymentConfig(configuration({ mchWechatpayPublicKeyId: 'PUB_KEY_ID_01118515135202610090191890001004' })), true);
  for (const value of ['', '-', 'AB12', 'PUB_KEY_ID_', 'PUB_KEY_ID_abc\n']) {
    rejected(configuration({ mchWechatpayPublicKeyId: value }), ['wxPayPublicKeyId']);
  }
});

test('key type, direction and cryptographic parse errors fail without exposing material', () => {
  const ecPrivate = ecKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ecPublic = ecKeys.publicKey.export({ type: 'spki', format: 'pem' });
  for (const value of ['', 'secret-material-invalid', ecPrivate,
    platformKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    '-----BEGIN PRIVATE KEY-----\nsecret-material-invalid\n-----END PRIVATE KEY-----']) {
    rejected(configuration({ mchPrivateKey: value }), ['privateKey']);
  }
  for (const value of ['', 'secret-material-invalid', ecPublic,
    merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })]) {
    rejected(configuration({ mchWechatpayPublicKey: value }), ['wxPayPublicKey']);
  }
});

test('unsupported weak RSA and password-protected private keys are rejected at startup', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  rejected(configuration({
    mchPrivateKey: weak.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    mchWechatpayPublicKey: weak.publicKey.export({ type: 'spki', format: 'pem' })
  }), ['privateKey', 'wxPayPublicKey']);
  rejected(configuration({ mchPrivateKey: merchantKeys.privateKey.export({
    type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase'
  }) }), ['privateKey']);
});

test('callback URLs require HTTPS and reject credentials, fragments, parameters and loopback', () => {
  for (const value of ['', 'http://example.com/pay', 'not-a-url', 'https://localhost/pay',
    'https://127.0.0.1/pay', 'https://0.0.0.0/pay', 'https://[::1]/pay',
    'https://user:password@example.com/pay', 'https://example.com/pay?key=value',
    'https://example.com/pay#fragment', 'https://example.com/\npay']) {
    rejected(configuration({ jsapiNotifyUrl: value }), ['notifyURLPayURL']);
  }
});

test('internal shared credential is mandatory and diagnostics contain only known field names', () => {
  rejected({ ...configuration(), env: {} }, ['PAYMENT_CALLBACK_TOKEN']);
  rejected({ ...configuration(), env: { PAYMENT_CALLBACK_TOKEN: 'x'.repeat(31) } }, ['PAYMENT_CALLBACK_TOKEN']);
  const secrets = ['sentinel-api-secret', 'sentinel-private-secret', 'sentinel-public-secret', 'sentinel-token-secret'];
  const input = configuration({ mchAPIv3Key: secrets[0], mchPrivateKey: secrets[1], mchWechatpayPublicKey: secrets[2] });
  input.env.PAYMENT_CALLBACK_TOKEN = secrets[3];
  assert.throws(() => assertPaymentConfig(input), error => {
    assert.deepEqual(error.fields, ['apiV3Key', 'privateKey', 'wxPayPublicKey', 'PAYMENT_CALLBACK_TOKEN']);
    for (const secret of secrets) assert.ok(!String(error.stack).includes(secret));
    return true;
  });
});

test('missing configuration fails closed with a deterministic complete field list', () => {
  for (const value of [undefined, null, 'not-a-configuration', { payConfig: null, merchant: null, env: null }]) {
    rejected(value, ['merchantId', 'appId', 'apiV3Key', 'merchantSerialNumber',
      'privateKey', 'wxPayPublicKey', 'wxPayPublicKeyId', 'notifyURLPayURL', 'PAYMENT_CALLBACK_TOKEN']);
  }
});
