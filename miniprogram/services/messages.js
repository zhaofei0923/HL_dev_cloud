"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageApi = void 0;
const api_1 = require("./api");
exports.messageApi = {
    list(data = {}) {
        return (0, api_1.request)('/messages', { data });
    },
    markRead(id) {
        return (0, api_1.request)(`/messages/${id}/read`, { method: 'POST' });
    }
};
