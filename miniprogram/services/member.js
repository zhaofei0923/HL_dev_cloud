"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memberApi = void 0;
const api_1 = require("./api");
exports.memberApi = {
    certifications(showError = false) {
        return (0, api_1.request)('/user/certifications', { showError });
    },
    applyCertification(data, showError = false) {
        return (0, api_1.request)('/user/certification-requests', { method: 'POST', data, showError });
    },
    stagingCertificationMaterials(kind, showError = false) {
        return (0, api_1.request)('/user/certification-materials', { data: { kind }, showError });
    },
    uploadCertificationMaterial(data, showError = false) {
        return (0, api_1.request)('/user/certification-materials', { method: 'POST', data, showError });
    },
    removeCertificationMaterial(id, showError = false) {
        return (0, api_1.request)(`/user/certification-materials/${encodeURIComponent(id)}`, { method: 'DELETE', showError });
    },
    certificationMaterial(id, showError = false) {
        return (0, api_1.request)(`/user/certification-materials/${encodeURIComponent(id)}`, { showError });
    },
    list(data) {
        return (0, api_1.request)('/member/list', { data });
    },
    inviteOptions(data) {
        return (0, api_1.request)('/member/invite-options', { data });
    },
    resources(data) {
        return (0, api_1.request)('/member/resources', { data });
    },
    async showcase(data) {
        const result = await (0, api_1.request)('/member/showcase', { data });
        if (data && data.category && data.category !== 'recommend' && result.category !== data.category) {
            throw new Error('该分类暂不可用，请稍后重试');
        }
        return result;
    },
    showcaseDetail(id) {
        return (0, api_1.request)(`/member/showcase/${encodeURIComponent(String(id))}`, { showError: false });
    },
    likedMe(data) {
        return (0, api_1.request)('/member/liked-me', { data });
    },
    relationships(data) {
        return (0, api_1.request)('/member/relationships', { data });
    },
    membershipOverview() {
        return (0, api_1.request)('/member/membership-plans');
    },
    orders(page = 1, pageSize = 20) {
        return (0, api_1.request)('/member/orders', {
            data: { page, pageSize }, showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
        });
    },
    orderDetail(outTradeNo) {
        return (0, api_1.request)(`/member/orders/${encodeURIComponent(outTradeNo)}`, {
            showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
        });
    },
    vipOverview() {
        return (0, api_1.request)('/member/vip/overview', { showError: false });
    },
    privacy() {
        return (0, api_1.request)('/member/vip/privacy', { showError: false });
    },
    updatePrivacy(data) {
        return (0, api_1.request)('/member/vip/privacy', { method: 'POST', data });
    },
    visitors(data = {}) {
        return (0, api_1.request)('/member/vip/visitors', { data, showError: false });
    },
    recordVisit(targetUserId) {
        return (0, api_1.request)('/member/vip/visits', { method: 'POST', data: { targetUserId }, showError: false });
    },
    wechatExchanges() {
        return (0, api_1.request)('/member/vip/wechat-exchanges', { showError: false });
    },
    requestWechatExchange(data) {
        return (0, api_1.request)('/member/vip/wechat-exchanges', { method: 'POST', data });
    },
    respondWechatExchange(id, data) {
        return (0, api_1.request)(`/member/vip/wechat-exchanges/${encodeURIComponent(id)}/respond`, { method: 'POST', data });
    },
    wechatExchange(id) {
        return (0, api_1.request)(`/member/vip/wechat-exchanges/${encodeURIComponent(id)}`, { showError: false });
    },
    onlineSubscriptions() {
        return (0, api_1.request)('/member/vip/online-subscriptions', { showError: false });
    },
    subscribeOnline(data) {
        return (0, api_1.request)('/member/vip/online-subscriptions', { method: 'POST', data });
    },
    updatePresence() {
        return (0, api_1.request)('/member/vip/presence', { method: 'POST', data: {}, showError: false });
    },
    matchmakingPackages() {
        return (0, api_1.request)('/member/matchmaking/packages', { showError: false });
    },
    matchmakingReadiness(memberUserId) {
        return (0, api_1.request)('/member/matchmaking/readiness', { data: memberUserId ? { memberUserId } : {}, showError: false });
    },
    confirmMatchmakingReadiness(memberUserId, confirmed) {
        return (0, api_1.request)('/member/matchmaking/readiness', { method: 'POST', data: { memberUserId, confirmed } });
    },
    matchmakingRequests() {
        return (0, api_1.request)('/member/matchmaking/requests', { showError: false });
    },
    requestMatchmaking(data) {
        return (0, api_1.request)('/member/matchmaking/requests', { method: 'POST', data });
    },
    respondMatchmaking(id, data) {
        return (0, api_1.request)(`/member/matchmaking/requests/${encodeURIComponent(id)}/respond`, { method: 'POST', data });
    },
    approveMatchmaking(id) {
        return (0, api_1.request)(`/member/matchmaking/requests/${encodeURIComponent(id)}/approve`, { method: 'POST', data: {} });
    },
    cancelMatchmaking(id) {
        return (0, api_1.request)(`/member/matchmaking/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST', data: {} });
    },
    createMembershipOrder(planCode) {
        return (0, api_1.request)('/member/payment-orders', {
            method: 'POST',
            data: { planCode }
        });
    },
    membershipOrder(outTradeNo) {
        return (0, api_1.request)(`/member/payment-orders/${outTradeNo}`, {
            showError: false
        });
    },
    cancelPaymentOrder(outTradeNo) {
        return (0, api_1.request)(`/member/payment-orders/${encodeURIComponent(outTradeNo)}/cancel`, {
            method: 'POST', data: {}, showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
        });
    },
    virtualPaymentCheckout(outTradeNo, loginCode) {
        return (0, api_1.request)('/member/payment-virtual/checkout', {
            method: 'POST',
            data: { outTradeNo, loginCode }
        });
    },
    virtualPaymentQuery(outTradeNo) {
        return (0, api_1.request)('/member/payment-virtual/query', {
            method: 'POST',
            data: { outTradeNo },
            showError: false
        });
    },
    gifts(showError = true) {
        return (0, api_1.request)('/member/gifts', { showError });
    },
    interact(data, showError = true) {
        return (0, api_1.request)('/member/interactions', { method: 'POST', data, showError });
    },
    sendGift(data, showError = true) {
        return (0, api_1.request)('/member/gifts/send', { method: 'POST', data, showError });
    },
    resolveMatchmakerInvite(data) {
        return (0, api_1.request)('/member/matchmaker-invite/resolve', { data });
    },
    requestMatchmaker(data) {
        return (0, api_1.request)('/member/matchmaker-requests', { method: 'POST', data });
    },
    acceptMatchmakerInvite(data) {
        return (0, api_1.request)('/member/matchmaker-invite/accept', { method: 'POST', data });
    },
    referralCard(showError = false) {
        return (0, api_1.request)('/member/referral-card', { showError });
    },
    addManual(data) {
        return (0, api_1.request)('/member/manual', { method: 'POST', data });
    },
    createIdentityClaimInvite(id) {
        return (0, api_1.request)(`/member/${id}/identity-claim-invite`, { method: 'POST' });
    },
    detail(id) {
        return (0, api_1.request)(`/member/${id}`);
    },
    update(id, data) {
        return (0, api_1.request)(`/member/${id}`, { method: 'PUT', data });
    },
    remove(id) {
        return (0, api_1.request)(`/member/${id}`, { method: 'DELETE' });
    },
    recommend(data) {
        return (0, api_1.request)('/member/recommend', { method: 'POST', data });
    }
};
