const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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
  assert.match(apiSource, /memberRef\.update\(\{ data: memberPatch \}\)/);
  assert.match(apiSource, /orderRef\.update\(\{ data: orderPatch \}\)/);
});

test('mini program payment requests send order identity and login code without client prices', () => {
  const source = frontendSource();
  function callIn(text, name, firstArgument) {
    const parsed = ts.createSourceFile('payment.ts', text, ts.ScriptTarget.Latest, true);
    let found;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === name
        && (firstArgument === undefined || (ts.isStringLiteral(node.arguments[0])
          && node.arguments[0].text === firstArgument))) found = node;
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(found, `Expected payment request ${name}`);
    return found;
  }
  function dataFields(options) {
    assert.ok(ts.isObjectLiteralExpression(options));
    const data = options.properties.find(property => property.name && property.name.getText() === 'data');
    assert.ok(data && ts.isPropertyAssignment(data) && ts.isObjectLiteralExpression(data.initializer));
    return data.initializer.properties.map(property => {
      assert.ok(ts.isShorthandPropertyAssignment(property), 'Payment data must use the trusted identity arguments');
      return property.name.text;
    }).sort();
  }
  const legacy = callIn(source, 'cloud.callHTTPFunction');
  assert.deepEqual(dataFields(legacy.arguments[0]), ['outTradeNo']);
  const service = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'services', 'member.ts'), 'utf8');
  const virtual = callIn(service, 'request', '/member/payment-virtual/checkout');
  assert.deepEqual(dataFields(virtual.arguments[1]), ['loginCode', 'outTradeNo']);
  const query = callIn(service, 'request', '/member/payment-virtual/query');
  assert.deepEqual(dataFields(query.arguments[1]), ['outTradeNo']);
  assert.match(source, /pollPaymentOrder/);
});
