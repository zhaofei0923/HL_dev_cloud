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
    requestMatchmaker(data) {
        return (0, api_1.request)('/member/matchmaker-requests', { method: 'POST', data });
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
