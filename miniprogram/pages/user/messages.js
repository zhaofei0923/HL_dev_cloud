"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_1 = require("../../services/chat");
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
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
function compactStrings(values) {
    return values.map(value => String(value || '').trim()).filter(Boolean);
}
function normalizeLikedMeItem(row, index) {
    const locked = row.locked === true || row.blurred === true;
    if (locked) {
        const tags = compactStrings(row.tags || []).slice(0, 3);
        return {
            id: String(row.id || `locked_${index + 1}`),
            userId: 0,
            displayName: row.displayName || `第 ${index + 1} 位喜欢你的人`,
            avatarUrl: '',
            coverUrl: '',
            metaText: row.metaText || tags.join(' · ') || '有会员对你感兴趣',
            hint: row.hint || '开通后查看完整资料',
            tags: tags.length ? tags : ['资料完整'],
            locked: true,
            canViewDetail: false,
            coverToneClass: `tone-${Number(row.coverTone || index) % 4}`,
            raw: null
        };
    }
    const profile = (0, member_format_1.normalizeMemberProfile)(row);
    const tags = compactStrings(profile.highlightTags || row.highlightTags || row.tags || []).slice(0, 3);
    return {
        id: String(profile.id || row.id || row.userId || index),
        userId: Number(row.userId || 0),
        displayName: profile.displayName || row.displayName || '优质会员',
        avatarUrl: profile.avatarUrl || (0, member_format_1.defaultAvatar)(row),
        coverUrl: profile.coverUrl || profile.avatarUrl || (0, member_format_1.defaultAvatar)(row),
        metaText: profile.metaText || profile.workText || '资料已完善',
        hint: row.hint || (row.likedAt ? `${formatTime(row.likedAt)} 喜欢了你` : '喜欢了你'),
        tags: tags.length ? tags : compactStrings([profile.cityText, profile.occupationText]).slice(0, 3),
        locked: false,
        canViewDetail: row.canViewDetail !== false,
        coverToneClass: '',
        raw: row
    };
}
Page({
    data: {
        list: [],
        likedMeList: [],
        total: 0,
        likedMeTotal: 0,
        likedMePreviewCount: 0,
        isPremiumMember: false,
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
            const [conversationResult, likedMeResult] = await Promise.all([
                chat_1.chatApi.listConversations({ page: 1, pageSize: 50 }),
                member_1.memberApi.likedMe({ page: 1, pageSize: 12 })
            ]);
            const list = (conversationResult.list || []).map(normalizeConversation);
            const likedMeList = (likedMeResult.list || []).map(normalizeLikedMeItem);
            this.setData({
                list,
                likedMeList,
                total: Number(conversationResult.total || list.length || 0),
                likedMeTotal: Number(likedMeResult.total || likedMeList.length || 0),
                likedMePreviewCount: Number(likedMeResult.previewCount || likedMeList.length || 0),
                isPremiumMember: likedMeResult.isPremiumMember === true,
                emptyTitle: '暂无消息',
                emptyNote: '和红娘建立服务关系、互相关注，或由红娘发起配对后，这里会出现会话。'
            });
        }
        catch (err) {
            console.warn('load user conversations failed', err);
            this.setData({
                list: [],
                likedMeList: [],
                total: 0,
                likedMeTotal: 0,
                likedMePreviewCount: 0,
                isPremiumMember: false,
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
    openLikedMember(e) {
        const id = String(e.currentTarget.dataset.id || '');
        if (!id)
            return;
        const item = this.data.likedMeList.find(row => row.id === id);
        if (!item)
            return;
        if (item.locked || !this.data.isPremiumMember || !item.canViewDetail) {
            this.promptOpenMembership();
            return;
        }
        if (item.raw)
            wx.setStorageSync('selectedUserMember', item.raw);
        wx.navigateTo({ url: `/pages/user/member-detail?id=${encodeURIComponent(item.id)}` });
    },
    promptOpenMembership() {
        wx.showModal({
            title: '开通会员',
            content: '开通会员后可查看谁喜欢你的完整资料。当前版本请联系红娘，或在我的页面完善资料后开通服务。',
            confirmText: '去我的',
            cancelText: '稍后',
            success(res) {
                if (res.confirm)
                    wx.redirectTo({ url: '/pages/user/profile' });
            }
        });
    },
    goMembers() {
        wx.redirectTo({ url: '/pages/user/members' });
    }
});
