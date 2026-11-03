"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.relationshipApi = void 0;
const api_1 = require("./api");
exports.relationshipApi = {
    overview() {
        return (0, api_1.request)('/member/relationship-status', { showError: false });
    },
    setStatus(status) {
        return (0, api_1.request)('/member/relationship-status', { method: 'POST', data: { status }, showError: false });
    },
    invite(targetUserId) {
        return (0, api_1.request)('/member/relationship-invitations', { method: 'POST', data: { targetUserId }, showError: false });
    },
    respond(id, accept) {
        return (0, api_1.request)(`/member/relationship-invitations/${id}/respond`, { method: 'POST', data: { accept }, showError: false });
    },
    unmatch(targetUserId, reason) {
        return (0, api_1.request)('/member/unmatch', { method: 'POST', data: { targetUserId, reason }, showError: false });
    }
};
