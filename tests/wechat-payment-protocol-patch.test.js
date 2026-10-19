const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const protocol = require('../integrations/wechat-pay/hl-payment-response-verifier');

const original = readFileSync(join(__dirname, 'fixtures/wechat-payment-sdk-strategy.cjs.txt'), 'utf8');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyId = 'PUB_KEY_ID_protocol_offline_test';
const configuration = {
  appId: 'wx1234567890abcdef', mchId: '1118515135', mchSerialNo: '12AB',
  mchAPIv3Key: 'OfflineTestOnly000000000000000001', mchPrivateKey: privateKey,
  mchWechatpayPublicKey: publicKey, mchWechatpayPublicKeyId: keyId,
};

async function strategy(mode = 'publickey') {
  const { patchPaymentProtocolSource } = await import('../scripts/wechat-payment-protocol-patch.mjs');
  const source = patchPaymentProtocolSource(original);
  const module = { exports: {} };
  class StubSdk {
    createHttp(http) { this.httpService = http; }
    async transactions_jsapi() { return { status: 200, verified: true, data: { prepay_id: 'offline-prepay' } }; }
    decipher_gcm(...args) { return args; }
  }
  const context = {
    module, Buffer, console: { log() {} },
    require(name) {
      if (name === 'wechatpay-node-v3') return StubSdk;
      if (name === '../../config/config') return { verifyMode: mode };
      if (name === '../hl-payment-safe-log') return { safePaymentError: () => ({}) };
      if (name === '../hl-payment-response-verifier') return protocol;
      if (name === 'crypto') return crypto;
      if (name === 'https') return require('node:https');
      throw new Error('Unexpected fixture dependency');
    },
  };
  vm.runInNewContext(source, context, { filename: 'sdkStrategy.fixture.js' });
  return new module.exports(configuration);
}

function callback(rawBody = '{"event_type":"TRANSACTION.SUCCESS"}') {
  const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = 'offlineCallbackNonce';
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`), keys.privateKey).toString('base64');
  return { rawBody, body: JSON.parse(rawBody), timestamp, nonce, signature, serial: keyId };
}

test('precise protocol patch is idempotent with LF/CRLF and refuses unknown vendor changes', async () => {
  const { patchPaymentProtocolSource } = await import('../scripts/wechat-payment-protocol-patch.mjs');
  for (const source of [original.replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')]) {
    const patched = patchPaymentProtocolSource(source);
    assert.equal(patchPaymentProtocolSource(patched), patched);
    const paySignOriginal = source.slice(source.indexOf('    async jsapi('), source.indexOf('    async h5('));
    assert.equal(patched.slice(patched.indexOf('    async jsapi('), patched.indexOf('    async h5(')), paySignOriginal);
  }
  assert.throws(() => patchPaymentProtocolSource(original.replace('matchedCert = rawCerts[0]', 'matchedCert = rawCerts[1]')), /已核验版本/);
  assert.throws(() => patchPaymentProtocolSource(original.replace("console.log('[SdkStrategy] 验证模式: PUBLICKEY（固定公钥）')", 'console.log("changed")')), /已核验版本/);
});

test('direct callback verifies original bytes, exact key identity and complete fresh signature headers', async () => {
  const instance = await strategy();
  assert.equal(typeof instance.wxPay.httpService.get, 'function');
  const valid = callback();
  assert.equal(await instance.verifySign(valid), true);
  for (const invalid of [
    { ...valid, serial: 'PUB_KEY_ID_other' }, { ...valid, serial: undefined },
    { ...valid, timestamp: 'NaN' }, { ...valid, timestamp: `${valid.timestamp}garbage` },
    { ...valid, nonce: undefined }, { ...valid, signature: 'WECHATPAY/SIGNTEST/test' },
    { ...valid, rawBody: undefined }, { ...valid, rawBody: '{ "event_type":"TRANSACTION.SUCCESS"}' },
    { ...valid, timestamp: String(Number(valid.timestamp) - 301) },
  ]) assert.equal(await instance.verifySign(invalid), false);
  assert.equal(await instance.verifySign(null), false);
  assert.equal(await instance.verifySign(undefined), false);
  assert.deepEqual(await instance.decryptResource('encrypted', 'associated', 'nonce'), ['encrypted', 'associated', 'nonce']);
});

test('certificate and unknown modes fail closed rather than selecting an unmatched certificate', async () => {
  await assert.rejects(strategy('certificate'), { code: 'PAYMENT_VERIFY_MODE_UNSUPPORTED' });
  await assert.rejects(strategy('unknown'), { code: 'PAYMENT_VERIFY_MODE_UNSUPPORTED' });
});

test('unchanged requestPayment signer uses RSA and the mini program four-line signing message', async () => {
  const instance = await strategy();
  const result = await instance.jsapi({ appid: configuration.appId });
  assert.equal(result.verified, true);
  assert.equal(result.data.signType, 'RSA');
  assert.equal(result.data.package, 'prepay_id=offline-prepay');
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${configuration.appId}\n${result.data.timeStamp}\n${result.data.nonceStr}\n${result.data.package}\n`), keys.publicKey, Buffer.from(result.data.paySign, 'base64')), true);
});
