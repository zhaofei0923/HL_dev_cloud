const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vm = require('node:vm');

const fixtureApp = `const express = require('express');
const config = require('./config/config');
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
const payRouter = require('./routes/pay');
app.use('/wx-pay', payRouter);
module.exports = app;
`;
const fixtureService = `const OrderService = require('./orderService');
class PayService {
async unifiedOrder(params) {}
async queryOrderByOutTradeNo(params) {}
async handlePayCallback(callbackParams) {
  const verified = await this.strategy.verifySign(callbackParams);
  if (!verified) return null;
  const payResult = await this.strategy.decryptResource(callbackParams);
  this.orderService.handlerUnifiedTrigger(payResult).catch(err => {
    console.error('[PayService] 异步处理支付回调业务失败:', err);
  });
  return payResult;
}
async handleRefundCallback(callbackParams) {
  const verified = await this.strategy.verifySign(callbackParams);
  if (!verified) return null;
  const refundResult = await this.strategy.decryptResource(callbackParams);
  this.orderService.handlerRefundTrigger(refundResult).catch(err => {
    console.error('[PayService] 异步处理退款回调业务失败:', err);
  });
  return refundResult;
}
}
module.exports = PayService;

console.error('[PayService] unifiedOrder error:', err);
console.error('[PayService] refund error:', err);
console.error('[PayService] transfer error:', err);
console.error('[PayService] 异步处理转账回调业务失败:', err);
console.error(\x60[PayService] \${payType} 下单失败: status=\${result?.status}, code=\${result?.data?.code}, message=\${result?.data?.message}\x60);
console.error('[PayService] 退款失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);
console.error('[PayService] 转账失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);
`;
const fixtureController = "const config = require('../config/config');\n" + [
  'unifiedOrder', 'unifiedOrderH5', 'unifiedOrderNative', 'queryOrderByOutTradeNo',
  'queryOrderByTransactionId', 'closeOrder', 'refund', 'queryRefund', 'transfer',
  'queryTransferBill', 'queryTransferBillByNo'
].map(name => `console.error('[Controller] ${name} error:', err);`).join('\n')
  + '\nconsole.error(`[Controller] ${triggerName} error:`, err);\n';
// The complete public vendor file prevents small mocks from concealing an
// incompatible constructor or callback implementation. It contains no config.
const fixtureStrategy = readFileSync(join(__dirname, 'fixtures/wechat-payment-sdk-strategy.cjs.txt'), 'utf8');

function fixture(t, name = 'generated-payment-test') {
  const container = mkdtempSync(join(tmpdir(), 'hl-payment-integration-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const target = join(container, name);
  mkdirSync(join(target, 'services'), { recursive: true });
  mkdirSync(join(target, 'services/strategies'), { recursive: true });
  mkdirSync(join(target, 'controllers'), { recursive: true });
  writeFileSync(join(target, 'app.js'), fixtureApp);
  writeFileSync(join(target, 'services/payService.js'), fixtureService);
  writeFileSync(join(target, 'controllers/payController.js'), fixtureController);
  writeFileSync(join(target, 'services/strategies/sdkStrategy.js'), fixtureStrategy);
  writeFileSync(join(target, 'services/orderService.js'), 'class OrderService { async handlerUnifiedTrigger() {} async handlerRefundTrigger() {} }');
  writeFileSync(join(target, 'package.json'), JSON.stringify({ dependencies: { express: '^4.21.2', 'wechatpay-node-v3': '^2.2.1' } }));
  writeFileSync(join(target, 'scf_bootstrap'), '#!/bin/bash\n/var/lang/node18/bin/node index.js');
  return target;
}

test('payment preparation targets the actual generated function and preserves signature/decryption code', async t => {
  const { prepareIntegration } = await import('../scripts/prepare-wechat-payment-integration.mjs');
  const target = fixture(t);
  const result = prepareIntegration(target, 'generated-payment-test');
  assert.equal(result.merchant.merchantId, '1118515135');
  assert.equal(result.merchant.appId, 'wx7e5c0f4d07d2f0f8');
  const app = result.changes.find(item => item.file === 'app.js').content;
  const service = result.changes.find(item => item.file === 'services/payService.js').content;
  assert.ok(app.indexOf('hl-membership-routes') < app.indexOf("require('./routes/pay')"));
  assert.ok(app.indexOf('assertPaymentConfig') < app.indexOf("require('./services/hl-membership-routes')"));
  assert.ok(app.includes("req.rawBody = buf.toString('utf8')"));
  assert.ok(service.includes('await this.strategy.verifySign(callbackParams)'));
  assert.ok(service.includes('await this.strategy.decryptResource(callbackParams)'));
  assert.ok(service.includes('await this.orderService.handlerUnifiedTrigger(payResult)'));
  assert.ok(!service.includes('handlerUnifiedTrigger(payResult).catch'));
  assert.ok(service.includes('await this.orderService.handlerRefundTrigger(refundResult).catch'));
  assert.ok(service.includes('throw err;'));
  assert.ok(!result.changes.some(item => item.file.includes('config/config') || item.file.includes('.env')));
  assert.ok(result.changes.some(item => item.file === 'services/hl-payment-config-policy.js'));
  assert.ok(result.changes.some(item => item.file === 'services/hl-payment-response-verifier.js'));
  const strategy = result.changes.find(item => item.file === 'services/strategies/sdkStrategy.js').content;
  assert.ok(strategy.includes('this.paymentVerifier = installVerifiedWechatPayTransport('));
  assert.ok(strategy.includes("'wechatpay-serial': callbackParams.serial"));
  assert.ok(!strategy.includes('matchedCert = rawCerts[0]'));
  assert.ok(!strategy.includes('rawBody ||'));
  assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), fixtureApp, 'preview does not mutate the generated function');
  for (const change of result.changes) writeFileSync(join(target, change.file), change.content);
  const second = prepareIntegration(target, 'generated-payment-test');
  assert.equal(second.changes.find(item => item.file === 'app.js').content, app);
  assert.equal(second.changes.find(item => item.file === 'services/payService.js').content, service);
  assert.equal(second.changes.find(item => item.file === 'services/strategies/sdkStrategy.js').content, strategy);
});

test('unknown SDK verification templates and changed installed protocol patches fail without mutation', async t => {
  const { prepareIntegration } = await import('../scripts/prepare-wechat-payment-integration.mjs');
  const target = fixture(t);
  const strategyPath = join(target, 'services/strategies/sdkStrategy.js');
  writeFileSync(strategyPath, fixtureStrategy.replace('parseInt(callbackParams.timestamp, 10)', 'Number(callbackParams.timestamp)'));
  assert.throws(() => prepareIntegration(target, 'generated-payment-test'), /支付协议模板/);
  assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), fixtureApp);
  writeFileSync(strategyPath, fixtureStrategy);
  const result = prepareIntegration(target, 'generated-payment-test');
  const patched = result.changes.find(item => item.file === 'services/strategies/sdkStrategy.js').content;
  writeFileSync(strategyPath, patched.replace("'wechatpay-serial': callbackParams.serial", "'wechatpay-serial': 'unexpected'"));
  assert.throws(() => prepareIntegration(target, 'generated-payment-test'), /未知修改/);
  assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), fixtureApp);
});

test('refund await patch accepts only one known callback and rejects missing, duplicated, or modified hooks', async () => {
  const { patchRefundCallbackSource } = await import('../scripts/prepare-wechat-payment-integration.mjs');
  const patched = patchRefundCallbackSource(fixtureService);
  assert.equal(patchRefundCallbackSource(patched), patched);
  assert.equal(patchRefundCallbackSource(fixtureService.replace(/\n/g, '\r\n')), patched.replace(/\n/g, '\r\n'));
  for (const source of [
    fixtureService.replace('handlerRefundTrigger(refundResult)', 'handlerDifferentRefund(refundResult)'),
    fixtureService + fixtureService,
    fixtureService.replace('异步处理退款回调业务失败:', 'unknown refund diagnostic:'),
    fixtureService.replace('this.orderService.handlerRefundTrigger(refundResult)', 'await this.orderService.handlerRefundTrigger(refundResult)'),
    patched.replace('throw err;', 'return null;')
  ]) assert.throws(() => patchRefundCallbackSource(source), /退款回调/);
});

test('prepared refund callback waits for business reconciliation and propagates failure before acknowledging', async t => {
  const { prepareIntegration } = await import('../scripts/prepare-wechat-payment-integration.mjs');
  const target = fixture(t);
  const prepared = prepareIntegration(target, 'generated-payment-test');
  const content = prepared.changes.find(change => change.file === 'services/payService.js').content;
  // The fixture footer exercises vendor diagnostics. Execute its actual service
  // class only, so no synthetic footer errors can conceal callback semantics.
  const source = content.split('module.exports = PayService;')[0] + 'module.exports = PayService;';
  const module = { exports: {} }, logs = [];
  vm.runInNewContext(source, { module, exports: module.exports, console: { error: (...args) => logs.push(args) },
    require(name) {
      if (name === './orderService') return class OrderService {};
      if (name === './hl-payment-safe-log') return require('../integrations/wechat-pay/hl-payment-safe-log');
      throw new Error(`unexpected fixture dependency ${name}`);
    }
  });
  const service = new module.exports();
  const payload = { out_trade_no: 'HLM_REFUND_FIXTURE_001', out_refund_no: 'HLR_REFUND_FIXTURE_001' };
  service.strategy = { async verifySign() { return true; }, async decryptResource() { return payload; } };
  let commit;
  service.orderService = { handlerRefundTrigger: () => new Promise(resolve => { commit = resolve; }) };
  let acknowledged = false;
  const callback = service.handleRefundCallback({}).then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  commit({ order: { status: 'refunded' } });
  assert.deepEqual(await callback, payload);
  const secret = 'private-business-refund-error';
  service.orderService.handlerRefundTrigger = async () => { throw new Error(secret); };
  await assert.rejects(service.handleRefundCallback({}), /private-business-refund-error/);
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(secret), 'prepared diagnostics must keep business errors private');
});

test('unexpected templates, directory identities and stale dependency locks fail before mutation', async t => {
  const { prepareIntegration } = await import('../scripts/prepare-wechat-payment-integration.mjs');
  const target = fixture(t);
  assert.throws(() => prepareIntegration(target, 'hlApi'), /实际生成/);
  assert.throws(() => prepareIntegration(target, 'other-payment-name'), /目录名/);
  writeFileSync(join(target, 'app.js'), fixtureApp.replace('const payRouter', 'let payRouter'));
  assert.throws(() => prepareIntegration(target, 'generated-payment-test'), /唯一定位/);
  writeFileSync(join(target, 'app.js'), fixtureApp);
  writeFileSync(join(target, 'package-lock.json'), '{}');
  assert.throws(() => prepareIntegration(target, 'generated-payment-test'), /锁文件/);
  assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), fixtureApp);
});

test('member payment routes reject arbitrary merchant API operations including root dispatch bypasses', () => {
  const { install } = require('../integrations/wechat-pay/hl-membership-routes');
  const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');
  const layers = [];
  const routes = [];
  const app = { use: (...args) => layers.push(args) };
  class PayService { async unifiedOrder() {} async queryOrderByOutTradeNo() {} }
  class OrderService { async handlerUnifiedTrigger() {} }
  const cloud = { init: options => assert.deepEqual(options, { env: merchant.envId }), callFunction: async () => ({ result: { code: 0, data: {} } }) };
  install(app, {
    express: { Router: () => ({ post: (path, handler) => routes.push({ path, handler }) }) },
    PayService, OrderService, cloud, merchant,
    payConfig: { mchId: merchant.merchantId, appId: merchant.appId },
    env: { PAYMENT_CALLBACK_TOKEN: 'isolated-test-internal-token-1234567890' }
  });
  assert.deepEqual(routes.map(route => route.path), ['/create', '/query', '/refund-query']);
  const gate = layers.find(layer => typeof layer[0] === 'function')[0];
  for (const req of [
    { method: 'POST', path: '/wx-pay/wxpay_refund', body: {} },
    { method: 'POST', path: '/', body: { _action: 'wxpay_refund', ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } } },
    { method: 'POST', path: '/', body: { path: '/wx-pay/wxpay_transfer', ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } } },
    { method: 'POST', path: '/wx-pay/wxpay_order', body: {} }
  ]) {
    let status;
    const response = { status(value) { status = value; return this; }, json(value) { return value; } };
    gate(req, response, () => assert.fail('Generic merchant operation must not be forwarded'));
    assert.equal(status, 403);
  }
  let forwarded = 0;
  for (const req of [
    { method: 'POST', path: '/wx-pay/unifiedOrderTrigger', body: {} },
    { method: 'POST', path: '/', body: { ParsedNotify: { event_type: 'TRANSACTION.SUCCESS' } } },
    { method: 'POST', path: '/', body: { _action: 'unifiedOrderTrigger' } }
  ]) gate(req, {}, () => forwarded++);
  assert.equal(forwarded, 3);
});
