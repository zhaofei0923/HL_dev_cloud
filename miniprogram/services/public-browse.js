"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicBrowseApi = void 0;
const api_1 = require("./api");
exports.publicBrowseApi = {
    salons() {
        return (0, api_1.request)('/public/salon/events', {
            auth: false, showError: false, preserveSessionOnUnauthorized: true,
            data: { page: 1, pageSize: 3, period: 'upcoming' }
        });
    },
    plans() {
        return (0, api_1.request)('/public/service-plans', {
            auth: false, showError: false, preserveSessionOnUnauthorized: true
        });
    }
};
