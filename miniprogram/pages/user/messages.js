"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_1 = require("../../services/chat");
const messages_1 = require("../../services/messages");
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
function formatTime(value) {
    if (!value)
        return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return '';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
}
function typeText(type) {
    return type === 'member_pair' ? '配对沟通' : '红娘服务';
}
function normalizeConversation(row) {
    const peer = row.peer || { id: 0, nickname: row.title || '会话', avatarUrl: '' };
    return {
        ...row,
        peerName: peer.nickname || row.title || '会话',
        peerAvatar: peer.avatarUrl || '/assets/members/avatar-female-1.png',
        preview: row.lastMessageContent || '暂无消息，进入后开始沟通',
        timeText: formatTime(row.lastMessageAt || row.updatedAt),
        unreadText: row.unreadCount > 99 ? '99+' : String(row.unreadCount || ''),
        typeText: typeText(row.conversationType)
    };
}
function notificationTypeText(type) {
    if (type === 'member_favorite')
        return '关注提醒';
    return '站内通知';
}
function normalizeNotification(row) {
    const sender = row.sender || { id: row.senderId || 0, nickname: '会员', avatarUrl: '' };
    const actionText = row.conversationId || row.canChat
        ? '去聊天'
        : (row.messageType === 'member_favorite' ? '互关后可聊' : (row.hasUnread ? '标记已读' : '已读'));
    return {
        ...row,
        senderName: sender.nickname || '会员',
        senderAvatar: sender.avatarUrl || '/assets/members/avatar-female-1.png',
        preview: row.content || '你收到一条新通知',
        timeText: formatTime(row.createdAt),
        typeText: notificationTypeText(row.messageType),
        actionText
    };
}
Page({
    data: {
        list: [],
        notifications: [],
        total: 0,
        notificationTotal: 0,
        notificationUnreadCount: 0,
        loading: false,
        emptyTitle: '暂无消息',
        emptyNote: '和红娘建立服务关系，或由红娘发起配对后，这里会出现会话。'
    },
    onShow() {
        const token = wx.getStorageSync('token');
        if (!token) {
            wx.redirectTo({ url: '/pages/index/index' });
            return;
        }
        this.load();
    },
    onPullDownRefresh() {
        this.load().finally(() => wx.stopPullDownRefresh());
    },
    async load() {
        this.setData({ loading: true });
        try {
            const [conversationResult, notificationResult] = await Promise.all([
                chat_1.chatApi.listConversations({ page: 1, pageSize: 50 }),
                messages_1.messageApi.list({ page: 1, pageSize: 20 })
            ]);
            const list = (conversationResult.list || []).map(normalizeConversation);
            const notifications = (notificationResult.list || []).map(normalizeNotification);
            this.setData({
                list,
                notifications,
                total: Number(conversationResult.total || list.length || 0),
                notificationTotal: Number(notificationResult.total || notifications.length || 0),
                notificationUnreadCount: Number(notificationResult.unreadCount || 0),
                emptyTitle: '暂无消息',
                emptyNote: '和红娘建立服务关系、互相关注，或由红娘发起配对后，这里会出现会话。'
            });
        }
        catch (err) {
            console.warn('load user conversations failed', err);
            this.setData({
                list: [],
                notifications: [],
                total: 0,
                notificationTotal: 0,
                notificationUnreadCount: 0,
                emptyTitle: '消息暂不可用',
                emptyNote: '请确认云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    openChat(e) {
        const id = String(e.currentTarget.dataset.id || '');
        if (!id)
            return;
        wx.navigateTo({ url: `/pages/user/chat?id=${id}` });
    },
    async openNotification(e) {
        const id = Number(e.currentTarget.dataset.id || 0);
        if (!id)
            return;
        const current = this.data.notifications.find(item => Number(item.id) === id);
        let updated = current || null;
        try {
            const marked = normalizeNotification(await messages_1.messageApi.markRead(id));
            updated = marked;
            const notifications = this.data.notifications.map(item => (Number(item.id) === id ? marked : item));
            this.setData({
                notifications,
                notificationUnreadCount: notifications.filter(item => item.hasUnread).length
            });
        }
        catch (err) {
            console.warn('mark notification read failed', err);
        }
        const conversationId = updated && updated.conversationId ? String(updated.conversationId) : '';
        if (conversationId) {
            wx.navigateTo({ url: `/pages/user/chat?id=${conversationId}` });
            return;
        }
        wx.showToast({ title: updated && updated.messageType === 'member_favorite' ? '互相关注后可聊天' : '已标记已读', icon: 'none' });
    },
    goMembers() {
        wx.redirectTo({ url: '/pages/user/members' });
    }
});
