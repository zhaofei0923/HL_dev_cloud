'use strict';

// Virtual payment (小程序虚拟支付 / 米大师) integration primitives.
// Owns: environment configuration, the two HMAC-SHA256 signature schemes,
// code2session, access token caching, the xpay query_order API and
// goods-delivery push validation. Secrets never leave this module except
// into the exact outbound request or signature that requires them.
const crypto = require('node:crypto');
const https = require('node:https');

const XPAY_QUERY_ORDER_URI = '/xpay/query_order';
const XPAY_NOTIFY_PROVIDE_GOODS_URI = '/xpay/notify_provide_goods';
const CLIENT_PAYMENT_URI = 'requestVirtualPayment';
const MAX_HTTPS_BODY = 1024 * 1024;

function failure(message, status = 502, code = 50201) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Full configuration including secrets. Callers must never serialize the
// returned appKey/appSecret/callbackToken into any response or log.
function virtualPaymentConfig(env = {}) {
  const offerId = String(env.VPAY_OFFER_ID || '').trim();
  const envMode = String(env.VPAY_ENV ?? '').trim();
  const validEnv = envMode === '0' || envMode === '1';
  const appKey = String((envMode === '1' ? env.VPAY_SANDBOX_APP_KEY
    : (envMode === '0' ? env.VPAY_APP_KEY : '')) || '').trim();
  const appSecret = String(env.WX_APP_SECRET || '').trim();
  const callbackToken = String(env.PAYMENT_CALLBACK_TOKEN || '').trim();
  const configured = validEnv && /^\d{6,20}$/.test(offerId) && appKey.length >= 16 && appKey.length <= 128
    && appSecret.length >= 16 && appSecret.length <= 128 && callbackToken.length >= 32;
  return {
    configured,
    offerId,
    env: validEnv ? Number(envMode) : null,
    appKey,
    appSecret,
    callbackToken
  };
}

function assertVirtualOrderNumber(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,32}$/.test(value) || value.startsWith('_')) {
    throw failure('支付订单号无效', 400, 40001);
  }
  return value;
}

function assertVirtualPayer(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || /^(manual_|seed-|mock_)/.test(value)) {
    throw failure('请使用当前微信账号发起支付', 403, 40304);
  }
  return value;
}

function assertVirtualLoginCode(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw failure('微信登录态无效，请重新进入小程序', 400, 40001);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Signatures (见官方文档《虚拟支付》签名详解)
// paySig    = HMAC-SHA256(uri + '&' + postBody, appKey)      — 支付签名
// signature = HMAC-SHA256(postBody, sessionKey)              — 用户态签名
// ---------------------------------------------------------------------------

function hmacSha256Hex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

// signData 字段顺序固定，与官方文档示例一致；同一字符串既被签名也被发送。
function buildVirtualSignData({ offerId, env, productId, goodsPrice, outTradeNo, attach } = {}) {
  if (!/^\d{6,20}$/.test(String(offerId || ''))) throw failure('虚拟支付应用编号无效', 503, 50301);
  if (env !== 0 && env !== 1) throw failure('虚拟支付环境配置无效', 503, 50301);
  if (typeof productId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(productId)) {
    throw failure('会员套餐道具编号无效', 503, 50301);
  }
  if (!Number.isSafeInteger(goodsPrice) || goodsPrice <= 0 || goodsPrice > 100000000) {
    throw failure('会员套餐金额无效', 409, 40907);
  }
  assertVirtualOrderNumber(outTradeNo);
  if (typeof attach !== 'string' || !attach || attach.length > 128) {
    throw failure('虚拟支付透传参数无效', 503, 50301);
  }
  return JSON.stringify({
    offerId: String(offerId),
    buyQuantity: 1,
    env,
    currencyType: 'CNY',
    productId,
    goodsPrice,
    outTradeNo,
    attach
  });
}

function clientPaymentSignatures({ signData, sessionKey, appKey } = {}) {
  if (typeof signData !== 'string' || !signData || signData.length > 1024
    || typeof sessionKey !== 'string' || !/^[a-zA-Z0-9+/=_-]{16,128}$/.test(sessionKey)
    || typeof appKey !== 'string' || appKey.length < 16) {
    throw failure('虚拟支付签名材料无效', 503, 50301);
  }
  return {
    paySig: hmacSha256Hex(appKey, `${CLIENT_PAYMENT_URI}&${signData}`),
    signature: hmacSha256Hex(sessionKey, signData)
  };
}

function serverPaySig(uri, postBody, appKey) {
  if (typeof uri !== 'string' || !uri.startsWith('/') || typeof postBody !== 'string'
    || typeof appKey !== 'string' || appKey.length < 16) {
    throw failure('虚拟支付服务端签名材料无效', 503, 50301);
  }
  return hmacSha256Hex(appKey, `${uri}&${postBody}`);
}

// ---------------------------------------------------------------------------
// HTTPS transport (Node 16 runtime has no global fetch)
// ---------------------------------------------------------------------------

function httpsRequestJson(url, { method = 'GET', body, timeoutMs = 6000 } = {}) {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let request;
    try {
      request = https.request(url, {
        method,
        timeout: timeoutMs,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_HTTPS_BODY) { done(reject, failure('微信服务响应过大', 502, 50201)); response.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const responseBody = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(responseBody); } catch (_) { data = null; }
          done(resolveResult, { status: Number(response.statusCode) || 0, data, emptyBody: responseBody.trim() === '' });
        });
        response.on('error', () => done(reject, failure('微信服务连接失败，请稍后重试', 503, 50301)));
      });
    } catch (_) {
      done(reject, failure('微信服务请求无法发起', 503, 50301));
      return;
    }
    request.on('timeout', () => { request.destroy(); done(reject, failure('微信服务响应超时，请稍后重试', 503, 50301)); });
    request.on('error', () => done(reject, failure('微信服务连接失败，请稍后重试', 503, 50301)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// WeChat API client (code2session / stable access_token / xpay query_order)
// ---------------------------------------------------------------------------

function createVirtualPaymentClient({ request = httpsRequestJson, appId } = {}) {
  if (typeof request !== 'function' || typeof appId !== 'string' || !/^wx[a-fA-F0-9]{16}$/.test(appId)) {
    throw failure('虚拟支付客户端尚未安全配置', 503, 50301);
  }
  let tokenCache = { token: '', expiresAt: 0 };

  async function code2session(appSecret, loginCode) {
    assertVirtualLoginCode(loginCode);
    const query = `appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
      + `&js_code=${encodeURIComponent(loginCode)}&grant_type=authorization_code`;
    const { status, data } = await request(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
    if (status !== 200 || !record(data) || (data.errcode !== undefined && data.errcode !== 0)) {
      throw failure('微信登录态校验失败，请重新进入小程序', 503, 50301);
    }
    if (typeof data.openid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.openid)
      || typeof data.session_key !== 'string' || !/^[a-zA-Z0-9+/=_-]{16,128}$/.test(data.session_key)) {
      throw failure('微信登录态返回不完整，请重新进入小程序', 503, 50301);
    }
    return { openid: data.openid, sessionKey: data.session_key };
  }

  async function accessToken(appSecret, { forceRefresh = false } = {}) {
    if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    const body = JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: forceRefresh });
    const { status, data } = await request('https://api.weixin.qq.com/cgi-bin/stable_token', { method: 'POST', body });
    if (status !== 200 || !record(data) || typeof data.access_token !== 'string'
      || !/^[a-zA-Z0-9_-]{20,512}$/.test(data.access_token)) {
      throw failure('微信接口凭证获取失败，请稍后重试', 503, 50301);
    }
    const expiresIn = Number(data.expires_in);
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (Number.isSafeInteger(expiresIn) && expiresIn > 600 ? expiresIn - 300 : 600) * 1000
    };
    return tokenCache.token;
  }

  // 查询创建的订单（现金单）。返回订单对象；订单不存在返回 null；其余失败抛错。
  async function queryOrder({ appSecret, appKey, openid, env, outTradeNo }, retried = false) {
    assertVirtualPayer(openid);
    assertVirtualOrderNumber(outTradeNo);
    if (env !== 0 && env !== 1) throw failure('虚拟支付环境配置无效', 503, 50301);
    const body = JSON.stringify({ openid, env, order_id: outTradeNo });
    const paySig = serverPaySig(XPAY_QUERY_ORDER_URI, body, appKey);
    const token = await accessToken(appSecret, { forceRefresh: retried });
    const url = `https://api.weixin.qq.com${XPAY_QUERY_ORDER_URI}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`;
    const { status, data } = await request(url, { method: 'POST', body });
    if (status !== 200 || !record(data)) throw failure('微信订单查询失败，请稍后重试', 503, 50301);
    // access_token 可能在平台侧提前失效：强制刷新后仅重试一次。
    if (!retried && [40001, 40014, 42001].includes(Number(data.errcode))) {
      return queryOrder({ appSecret, appKey, openid, env, outTradeNo }, true);
    }
    if (data.errcode === 0) {
      if (!record(data.order)) return null;
      return data.order;
    }
    const message = String(data.errmsg || '');
    if (Number(data.errcode) === 90019 || /未找到|不存在|not[\s_]*found|not[\s_]*exist/i.test(message)) return null;
    throw failure('微信订单查询失败，请稍后重试', 503, 50301);
  }

  // 查单补发后主动告知平台已完成发货。推送成功应答本身也能确认发货。
  // xpay 服务端签名绑定 URI 和实际发送的 JSON 字节；沙箱真机已验证 pay_sig 必需。
  async function notifyProvideGoods({ appSecret, appKey, env, outTradeNo }, retried = false) {
    assertVirtualOrderNumber(outTradeNo);
    if (env !== 0 && env !== 1) throw failure('虚拟支付环境配置无效', 503, 50301);
    const body = JSON.stringify({ order_id: outTradeNo, env });
    const paySig = serverPaySig(XPAY_NOTIFY_PROVIDE_GOODS_URI, body, appKey);
    const token = await accessToken(appSecret, { forceRefresh: retried });
    const url = `https://api.weixin.qq.com${XPAY_NOTIFY_PROVIDE_GOODS_URI}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`;
    const { status, data, emptyBody } = await request(url, { method: 'POST', body });
    if (status !== 200) throw failure('微信发货确认失败，请稍后重试', 503, 50301);
    if (!retried && record(data) && [40001, 40014, 42001].includes(Number(data.errcode))) {
      return notifyProvideGoods({ appSecret, appKey, env, outTradeNo }, true);
    }
    if ((record(data) && data.errcode === 0) || (data === null && emptyBody === true)) return;
    throw failure('微信发货确认失败，请稍后重试', 503, 50301);
  }

  return { code2session, accessToken, queryOrder, notifyProvideGoods };
}

// ---------------------------------------------------------------------------
// Order state mapping & fulfillment evidence
// ---------------------------------------------------------------------------

// xpay order.status: 0-初始化 1-创建成功(未支付) 2-已支付待发货 3-发货中 4-已发货
// 5-已退款 6-已关闭 7-退款失败 8-用户退款完成 9-回收广告金完成 10-分账回退完成
function mapVirtualOrderState(order = {}) {
  const status = Number(order.status);
  if (status === 1) return 'NOTPAY';
  if (status === 2 || status === 3 || status === 4) return 'SUCCESS';
  if (status === 6) return 'CLOSED';
  if (status === 5 || status === 8) return 'REFUNDED';
  return 'OTHER';
}

// localOrder: 来自 hlApi 内部查询的可信快照；xpayOrder: 服务端查单返回。
// 任何身份、金额、环境或凭据不一致都直接拒绝，绝不放宽为人工以外的自动履约。
function buildVirtualConfirmation(localOrder = {}, xpayOrder = {}, expectedEnv = 0, identity = {}) {
  const outTradeNo = assertVirtualOrderNumber(localOrder.outTradeNo);
  const amountFen = Number(localOrder.amountFen);
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw failure('会员订单金额无效', 409, 40907);
  const payer = assertVirtualPayer(localOrder.payerOpenid);
  if (String(xpayOrder.order_id || '') !== outTradeNo) throw failure('微信交易与会员订单不匹配', 409, 40907);
  const expectedEnvType = expectedEnv === 1 ? 2 : 1; // env_type: 1-现网 2-沙箱
  if (Number(xpayOrder.env_type) !== expectedEnvType) throw failure('微信交易环境与当前配置不匹配', 409, 40907);
  // query_order: 0 is a regular payment; 7 is an Apple IAP payment.
  // Refund orders (1/8) are never original-payment evidence. Apple supports
  // production only and requires at least CNY 1 per payment.
  const orderType = Number(xpayOrder.order_type);
  if (orderType !== 0 && orderType !== 7) throw failure('微信交易类型与会员订单不匹配', 409, 40907);
  if (orderType === 7 && (expectedEnv !== 0 || amountFen < 100)) {
    throw failure('苹果支付订单环境或金额无效', 409, 40907);
  }
  if (Number(xpayOrder.order_fee) !== amountFen || Number(xpayOrder.paid_fee) !== amountFen) {
    throw failure('微信交易金额与会员订单不匹配', 409, 40907);
  }
  const paidTime = Number(xpayOrder.paid_time);
  if (!Number.isSafeInteger(paidTime) || paidTime <= 0 || paidTime * 1000 > Date.now() + 5 * 60 * 1000) {
    throw failure('微信付款时间无效，暂不能确认会员权益', 409, 40907);
  }
  const transactionId = String(xpayOrder.wxpay_order_id || xpayOrder.channel_order_id || xpayOrder.wx_order_id || '');
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(transactionId)) throw failure('微信付款凭据不完整，暂不能确认会员权益', 409, 40907);
  for (const field of ['merchantId', 'appId', 'currency']) {
    if (typeof identity[field] !== 'string' || !identity[field]) throw failure('会员订单商户信息无效', 409, 40907);
  }
  return {
    outTradeNo,
    merchantId: identity.merchantId,
    appId: identity.appId,
    currency: identity.currency,
    amountFen,
    payerOpenid: payer,
    tradeState: 'SUCCESS',
    transactionId,
    successTime: new Date(paidTime * 1000).toISOString()
  };
}

function buildVirtualCloseProof(localOrder = {}, identity = {}) {
  const outTradeNo = assertVirtualOrderNumber(localOrder.outTradeNo);
  const amountFen = Number(localOrder.amountFen);
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) throw failure('会员订单金额无效', 409, 40907);
  const payer = assertVirtualPayer(localOrder.payerOpenid);
  for (const field of ['merchantId', 'appId', 'currency']) {
    if (typeof identity[field] !== 'string' || !identity[field]) throw failure('会员订单商户信息无效', 409, 40907);
  }
  return {
    outTradeNo,
    merchantId: identity.merchantId,
    appId: identity.appId,
    currency: identity.currency,
    amountFen,
    payerOpenid: payer,
    tradeState: 'CLOSED'
  };
}

// A completed refund state alone does not prove a full refund. Require the
// provider's remaining refundable amount to be zero; missing/partial evidence
// stays with the service team rather than revoking unrelated purchased rights.
function buildVirtualRefundProof(localOrder = {}, xpayOrder = {}, expectedEnv = 0, identity = {}) {
  const proof = buildVirtualConfirmation(localOrder, xpayOrder, expectedEnv, identity);
  if (mapVirtualOrderState(xpayOrder) !== 'REFUNDED'
    || typeof xpayOrder.left_fee !== 'number' || !Number.isSafeInteger(xpayOrder.left_fee) || xpayOrder.left_fee !== 0) {
    throw failure('微信全额退款凭据不完整，需人工核查', 409, 40907);
  }
  return { ...proof, tradeState: 'REFUND', providerVerified: true,
    refundId: `vpay_refund_${proof.outTradeNo}`, refundAmountFen: proof.amountFen, refundSource: 'virtual_order_query' };
}

// ---------------------------------------------------------------------------
// Goods delivery push (xpay_goods_deliver_notify)
// ---------------------------------------------------------------------------

// 推送只作为履约触发器：字段校验通过后仍须重新向微信查单核实。
function validateGoodsDeliverPush(raw = {}, expectedEnv = 0) {
  if (!record(raw) || raw.MsgType !== 'event' || raw.Event !== 'xpay_goods_deliver_notify') {
    throw failure('虚拟支付推送类型无效', 400, 40001);
  }
  if (Number(raw.Env) !== expectedEnv) throw failure('虚拟支付推送环境与配置不匹配', 400, 40001);
  const outTradeNo = assertVirtualOrderNumber(raw.OutTradeNo);
  const openid = assertVirtualPayer(raw.OpenId);
  const goods = record(raw.GoodsInfo) ? raw.GoodsInfo : {};
  if (typeof goods.ProductId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(goods.ProductId)) {
    throw failure('虚拟支付推送道具信息无效', 400, 40001);
  }
  const quantity = Number(goods.Quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
    throw failure('虚拟支付推送数量无效', 400, 40001);
  }
  const wechat = record(raw.WeChatPayInfo) ? raw.WeChatPayInfo : {};
  return {
    outTradeNo,
    openid,
    productId: goods.ProductId,
    quantity,
    actualPrice: Number.isSafeInteger(Number(goods.ActualPrice)) ? Number(goods.ActualPrice) : null,
    wxOrderId: typeof wechat.MchOrderNo === 'string' ? wechat.MchOrderNo : '',
    transactionId: typeof wechat.TransactionId === 'string' ? wechat.TransactionId : '',
    paidTime: Number.isSafeInteger(Number(wechat.PaidTime)) ? Number(wechat.PaidTime) : 0
  };
}

module.exports = {
  XPAY_QUERY_ORDER_URI,
  XPAY_NOTIFY_PROVIDE_GOODS_URI,
  buildVirtualCloseProof,
  buildVirtualConfirmation,
  buildVirtualRefundProof,
  buildVirtualSignData,
  clientPaymentSignatures,
  createVirtualPaymentClient,
  assertVirtualLoginCode,
  assertVirtualOrderNumber,
  assertVirtualPayer,
  hmacSha256Hex,
  mapVirtualOrderState,
  serverPaySig,
  validateGoodsDeliverPush,
  virtualPaymentConfig
};
