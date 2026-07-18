"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chat_1 = require("../../services/chat");
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
const EMPTY_COUNTS = { incoming: 0, mutual: 0 };
let conversationRequestSerial = 0;
let relationshipRequestSerial = 0;
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
    return type === 'member_pair' ? '配对沟通' : '主理人服务';
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
function normalizeRelationshipItem(row, index, kind) {
    const locked = row.locked === true || row.blurred === true;
    if (locked) {
        const tags = compactStrings(row.tags || []).slice(0, 3);
        return {
            id: String(row.id || `locked_${kind}_${index + 1}`),
            userId: 0,
            displayName: row.displayName || (kind === 'mutual'
                ? `第 ${index + 1} 位与你互相喜欢的人`
                : `第 ${index + 1} 位喜欢你的人`),
            avatarUrl: '',
            coverUrl: '',
            metaText: row.metaText || tags.join(' · ') || '有会员对你感兴趣',
            hint: row.hint || (kind === 'mutual' ? '你们已经互相喜欢' : '等待你的回应'),
            tags: tags.length ? tags : ['资料完整'],
            kind,
            locked: true,
            canViewDetail: false,
            canRespond: false,
            canChat: false,
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
        hint: kind === 'mutual'
            ? '你们已经互相喜欢'
            : (row.likedAt ? `${formatTime(row.likedAt)} 喜欢了你` : '喜欢了你'),
        tags: tags.length ? tags : compactStrings([profile.cityText, profile.occupationText]).slice(0, 3),
        kind,
        locked: false,
        canViewDetail: row.canViewDetail !== false,
        canRespond: kind === 'incoming' && row.canRespond !== false,
        canChat: kind === 'mutual' && row.canChat !== false,
        coverToneClass: '',
        raw: row
    };
}
Page({
    data: {
        list: [],
        total: 0,
        conversationLoading: false,
        relationshipType: 'incoming',
        relationshipItems: [],
        relationshipCounts: { ...EMPTY_COUNTS },
        relationshipTotal: 0,
        relationshipPage: 1,
        relationshipPageSize: 2,
        relationshipExpanded: false,
        relationshipHasMore: false,
        relationshipLoading: false,
        relationshipError: '',
        relationshipInitialized: false,
        isPremiumMember: false,
        respondingId: '',
        chatStartingId: '',
        emptyTitle: '暂无消息',
        emptyNote: '和主理人建立服务关系，或由主理人发起配对后，这里会出现会话。'
    },
    onShow() {
        const token = wx.getStorageSync('token');
        if (!token) {
            wx.redirectTo({ url: '/pages/index/index' });
            return;
        }
        const initial = !this.data.relationshipInitialized;
        const type = initial ? 'incoming' : this.data.relationshipType;
        this.loadConversations({ force: true });
        this.loadRelationships(type, {
            expanded: this.data.relationshipExpanded,
            allowAutoSelect: initial,
            force: true
        });
    },
    onPullDownRefresh() {
        Promise.allSettled([
            this.loadConversations({ force: true }),
            this.loadRelationships(this.data.relationshipType, {
                expanded: this.data.relationshipExpanded,
                force: true
            })
        ]).finally(() => wx.stopPullDownRefresh());
    },
    async loadConversations(options = {}) {
        if (this.data.conversationLoading && !options.force)
            return;
        const requestId = ++conversationRequestSerial;
        this.setData({ conversationLoading: true });
        try {
            const result = await chat_1.chatApi.listConversations({ page: 1, pageSize: 50 });
            if (requestId !== conversationRequestSerial)
                return;
            const list = (result.list || []).map(normalizeConversation);
            this.setData({
                list,
                total: Number(result.total || list.length || 0),
                emptyTitle: '暂无消息',
                emptyNote: '和主理人建立服务关系、开通互选聊天，或由主理人发起配对后，这里会出现会话。'
            });
        }
        catch (err) {
            if (requestId !== conversationRequestSerial)
                return;
            console.warn('load user conversations failed', err);
            this.setData({
                emptyTitle: '消息暂不可用',
                emptyNote: '请稍后下拉刷新重试。'
            });
        }
        finally {
            if (requestId === conversationRequestSerial)
                this.setData({ conversationLoading: false });
        }
    },
    async loadRelationships(type, options = {}) {
        if (this.data.relationshipLoading && !options.force)
            return;
        const requestId = ++relationshipRequestSerial;
        const expanded = options.expanded === true;
        const append = options.append === true;
        const page = append ? this.data.relationshipPage + 1 : 1;
        const pageSize = expanded ? 12 : 2;
        this.setData({
            relationshipLoading: true,
            relationshipError: '',
            relationshipType: type,
            relationshipExpanded: expanded
        });
        try {
            const result = await member_1.memberApi.relationships({
                type,
                page,
                pageSize
            });
            if (requestId !== relationshipRequestSerial)
                return;
            const counts = result.counts || { ...EMPTY_COUNTS };
            if (options.allowAutoSelect && type === 'incoming' && counts.incoming === 0 && counts.mutual > 0) {
                this.setData({
                    relationshipCounts: counts,
                    isPremiumMember: result.isPremiumMember === true,
                    relationshipInitialized: true,
                    relationshipLoading: false
                });
                await this.loadRelationships('mutual', { expanded: false, force: true });
                return;
            }
            const startIndex = append ? this.data.relationshipItems.length : 0;
            const rows = (result.list || []).map((row, index) => normalizeRelationshipItem(row, startIndex + index, type));
            const items = append ? [...this.data.relationshipItems, ...rows] : rows;
            const total = Number(result.total || 0);
            const isPremiumMember = result.isPremiumMember === true;
            this.setData({
                relationshipItems: items,
                relationshipCounts: counts,
                relationshipTotal: total,
                relationshipPage: Number(result.page || page),
                relationshipPageSize: Number(result.pageSize || pageSize),
                relationshipHasMore: items.length < total,
                relationshipInitialized: true,
                relationshipExpanded: isPremiumMember && expanded,
                isPremiumMember
            });
        }
        catch (err) {
            if (requestId !== relationshipRequestSerial)
                return;
            console.warn('load member relationships failed', err);
            this.setData({
                relationshipError: '心动关系暂时无法加载，请稍后重试。',
                relationshipInitialized: true
            });
        }
        finally {
            if (requestId === relationshipRequestSerial)
                this.setData({ relationshipLoading: false });
        }
    },
    switchRelationship(e) {
        if (this.data.relationshipLoading)
            return;
        const value = String(e.currentTarget.dataset.type || '');
        if (value !== 'incoming' && value !== 'mutual')
            return;
        const type = value;
        if (type === this.data.relationshipType && !this.data.relationshipError)
            return;
        this.setData({
            relationshipType: type,
            relationshipItems: [],
            relationshipTotal: Number(this.data.relationshipCounts[type] || 0),
            relationshipExpanded: false,
            relationshipHasMore: false
        });
        this.loadRelationships(type);
    },
    retryRelationships() {
        this.loadRelationships(this.data.relationshipType, {
            expanded: this.data.relationshipExpanded
        });
    },
    toggleRelationshipExpanded() {
        if (this.data.relationshipLoading)
            return;
        if (!this.data.isPremiumMember) {
            this.promptOpenMembership();
            return;
        }
        const expanded = !this.data.relationshipExpanded;
        this.setData({ relationshipItems: [], relationshipHasMore: false });
        this.loadRelationships(this.data.relationshipType, { expanded });
    },
    loadMoreRelationships() {
        if (!this.data.relationshipExpanded || !this.data.relationshipHasMore)
            return;
        this.loadRelationships(this.data.relationshipType, {
            expanded: true,
            append: true
        });
    },
    findRelationship(id) {
        return this.data.relationshipItems.find(row => row.id === id);
    },
    openRelationshipMember(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const item = this.findRelationship(id);
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
    async respondFavorite(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const item = this.findRelationship(id);
        if (!item || !item.userId || this.data.respondingId)
            return;
        if (!this.data.isPremiumMember || !item.canRespond) {
            this.promptOpenMembership();
            return;
        }
        this.setData({ respondingId: id });
        try {
            const result = await member_1.memberApi.interact({
                targetUserId: item.userId,
                actionType: 'favorite',
                active: true
            });
            wx.showToast({
                title: result && result.canChat
                    ? '已互相喜欢，可以聊天'
                    : '已回应爱心',
                icon: 'none'
            });
            this.setData({
                relationshipType: 'mutual',
                relationshipItems: [],
                relationshipExpanded: false,
                relationshipHasMore: false
            });
            await this.loadRelationships('mutual', { force: true });
            await this.loadConversations({ force: true });
        }
        catch (err) {
            console.warn('respond relationship favorite failed', err);
        }
        finally {
            this.setData({ respondingId: '' });
        }
    },
    async openRelationshipChat(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const item = this.findRelationship(id);
        if (!item || !item.userId || this.data.chatStartingId)
            return;
        if (!this.data.isPremiumMember || !item.canChat) {
            this.promptOpenMembership();
            return;
        }
        this.setData({ chatStartingId: id });
        try {
            const conversation = await chat_1.chatApi.getOrCreateConversation({
                targetUserId: item.userId
            });
            wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` });
        }
        catch (err) {
            console.warn('open mutual relationship chat failed', err);
        }
        finally {
            this.setData({ chatStartingId: '' });
        }
    },
    openChat(e) {
        const id = String(e.currentTarget.dataset.id || '');
        if (!id)
            return;
        wx.navigateTo({ url: `/pages/user/chat?id=${id}` });
    },
    promptOpenMembership() {
        wx.navigateTo({ url: '/pages/user/membership' });
    },
    goMembers() {
        wx.redirectTo({ url: '/pages/user/members' });
    }
});
