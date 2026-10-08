"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salonApi = void 0;
const api_1 = require("./api");
function activitySessionReturn(id) {
    return `/pages/index/index?register=1&eventId=${encodeURIComponent(String(id))}`;
}
exports.salonApi = {
    list(data) {
        return (0, api_1.request)('/salon/events', { data });
    },
    detail(id) {
        return (0, api_1.request)(`/salon/events/${id}`, { unauthorizedRedirect: activitySessionReturn(id) });
    },
    shareCard(id, showError = false) {
        return (0, api_1.request)(`/salon/events/${id}/share-card`, { showError, unauthorizedRedirect: activitySessionReturn(id) });
    },
    register(id) {
        return (0, api_1.request)(`/salon/events/${id}/register`, { method: 'POST', data: { participantProfileVisible: true }, unauthorizedRedirect: activitySessionReturn(id) });
    },
    participants(id, page = 1) {
        return (0, api_1.request)(`/salon/events/${id}/participants`, { data: { page, pageSize: 20 }, unauthorizedRedirect: activitySessionReturn(id) });
    },
    participantProfile(id, userId) {
        return (0, api_1.request)(`/salon/events/${id}/participants/${userId}`, { unauthorizedRedirect: activitySessionReturn(id) });
    },
    cancelRegistration(id) {
        return (0, api_1.request)(`/salon/events/${id}/register`, { method: 'DELETE', unauthorizedRedirect: activitySessionReturn(id) });
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
