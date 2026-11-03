"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingPreferencesApi = void 0;
const api_1 = require("./api");
exports.matchingPreferencesApi = {
    get() {
        return (0, api_1.request)('/user/matching-preferences', { showError: false });
    },
    save(preferences) {
        return (0, api_1.request)('/user/matching-preferences', {
            method: 'PUT', data: { preferences }, showError: false
        });
    }
};
