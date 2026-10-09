'use strict';

// Installed into the Integration Center payment function. Its PayService owns
// WeChat signing and verification; this module owns membership order matching.
const ORDER_STATES = new Set(['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']);
const PUBLIC_ORDER_FIELDS = ['id', 'outTradeNo', 'userId', 'planCode', 'planTitle', 'amountFen', 'durationDays',
  'status', 'transactionId', 'paidAt', 'createdAt', 'updatedAt'];
const MAX_CALL_MS = 8000;
const OPERATION_MS = 15000;
const CALLBACK_MS = 3500;

function failure(message, status = 502, code = 50201) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function orderNumber(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,32}$/.test(value)) {
    throw failure('支付订单号无效', 400, 40001);
  }
  return value;
}

function openid(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || /^(manual_|seed-|mock_)/.test(value)) {
    throw failure('请使用当前微信账号发起支付', 403, 40304);
  }
  return value;
}

async function bounded(operation, deadline, message) {
  const remaining = Math.min(MAX_CALL_MS, deadline - Date.now());
  if (remaining <= 0) throw failure(message, 503, 50301);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure(message, 503, 50301)), remaining); })
    ]);
    if (Date.now() >= deadline) throw failure(message, 503, 50301);
    return result;
  } catch (_) {
    // SDK errors can include signed headers, keys, or the callback credential.
    throw failure(message, 503, 50301);
  } finally {
    clearTimeout(timer);
  }
}

function publicOrder(value, outTradeNo) {
  const order = record(value) && record(value.order) ? value.order : value;
  if (!record(order) || order.outTradeNo !== outTradeNo || !ORDER_STATES.has(order.status)) {
    throw failure('业务订单状态暂未确认，请稍后查询');
  }
  return Object.fromEntries(PUBLIC_ORDER_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(order, key)
    && (order[key] === null || ['string', 'number', 'boolean'].includes(typeof order[key])))
    .map(key => [key, order[key]]));
}

function paymentParameters(result, appId) {
  if (!record(result) || result.status !== 200 || !record(result.data)) throw failure('微信支付下单失败，请稍后重试');
  const value = result.data;
  if (typeof value.timeStamp !== 'string' || !/^[1-9]\d{8,12}$/.test(value.timeStamp)
    || typeof value.nonceStr !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.nonceStr)
    || typeof value.package !== 'string' || !/^prepay_id=[a-zA-Z0-9_-]{1,200}$/.test(value.package)
    || value.signType !== 'RSA' || typeof value.paySign !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.paySign) || value.paySign.length % 4 !== 0
    || Buffer.from(value.paySign, 'base64').length < 256 || Buffer.from(value.paySign, 'base64').length > 1024
    || Buffer.from(value.paySign, 'base64').toString('base64') !== value.paySign
    || (value.appId !== undefined && value.appId !== appId)) {
    throw failure('微信支付参数不完整，请重新查询订单后重试');
  }
  return { timeStamp: value.timeStamp, nonceStr: value.nonceStr, package: value.package, signType: 'RSA', paySign: value.paySign };
}

function createMembershipBridge({ callFunction, payService, merchant, callbackToken } = {}) {
  if (typeof callFunction !== 'function' || !payService || typeof payService.unifiedOrder !== 'function'
    || typeof payService.queryOrderByOutTradeNo !== 'function' || !record(merchant)
    || typeof merchant.merchantId !== 'string' || !/^\d{6,32}$/.test(merchant.merchantId)
    || typeof merchant.appId !== 'string' || !/^wx[a-fA-F0-9]{16}$/.test(merchant.appId)
    || typeof merchant.envId !== 'string' || !/^[a-zA-Z0-9_-]{6,128}$/.test(merchant.envId)
    || merchant.businessFunctionName !== 'hlApi' || merchant.currency !== 'CNY'
    || typeof callbackToken !== 'string' || callbackToken.trim().length < 32) {
    throw failure('会员支付服务尚未安全配置', 503, 50301);
  }
  // Capture only public configuration; neither credentials nor PayService are
  // copied into any response, callback body or serializable bridge state.
  const config = Object.freeze({ merchantId: merchant.merchantId, appId: merchant.appId, envId: merchant.envId,
    businessFunctionName: merchant.businessFunctionName, currency: merchant.currency });
  const credential = callbackToken.trim();

  async function business(action, data, deadline) {
    const response = await bounded(() => callFunction({
      name: config.businessFunctionName, config: { env: config.envId },
      data: { path: `/internal/payment-orders/${action}`, method: 'POST', data: { ...data, callbackToken: credential } }
    }), deadline, '会员订单服务暂时不可用，请稍后查询');
    const result = response && response.result;
    if (!record(result) || result.code !== 0 || !record(result.data)) {
      const denied = result && [40100, 40102, 40304].includes(result.code);
      throw denied ? failure('当前微信账号无权操作此订单', 403, 40304)
        : failure('会员订单状态暂未确认，请稍后查询', 503, 50301);
    }
    return result.data;
  }

  function trustedOrder(value, outTradeNo, requesterOpenid) {
    if (!record(value) || value.outTradeNo !== outTradeNo || value.merchantId !== config.merchantId
      || value.appId !== config.appId || value.currency !== config.currency
      || !Number.isSafeInteger(value.amountFen) || value.amountFen <= 0 || value.amountFen > 100000000
      || !Number.isSafeInteger(value.userId) || value.userId <= 0 || !ORDER_STATES.has(value.status)) {
      throw failure('会员订单信息不完整或商户不一致');
    }
    if (openid(value.payerOpenid) !== requesterOpenid) throw failure('当前微信账号无权操作此订单', 403, 40304);
    return value;
  }

  async function wechatOrder(outTradeNo, deadline) {
    const result = await bounded(() => payService.queryOrderByOutTradeNo({ out_trade_no: outTradeNo, mchid: config.merchantId }),
      deadline, '微信订单查询暂未完成，请稍后重试');
    if (!record(result) || result.status !== 200 || !record(result.data)) throw failure('微信订单查询失败，请稍后重试');
    const trade = result.data;
    if (trade.out_trade_no !== outTradeNo || trade.mchid !== config.merchantId || trade.appid !== config.appId
      || trade.trade_type !== 'JSAPI') throw failure('微信交易与会员订单不匹配');
    return trade;
  }

  function matchTrade(trade, order, complete) {
    if ((complete || trade.amount !== undefined) && (!record(trade.amount) || trade.amount.total !== order.amountFen
      || trade.amount.currency !== config.currency
      || (trade.amount.payer_currency !== undefined && trade.amount.payer_currency !== config.currency))) {
      throw failure('微信交易金额或币种与会员订单不匹配');
    }
    if ((complete || trade.payer !== undefined) && (!record(trade.payer) || trade.payer.openid !== order.payerOpenid)) {
      throw failure('微信付款人与会员订单不匹配');
    }
  }

  async function reconcile(order, trade, deadline) {
    const outTradeNo = order.outTradeNo;
    const complete = ['SUCCESS', 'CLOSED', 'PAYERROR'].includes(trade.trade_state);
    matchTrade(trade, order, complete);
    if (['NOTPAY', 'USERPAYING'].includes(trade.trade_state)) return { order: publicOrder(order, outTradeNo) };
    if (!complete) throw failure('微信交易状态暂不支持自动处理，请联系工作人员', 409, 40905);
    const proof = { outTradeNo, merchantId: trade.mchid, appId: trade.appid, currency: trade.amount.currency,
      amountFen: trade.amount.total, payerOpenid: trade.payer.openid, tradeState: trade.trade_state };
    if (trade.trade_state === 'SUCCESS') {
      if (typeof trade.transaction_id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(trade.transaction_id)
        || typeof trade.success_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(trade.success_time)
        || !Number.isFinite(Date.parse(trade.success_time))) throw failure('微信付款凭据不完整，暂不能确认会员权益');
      const confirmed = await business('confirm', { ...proof, transactionId: trade.transaction_id, successTime: trade.success_time }, deadline);
      const safe = publicOrder(confirmed, outTradeNo);
      if (safe.status !== 'paid' || safe.transactionId !== trade.transaction_id
        || safe.amountFen !== order.amountFen || safe.userId !== order.userId) throw failure('会员权益尚未确认，请稍后查询');
      return { order: safe };
    }
    const closed = await business('close', proof, deadline);
    return { order: publicOrder(closed, outTradeNo) };
  }

  return Object.freeze({
    async create(input, requesterOpenid) {
      const outTradeNo = orderNumber(record(input) ? input.outTradeNo : undefined);
      const payer = openid(requesterOpenid);
      const deadline = Date.now() + OPERATION_MS;
      const order = trustedOrder(await business('checkout', { outTradeNo, requesterOpenid: payer }, deadline), outTradeNo, payer);
      if (!['pending', 'confirming'].includes(order.status)) throw failure('支付订单已结束，请先查询最新状态', 409, 40905);
      if (typeof order.description !== 'string' || !order.description.trim() || Buffer.byteLength(order.description, 'utf8') > 127) {
        throw failure('会员套餐名称不完整，暂不能发起支付');
      }
      const result = await bounded(() => payService.unifiedOrder({ appid: config.appId, mchid: config.merchantId,
        out_trade_no: order.outTradeNo, description: order.description,
        amount: { total: order.amountFen, currency: config.currency }, payer: { openid: order.payerOpenid }
      }, 'jsapi'), deadline, '微信支付下单暂未确认，请查询订单后重试');
      return paymentParameters(result, config.appId);
    },

    async query(input, requesterOpenid) {
      const outTradeNo = orderNumber(record(input) ? input.outTradeNo : undefined);
      const payer = openid(requesterOpenid);
      const deadline = Date.now() + OPERATION_MS;
      const order = trustedOrder(await business('query', { outTradeNo, requesterOpenid: payer }, deadline), outTradeNo, payer);
      return reconcile(order, await wechatOrder(outTradeNo, deadline), deadline);
    },

    async confirmVerifiedCallback(payResult) {
      const outTradeNo = orderNumber(record(payResult) ? payResult.out_trade_no : undefined);
      const deadline = Date.now() + CALLBACK_MS;
      // Even a gateway ParsedContent payload can never serve as paid evidence.
      // Query WeChat first, derive the owner from that result, then load hlApi's
      // order. Callback failures must reject so the template can return non-2xx.
      const trade = await wechatOrder(outTradeNo, deadline);
      const payer = openid(trade.payer && trade.payer.openid);
      const order = trustedOrder(await business('query', { outTradeNo, requesterOpenid: payer }, deadline), outTradeNo, payer);
      return reconcile(order, trade, deadline);
    }
  });
}

module.exports = { createMembershipBridge };
