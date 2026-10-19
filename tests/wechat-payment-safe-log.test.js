const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { safePaymentError } = require('../integrations/wechat-pay/hl-payment-safe-log');

test('payment diagnostics expose only closed codes and allowed HTTP status, never SDK error contents', () => {
  const marker = 'secret-signed-authorization-or-private-key';
  const error = Object.assign(new Error(marker), {
    code: marker, status: 401, request: { headers: { Authorization: marker } },
    response: { status: 403, data: { privateKey: marker }, headers: { secret: marker } },
    headers: { Authorization: marker }, config: { data: marker, privateKey: marker }
  });
  assert.deepEqual(safePaymentError(error), { code: 'PAYMENT_ERROR', status: 401 });
  assert.ok(!JSON.stringify(safePaymentError(error)).includes(marker));
  assert.deepEqual(safePaymentError({ code: 'SIGN_ERROR', response: { status: 403 } }), { code: 'PAYMENT_AUTH_ERROR', status: 403 });
  assert.deepEqual(safePaymentError({ code: 'FREQUENCY_LIMITED', status: 429 }), { code: 'PAYMENT_RATE_LIMITED', status: 429 });
  for (const value of [null, undefined, 'secret', { code: 'constructor', status: '401' }, { code: ['SIGN_ERROR'], status: 200 }]) {
    assert.deepEqual(safePaymentError(value), { code: 'PAYMENT_ERROR', status: 500 });
  }
});

test('payment logging does not execute getters, stringify objects or trust unknown error codes', () => {
  const error = {};
  for (const key of ['message', 'stack', 'request', 'response', 'headers', 'config', 'code', 'status', 'statusCode']) {
    Object.defineProperty(error, key, { get() { assert.fail(`logger read getter ${key}`); } });
  }
  assert.deepEqual(safePaymentError(error), { code: 'PAYMENT_ERROR', status: 500 });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private proxy detail'); } });
  assert.deepEqual(safePaymentError(proxy), { code: 'PAYMENT_ERROR', status: 500 });
});

// Mirrors the inspected template, without importing its credentials or SDK dependencies.
const serviceRaw = `const OrderService = require('./orderService');
console.error('[PayService] unifiedOrder error:', err);
console.error('[PayService] 异步处理支付回调业务失败:', err);
console.error('[PayService] 异步处理退款回调业务失败:', err);
console.error('[PayService] refund error:', err);
console.error('[PayService] transfer error:', err);
console.error('[PayService] 异步处理转账回调业务失败:', err);
console.error(\x60[PayService] \${payType} 下单失败: status=\${result?.status}, code=\${result?.data?.code}, message=\${result?.data?.message}\x60);
console.error('[PayService] 退款失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);
console.error('[PayService] 转账失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);
const verified = await this.strategy.verifySign(callbackParams);
const clear = await this.strategy.decryptResource(ciphertext, associated_data, nonce);
`;
const controllerRaw = `const config = require('../config/config');\n` + [
  'unifiedOrder', 'unifiedOrderH5', 'unifiedOrderNative', 'queryOrderByOutTradeNo',
  'queryOrderByTransactionId', 'closeOrder', 'refund', 'queryRefund', 'transfer',
  'queryTransferBill', 'queryTransferBillByNo'
].map(name => `console.error('[Controller] ${name} error:', err);`).join('\n')
  + '\nconsole.error(`[Controller] ${triggerName} error:`, err);\nres.status(500).json({ code: \'FAIL\', message: \'处理失败\' });\n';
const strategyRaw = `const { verifyMode: defaultVerifyMode } = require('../../config/config');
console.error('[SdkStrategy] 下载平台证书失败（这通常是根因）:',
                            dlErr.code || 'NO_CODE', '-', dlErr.message || dlErr);
console.error('[SdkStrategy] 验签异常:', err.message);
const result = verify.verify(this.payConfig.mchWechatpayPublicKey, signature, 'base64');
return false;
`;

test('precise template patches remove raw errors and response messages while preserving verification and behavior', async () => {
  const { patchPaymentLogSource } = await import('../scripts/wechat-payment-log-patch.mjs');
  for (const [filename, source] of [
    ['services/payService.js', serviceRaw], ['controllers/payController.js', controllerRaw],
    ['services/strategies/sdkStrategy.js', strategyRaw]
  ]) {
    const patched = patchPaymentLogSource(filename, source);
    assert.ok(patched.includes('require(') && patched.includes('safePaymentError'));
    assert.doesNotMatch(patched, /console\.error\([^;]*(?:, err\);|err\.message|dlErr\.message|result\?\.data\?\.message)/);
    assert.equal(patchPaymentLogSource(filename, patched), patched, 'second patch is identical');
    const crlf = patchPaymentLogSource(filename, source.replace(/\n/g, '\r\n'));
    assert.equal(crlf, patched.replace(/\n/g, '\r\n'));
  }
  const service = patchPaymentLogSource('services/payService.js', serviceRaw);
  assert.ok(service.includes('await this.strategy.verifySign(callbackParams)'));
  assert.ok(service.includes('await this.strategy.decryptResource(ciphertext, associated_data, nonce)'));
  const strategy = patchPaymentLogSource('services/strategies/sdkStrategy.js', strategyRaw);
  assert.ok(strategy.includes("verify.verify(this.payConfig.mchWechatpayPublicKey, signature, 'base64')"));
  assert.ok(strategy.includes('return false;'));
});

test('unrecognized, missing, duplicated or partially patched log templates fail instead of changing arbitrary source', async () => {
  const { patchPaymentLogSource } = await import('../scripts/wechat-payment-log-patch.mjs');
  assert.throws(() => patchPaymentLogSource('app.js', serviceRaw), /不支持/);
  assert.throws(() => patchPaymentLogSource('services/payService.js', serviceRaw.replace('unifiedOrder error:', 'new error:')), /不匹配/);
  assert.throws(() => patchPaymentLogSource('services/payService.js', serviceRaw + "console.error('[PayService] refund error:', err);"), /不匹配/);
  assert.throws(() => patchPaymentLogSource('services/payService.js', serviceRaw.replace('const OrderService', 'let OrderService')), /锚点/);
  const patched = patchPaymentLogSource('services/payService.js', serviceRaw);
  assert.throws(() => patchPaymentLogSource('services/payService.js', patched.replace('safePaymentError(err));', 'err);')), /不匹配/);
  const fulfilled = serviceRaw.replace("console.error('[PayService] 异步处理支付回调业务失败:', err);", '// HL: await business fulfillment before acknowledging the callback\nawait this.orderService.handlerUnifiedTrigger(payResult);');
  assert.ok(patchPaymentLogSource('services/payService.js', fulfilled).includes('await this.orderService.handlerUnifiedTrigger(payResult);'));
});

test('patched generated logs cannot emit a private SDK error or read its response message', async () => {
  const { patchPaymentLogSource } = await import('../scripts/wechat-payment-log-patch.mjs');
  const secret = 'signed-request-with-merchant-secret';
  const error = Object.assign(new Error(secret), { code: secret, config: { privateKey: secret }, response: { status: 403, data: secret } });
  const upstream = { status: 403, data: { code: 'SIGN_ERROR' } };
  Object.defineProperty(upstream.data, 'message', { get() { assert.fail('raw upstream message was accessed'); } });
  const logged = [];
  const source = patchPaymentLogSource('services/payService.js', serviceRaw);
  await vm.runInNewContext(`(async function() { ${source} }).call(context)`, {
    require: name => name === './hl-payment-safe-log' ? { safePaymentError } : {},
    console: { error: (...args) => logged.push(args) }, err: error, result: upstream,
    callbackParams: {}, ciphertext: '', associated_data: '', nonce: '',
    context: { strategy: { verifySign: async () => false, decryptResource: async () => ({}) } }
  });
  assert.equal(logged.length, 9);
  assert.ok(!JSON.stringify(logged).includes(secret));
  for (const [, diagnostics] of logged) {
    assert.deepEqual(Object.keys(diagnostics), ['code', 'status']);
    assert.equal(diagnostics.status, 403);
  }
});

test('log and response-verification patches compose without weakening callback checks', async () => {
  const { patchPaymentLogSource } = await import('../scripts/wechat-payment-log-patch.mjs');
  const { patchPaymentProtocolSource } = await import('../scripts/wechat-payment-protocol-patch.mjs');
  const inspected = readFileSync(join(__dirname, 'fixtures/wechat-payment-sdk-strategy.cjs.txt'), 'utf8');
  for (const source of [inspected, inspected.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')]) {
    const verified = patchPaymentProtocolSource(source);
    assert.equal(patchPaymentLogSource('services/strategies/sdkStrategy.js', verified), verified);
    assert.equal(patchPaymentProtocolSource(patchPaymentLogSource('services/strategies/sdkStrategy.js', verified)), verified);
    new vm.Script(verified);
    assert.throws(() => patchPaymentLogSource('services/strategies/sdkStrategy.js',
      verified.replace('this.paymentVerifier({', 'this.unverifiedCallback({')), /未知修改/);
    assert.throws(() => patchPaymentLogSource('services/strategies/sdkStrategy.js',
      verified + "\nconsole.error('[SdkStrategy] 验签异常:', err.message);"), /不匹配/);
  }
});

test('downloaded template patch previews remain read-only and match the inspected three files when available', async t => {
  const { patchPaymentLogSource } = await import('../scripts/wechat-payment-log-patch.mjs');
  const root = join(__dirname, '../.cloudbase/payment-source/hl-wechat-pay-o6axgghd-demo-scfweb');
  if (!existsSync(join(root, 'services/payService.js'))) return t.skip('downloaded template is a local review artifact');
  for (const filename of ['services/payService.js', 'controllers/payController.js', 'services/strategies/sdkStrategy.js']) {
    const before = readFileSync(join(root, filename), 'utf8');
    const patched = patchPaymentLogSource(filename, before);
    new vm.Script(patched, { filename });
    assert.equal(readFileSync(join(root, filename), 'utf8'), before);
    assert.equal(patchPaymentLogSource(filename, patched), patched);
  }
});
