const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const fixtureApp = `const express = require('express');
const config = require('./config/config');
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
const payRouter = require('./routes/pay');
app.use('/wx-pay', payRouter);
module.exports = app;
`;
const fixtureService = `class PayService {
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
}
module.exports = PayService;
`;

function fixture(t, name = 'generated-payment-test') {
  const container = mkdtempSync(join(tmpdir(), 'hl-payment-integration-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const target = join(container, name);
  mkdirSync(join(target, 'services'), { recursive: true });
  writeFileSync(join(target, 'app.js'), fixtureApp);
  writeFileSync(join(target, 'services/payService.js'), fixtureService);
  writeFileSync(join(target, 'services/orderService.js'), 'class OrderService { async handlerUnifiedTrigger() {} }');
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
  assert.ok(app.includes("req.rawBody = buf.toString('utf8')"));
  assert.ok(service.includes('await this.strategy.verifySign(callbackParams)'));
  assert.ok(service.includes('await this.strategy.decryptResource(callbackParams)'));
  assert.ok(service.includes('await this.orderService.handlerUnifiedTrigger(payResult)'));
  assert.ok(!service.includes('handlerUnifiedTrigger(payResult).catch'));
  assert.ok(!result.changes.some(item => item.file.includes('config/config') || item.file.includes('.env')));
  assert.equal(readFileSync(join(target, 'app.js'), 'utf8'), fixtureApp, 'preview does not mutate the generated function');
  for (const change of result.changes) writeFileSync(join(target, change.file), change.content);
  const second = prepareIntegration(target, 'generated-payment-test');
  assert.equal(second.changes.find(item => item.file === 'app.js').content, app);
  assert.equal(second.changes.find(item => item.file === 'services/payService.js').content, service);
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
  assert.deepEqual(routes.map(route => route.path), ['/create', '/query']);
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
