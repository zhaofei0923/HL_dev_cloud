"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
const member_1 = require("../../services/member");
const api_1 = require("../../services/api");
const invite_1 = require("../../utils/invite");
const page_session_1 = require("../../utils/page-session");
function sourceText(source) {
    if (source === 'scan')
        return '扫码添加';
    if (source === 'share' || source === 'matchmakerShare' || source === 'memberShare')
        return '微信注册链接';
    if (source === 'salonShare' || source === 'memberSalonShare')
        return '沙龙邀请';
    if (source === 'inviteCode')
        return '邀请码';
    return '手动输入';
}
function queryValue(raw, key) {
    const match = raw.match(new RegExp(`[?&#]?${key}=([^&#]+)`, 'i'));
    return match ? safeDecode(match[1]) : '';
}
function safeDecode(value) {
    try {
        return decodeURIComponent(String(value || ''));
    }
    catch (err) {
        return '';
    }
}
function eventIdFrom(value) {
    const id = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}
function isAutoInviteSource(source) {
    return ['share', 'matchmakerShare', 'memberShare', 'salonShare', 'memberSalonShare'].includes(source);
}
function errorMessage(err) {
    return String((err && (err.message || err.errMsg)) || err || '处理失败');
}
function parseOptions(options) {
    const scene = options.scene ? safeDecode(options.scene) : '';
    const code = (0, invite_1.extractInviteCode)(options.code || options.inviteCode || options.matchmakerNo || scene);
    const source = String(options.source || queryValue(scene, 'source') || (scene ? 'scan' : 'share'));
    const rawEventId = String(options.eventId || queryValue(scene, 'eventId') || '').trim();
    const eventId = eventIdFrom(rawEventId);
    const autoRegister = String(options.autoRegister || queryValue(scene, 'autoRegister') || '') === '1' || source === 'salonShare' || source === 'memberSalonShare';
    return {
        code: (0, invite_1.normalizeInviteCode)(code),
        source,
        eventId,
        autoRegister,
        invalidEvent: (!!rawEventId || autoRegister || source === 'salonShare' || source === 'memberSalonShare') && !eventId
    };
}
Page({
    _inviteUnloaded: false,
    _inviteVisible: true,
    _inviteGeneration: 0,
    _ordinaryScope: '',
    _inviteNeedsReload: false,
    _inviteTimer: null,
    _activityScope: '',
    _activityPending: null,
    data: {
        code: '',
        source: 'share',
        sourceText: '微信链接',
        invite: null,
        canSubmit: false,
        autoMode: false,
        autoRegister: false,
        autoDone: false,
        eventId: '',
        activityInvite: false,
        activityReady: false,
        invalidEvent: false,
        autoMessage: '',
        actionText: '确认加入',
        loading: false,
        submitting: false,
        errorText: '',
        sharePath: ''
    },
    async onLoad(options) {
        const parsed = parseOptions(options || {});
        this.setData({
            ...parsed,
            activityInvite: !!parsed.eventId || parsed.invalidEvent,
            sourceText: sourceText(parsed.source),
            autoMode: isAutoInviteSource(parsed.source),
            actionText: isAutoInviteSource(parsed.source) ? '正在处理邀请' : '确认加入',
            sharePath: parsed.code ? (0, invite_1.invitePath)(parsed.code, parsed.source, {
                eventId: parsed.eventId,
                autoRegister: parsed.autoRegister
            }) : ''
        });
        if (parsed.invalidEvent) {
            this.setData({ errorText: '活动链接不完整，请重新打开活动邀请。' });
            return;
        }
        await this.loadInvite();
    },
    onUnload() {
        this.onHide();
        this._inviteUnloaded = true;
        this._activityPending = null;
    },
    onHide() {
        this._inviteVisible = false;
        this._inviteGeneration += 1;
        if (this._inviteTimer !== null)
            clearTimeout(this._inviteTimer);
        this._inviteTimer = null;
        this._inviteNeedsReload = true;
        this._activityPending = null;
        this.setData({ loading: false, submitting: false });
    },
    onShow() {
        this._inviteVisible = true;
        const reload = this._inviteNeedsReload;
        this._inviteNeedsReload = false;
        if (this.data.eventId && (reload || (this._activityScope && this._activityScope !== (0, page_session_1.pageSessionScope)()))) {
            return this.loadActivityInvite();
        }
        if (!this.data.eventId && (reload || (this._ordinaryScope && this._ordinaryScope !== (0, page_session_1.pageSessionScope)()))) {
            this.setData({ invite: null, canSubmit: false, autoDone: false, autoMessage: '', errorText: '' });
            return this.loadInvite();
        }
        return Promise.resolve();
    },
    loadActivityInvite() {
        if (!this.data.eventId || this._inviteUnloaded)
            return Promise.resolve();
        const scope = (0, page_session_1.pageSessionScope)();
        if (this._activityPending && this._activityScope === scope)
            return this._activityPending;
        if (this._activityScope !== scope) {
            this._inviteGeneration += 1;
            this._activityPending = null;
            this._activityScope = scope;
            this.setData({ loading: false, activityReady: false, errorText: '' });
        }
        if (!scope) {
            this.goRegistration();
            return Promise.resolve();
        }
        const generation = ++this._inviteGeneration;
        this._activityScope = scope;
        const isCurrent = () => this._inviteVisible && !this._inviteUnloaded && generation === this._inviteGeneration
            && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ loading: true, errorText: '', activityReady: false,
            actionText: '查看活动并确认报名', autoMessage: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const status = await (0, api_1.request)('/user/minimum-registration', {
                    showError: false,
                    unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
                });
                if (!isCurrent())
                    return;
                if (!status.completed) {
                    this.goRegistration();
                    return;
                }
                this.setData({ activityReady: true });
                this.goSalonDetail();
            }
            catch (err) {
                if (!isCurrent()) {
                    return;
                }
                this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '报名资料暂时无法读取，请重试。' });
            }
            finally {
                if (isCurrent())
                    this.setData({ loading: false });
                if (this._activityPending === promise)
                    this._activityPending = null;
            }
        });
        this._activityPending = promise;
        return promise;
    },
    goRegistration() {
        if (!this.data.eventId || this._inviteUnloaded)
            return;
        wx.redirectTo({ url: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}` });
    },
    async ensureLogin() {
        if (wx.getStorageSync('token'))
            return;
        await (0, auth_1.loginByWechat)('user');
    },
    isOrdinaryCurrent(scope, generation) {
        return this._inviteVisible && !this._inviteUnloaded && generation === this._inviteGeneration
            && !!scope && scope === (0, page_session_1.pageSessionScope)();
    },
    scheduleProfileReturn(scope, generation, delay) {
        if (this._inviteTimer !== null)
            clearTimeout(this._inviteTimer);
        this._inviteTimer = setTimeout(() => {
            this._inviteTimer = null;
            if (this.isOrdinaryCurrent(scope, generation))
                wx.switchTab({ url: '/pages/user/profile' });
        }, delay);
    },
    async loadInvite() {
        if (this._inviteUnloaded || !this._inviteVisible)
            return;
        if (this.data.invalidEvent)
            return;
        if (this.data.eventId) {
            await this.loadActivityInvite();
            return;
        }
        const code = (0, invite_1.normalizeInviteCode)(this.data.code);
        if (!code) {
            this.setData({ errorText: '未识别到有效的邀请码或主理人编号' });
            return;
        }
        this.setData({ loading: true, errorText: '' });
        const generation = ++this._inviteGeneration;
        const startingScope = (0, page_session_1.pageSessionScope)();
        try {
            await this.ensureLogin();
            if (!this._inviteVisible || this._inviteUnloaded || generation !== this._inviteGeneration
                || (startingScope && startingScope !== (0, page_session_1.pageSessionScope)()))
                return;
            const scope = (0, page_session_1.pageSessionScope)();
            this._ordinaryScope = scope;
            const invite = await member_1.memberApi.resolveMatchmakerInvite({
                code,
                source: this.data.source,
                eventId: this.data.eventId
            });
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            const autoMode = isAutoInviteSource(this.data.source);
            this.setData({
                invite,
                autoMode,
                canSubmit: !autoMode && !(invite && invite.alreadyAssigned),
                actionText: autoMode ? '正在处理邀请' : '确认加入'
            });
            if (autoMode)
                await this.acceptShareInvite();
        }
        catch (err) {
            if (!this._inviteVisible || this._inviteUnloaded || generation !== this._inviteGeneration
                || (startingScope && startingScope !== (0, page_session_1.pageSessionScope)()))
                return;
            console.warn('resolve matchmaker invite failed', err);
            this.setData({ errorText: err && err.message ? err.message : '邀请信息暂不可用', canSubmit: false });
        }
        finally {
            if (this._inviteVisible && !this._inviteUnloaded && generation === this._inviteGeneration
                && (!startingScope || startingScope === (0, page_session_1.pageSessionScope)()))
                this.setData({ loading: false });
        }
    },
    async acceptShareInvite() {
        if (this._inviteUnloaded || !this._inviteVisible)
            return;
        if (this.data.eventId) {
            await this.loadActivityInvite();
            return;
        }
        if (this.data.submitting || !this.data.code)
            return;
        const scope = (0, page_session_1.pageSessionScope)(), generation = this._inviteGeneration;
        if (!scope || scope !== this._ordinaryScope)
            return;
        this.setData({
            submitting: true,
            errorText: '',
            autoMessage: '',
            actionText: '正在处理邀请'
        });
        try {
            await this.ensureLogin();
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            const result = await member_1.memberApi.acceptMatchmakerInvite({
                code: this.data.code,
                source: this.data.source,
                eventId: this.data.eventId
            });
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            const invite = result && result.invite
                ? { ...result.invite, alreadyAssigned: true, existingRequest: result.request || null }
                : this.data.invite;
            this.setData({
                invite,
                canSubmit: false,
                autoDone: true,
                actionText: '已自动注册',
                autoMessage: '已成为该主理人名下免费会员。'
            });
            wx.showToast({ title: result && result.alreadyAssigned ? '已是名下会员' : '注册成功', icon: 'success' });
            this.scheduleProfileReturn(scope, generation, 700);
        }
        catch (err) {
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            console.warn('accept matchmaker invite failed', err);
            this.setData({
                errorText: errorMessage(err),
                autoDone: false,
                actionText: '重新处理邀请'
            });
        }
        finally {
            if (this.isOrdinaryCurrent(scope, generation))
                this.setData({ submitting: false });
        }
    },
    async submitRequest() {
        if (this.data.submitting || !this.data.canSubmit || !this.data.code)
            return;
        const scope = (0, page_session_1.pageSessionScope)(), generation = this._inviteGeneration;
        if (!scope || scope !== this._ordinaryScope || !this.isOrdinaryCurrent(scope, generation))
            return;
        this.setData({ submitting: true, errorText: '' });
        try {
            await this.ensureLogin();
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            const result = await member_1.memberApi.requestMatchmaker({
                code: this.data.code,
                source: this.data.source
            });
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            if (!result || result.status !== 'approved') {
                this.setData({ errorText: '加入状态尚未确认，请返回后重新打开邀请。' });
                return;
            }
            const invite = result.invite
                ? { ...result.invite, alreadyAssigned: true, existingRequest: result.request || null }
                : { ...this.data.invite, alreadyAssigned: true, existingRequest: result.request || null };
            this.setData({ invite, canSubmit: false, autoDone: true, actionText: '已加入',
                autoMessage: '已成为该主理人名下免费会员。' });
            wx.showToast({ title: result.alreadyAssigned ? '已是名下会员' : '加入成功', icon: 'success' });
            this.scheduleProfileReturn(scope, generation, 500);
        }
        catch (err) {
            if (!this.isOrdinaryCurrent(scope, generation))
                return;
            console.warn('submit matchmaker invite failed', err);
            this.setData({ errorText: errorMessage(err) });
        }
        finally {
            if (this.isOrdinaryCurrent(scope, generation))
                this.setData({ submitting: false });
        }
    },
    copyCode() {
        if (!this.data.code)
            return;
        wx.setClipboardData({ data: this.data.code });
    },
    goProfile() {
        wx.switchTab({ url: '/pages/user/profile' });
    },
    goSalonDetail() {
        if (!this.data.eventId)
            return;
        const ready = this.data.activityReady && this._activityScope === (0, page_session_1.pageSessionScope)();
        wx.redirectTo({ url: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}${ready ? '&registrationReady=1' : ''}` });
    },
    onShareAppMessage() {
        if (this.data.activityInvite && this.data.eventId) {
            return {
                title: '邀请你参加沙龙活动',
                path: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}&source=salonShare`
            };
        }
        return {
            title: this.data.autoRegister ? '邀请你报名沙龙活动' : '邀请你注册成为会员',
            path: this.data.sharePath || (0, invite_1.invitePath)(this.data.code, 'matchmakerShare')
        };
    }
});
