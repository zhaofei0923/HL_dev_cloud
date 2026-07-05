"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memberApi = void 0;
const api_1 = require("./api");
exports.memberApi = {
    list(data) {
        return (0, api_1.request)('/member/list', { data });
    },
    resources(data) {
        return (0, api_1.request)('/member/resources', { data });
    },
    showcase(data) {
        return (0, api_1.request)('/member/showcase', { data });
    },
    gifts() {
        return (0, api_1.request)('/member/gifts');
    },
    interact(data) {
        return (0, api_1.request)('/member/interactions', { method: 'POST', data });
    },
    sendGift(data) {
        return (0, api_1.request)('/member/gifts/send', { method: 'POST', data });
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
