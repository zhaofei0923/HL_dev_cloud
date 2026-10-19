"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertPaymentQueryResponse = exports.virtualPaymentParamsFrom = exports.paymentParamsFrom = exports.isTransientPaymentQueryError = exports.paymentRecord = void 0;
function paymentRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
exports.paymentRecord = paymentRecord;
function responseError(message, statusCode, code) {
    const error = new Error(message);
    if (typeof statusCode === 'number')
        error.statusCode = statusCode;
    if (typeof code === 'number')
        error.code = code;
    return error;
}
function isTransientPaymentQueryError(error) {
    if (!paymentRecord(error))
        return false;
    const code = typeof error.code === 'number' ? error.code : undefined;
    if (code !== undefined && ((code >= 400 && code < 500) || (code >= 40000 && code < 50000)))
        return false;
    const status = typeof error.statusCode === 'number' ? error.statusCode : error.status;
    if (typeof status === 'number')
        return status === 502 || status === 503;
    // hlApi business errors arrive through callFunction without HTTP metadata.
    // Only the two agreed temporary query failures authorize bounded retries.
    if (code === 50201 || code === 50301)
        return true;
    const source = paymentRecord(error.raw) ? error.raw : error;
    const message = typeof source.errMsg === 'string' ? source.errMsg : '';
    if (/permission|denied|unauthori[sz]ed|forbidden|cancel/i.test(message))
        return false;
    return /timeout|timed out|network|connection (?:reset|refused|closed)|socket hang up/i.test(message);
}
exports.isTransientPaymentQueryError = isTransientPaymentQueryError;
// Legacy integrations omit transport metadata or wrap parameters in payment.
// Validate every envelope before unwrapping SDK and business responses.
function paymentPayloadFrom(result) {
    let current = result;
    for (let depth = 0; depth < 8; depth += 1) {
        if (!paymentRecord(current))
            throw new Error('支付服务返回格式无效');
        if (Object.prototype.hasOwnProperty.call(current, 'statusCode') && current.statusCode !== 200) {
            const bodyCode = paymentRecord(current.data) ? current.data.code : undefined;
            throw responseError('支付服务请求未成功，请稍后重试', current.statusCode, bodyCode);
        }
        if (Object.prototype.hasOwnProperty.call(current, 'status') && current.status !== 200) {
            const bodyCode = paymentRecord(current.data) ? current.data.code : undefined;
            throw responseError('支付服务未确认请求成功', current.status, bodyCode);
        }
        if (Object.prototype.hasOwnProperty.call(current, 'code') && current.code !== 0) {
            throw responseError('支付服务返回业务错误，请查询订单或联系主理人', undefined, current.code);
        }
        if ('data' in current)
            current = current.data;
        else if ('payment' in current)
            current = current.payment;
        else
            return current;
    }
    throw new Error('支付服务返回格式无效');
}
function paymentParamsFrom(result) {
    const params = paymentPayloadFrom(result);
    if (typeof params.timeStamp !== 'string' || !/^[1-9]\d{9}$/.test(params.timeStamp)
        || typeof params.nonceStr !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(params.nonceStr)
        || typeof params.package !== 'string' || !/^prepay_id=[A-Za-z0-9_-]+$/.test(params.package) || params.package.length > 128
        || typeof params.paySign !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(params.paySign)
        || params.paySign.length < 344 || params.paySign.length > 512 || params.paySign.length % 4 !== 0
        || (params.signType !== undefined && params.signType !== 'RSA')) {
        throw new Error('支付函数未返回有效的微信支付参数');
    }
    return { timeStamp: params.timeStamp, nonceStr: params.nonceStr, package: params.package,
        signType: 'RSA', paySign: params.paySign };
}
exports.paymentParamsFrom = paymentParamsFrom;
// 虚拟支付（requestVirtualPayment）参数校验：signData 既是被签名的字符串，
// 也是客户端透传的载荷，必须逐字段核验后才允许拉起收银台。
function virtualPaymentParamsFrom(result, expected) {
    const payload = paymentPayloadFrom(result);
    const source = paymentRecord(payload.virtualPayment) ? payload.virtualPayment : payload;
    if (!paymentRecord(source) || source.mode !== 'short_series_goods'
        || typeof source.paySig !== 'string' || !/^[0-9a-f]{64}$/.test(source.paySig)
        || typeof source.signature !== 'string' || !/^[0-9a-f]{64}$/.test(source.signature)
        || typeof source.signData !== 'string' || source.signData.length > 1024) {
        throw new Error('支付函数未返回有效的虚拟支付参数');
    }
    let signData;
    try {
        signData = JSON.parse(source.signData);
    }
    catch (_) {
        throw new Error('支付函数未返回有效的虚拟支付参数');
    }
    if (!paymentRecord(signData) || typeof signData.offerId !== 'string' || !/^\d{6,20}$/.test(signData.offerId)
        || signData.buyQuantity !== 1 || (signData.env !== 0 && signData.env !== 1) || signData.currencyType !== 'CNY'
        || typeof signData.productId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(signData.productId)
        || !Number.isSafeInteger(signData.goodsPrice) || Number(signData.goodsPrice) <= 0
        || typeof signData.outTradeNo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_|*@-]{7,31}$/.test(signData.outTradeNo)
        || typeof signData.attach !== 'string' || !signData.attach) {
        throw new Error('支付函数未返回有效的虚拟支付参数');
    }
    if (expected && (signData.outTradeNo !== expected.paymentAttemptNo
        || signData.productId !== expected.productId || signData.goodsPrice !== expected.goodsPrice)) {
        throw new Error('虚拟支付参数与当前会员订单不一致');
    }
    return { mode: 'short_series_goods', signData: source.signData, paySig: source.paySig, signature: source.signature };
}
exports.virtualPaymentParamsFrom = virtualPaymentParamsFrom;
function assertPaymentQueryResponse(result, outTradeNo) {
    const payload = paymentPayloadFrom(result);
    const order = payload.order;
    if (!paymentRecord(order) || order.outTradeNo !== outTradeNo
        || (Object.prototype.hasOwnProperty.call(order, 'code') && order.code !== 0)
        || typeof order.status !== 'string' || !['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'].includes(order.status)
        || (order.fulfillmentStatus !== undefined && (typeof order.fulfillmentStatus !== 'string'
            || !['', 'fulfilled', 'requires_review'].includes(order.fulfillmentStatus)))) {
        throw new Error('支付查询未返回当前订单的有效结果');
    }
    const tradeState = payload.tradeState;
    if (Object.prototype.hasOwnProperty.call(payload, 'providerOrderAbsent')) {
        if (payload.providerOrderAbsent !== true || Object.prototype.hasOwnProperty.call(payload, 'tradeState')
            || !['pending', 'confirming'].includes(order.status)) {
            throw new Error('微信订单不存在的查询证据无效，请查询订单或联系主理人');
        }
        return { providerOrderAbsent: true };
    }
    if (tradeState === undefined)
        return {};
    const compatible = ((tradeState === 'NOTPAY' || tradeState === 'USERPAYING') && ['pending', 'confirming'].includes(order.status))
        || (tradeState === 'SUCCESS' && order.status === 'paid')
        || (tradeState === 'CLOSED' && order.status === 'closed')
        || (tradeState === 'PAYERROR' && order.status === 'failed');
    if (!compatible)
        throw new Error('微信交易状态与会员订单结果不一致，请查询订单或联系主理人');
    return { tradeState: tradeState };
}
exports.assertPaymentQueryResponse = assertPaymentQueryResponse;
