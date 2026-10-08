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
    hidden(page = 1) {
        return (0, api_1.request)('/member/hidden', {
            data: { page, pageSize: 20 }, showError: false
        });
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
