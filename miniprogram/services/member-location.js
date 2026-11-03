"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memberLocationApi = void 0;
const api_1 = require("./api");
exports.memberLocationApi = {
    read() { return (0, api_1.request)('/user/location', { showError: false }); },
    save(data) {
        return (0, api_1.request)('/user/location', { method: 'PUT', data, showError: false });
    }
};
