"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestMatchmakerPayment = exports.matchmakerPaymentReason = exports.matchmakerPaymentSupport = exports.assertMatchmakerActivationOverview = exports.assertMatchmakerActivationOrder = exports.MATCHMAKER_LIFETIME_AMOUNT_FEN = exports.MATCHMAKER_LIFETIME_PLAN_CODE = void 0;
const payment_response_1 = require("./payment-response");
exports.MATCHMAKER_LIFETIME_PLAN_CODE = 'matchmaker_lifetime';
exports.MATCHMAKER_LIFETIME_AMOUNT_FEN = 698000;
function assertMatchmakerActivationOrder(order, userId) {
    if (!order || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(order.outTradeNo))
        throw new Error('主理人订单编号无效');
    (0, payment_response_1.assertPaymentQueryResponse)({ order }, order.outTradeNo);
    if (Number(order.userId) !== userId || !Number.isSafeInteger(userId) || userId <= 0
        || order.productType !== 'matchmaker' || order.planCode !== exports.MATCHMAKER_LIFETIME_PLAN_CODE
        || order.amountFen !== exports.MATCHMAKER_LIFETIME_AMOUNT_FEN || order.durationDays !== 0
        || (order.serviceCount !== undefined && order.serviceCount !== 0)
        || order.paymentProvider !== 'virtual')
        throw new Error('主理人订单与当前账号或开通方案不一致，请查询订单');
}
exports.assertMatchmakerActivationOrder = assertMatchmakerActivationOrder;
function assertMatchmakerActivationOverview(result) {
    const plan = result && result.plan;
    if (!result || typeof result.active !== 'boolean' || typeof result.phoneBound !== 'boolean'
        || !plan || plan.planCode !== exports.MATCHMAKER_LIFETIME_PLAN_CODE || plan.productType !== 'matchmaker'
        || plan.amountFen !== exports.MATCHMAKER_LIFETIME_AMOUNT_FEN || plan.durationDays !== 0 || plan.lifetime !== true
        || !result.payment || typeof result.payment.available !== 'boolean')
        throw new Error('主理人开通方案暂时无法确认，请刷新重试');
    if (result.active && (!result.matchmaker || Number(result.matchmaker.certificationStatus) !== 2
        || Number(result.matchmaker.status) !== 1))
        throw new Error('主理人权限尚未确认，请刷新重试');
}
exports.assertMatchmakerActivationOverview = assertMatchmakerActivationOverview;
function compareVersion(left, right) {
    const a = left.split('.'), b = right.split('.');
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (Number(a[index]) || 0) - (Number(b[index]) || 0);
        if (difference)
            return difference;
    }
    return 0;
}
function matchmakerPaymentSupport() {
    const api = wx;
    let legacy;
    const oldInfo = () => legacy || (legacy = typeof api.getSystemInfoSync === 'function' ? api.getSystemInfoSync() || {} : {});
    const device = typeof api.getDeviceInfo === 'function' ? api.getDeviceInfo() || {} : oldInfo();
    const app = typeof api.getAppBaseInfo === 'function' ? api.getAppBaseInfo() || {} : oldInfo();
    const platform = String(device.platform || '').toLowerCase();
    if (platform === 'ios') {
        const system = /^iOS\s+(\d+(?:\.\d+)*)$/i.exec(String(device.system || oldInfo().system || ''))?.[1] || '';
        if (!system || compareVersion(system, '15') < 0)
            return { platform, reason: '苹果支付需要 iOS 15 及以上，请更新系统后重试。' };
        const version = String(app.version || oldInfo().version || '');
        if (!/^\d+(?:\.\d+)*$/.test(version) || compareVersion(version, '8.0.68') < 0) {
            return { platform, reason: '苹果支付需要微信 8.0.68 及以上，请更新微信后重试。' };
        }
    }
    const supported = compareVersion(String(app.SDKVersion || ''), '2.19.2') >= 0
        || (typeof wx.canIUse === 'function' && wx.canIUse('requestVirtualPayment'));
    return { platform, reason: supported ? '' : '当前微信版本不支持虚拟支付，请更新微信后重试。' };
}
exports.matchmakerPaymentSupport = matchmakerPaymentSupport;
function matchmakerPaymentReason(reason) {
    if (reason === 'phone_required')
        return '请先授权微信手机号，再开通主理人。';
    if (['account_inactive', 'matchmaker_inactive', 'matchmaker_application_unavailable'].includes(reason))
        return '当前账号暂无法开通，请联系平台。';
    if (reason === 'already_active' || reason === 'matchmaker_already_active')
        return '主理人权限已经开通，无需再次付款。';
    if (reason === 'pending_order_query_required')
        return '请先查询上一笔订单，确认结果前勿重复付款。';
    if (reason === 'retired_plan_query_required')
        return '请查询原订单或联系平台处理。';
    return '主理人支付暂不可用，请稍后重试或联系平台。';
}
exports.matchmakerPaymentReason = matchmakerPaymentReason;
function requestMatchmakerPayment(params, submittedAttempts) {
    return new Promise((resolve, reject) => {
        const validated = (0, payment_response_1.virtualPaymentParamsFrom)(params);
        const signed = JSON.parse(validated.signData);
        const support = matchmakerPaymentSupport();
        if (support.reason)
            throw new Error(support.reason);
        if (signed.goodsPrice !== exports.MATCHMAKER_LIFETIME_AMOUNT_FEN)
            throw new Error('主理人支付金额与开通方案不一致');
        if (support.platform === 'ios' && signed.env !== 0)
            throw new Error('苹果支付暂不支持当前测试商品，请联系平台。');
        const payer = wx.requestVirtualPayment;
        if (typeof payer !== 'function')
            throw new Error('当前微信版本不支持虚拟支付，请更新微信后重试。');
        if (submittedAttempts.includes(signed.outTradeNo))
            throw new Error('付款尝试已经提交，请先查询订单。');
        submittedAttempts.push(signed.outTradeNo);
        payer({ ...validated, success: () => resolve(), fail: reject });
    });
}
exports.requestMatchmakerPayment = requestMatchmakerPayment;
