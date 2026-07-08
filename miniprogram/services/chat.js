"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatApi = void 0;
const api_1 = require("./api");
exports.chatApi = {
    listConversations(data = {}) {
        return (0, api_1.request)('/chat/conversations', { data });
    },
    getOrCreateConversation(data) {
        return (0, api_1.request)('/chat/conversations', { method: 'POST', data });
    },
    listMessages(id, data = {}) {
        return (0, api_1.request)(`/chat/conversations/${id}/messages`, { data });
    },
    sendMessage(id, content) {
        return (0, api_1.request)(`/chat/conversations/${id}/messages`, {
            method: 'POST',
            data: { content, contentType: 'text' }
        });
    },
    sendVoiceMessage(id, data) {
        return (0, api_1.request)(`/chat/conversations/${id}/messages`, {
            method: 'POST',
            data: { ...data, contentType: 'voice' }
        });
    },
    markRead(id) {
        return (0, api_1.request)(`/chat/conversations/${id}/read`, { method: 'POST' });
    }
};
