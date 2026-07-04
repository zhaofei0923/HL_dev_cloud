"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_1 = require("../../services/chat");
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
function formatTime(value) {
    if (!value)
        return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return '';
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function normalizeMessage(row) {
    return {
        ...row,
        anchorId: `msg-${row.id}`,
        timeText: formatTime(row.createdAt),
        senderAvatar: (row.sender && row.sender.avatarUrl) || '/assets/members/avatar-female-1.png'
    };
}
Page({
    data: {
        id: '',
        conversation: null,
        messages: [],
        inputValue: '',
        scrollIntoView: '',
        loading: false,
        sending: false
    },
    onLoad(options) {
        this.setData({ id: String(options.id || '') });
        this.load();
    },
    onUnload() {
        if (this.data.id)
            chat_1.chatApi.markRead(this.data.id).catch(err => console.warn('mark user chat read failed', err));
    },
    async load() {
        if (!this.data.id)
            return;
        this.setData({ loading: true });
        try {
            const result = await chat_1.chatApi.listMessages(this.data.id, { page: 1, pageSize: 80 });
            const messages = (result.messages || []).map(normalizeMessage);
            const last = messages[messages.length - 1];
            this.setData({
                conversation: result.conversation,
                messages,
                scrollIntoView: last ? last.anchorId : ''
            });
            if (result.conversation && result.conversation.title) {
                wx.setNavigationBarTitle({ title: result.conversation.title.slice(0, 12) });
            }
        }
        catch (err) {
            console.warn('load user chat failed', err);
            wx.showToast({ title: '会话暂不可用', icon: 'none' });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onInput(e) {
        this.setData({ inputValue: e.detail.value });
    },
    async send() {
        const content = String(this.data.inputValue || '').trim();
        if (!content) {
            wx.showToast({ title: '请输入消息', icon: 'none' });
            return;
        }
        if (this.data.sending)
            return;
        this.setData({ sending: true });
        try {
            await chat_1.chatApi.sendMessage(this.data.id, content);
            this.setData({ inputValue: '' });
            await this.load();
        }
        catch (err) {
            console.warn('send user chat message failed', err);
        }
        finally {
            this.setData({ sending: false });
        }
    }
});
