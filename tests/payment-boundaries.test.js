const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiSource = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'),
  'utf8'
);

function frontendSource() {
  return fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'pages', 'user', 'membership.ts'),
    'utf8'
  );
}

test('wx login uses CloudBase OPENID and has no implicit code fallback', () => {
  assert.match(apiSource, /resolveWechatOpenid\(/);
  assert.doesNotMatch(apiSource, /wxContext\.OPENID\s*\|\|\s*`wx_/);
});

test('phone binding exchanges the dynamic code on the server', () => {
  assert.match(apiSource, /cloud\.openapi\.phonenumber\.getPhoneNumber\(\{\s*code/);
  assert.match(
    apiSource,
    /path === '\/auth\/wechat-phone'[\s\S]*auth\.bindWechatPhone\(session\.userId, data\.code\)/
  );
  assert.doesNotMatch(apiSource, /path === '\/auth\/bind-phone'/);
});

test('member order routes are scoped to the authenticated user', () => {
  assert.match(
    apiSource,
    /path === '\/member\/payment-orders'[\s\S]*membership\.createOrder\(session\.userId, data\)/
  );
  assert.match(
    apiSource,
    /paymentOrderMatch[\s\S]*membership\.getOrder\(session\.userId, paymentOrderMatch\[1\]\)/
  );
});

test('internal checkout and confirmation require the server callback token', () => {
  assert.match(apiSource, /function assertPaymentCallbackToken/);
  assert.match(apiSource, /async internalCheckout\(data[\s\S]*assertPaymentCallbackToken\(data\.callbackToken\)/);
  assert.match(apiSource, /async confirmPayment\(data[\s\S]*assertPaymentCallbackToken\(data\.callbackToken\)/);
  assert.match(apiSource, /paymentConfirmationMatches\(currentOrder, data\)/);
  assert.match(apiSource, /db\.runTransaction/);
});

test('mini program sends only the server order number to the payment function', () => {
  const source = frontendSource();
  const callStart = source.indexOf('callHTTPFunction({');
  const requestStart = source.indexOf('wx.requestPayment', callStart);
  assert.ok(callStart >= 0 && requestStart > callStart);
  const checkoutCall = source.slice(callStart, requestStart);
  assert.match(checkoutCall, /outTradeNo/);
  assert.doesNotMatch(checkoutCall, /amountFen|price|fee/);
  assert.match(source, /pollPaymentOrder/);
});
