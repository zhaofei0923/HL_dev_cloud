const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeWechatPhoneResult,
  resolveWechatOpenid
} = require('../cloudfunctions/hlApi/auth-policy');

test('production login requires the CloudBase OPENID context', () => {
  assert.equal(resolveWechatOpenid({ wxContext: { OPENID: 'openid-123' } }), 'openid-123');
  assert.throws(
    () => resolveWechatOpenid({ wxContext: {}, payload: { code: 'temporary-code' } }),
    /OPENID/
  );
});

test('mock login is explicit and never stores the raw wx.login code', () => {
  const openid = resolveWechatOpenid({
    wxContext: {},
    payload: { code: 'temporary-code' },
    allowMockLogin: true
  });

  assert.match(openid, /^mock_[a-f0-9]{24}$/);
  assert.doesNotMatch(openid, /temporary-code/);
});

test('phone authorization reads only the verified server response', () => {
  assert.equal(normalizeWechatPhoneResult({
    phoneInfo: {
      phoneNumber: '+86 13800138000',
      purePhoneNumber: '13800138000',
      countryCode: '86'
    }
  }), '13800138000');
  assert.throws(() => normalizeWechatPhoneResult({ phoneInfo: {} }), /手机号/);
});

test('cloud function declares the phone-number OpenAPI permission', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'config.json'),
    'utf8'
  ));
  assert.ok(config.permissions.openapi.includes('phonenumber.getPhoneNumber'));
});
