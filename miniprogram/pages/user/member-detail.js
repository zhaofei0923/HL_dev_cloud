"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const chat_1 = require("../../services/chat");
const api_1 = require("../../services/api");
const member_format_1 = require("../../utils/member-format");
const member_certification_1 = require("../../utils/member-certification");
const page_session_1 = require("../../utils/page-session");
const showcase_cache_1 = require("../../utils/showcase-cache");
function publicMember(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : null;
}
Page({
    _detailGeneration: 0,
    _detailScope: '',
    _detailUnloaded: false,
    _detailLoadedAt: 0,
    _detailRefreshOnShow: false,
    data: {
        id: '',
        member: null,
        certificationRows: [],
        loading: false,
        chatStarting: false,
        favoriteLoading: false,
        isFavorite: false,
        chatAccess: 'unknown',
        loadError: '',
        unavailable: false
    },
    onLoad(options) {
        this._detailUnloaded = false;
        this.setData({ id: String(options.id || '') });
        this.load();
    },
    onShow() {
        const refresh = this._detailRefreshOnShow || (this._detailLoadedAt > 0 && Date.now() - this._detailLoadedAt >= showcase_cache_1.SHOWCASE_CACHE_TTL_MS);
        this._detailRefreshOnShow = false;
        if (this._detailScope !== (0, page_session_1.pageSessionScope)() || refresh)
            return this.load();
    },
    onHide() {
        this._detailRefreshOnShow = true;
    },
    onUnload() {
        this._detailUnloaded = true;
        this._detailGeneration += 1;
    },
    async load() {
        if (!this.data.id)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        this._detailScope = scope;
        this._detailLoadedAt = 0;
        const generation = ++this._detailGeneration;
        const isCurrent = () => !this._detailUnloaded && generation === this._detailGeneration && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ member: null, certificationRows: [], loading: !!scope, chatAccess: 'unknown',
            loadError: '', unavailable: false, isFavorite: false });
        if (!scope)
            return;
        try {
            const cached = publicMember(wx.getStorageSync('selectedUserMember'));
            if (cached && String(cached.id) === this.data.id && wx.getStorageSync('selectedUserMemberScope') === scope) {
                const preview = { ...cached };
                delete preview.financialAssetRange;
                this.setData({ member: (0, member_format_1.normalizeMemberProfile)(preview), certificationRows: (0, member_certification_1.publicCertificationRows)(preview) });
            }
            const row = await member_1.memberApi.showcaseDetail(this.data.id);
            if (!isCurrent())
                return;
            const state = publicMember(row.viewerState) || {};
            this.setData({ member: (0, member_format_1.normalizeMemberProfile)(row), certificationRows: (0, member_certification_1.publicCertificationRows)(row),
                isFavorite: state.isFavorite === true,
                chatAccess: ['allowed', 'membership_required', 'unavailable'].includes(String(state.chatAccess)) ? String(state.chatAccess) : 'unknown' });
            this._detailLoadedAt = Date.now();
        }
        catch (err) {
            if (!isCurrent())
                return;
            console.warn('load user member detail failed', err);
            const code = Number(err.code);
            const unavailable = [404, 40400, 403, 40300].includes(code) || /not found/i.test((0, api_1.apiErrorMessage)(err));
            this.setData({ member: null, certificationRows: [], unavailable,
                loadError: unavailable ? '该会员已暂停公开资料或暂不可查看，请返回推荐页。' : '暂时无法加载资料，请检查网络后重试。' });
        }
        finally {
            if (isCurrent())
                this.setData({ loading: false });
        }
    },
    goBack() {
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/user/members' }) });
    },
    goProfile() {
        wx.switchTab({ url: '/pages/user/profile' });
    },
    primaryAction() {
        if (this.data.loading || this.data.favoriteLoading || this.data.chatStarting)
            return;
        if (this.data.chatAccess === 'unknown')
            return this.load();
        if (this.data.chatAccess === 'allowed')
            return this.startChat();
        if (this.data.chatAccess === 'membership_required') {
            wx.navigateTo({ url: '/pages/user/membership' });
            return;
        }
        if (!this.data.isFavorite)
            return this.toggleFavorite();
    },
    async toggleFavorite() {
        const targetUserId = Number(this.data.member?.userId);
        if (!targetUserId || this.data.loading || this.data.favoriteLoading)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        const generation = this._detailGeneration;
        const isCurrent = () => !this._detailUnloaded && (0, page_session_1.pageSessionScope)() === scope && generation === this._detailGeneration;
        const active = !this.data.isFavorite;
        this.setData({ favoriteLoading: true });
        try {
            const response = await member_1.memberApi.interact({ targetUserId, targetMemberId: this.data.id, actionType: 'favorite', active }, false);
            if (!isCurrent())
                return;
            const savedActive = response?.viewerState?.isFavorite === true;
            (0, showcase_cache_1.applyShowcaseInteraction)(scope, { page: 1, pageSize: 50, keyword: '', city: '', gender: '' }, targetUserId, 'favorite', response.favoriteQuota, savedActive);
            (0, showcase_cache_1.invalidateShowcaseCategory)(scope, 'popularity');
            this.setData({ isFavorite: savedActive });
            wx.showToast({ title: savedActive ? '爱心已送出' : '爱心已撤回', icon: 'none' });
            await this.load();
        }
        catch (err) {
            if (isCurrent())
                wx.showToast({ title: (0, api_1.apiErrorMessage)(err) || '操作未完成，请重试', icon: 'none' });
        }
        finally {
            if (!this._detailUnloaded && (0, page_session_1.pageSessionScope)() === scope)
                this.setData({ favoriteLoading: false });
        }
    },
    async startChat() {
        if (this.data.chatAccess !== 'allowed' || this.data.loading)
            return;
        const member = this.data.member;
        const targetUserId = Number(member && member.userId ? member.userId : 0);
        const memberId = String(member && member.id ? member.id : '');
        if (!targetUserId && !/^\d+$/.test(memberId)) {
            wx.showToast({ title: '互相关注或配对后才能聊天', icon: 'none' });
            return;
        }
        if (this.data.chatStarting)
            return;
        const scope = (0, page_session_1.pageSessionScope)();
        this.setData({ chatStarting: true });
        try {
            const conversation = await chat_1.chatApi.getOrCreateConversation(targetUserId
                ? { targetUserId }
                : { targetMemberId: memberId });
            if (!this._detailUnloaded && (0, page_session_1.pageSessionScope)() === scope)
                wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` });
        }
        catch (err) {
            console.warn('start user chat failed', err);
        }
        finally {
            this.setData({ chatStarting: false });
        }
    }
});
