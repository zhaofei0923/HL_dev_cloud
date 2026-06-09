"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchmakerApi = void 0;
const api_1 = require("./api");
exports.matchmakerApi = {
    apply() {
        return (0, api_1.request)('/matchmaker/apply', { method: 'POST' });
    },
    dashboard(showError = true) {
        return (0, api_1.request)('/matchmaker/dashboard', { showError });
    },
    memberRequests(data, showError = true) {
        return (0, api_1.request)('/matchmaker/member-requests', { data, showError });
    },
    approveMemberRequest(id) {
        return (0, api_1.request)(`/matchmaker/member-requests/${id}/approve`, { method: 'POST' });
    },
    rejectMemberRequest(id, remark = '') {
        return (0, api_1.request)(`/matchmaker/member-requests/${id}/reject`, { method: 'POST', data: { remark } });
    }
};
