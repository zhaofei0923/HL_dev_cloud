"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messagesController = void 0;
const matchmaker_workspace_1 = require("../../utils/matchmaker-workspace");
const chat_1 = require("../../services/chat");
const matchmaker_page_cache_1 = require("../../utils/matchmaker-page-cache");
const MESSAGE_PAGE_KEY = 'pages/matchmaker/messages';
const MESSAGES_TTL_MS = 10 * 1000;
function accessDenied(err) {
    return [401, 40100, 40102, 403, 40301].indexOf(Number(err && err.code)) >= 0;
}
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
    return type === 'member_pair' ? '配对沟通' : '会员服务';
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
exports.messagesController = (0, matchmaker_workspace_1.defineMatchmakerController)({
    _messagesScope: '',
    _messagesRevision: 0,
    _messagesLoadedAt: 0,
    _messagesInitialized: false,
    _messagesGeneration: 0,
    _messagesPromise: null,
    _messagesUnloaded: false,
    _refreshOnShow: false,
    data: {
        list: [],
        total: 0,
        loading: false,
        errorNote: '',
        emptyTitle: '暂无消息',
        emptyNote: '会员添加成功或互推开通后，这里会出现会话。'
    },
    onShow() {
        this._messagesUnloaded = false;
        if (!this.synchronizeSession())
            return;
        if (!this._messagesInitialized) {
            const snapshot = (0, matchmaker_page_cache_1.readMatchmakerPageSnapshot)(MESSAGE_PAGE_KEY);
            if (snapshot) {
                this.setData({ ...snapshot.data, loading: false });
                this._messagesLoadedAt = snapshot.loadedAt;
                this._messagesInitialized = true;
            }
        }
        const force = this._refreshOnShow;
        this._refreshOnShow = false;
        return this.load(force);
    },
    onPullDownRefresh() {
        return this.load(true).finally(() => wx.stopPullDownRefresh());
    },
    synchronizeSession() {
        const scope = (0, matchmaker_page_cache_1.matchmakerPageSessionScope)();
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        if (scope !== this._messagesScope || revision !== this._messagesRevision) {
            this._messagesScope = scope;
            this._messagesRevision = revision;
            this._messagesLoadedAt = 0;
            this._messagesInitialized = false;
            this._messagesGeneration += 1;
            this._messagesPromise = null;
            this.setData({
                list: [], total: 0, loading: false, errorNote: '',
                emptyTitle: '暂无消息', emptyNote: '会员添加成功或互推开通后，这里会出现会话。'
            });
        }
        if (scope)
            return scope;
        wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    rememberMessages() {
        if (!this._messagesInitialized || this._messagesScope !== (0, matchmaker_page_cache_1.matchmakerPageSessionScope)()
            || this._messagesRevision !== (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)())
            return;
        (0, matchmaker_page_cache_1.writeMatchmakerPageSnapshot)(MESSAGE_PAGE_KEY, {
            list: this.data.list.map(row => ({
                id: row.id, peerName: row.peerName, peerAvatar: row.peerAvatar,
                preview: row.preview, timeText: row.timeText, unreadText: row.unreadText,
                typeText: row.typeText, hasUnread: row.hasUnread
            })),
            total: this.data.total, errorNote: this.data.errorNote,
            emptyTitle: this.data.emptyTitle, emptyNote: this.data.emptyNote
        }, this._messagesLoadedAt);
    },
    load(force = true) {
        const scope = this.synchronizeSession();
        if (!scope || this._messagesUnloaded)
            return Promise.resolve();
        if (force === false && this._messagesPromise)
            return this._messagesPromise;
        if (force === false && this._messagesInitialized
            && Date.now() - this._messagesLoadedAt < MESSAGES_TTL_MS)
            return Promise.resolve();
        const generation = ++this._messagesGeneration;
        const revision = this._messagesRevision;
        const isCurrent = () => !this._messagesUnloaded && generation === this._messagesGeneration
            && scope === (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() && revision === (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        this.setData({ loading: force !== false || !this._messagesInitialized, errorNote: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const result = await chat_1.chatApi.listConversations({ page: 1, pageSize: 50 });
                if (!isCurrent())
                    return;
                const list = (result.list || []).map(normalizeConversation);
                this._messagesLoadedAt = Date.now();
                this._messagesInitialized = true;
                this.setData({
                    list, total: Number(result.total || list.length || 0),
                    emptyTitle: '暂无消息', emptyNote: '会员添加成功或互推开通后，这里会出现会话。'
                });
                this.rememberMessages();
            }
            catch (err) {
                if (!isCurrent())
                    return;
                console.warn('load matchmaker conversations failed', err);
                if (accessDenied(err)) {
                    (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
                    this.synchronizeSession();
                    this.setData({ list: [], total: 0, errorNote: '请重新核验登录或主理人权限。' });
                }
                else {
                    this._messagesLoadedAt = 0;
                    this.setData({ errorNote: '消息暂未更新成功，下拉刷新或点击重试。' });
                    if (!this._messagesInitialized)
                        this.setData({
                            emptyTitle: '消息暂不可用', emptyNote: '请稍后刷新重试。'
                        });
                    this.rememberMessages();
                }
            }
            finally {
                if (isCurrent()) {
                    this._messagesPromise = null;
                    this.setData({ loading: false });
                }
            }
        });
        this._messagesPromise = promise;
        return promise;
    },
    onUnload() {
        this.rememberMessages();
        this._messagesUnloaded = true;
        this._messagesGeneration += 1;
        this._messagesPromise = null;
    },
    openChat(e) {
        const id = String(e.currentTarget.dataset.id || '');
        if (!id)
            return;
        this._refreshOnShow = true;
        wx.navigateTo({ url: `/pages/matchmaker/chat?id=${id}` });
    },
    goMembers() {
        wx.redirectTo({ url: '/pages/matchmaker/members' });
    }
});
