"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salonApi = void 0;
const api_1 = require("./api");
exports.salonApi = {
    list(data) {
        return (0, api_1.request)('/salon/events', { data });
    },
    detail(id) {
        return (0, api_1.request)(`/salon/events/${id}`);
    },
    shareCard(id, showError = false) {
        return (0, api_1.request)(`/salon/events/${id}/share-card`, { showError });
    },
    register(id) {
        return (0, api_1.request)(`/salon/events/${id}/register`, { method: 'POST' });
    },
    cancelRegistration(id) {
        return (0, api_1.request)(`/salon/events/${id}/register`, { method: 'DELETE' });
    },
    myRegistrations(data) {
        return (0, api_1.request)('/salon/my-registrations', { data });
    },
    myEvents(data) {
        return (0, api_1.request)('/salon/my-events', { data });
    },
    create(data) {
        return (0, api_1.request)('/salon/events', { method: 'POST', data });
    },
    update(id, data) {
        return (0, api_1.request)(`/salon/events/${id}`, { method: 'PUT', data });
    },
    cancelEvent(id) {
        return (0, api_1.request)(`/salon/events/${id}/cancel`, { method: 'PUT' });
    },
    invite(id, userIds, all = false) {
        return (0, api_1.request)(`/salon/events/${id}/invite`, { method: 'POST', data: { userIds, all } });
    }
};
