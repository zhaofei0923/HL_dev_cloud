'use strict';

const crypto = require('node:crypto');

function resolveWechatOpenid({ wxContext = {}, payload = {}, allowMockLogin = false } = {}) {
  const openid = String(wxContext.OPENID || '').trim();
  if (openid) return openid;

  if (allowMockLogin === true) {
    const code = String(payload.code || '').trim();
    if (!code) throw new Error('mock login code is required');
    const digest = crypto.createHash('sha256').update(code).digest('hex').slice(0, 24);
    return `mock_${digest}`;
  }

  throw new Error('CloudBase OPENID context is required');
}

function normalizeWechatPhoneResult(result = {}) {
  const phoneInfo = result.phoneInfo || (result.data && result.data.phoneInfo) || {};
  const rawPhone = phoneInfo.purePhoneNumber || phoneInfo.phoneNumber || '';
  let phone = String(rawPhone).replace(/[\s()-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  if (!/^\d{6,20}$/.test(phone)) throw new Error('未获取到有效手机号');
  return phone;
}

module.exports = {
  normalizeWechatPhoneResult,
  resolveWechatOpenid
};
