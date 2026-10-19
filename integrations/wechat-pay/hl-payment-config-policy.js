'use strict';

const { createPrivateKey, createPublicKey } = require('node:crypto');

function text(value) {
  return typeof value === 'string' ? value : '';
}

function rsaPem(value, privateKey) {
  const pem = text(value).replace(/\\n/g, '\n').trim();
  const label = privateKey ? '(PRIVATE KEY|RSA PRIVATE KEY)' : '(PUBLIC KEY|RSA PUBLIC KEY)';
  // A public key must not be accepted from a private-key or certificate PEM.
  const envelope = new RegExp(`^-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+\\r?\\n-----END \\1-----$`);
  if (!envelope.test(pem)) return false;
  try {
    const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa'
      && Number(key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength) >= 2048;
  } catch (_) {
    // Parsing errors may contain supplied material; never expose their details.
    return false;
  }
}

function paymentNotifyUrl(value) {
  const raw = text(value);
  if (!raw || /\s/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash
      && !['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

// Uses the actual Integration Center template's config.payConfig field names.
// Merchant and WeChat keys belong to different parties; they must not be paired.
function assertPaymentConfig(input = {}) {
  const { payConfig = {}, merchant = {}, env = {} } = input && typeof input === 'object' ? input : {};
  const invalid = [];
  function check(field, valid) { if (!valid) invalid.push(field); }
  const payment = payConfig && typeof payConfig === 'object' ? payConfig : {};
  const expected = merchant && typeof merchant === 'object' ? merchant : {};
  const environment = env && typeof env === 'object' ? env : {};

  check('merchantId', /^\d{6,32}$/.test(text(payment.mchId))
    && payment.mchId === expected.merchantId);
  check('appId', /^wx[a-fA-F0-9]{16}$/.test(text(payment.appId))
    && payment.appId === expected.appId);
  check('apiV3Key', /^[a-zA-Z0-9]{32}$/.test(text(payment.mchAPIv3Key)));
  // Serial numbers are hexadecimal integers; do not assume a fixed width.
  check('merchantSerialNumber', /^[a-fA-F0-9]{1,64}$/.test(text(payment.mchSerialNo)));
  check('privateKey', rsaPem(payment.mchPrivateKey, true));
  check('wxPayPublicKey', rsaPem(payment.mchWechatpayPublicKey, false));
  check('wxPayPublicKeyId', /^PUB_KEY_ID_[a-zA-Z0-9_-]{1,118}$/.test(text(payment.mchWechatpayPublicKeyId)));
  check('notifyURLPayURL', paymentNotifyUrl(payment.jsapiNotifyUrl));
  check('PAYMENT_CALLBACK_TOKEN', text(environment.PAYMENT_CALLBACK_TOKEN).trim().length >= 32);

  if (invalid.length) {
    const error = new Error(`支付配置无效: ${invalid.join(', ')}`);
    error.code = 'PAYMENT_CONFIG_INVALID';
    error.fields = Object.freeze(invalid.slice());
    throw error;
  }
  return true;
}

module.exports = { assertPaymentConfig };
