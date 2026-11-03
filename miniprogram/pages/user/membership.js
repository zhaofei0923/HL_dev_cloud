"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
const chat_1 = require("../../services/chat");
const page_session_1 = require("../../utils/page-session");
const payment_response_1 = require("../../utils/payment-response");
const member_1 = require("../../services/member");
const MEMBERSHIP_BENEFITS = [
    { key: 'chat', title: '无限畅聊', note: '互相喜欢或正式牵线后畅聊' },
    { key: 'readReceipts', title: '消息已读', note: '查看自己发送的消息是否已读' },
    { key: 'exchangeWechat', title: '交换微信', note: '双方同意后交换微信号' },
    { key: 'unlimitedSwipe', title: '无限划卡', note: '随心浏览推荐会员' },
    { key: 'advancedFilter', title: '高级筛选', note: '按择偶条件查找合适的人' },
    { key: 'onlineReminder', title: '上线提醒', note: '关注对象上线时，接收站内提醒' },
    { key: 'exclusiveSupport', title: '专属客服', note: '联系主理人获取服务支持' },
    { key: 'memberBadge', title: '专属会员标识', note: '展示你的 VIP 身份' },
    { key: 'likedMe', title: '谁喜欢我', note: '查看身份并回应喜欢' },
    { key: 'visitors', title: '查看来访', note: '了解谁看过你的资料' },
    { key: 'invisibleVisit', title: '隐身访问', note: '开启后不留下可见来访记录' }
];
function isPaymentHTTPCloud(value) {
    return (0, payment_response_1.paymentRecord)(value) && typeof value.callHTTPFunction === 'function';
}
const EMPTY_OVERVIEW = {
    isPremiumMember: false,
    phoneBound: false,
    phoneMasked: '',
    needsMatchmaker: false,
    membership: null,
    plans: [],
    payment: {
        available: false,
        reason: 'merchant_not_configured',
        functionName: '',
        createPath: '',
        queryPath: ''
    }
};
function durationText(days) {
    if (days % 365 === 0)
        return `${days / 365} 年`;
    if (days % 30 === 0)
        return `${days / 30} 个月`;
    return `${days} 天`;
}
function expiryText(overview) {
    if (overview.vipMembership) {
        if (overview.vipMembership.lifetime)
            return '长期有效';
        if (overview.vipMembership.expireAt)
            return dateExpiryText(overview.vipMembership.expireAt);
    }
    if (overview.membershipTier === 'free')
        return '尚未开通VIP权益';
    if (!overview.membership)
        return '尚未开通VIP权益';
    if (overview.membership.lifetime)
        return '长期有效';
    if (!overview.membership.expireAt)
        return '尚未开通付费权益';
    const date = new Date(overview.membership.expireAt);
    if (Number.isNaN(date.getTime()))
        return '会员有效期待确认';
    return `有效期至 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
function dateExpiryText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '有效期待确认' : `有效期至 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
function productType(plan) {
    return plan.productType === 'matchmaker' ? 'matchmaker' : plan.productType === 'matchmaking' ? 'matchmaking' : 'vip';
}
function paymentFor(overview, type) {
    return type === 'matchmaking' ? (overview.matchmakingPayment || { provider: 'virtual', available: false,
        reason: 'integration_incomplete', functionName: '', createPath: '', queryPath: '' }) : overview.payment;
}
function testAmountText(snapshot) {
    return snapshot && Number.isFinite(snapshot.amountFen) && Number(snapshot.amountFen) > 0
        ? `¥${(Number(snapshot.amountFen) / 100).toFixed(2)}` : snapshot?.priceText || '金额待确认';
}
function testEntitlementText(snapshot) {
    return snapshot && Number.isFinite(snapshot.durationDays) && Number(snapshot.durationDays) > 0
        ? `${snapshot.durationDays}天会员权益` : '会员权益待确认';
}
function paymentTestNotice(snapshot) {
    return `沙箱测试金额${testAmountText(snapshot)}，服务端确认后获得${testEntitlementText(snapshot)}。仅在测试窗口内手动发起，不自动扣款。`;
}
function paymentTestActionText(snapshot) {
    return `手动测试 ${testAmountText(snapshot)}`;
}
function planViews(overview, type, payment) {
    return overview.plans.filter(plan => productType(plan) === type).map(plan => ({
        ...plan,
        durationText: type === 'matchmaking' ? `${plan.durationDays} 天有效` : durationText(plan.durationDays),
        descriptionText: payment.testMode ? `沙箱测试：${testAmountText(plan)}，确认后开通${testEntitlementText(plan)}`
            : type === 'matchmaking' ? `付款确认后即获得 ${plan.serviceCount || 0} 次牵线权益` : plan.description || `${durationText(plan.durationDays)}会员权益`,
        dailyPriceText: type === 'vip' && !payment.testMode && Number.isFinite(plan.amountFen) && plan.durationDays > 0
            ? `约 ${(plan.amountFen / 100 / plan.durationDays).toFixed(1)} 元/天` : ''
    }));
}
function matchmakingProgress(overview) {
    if (overview.matchmakingProgress)
        return overview.matchmakingProgress;
    const packages = overview.matchmakingPackages || [];
    const active = packages.filter(item => item.status === 'active' && item.remainingCount > 0);
    const readiness = overview.matchmakingReadiness;
    const assigned = readiness?.activeAssignment === undefined ? Number(readiness?.matchmakerId) > 0 : readiness.activeAssignment;
    const profileComplete = readiness?.profileComplete === true;
    const matchmakerConfirmed = readiness?.matchmakerConfirmed === true;
    const earliestExpireAt = active.map(item => item.expireAt).filter(value => Number.isFinite(new Date(value).getTime()))
        .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || null;
    const status = active.length
        ? !profileComplete ? 'needs_profile' : !assigned ? 'awaiting_assignment' : !matchmakerConfirmed || readiness?.ready !== true ? 'awaiting_contact' : 'ready'
        : !packages.length ? 'not_purchased' : packages.some(item => item.status === 'expired') ? 'expired'
            : packages.some(item => item.status === 'exhausted') ? 'exhausted' : 'refunded';
    return { status, purchased: packages.length > 0, profileComplete, assigned, matchmakerConfirmed,
        matchmakerId: readiness?.matchmakerId || null, matchmakerUserId: null, matchmakerName: '', requestedAt: null,
        remainingCount: active.reduce((total, item) => total + item.remainingCount, 0), earliestExpireAt };
}
function matchmakingNextStep(progress) {
    const titles = { not_purchased: '购买后开启牵线服务', needs_profile: '下一步：完善资料',
        awaiting_assignment: '平台待分配', awaiting_contact: '主理人待对接', ready: '可申请人工牵线',
        expired: '牵线服务已到期', exhausted: '牵线次数已用完', refunded: '牵线服务已退款' };
    const notes = {
        not_purchased: '可直接选择套餐购买；付款确认后即获得次数，再完善资料，由平台安排主理人对接。',
        needs_profile: '牵线次数已到账。请完善个人资料，平台会按资料安排主理人开展推荐服务。',
        awaiting_assignment: '个人资料已就绪，平台将安排主理人对接，请留意服务进度。',
        awaiting_contact: '平台已分配主理人，等待主理人对接并确认服务准备；也可主动联系咨询。',
        ready: '资料与主理人对接已就绪，可选择对象申请牵线。每次具体牵线仍需主理人确认安排及双方本人同意。',
        expired: '已到期套餐保留记录，可重新购买；新套餐独立计期。', exhausted: '已购套餐次数已用完，可重新购买；新套餐独立计期。',
        refunded: '已退款套餐保留记录，当前权益以服务记录为准。'
    };
    return { title: titles[progress.status], note: notes[progress.status] };
}
function paymentReasonText(reason) {
    const labels = {
        merchant_not_configured: '微信支付暂不可用，请稍后重试',
        integration_incomplete: '微信支付暂未开放',
        member_assignment_required: '支付状态待刷新，请稍后重试',
        phone_required: '授权微信手机号后可付款',
        plans_not_configured: '套餐暂不可用，请稍后重试',
        profile_required: '支付状态待刷新，请稍后重试',
        matchmaker_confirmation_required: '支付状态待刷新，请稍后重试',
        payment_test_completed: '支付测试已完成',
        historical_payment_query_required: '请查询原订单或联系主理人',
        retired_plan_query_required: '该套餐已停售，请查询原订单或联系主理人'
    };
    return labels[reason] || '微信支付暂不可用';
}
function wait(delay) {
    return new Promise(resolve => setTimeout(resolve, delay));
}
function isNativePaymentRestricted(error) {
    if (!(0, payment_response_1.paymentRecord)(error))
        return false;
    // 虚拟支付的收款限制以错误码为准（-15017 商家收款受限 / -15019 商户受限）。
    if (error.errCode === -15017 || error.errCode === -15019)
        return true;
    if (typeof error.errMsg !== 'string')
        return false;
    return /^request(?:Virtual)?Payment:fail(?:[\s:]|$)/i.test(error.errMsg)
        && /\bbanned\b|\bno[\s_-]*permission\b|\baccess[\s_-]*denied\b/i.test(error.errMsg);
}
function isNativePaymentCancelled(error) {
    if (!(0, payment_response_1.paymentRecord)(error))
        return false;
    // 虚拟支付 -2 即用户取消；旧通道靠 errMsg 中的 cancel 标识。
    if (error.errCode === -2)
        return true;
    return typeof error.errMsg === 'string'
        && /^request(?:Virtual)?Payment:fail(?:[\s:]|$).*\bcancel\b/i.test(error.errMsg);
}
// 虚拟支付要求基础库 >= 2.19.2；苹果 IAP 另需 iOS >= 15、微信 >= 8.0.68。
function compareVersionText(v1, v2) {
    const left = String(v1 || '').split('.');
    const right = String(v2 || '').split('.');
    const length = Math.max(left.length, right.length);
    while (left.length < length)
        left.push('0');
    while (right.length < length)
        right.push('0');
    for (let index = 0; index < length; index += 1) {
        const a = parseInt(left[index], 10) || 0;
        const b = parseInt(right[index], 10) || 0;
        if (a !== b)
            return a > b ? 1 : -1;
    }
    return 0;
}
function virtualPaymentSupport() {
    const wxAny = wx;
    let legacy;
    const legacyInfo = () => {
        if (!legacy)
            legacy = typeof wxAny.getSystemInfoSync === 'function' ? (wxAny.getSystemInfoSync() || {}) : {};
        return legacy;
    };
    const device = typeof wxAny.getDeviceInfo === 'function'
        ? (wxAny.getDeviceInfo() || {})
        : legacyInfo();
    const platform = String(device.platform || '').toLowerCase();
    const appBase = typeof wxAny.getAppBaseInfo === 'function'
        ? (wxAny.getAppBaseInfo() || {})
        : legacyInfo();
    const sdkVersion = String(appBase.SDKVersion || '');
    if (platform === 'ios') {
        const system = String(device.system || legacyInfo().system || '');
        const systemVersion = /^iOS\s+(\d+(?:\.\d+)*)$/i.exec(system)?.[1] || '';
        if (!systemVersion || compareVersionText(systemVersion, '15') < 0) {
            return { supported: false, platform, reason: 'ios_system_low' };
        }
        const wechatVersion = String(appBase.version || legacyInfo().version || '');
        if (!/^\d+(?:\.\d+)*$/.test(wechatVersion) || compareVersionText(wechatVersion, '8.0.68') < 0) {
            return { supported: false, platform, reason: 'ios_wechat_low' };
        }
    }
    if (compareVersionText(sdkVersion, '2.19.2') >= 0)
        return { supported: true, platform, reason: '' };
    const canIUse = typeof wx.canIUse === 'function' && wx.canIUse('requestVirtualPayment');
    return canIUse
        ? { supported: true, platform, reason: '' }
        : { supported: false, platform, reason: 'base_library_low' };
}
function virtualPaymentSupportMessage(reason) {
    if (reason === 'ios_system_low')
        return '苹果支付需要 iOS 15 及以上，请更新系统后重试。';
    if (reason === 'ios_wechat_low')
        return '苹果支付需要微信 8.0.68 及以上，请更新微信后重试。';
    return '当前微信版本过低，请更新微信至最新版后再付款。';
}
function orderFeedback(status, testMode = false, type = 'vip', snapshot) {
    if (testMode) {
        const testFeedback = {
            paid: { title: '支付测试已完成', note: `沙箱测试订单已确认，金额${testAmountText(snapshot)}，${testEntitlementText(snapshot)}已经生效。` },
            closed: { title: '测试订单已关闭', note: '此测试订单已关闭，未开通会员权益。' },
            failed: { title: '测试支付未成功', note: '此测试订单支付失败，请查看订单结果后重试。' },
            refunded: { title: '测试订单已退款', note: '此测试订单已退款，到账情况请查看微信支付账单。' }
        };
        if (testFeedback[status])
            return testFeedback[status];
    }
    if (type === 'matchmaking' && status === 'paid')
        return { title: '牵线服务已开通', note: '付款已确认，牵线次数已到账，30天服务期已开始。完善资料并由平台安排主理人对接后可申请推荐；双方确认正式牵线后扣次。' };
    const feedback = {
        paid: { title: '会员已开通', note: '付款已确认，会员权益已经生效。' },
        closed: { title: '订单已关闭', note: '此订单已关闭，未开通会员权益。需要开通时可重新选择套餐。' },
        failed: { title: '支付未成功', note: '此订单支付失败，未开通会员权益。请查看订单结果后重试。' },
        refunded: { title: '订单已退款', note: '此订单已退款，到账情况请查看微信支付账单。会员状态以当前权益为准。' }
    };
    return feedback[status] || { title: '付款结果确认中', note: '暂未收到最终结果，请查询订单状态。确认前请勿重复付款。' };
}
function paymentNeedsReview(order) {
    return !!order && order.status === 'paid' && order.fulfillmentStatus === 'requires_review';
}
function orderPlanText(order) {
    return `${order.planTitle || '会员套餐'}${Number.isFinite(order.amountFen) ? ` · ¥${(order.amountFen / 100).toFixed(2)}` : ''}`;
}
const REVIEW_FEEDBACK = {
    title: '已付款，待人工处理',
    note: '付款已确认，但会员服务关系发生变更，权益尚未开通。请联系主理人核查处理，勿重复付款。'
};
Page({
    _membershipScope: '',
    _membershipUnloaded: false,
    _overviewRequestSerial: 0,
    _resumableCheckout: null,
    _submittedVirtualPaymentAttempts: [],
    _nativeSuccessOrderNo: '',
    _activeOrderPayment: null,
    data: {
        loading: true,
        refreshing: false,
        phoneAuthorizing: false,
        paymentStarting: false,
        paymentRestricted: false,
        confirming: false,
        overview: EMPTY_OVERVIEW,
        activeProductType: 'vip',
        activePayment: EMPTY_OVERVIEW.payment,
        benefits: MEMBERSHIP_BENEFITS,
        matchmakingPackages: [],
        hasMatchmakingService: false,
        matchmakingReady: false,
        matchmakingProgress: null,
        matchmakingProgressTitle: '',
        matchmakingRemainingCount: 0,
        matchmakingEarliestExpiry: '',
        canContactMatchmaker: false,
        matchmakingReadinessText: '',
        plans: [],
        selectedPlanCode: '',
        statusTitle: '会员权益',
        expiryText: '',
        paymentActionText: '微信支付暂不可用',
        paymentTestNotice: '',
        onlineCheckout: false,
        lastOrderId: '',
        orderTitle: '',
        orderNote: '',
        orderStatus: '',
        orderChecking: false,
        orderCanResume: false,
        orderRequiresReview: false,
        orderPlanText: '',
        activationOrderPending: false,
        errorText: ''
    },
    onLoad(options) {
        if (options.type === 'matchmaking')
            this.setData({ activeProductType: 'matchmaking' });
    },
    async switchProduct(e) {
        const type = String(e.currentTarget.dataset.type || '');
        if (!['vip', 'matchmaking'].includes(type) || type === this.data.activeProductType)
            return;
        if (this.data.paymentStarting || this.data.confirming || this.data.orderChecking || this.data.orderRequiresReview
            || (this.data.lastOrderId && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus))) {
            wx.showToast({ title: '请先确认当前订单结果', icon: 'none' });
            return;
        }
        this.setData({ activeProductType: type, selectedPlanCode: '', plans: [], onlineCheckout: false });
        await this.loadOverview();
    },
    openPrivileges(e) {
        const requestedType = e ? String(e.currentTarget.dataset.type || '') : '';
        const type = requestedType || this.data.activeProductType;
        wx.navigateTo({ url: `/pages/user/vip-privileges?type=${type === 'matchmaking' ? 'matchmaking' : 'vip'}` });
    },
    onShow() {
        this._membershipUnloaded = false;
        return this.loadOverview();
    },
    onPullDownRefresh() {
        return this.loadOverview({ pullDown: true });
    },
    onUnload() {
        this._membershipUnloaded = true;
        this._overviewRequestSerial += 1;
        if (this.data.confirming)
            wx.hideLoading();
    },
    isMembershipSessionCurrent(scope) {
        return !!scope && !this._membershipUnloaded && this._membershipScope === scope && (0, page_session_1.pageSessionScope)() === scope;
    },
    assertMembershipSession(scope) {
        if (!this.isMembershipSessionCurrent(scope))
            throw new Error('会员会话已变化，请重新进入');
    },
    async loadOverview(options = {}) {
        if (this._membershipUnloaded)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._membershipScope) {
            if (this.data.confirming)
                wx.hideLoading();
            this._membershipScope = scope;
            this._resumableCheckout = null;
            this._submittedVirtualPaymentAttempts = [];
            this._nativeSuccessOrderNo = '';
            this._activeOrderPayment = null;
            this.setData({ overview: EMPTY_OVERVIEW, plans: [], onlineCheckout: false, selectedPlanCode: '',
                lastOrderId: '', orderTitle: '', orderNote: '', orderStatus: '', orderChecking: false, orderCanResume: false,
                orderPlanText: '', activationOrderPending: false, orderRequiresReview: false, paymentStarting: false, paymentRestricted: false, confirming: false, phoneAuthorizing: false,
                paymentTestNotice: '',
                matchmakingPackages: [], hasMatchmakingService: false, matchmakingReady: false, matchmakingReadinessText: '',
                matchmakingProgress: null, matchmakingProgressTitle: '', matchmakingRemainingCount: 0, matchmakingEarliestExpiry: '', canContactMatchmaker: false });
        }
        if (!scope)
            return;
        const requestSerial = ++this._overviewRequestSerial;
        const isCurrent = () => this.isMembershipSessionCurrent(scope) && requestSerial === this._overviewRequestSerial;
        if (options.pullDown)
            this.setData({ refreshing: true });
        else
            this.setData({ loading: true });
        try {
            const overview = await member_1.memberApi.membershipOverview();
            if (!isCurrent())
                return;
            const pendingOrder = overview.pendingOrder;
            if (pendingOrder?.productType === 'matchmaker') {
                this.setData({ overview });
                this.restoreActivationOrder(pendingOrder);
                return;
            }
            if (this.data.activationOrderPending) {
                this.setData({ activationOrderPending: false, lastOrderId: '', orderTitle: '', orderNote: '', orderStatus: '', orderPlanText: '', orderCanResume: false });
            }
            const activeProductType = pendingOrder ? productType(pendingOrder) : this.data.activeProductType;
            const payment = paymentFor(overview, activeProductType);
            const plans = planViews(overview, activeProductType, payment);
            const matchmakingPackages = (overview.matchmakingPackages || []).map(item => ({ ...item,
                expiryText: dateExpiryText(item.expireAt),
                statusText: ({ active: '服务中', expired: '已到期', exhausted: '已用完', refunded: '已退款' })[item.status] || '状态待确认' }));
            const hasMatchmakingService = matchmakingPackages.some(item => item.status === 'active' && item.remainingCount > 0);
            const progress = matchmakingProgress(overview);
            const nextStep = matchmakingNextStep(progress);
            const matchmakingReady = progress.status === 'ready';
            const selectedPlanCode = plans.some(plan => plan.planCode === this.data.selectedPlanCode)
                ? this.data.selectedPlanCode
                : (plans[0] ? plans[0].planCode : '');
            const testSnapshot = pendingOrder || plans.find(plan => plan.planCode === selectedPlanCode);
            const requiresReview = paymentNeedsReview(overview.pendingOrder) || this.data.orderRequiresReview;
            this.setData({
                overview,
                activeProductType,
                activePayment: payment,
                matchmakingPackages,
                hasMatchmakingService,
                matchmakingReady,
                matchmakingProgress: progress,
                matchmakingProgressTitle: nextStep.title,
                matchmakingReadinessText: nextStep.note,
                matchmakingRemainingCount: progress.remainingCount,
                matchmakingEarliestExpiry: progress.earliestExpireAt ? dateExpiryText(progress.earliestExpireAt) : '有效期待确认',
                canContactMatchmaker: progress.assigned,
                plans,
                selectedPlanCode,
                paymentTestNotice: payment.testMode ? paymentTestNotice(testSnapshot) : '',
                onlineCheckout: !requiresReview && plans.length > 0 && payment.provider === 'virtual' && (payment.available || payment.reason === 'phone_required'),
                statusTitle: requiresReview ? REVIEW_FEEDBACK.title : (payment.reason === 'payment_test_completed' ? '支付测试已完成'
                    : (payment.testMode ? '微信支付沙箱测试' : activeProductType === 'matchmaking' ? '人工牵线服务'
                        : (overview.isPremiumMember ? '会员权益已开通' : '开通会员权益'))),
                expiryText: requiresReview ? '付款已确认，会员权益待核查' : (payment.testMode && !overview.isPremiumMember
                    ? paymentTestNotice(testSnapshot) : activeProductType === 'matchmaking'
                    ? (hasMatchmakingService ? '查看服务次数，继续申请牵线' : '主理人协助推荐与沟通，按次数提供服务') : expiryText(overview)),
                paymentActionText: requiresReview ? REVIEW_FEEDBACK.title : (payment.available
                    ? (payment.testMode ? paymentTestActionText(testSnapshot) : activeProductType === 'matchmaking' ? (hasMatchmakingService ? '再购买人工牵线' : '购买人工牵线')
                        : (overview.isPremiumMember ? '微信支付续费' : '微信支付开通会员'))
                    : paymentReasonText(payment.reason)),
                errorText: ''
            });
            if (overview.pendingOrder && !this.data.paymentStarting && !this.data.confirming && !this.data.orderChecking) {
                await this.restorePaymentOrder(overview.pendingOrder, overview.pendingOrderPayment || payment, scope, requestSerial);
            }
        }
        catch (err) {
            if (!isCurrent())
                return;
            console.warn('load membership overview failed', err);
            this.setData({ errorText: '会员信息暂时无法加载，请稍后重试。', onlineCheckout: false });
        }
        finally {
            if (isCurrent()) {
                this.setData({ loading: false, refreshing: false });
                if (options.pullDown)
                    wx.stopPullDownRefresh();
            }
        }
    },
    async restorePaymentOrder(order, payment, scope, requestSerial) {
        const isCurrent = () => this.isMembershipSessionCurrent(scope) && requestSerial === this._overviewRequestSerial;
        if (!isCurrent())
            return;
        if (order.productType === 'matchmaker') {
            this.restoreActivationOrder(order);
            return;
        }
        if (!order.outTradeNo || Number(order.userId) !== Number(getApp().globalData.user?.id)) {
            throw new Error('待确认订单与当前账号不一致');
        }
        (0, payment_response_1.assertPaymentQueryResponse)({ order }, order.outTradeNo);
        if (!['pending', 'confirming'].includes(order.status) && !paymentNeedsReview(order)) {
            throw new Error('待确认订单状态无效');
        }
        this._activeOrderPayment = payment;
        this._resumableCheckout = paymentNeedsReview(order) || payment.provider !== 'virtual' || order.paymentProvider === 'jsapi'
            || payment.reason === 'retired_plan_query_required'
            ? null : { order, payment };
        this.setData({ activeProductType: productType(order), activePayment: payment,
            paymentTestNotice: payment.testMode ? paymentTestNotice(order) : '',
            ...(payment.testMode ? { statusTitle: '微信支付沙箱测试',
                paymentActionText: payment.available ? paymentTestActionText(order) : paymentReasonText(payment.reason),
                expiryText: this.data.overview.isPremiumMember ? this.data.expiryText : paymentTestNotice(order) } : {}),
            plans: planViews(this.data.overview, productType(order), payment), selectedPlanCode: order.productType ? order.planCode : this.data.selectedPlanCode,
            lastOrderId: order.outTradeNo, orderStatus: order.status, orderPlanText: orderPlanText(order),
            orderCanResume: false, orderRequiresReview: paymentNeedsReview(order),
            onlineCheckout: payment.reason === 'retired_plan_query_required' ? false : this.data.onlineCheckout,
            orderTitle: paymentNeedsReview(order) ? REVIEW_FEEDBACK.title : '正在恢复原订单',
            orderNote: paymentNeedsReview(order) ? REVIEW_FEEDBACK.note : '正在核对上一笔订单结果，确认前请勿重复付款。' });
        if (paymentNeedsReview(order)) {
            await this.showOrderResult(order, false, scope);
            return;
        }
        this.setData({ confirming: true, orderChecking: true });
        try {
            const result = await this.queryPaymentOrder(order.outTradeNo, scope);
            if (!isCurrent() || this.data.lastOrderId !== order.outTradeNo)
                return;
            await this.showOrderResult(result, false, scope);
        }
        catch (error) {
            if (!isCurrent() || this.data.lastOrderId !== order.outTradeNo)
                return;
            this.setData({ orderStatus: 'confirming', orderTitle: '订单状态暂未确认', orderCanResume: false,
                orderNote: '原订单尚未核实，请稍后查询订单状态。确认结果前请勿重复付款。' });
            console.warn('restore membership order failed', error);
        }
        finally {
            if (this.isMembershipSessionCurrent(scope) && this.data.lastOrderId === order.outTradeNo) {
                this.setData({ confirming: false, orderChecking: false });
            }
        }
    },
    restoreActivationOrder(order) {
        if (!order.outTradeNo || Number(order.userId) !== Number(getApp().globalData.user?.id)) {
            throw new Error('主理人订单与当前账号不一致');
        }
        (0, payment_response_1.assertPaymentQueryResponse)({ order }, order.outTradeNo);
        this._resumableCheckout = null;
        this._activeOrderPayment = null;
        this.setData({ activationOrderPending: true, onlineCheckout: false, plans: [], selectedPlanCode: '',
            lastOrderId: order.outTradeNo, orderStatus: order.status, orderCanResume: false, orderRequiresReview: false,
            statusTitle: '主理人开通订单待处理', expiryText: '请先查看主理人开通订单，确认结果前勿重复付款。',
            orderTitle: '主理人开通订单', orderPlanText: `${order.planTitle || '主理人长期方案'} · ¥${(order.amountFen / 100).toFixed(2)}`,
            orderNote: '此订单用于开通主理人工作台，长期有效。请进入主理人开通页查询或继续原订单。' });
    },
    openActivation() {
        if (!this.isMembershipSessionCurrent((0, page_session_1.pageSessionScope)()))
            return;
        wx.navigateTo({ url: '/pages/matchmaker/activation' });
    },
    selectPlan(e) {
        const planCode = String(e.currentTarget.dataset.code || '');
        if (!planCode || this.data.paymentStarting || this.data.confirming || this.data.orderCanResume || this.data.orderRequiresReview
            || (this.data.lastOrderId && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus)))
            return;
        this.setData({ selectedPlanCode: planCode });
        this.updatePaymentTestCopy();
    },
    onPlanChange(e) {
        if (this.data.paymentStarting || this.data.confirming || this.data.orderCanResume || this.data.orderRequiresReview
            || (this.data.lastOrderId && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus)))
            return;
        if (this.data.plans.some(plan => plan.planCode === e.detail.value)) {
            this.setData({ selectedPlanCode: e.detail.value });
            this.updatePaymentTestCopy();
        }
    },
    updatePaymentTestCopy() {
        if (!this.data.activePayment.testMode)
            return;
        const selectedPlan = this.data.plans.find(plan => plan.planCode === this.data.selectedPlanCode);
        this.setData({ paymentTestNotice: paymentTestNotice(selectedPlan),
            paymentActionText: this.data.activePayment.available ? paymentTestActionText(selectedPlan) : paymentReasonText(this.data.activePayment.reason),
            expiryText: this.data.overview.isPremiumMember ? this.data.expiryText : paymentTestNotice(selectedPlan) });
    },
    async authorizePhone(e) {
        const scope = (0, page_session_1.pageSessionScope)();
        if (this.data.phoneAuthorizing || !this.isMembershipSessionCurrent(scope))
            return;
        const detail = e.detail;
        const code = (0, payment_response_1.paymentRecord)(detail) && typeof detail.code === 'string' ? detail.code : '';
        if (!code) {
            wx.showToast({ title: '未授权手机号', icon: 'none' });
            return;
        }
        this.setData({ phoneAuthorizing: true });
        try {
            await (0, auth_1.bindWechatPhone)(code);
            if (!this.isMembershipSessionCurrent(scope))
                return;
            wx.showToast({ title: '手机号已授权' });
            await this.loadOverview();
        }
        catch (err) {
            if (this.isMembershipSessionCurrent(scope))
                console.warn('bind wechat phone failed', err);
        }
        finally {
            if (this.isMembershipSessionCurrent(scope))
                this.setData({ phoneAuthorizing: false });
        }
    },
    async contactMatchmaker() {
        const scope = (0, page_session_1.pageSessionScope)();
        const isCurrent = () => !!scope && !this._membershipUnloaded && (0, page_session_1.pageSessionScope)() === scope;
        if (!isCurrent())
            return;
        if (!this.data.canContactMatchmaker) {
            wx.showModal({ title: '平台安排主理人', content: '购买后完善资料，平台会安排主理人对接，可在牵线服务中查看进度。', showCancel: false });
            return;
        }
        try {
            const matchmakerUserId = this.data.matchmakingProgress?.matchmakerUserId;
            const conversations = await chat_1.chatApi.listConversations({ page: 1, pageSize: 100 });
            if (!isCurrent())
                return;
            const serviceConversation = conversations.list.find(item => item.conversationType === 'member_matchmaker'
                && (!matchmakerUserId || item.peer?.id === matchmakerUserId));
            if (serviceConversation) {
                wx.navigateTo({ url: `/pages/user/chat?id=${serviceConversation.id}` });
                return;
            }
            if (matchmakerUserId) {
                const conversation = await chat_1.chatApi.getOrCreateConversation({ targetUserId: matchmakerUserId });
                if (isCurrent())
                    wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` });
                return;
            }
        }
        catch (err) {
            if (!isCurrent())
                return;
            console.warn('load principal conversation failed', err);
        }
        wx.showToast({ title: '服务会话暂不可用，请稍后重试', icon: 'none' });
    },
    completeMatchmakingProfile() { wx.switchTab({ url: '/pages/user/profile' }); },
    confirmAdditionalMatchmakingPurchase(scope) {
        return new Promise(resolve => wx.showModal({ title: '确认新增牵线套餐',
            content: `你当前剩余 ${this.data.matchmakingRemainingCount} 次牵线权益，最早${this.data.matchmakingEarliestExpiry}。新购套餐从本次付款确认起独立有效30天，原套餐到期时间不会延长。是否继续购买？`,
            confirmText: '继续购买', cancelText: '先使用权益',
            success: result => resolve(result.confirm && this.isMembershipSessionCurrent(scope)), fail: () => resolve(false) }));
    },
    async callPaymentHTTP(payment, path, outTradeNo, scope) {
        this.assertMembershipSession(scope);
        const cloud = wx.cloud;
        if (!isPaymentHTTPCloud(cloud))
            throw new Error('当前微信基础库不支持支付函数调用');
        if (!payment.functionName || !path || !path.startsWith('/') || !outTradeNo)
            throw new Error('支付服务暂不可用');
        const result = await new Promise((resolve, reject) => {
            cloud.callHTTPFunction({
                name: payment.functionName,
                path,
                method: 'POST',
                config: { env: getApp().globalData.env },
                header: { 'Content-Type': 'application/json' },
                data: { outTradeNo },
                success: resolve,
                fail: reject
            });
        });
        this.assertMembershipSession(scope);
        return result;
    },
    wechatLoginCode() {
        return new Promise((resolve, reject) => {
            wx.login({
                success: res => (res.code ? resolve(res.code) : reject(new Error('微信登录态获取失败，请重试'))),
                fail: () => reject(new Error('微信登录态获取失败，请重试'))
            });
        });
    },
    async callPaymentFunction(checkout, requestScope) {
        const scope = requestScope || this._membershipScope;
        if (checkout.order.productType === 'matchmaker')
            throw new Error('请从主理人开通页继续该订单');
        if (checkout.payment.provider !== 'virtual' || checkout.order.paymentProvider === 'jsapi') {
            throw new Error(productType(checkout.order) === 'matchmaking'
                ? '人工牵线虚拟支付服务暂不可用，请联系主理人' : '会员虚拟支付服务暂不可用，请联系主理人');
        }
        const loginCode = await this.wechatLoginCode();
        this.assertMembershipSession(scope);
        // Each checkout requests a fresh platform attempt. Only the business order
        // is retained for recovery; native payment parameters are never cached.
        const result = await member_1.memberApi.virtualPaymentCheckout(checkout.order.outTradeNo, loginCode);
        this.assertMembershipSession(scope);
        (0, payment_response_1.assertPaymentQueryResponse)({ order: result.order }, checkout.order.outTradeNo);
        if (result.order.paymentProvider === 'jsapi' || productType(result.order) !== productType(checkout.order)
            || result.order.planCode !== checkout.order.planCode || result.order.amountFen !== checkout.order.amountFen) {
            throw new Error('虚拟支付订单与原套餐不一致，请查询原订单');
        }
        if (typeof result.paymentAttemptNo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_|*@-]{7,31}$/.test(result.paymentAttemptNo)) {
            throw new Error('虚拟支付未返回有效的付款尝试编号');
        }
        return (0, payment_response_1.virtualPaymentParamsFrom)(result, {
            paymentAttemptNo: result.paymentAttemptNo,
            productId: checkout.order.planCode,
            goodsPrice: checkout.order.amountFen
        });
    },
    requestPayment(params) {
        return new Promise((resolve, reject) => {
            const validated = (0, payment_response_1.virtualPaymentParamsFrom)(params);
            const signed = JSON.parse(validated.signData);
            const support = virtualPaymentSupport();
            if (support.platform === 'ios') {
                if (!support.supported)
                    throw new Error(virtualPaymentSupportMessage(support.reason));
                if (signed.env !== 0)
                    throw new Error('苹果支付暂不支持当前测试商品，请联系工作人员。');
                if (signed.goodsPrice < 100)
                    throw new Error('苹果支付金额不能低于 1 元，请选择其他套餐。');
            }
            const payer = wx.requestVirtualPayment;
            if (typeof payer !== 'function') {
                reject(new Error('当前微信版本不支持虚拟支付，请更新微信后重试'));
                return;
            }
            const paymentAttemptNo = signed.outTradeNo;
            if (this._submittedVirtualPaymentAttempts.includes(paymentAttemptNo)) {
                reject(new Error('付款尝试编号已使用，请查询订单后重试'));
                return;
            }
            this._submittedVirtualPaymentAttempts.push(paymentAttemptNo);
            payer({
                mode: validated.mode,
                signData: validated.signData,
                paySig: validated.paySig,
                signature: validated.signature,
                success: () => resolve(),
                fail: reject
            });
        });
    },
    async queryPaymentOrder(outTradeNo, requestScope) {
        const scope = requestScope || this._membershipScope;
        this.assertMembershipSession(scope);
        const payment = this._activeOrderPayment || this.data.activePayment;
        let queryState = {};
        // 虚拟支付通道直接查询 hlApi；旧通道走支付函数 HTTP 路由。
        if (payment.provider === 'virtual') {
            const response = await member_1.memberApi.virtualPaymentQuery(outTradeNo);
            this.assertMembershipSession(scope);
            queryState = (0, payment_response_1.assertPaymentQueryResponse)(response, outTradeNo);
        }
        else if (payment.queryPath !== undefined) {
            // Undefined belongs to the legacy API. An empty new query path cannot
            // silently fall back to potentially stale local order state.
            const response = await this.callPaymentHTTP(payment, payment.queryPath, outTradeNo, scope);
            queryState = (0, payment_response_1.assertPaymentQueryResponse)(response, outTradeNo);
        }
        this.assertMembershipSession(scope);
        const order = await member_1.memberApi.membershipOrder(outTradeNo);
        this.assertMembershipSession(scope);
        // The authoritative local state may change between the two reads. A
        // conflicting unpaid provider result cannot reopen a completed order.
        (0, payment_response_1.assertPaymentQueryResponse)({ order, ...queryState }, outTradeNo);
        return { ...order, ...queryState };
    },
    async pollPaymentOrder(outTradeNo, requestScope) {
        const scope = requestScope || this._membershipScope;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                const order = await this.queryPaymentOrder(outTradeNo, scope);
                // A successful native callback can precede the provider's paid state.
                // Keep waiting on NOTPAY/absence within this bounded confirmation loop.
                if (['paid', 'closed', 'failed', 'refunded'].includes(order.status) || attempt === 7)
                    return order;
            }
            catch (error) {
                if (!(0, payment_response_1.isTransientPaymentQueryError)(error) || attempt === 7)
                    throw error;
            }
            await wait(1500);
            this.assertMembershipSession(scope);
        }
        throw new Error('付款结果暂未确认，请稍后查询订单');
    },
    async showOrderResult(order, modal = false, requestScope) {
        const scope = requestScope || this._membershipScope;
        if (!this.isMembershipSessionCurrent(scope))
            return;
        if (order.productType === 'matchmaker') {
            this.restoreActivationOrder(order);
            return;
        }
        const unpaid = (order.tradeState === 'NOTPAY' || order.providerOrderAbsent === true) && ['pending', 'confirming'].includes(order.status);
        const requiresReview = paymentNeedsReview(order);
        const postSuccessPending = this._nativeSuccessOrderNo === order.outTradeNo && ['pending', 'confirming'].includes(order.status);
        const payment = this._activeOrderPayment || this.data.activePayment;
        const canResume = unpaid && !postSuccessPending && payment.available && payment.provider === 'virtual'
            && order.paymentProvider !== 'jsapi' && !this.data.paymentRestricted
            && !!this._resumableCheckout && this._resumableCheckout.order.outTradeNo === order.outTradeNo;
        const feedback = requiresReview ? REVIEW_FEEDBACK : (postSuccessPending
            ? { title: '付款结果确认中', note: '付款已提交，暂未完成结果确认。请稍后查询订单，勿重复付款。' }
            : unpaid
                ? { title: '订单尚未付款', note: this.data.paymentRestricted
                        ? '微信查询显示该订单尚未付款。当前支付能力受限，请联系主理人处理。'
                        : (canResume ? (order.providerOrderAbsent ? '原订单尚未提交至微信支付，可继续支付原订单。' : '微信查询显示该订单尚未付款，可继续支付原订单。')
                            : payment.reason === 'retired_plan_query_required'
                                ? paymentReasonText(payment.reason)
                                : payment.provider === 'jsapi' || order.paymentProvider === 'jsapi'
                                    ? '原支付通道已停止新付款，请查询原订单或联系主理人处理。'
                                    : '微信查询显示该订单尚未付款。请查询订单状态后再操作。') }
                : orderFeedback(order.status, payment.testMode || order.planCode === 'hl_payment_probe', productType(order), order));
        if (postSuccessPending || order.tradeState === 'NOTPAY' || order.tradeState === 'USERPAYING' || order.providerOrderAbsent)
            this.setData({ orderCanResume: canResume });
        if (['paid', 'closed', 'failed', 'refunded'].includes(order.status)) {
            this._resumableCheckout = null;
            if (this._nativeSuccessOrderNo === order.outTradeNo)
                this._nativeSuccessOrderNo = '';
            this.setData({ orderCanResume: false });
        }
        this.setData({ orderTitle: feedback.title, orderNote: feedback.note, orderStatus: postSuccessPending ? 'confirming' : order.status, orderRequiresReview: requiresReview });
        if (requiresReview)
            this.setData({ onlineCheckout: false, statusTitle: feedback.title,
                expiryText: '付款已确认，会员权益待核查', paymentActionText: feedback.title });
        if ((order.status === 'paid' && !requiresReview) || order.status === 'refunded')
            await this.loadOverview();
        if (modal && this.isMembershipSessionCurrent(scope))
            wx.showModal({ title: feedback.title, content: feedback.note, showCancel: false });
    },
    async refreshOrderStatus() {
        if (this.data.activationOrderPending) {
            this.openActivation();
            return;
        }
        if (!this.data.lastOrderId || this.data.orderChecking || this.data.confirming)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        if (!this.isMembershipSessionCurrent(scope))
            return;
        const orderId = this.data.lastOrderId;
        this.setData({ orderChecking: true });
        try {
            const order = await this.queryPaymentOrder(orderId, scope);
            if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== orderId)
                return;
            await this.showOrderResult(order, false, scope);
        }
        catch (error) {
            if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== orderId)
                return;
            if (!this.data.orderRequiresReview)
                this.setData({ orderStatus: 'confirming', orderTitle: this.data.paymentRestricted ? '微信支付能力受限' : '付款结果确认中', orderCanResume: false,
                    orderNote: '暂时无法查询订单，请稍后重试。确认结果前请勿重复付款。' });
            console.warn('refresh membership order failed', error);
        }
        finally {
            if (this.isMembershipSessionCurrent(scope))
                this.setData({ orderChecking: false });
        }
    },
    async startPayment() {
        if (this.data.activationOrderPending) {
            this.openActivation();
            return;
        }
        if (this.data.paymentStarting || this.data.confirming)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        if (!this.isMembershipSessionCurrent(scope))
            return;
        if (this.data.errorText) {
            wx.showToast({ title: '请先重新加载会员信息', icon: 'none' });
            return;
        }
        if (this.data.orderRequiresReview) {
            wx.showToast({ title: '已付款，请联系主理人核查处理', icon: 'none' });
            return;
        }
        if (this.data.paymentRestricted) {
            wx.showToast({ title: '微信支付能力受限，请联系主理人', icon: 'none' });
            return;
        }
        if (this.data.lastOrderId && !this.data.orderCanResume && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus)) {
            await this.refreshOrderStatus();
            if (this.isMembershipSessionCurrent(scope))
                wx.showToast({ title: '请查看上一笔订单结果', icon: 'none' });
            return;
        }
        const activeProductType = this.data.activeProductType;
        const payment = this.data.activePayment;
        if (!payment.available) {
            wx.showToast({ title: paymentReasonText(payment.reason), icon: 'none' });
            return;
        }
        if (!this.data.overview.phoneBound) {
            wx.showToast({ title: '授权微信手机号后可付款', icon: 'none' });
            return;
        }
        if (payment.provider !== 'virtual') {
            wx.showToast({ title: activeProductType === 'matchmaking'
                    ? '人工牵线虚拟支付服务暂不可用，请联系主理人' : '会员虚拟支付服务暂不可用，请联系主理人', icon: 'none' });
            return;
        }
        if (!this.data.selectedPlanCode) {
            wx.showToast({ title: '请选择会员套餐', icon: 'none' });
            return;
        }
        if (payment.provider === 'virtual') {
            const support = virtualPaymentSupport();
            if (!support.supported) {
                wx.showModal({
                    title: '暂无法支付',
                    content: virtualPaymentSupportMessage(support.reason),
                    showCancel: false
                });
                return;
            }
            if (support.platform === 'ios') {
                const selectedPlan = this.data.plans.find(plan => plan.planCode === this.data.selectedPlanCode);
                const amountFen = selectedPlan?.amountFen;
                const reason = payment.testMode ? '苹果支付暂不支持当前测试商品，请联系工作人员。'
                    : (!Number.isSafeInteger(amountFen) || Number(amountFen) < 100)
                        ? '苹果支付金额不能低于 1 元，请选择其他套餐。' : '';
                if (reason) {
                    wx.showModal({ title: '暂无法支付', content: reason, showCancel: false });
                    return;
                }
            }
        }
        this.setData({ paymentStarting: true });
        let paymentRequested = false;
        let paymentCompleted = false;
        let nativePaymentRestricted = false;
        let nativePaymentCancelled = false;
        try {
            const resuming = !!this.data.orderCanResume && !!this._resumableCheckout;
            if (!resuming && activeProductType === 'matchmaking' && this.data.hasMatchmakingService
                && !await this.confirmAdditionalMatchmakingPurchase(scope))
                return;
            if (!this.isMembershipSessionCurrent(scope))
                return;
            const checkout = resuming && this._resumableCheckout
                ? this._resumableCheckout : await member_1.memberApi.createMembershipOrder(this.data.selectedPlanCode);
            if (!this.isMembershipSessionCurrent(scope))
                return;
            if (checkout.order.productType === 'matchmaker') {
                this.restoreActivationOrder(checkout.order);
                return;
            }
            if (Number(checkout.order.userId) !== Number(getApp().globalData.user?.id))
                throw new Error('订单与当前账号不一致');
            (0, payment_response_1.assertPaymentQueryResponse)({ order: checkout.order }, checkout.order.outTradeNo);
            this._activeOrderPayment = checkout.payment;
            this._resumableCheckout = checkout.payment.provider === 'virtual' && checkout.order.paymentProvider !== 'jsapi' ? checkout : null;
            this.setData({ lastOrderId: checkout.order.outTradeNo, orderStatus: 'pending', orderTitle: '订单待支付',
                orderNote: '请在微信支付中完成付款。', orderPlanText: orderPlanText(checkout.order), orderCanResume: !!this._resumableCheckout });
            if (checkout.reused || checkout.recoveryRequired || paymentNeedsReview(checkout.order)) {
                this._resumableCheckout = null;
                this.setData({ paymentStarting: false, orderCanResume: false });
                await this.restorePaymentOrder(checkout.order, checkout.payment, scope, this._overviewRequestSerial);
                return;
            }
            const selectedPlan = this.data.plans.find(plan => plan.planCode === this.data.selectedPlanCode);
            if (productType(checkout.order) !== activeProductType
                || (!resuming && (checkout.order.planCode !== this.data.selectedPlanCode
                    || (selectedPlan && (checkout.order.durationDays !== selectedPlan.durationDays
                        || (Number.isFinite(selectedPlan.amountFen) && checkout.order.amountFen !== selectedPlan.amountFen)
                        || (activeProductType === 'matchmaking' && checkout.order.serviceCount !== selectedPlan.serviceCount)))))) {
                this._resumableCheckout = null;
                throw new Error('订单与当前选择的服务不一致，请查询原订单');
            }
            const paymentParams = await this.callPaymentFunction(checkout, scope);
            if (!this.isMembershipSessionCurrent(scope))
                return;
            paymentRequested = true;
            this.setData({ orderCanResume: false });
            try {
                await this.requestPayment(paymentParams);
            }
            catch (error) {
                // Only the native payment call can establish this restriction. An
                // order API or query permission failure must not disable payment.
                nativePaymentRestricted = isNativePaymentRestricted(error);
                nativePaymentCancelled = isNativePaymentCancelled(error);
                throw error;
            }
            paymentCompleted = true;
            if (!this.isMembershipSessionCurrent(scope))
                return;
            this._nativeSuccessOrderNo = checkout.order.outTradeNo;
            this.setData({ paymentStarting: false, confirming: true, orderStatus: 'confirming',
                orderTitle: '付款结果确认中', orderNote: '正在核对微信支付结果，请勿重复付款。' });
            wx.showLoading({ title: '正在确认付款', mask: true });
            const order = await this.pollPaymentOrder(checkout.order.outTradeNo, scope);
            if (!this.isMembershipSessionCurrent(scope))
                return;
            wx.hideLoading();
            await this.showOrderResult(order, true, scope);
        }
        catch (err) {
            if (!this.isMembershipSessionCurrent(scope))
                return;
            wx.hideLoading();
            const error = err && typeof err === 'object' ? err : {};
            const message = String(error.errMsg || error.message || err);
            if (nativePaymentRestricted) {
                this.setData({ paymentRestricted: true, orderCanResume: false, orderTitle: '微信支付能力受限',
                    orderNote: '当前小程序暂无法发起微信付款，请联系主理人处理。仍可查询已有订单，请勿重复尝试付款。' });
                wx.showToast({ title: '微信支付能力受限，请联系主理人', icon: 'none', duration: 3000 });
            }
            else if (nativePaymentCancelled) {
                // A cancellation callback is not payment evidence. Query the original
                // order before allowing another attempt, including after a late pay.
                const outTradeNo = this.data.lastOrderId;
                this.setData({ paymentStarting: false, confirming: true, orderStatus: 'confirming',
                    orderTitle: '正在确认订单状态', orderCanResume: false,
                    orderNote: '你已关闭微信支付，正在查询原订单结果。确认前请勿重复付款。' });
                try {
                    const order = await this.queryPaymentOrder(outTradeNo, scope);
                    if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== outTradeNo)
                        return;
                    await this.showOrderResult(order, false, scope);
                }
                catch (queryError) {
                    if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== outTradeNo)
                        return;
                    this.setData({ orderStatus: 'confirming', orderTitle: '订单状态暂未确认', orderCanResume: false,
                        orderNote: '暂时无法查询原订单，请稍后查询订单状态。确认结果前请勿重复付款。' });
                    console.warn('query cancelled membership order failed', queryError);
                }
                if (this.isMembershipSessionCurrent(scope) && this.data.lastOrderId === outTradeNo) {
                    wx.navigateTo({ url: `/pages/user/payment-cancel?outTradeNo=${encodeURIComponent(outTradeNo)}` });
                }
            }
            else {
                if (paymentCompleted) {
                    const transient = (0, payment_response_1.isTransientPaymentQueryError)(err);
                    this.setData({ orderCanResume: false, orderStatus: 'confirming',
                        orderTitle: transient ? '付款结果确认中' : '订单核验未通过',
                        orderNote: transient ? '付款已提交，暂未完成结果确认。请稍后查询订单，勿重复付款。'
                            : '付款已提交，但订单结果未能通过核验。请查询订单或联系主理人，勿重复付款。' });
                    wx.showToast({ title: transient ? '付款已提交，请稍后查询结果' : '订单核验未通过，请查询订单', icon: 'none', duration: 3000 });
                }
                else {
                    if (this.data.lastOrderId)
                        this.setData(!paymentRequested && this._resumableCheckout
                            ? { orderCanResume: true, orderTitle: '支付尚未开始', orderNote: '未能拉起微信支付，请继续支付原订单，不会重新创建订单。' }
                            : { orderCanResume: false, orderStatus: 'confirming', orderTitle: '付款结果确认中', orderNote: '本次支付未能完成确认，请查询订单状态后再操作。' });
                    wx.showToast({ title: message || '支付未完成', icon: 'none', duration: 3000 });
                }
            }
            console.warn('membership payment failed', err);
        }
        finally {
            if (this.isMembershipSessionCurrent(scope))
                this.setData({ paymentStarting: false, confirming: false });
        }
    }
});
