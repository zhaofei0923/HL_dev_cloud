"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memberApi = void 0;
const api_1 = require("./api");
exports.memberApi = {
    list(data) {
        return (0, api_1.request)('/member/list', { data });
    },
    inviteOptions(data) {
        return (0, api_1.request)('/member/invite-options', { data });
    },
    resources(data) {
        return (0, api_1.request)('/member/resources', { data });
    },
    showcase(data) {
        return (0, api_1.request)('/member/showcase', { data });
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
