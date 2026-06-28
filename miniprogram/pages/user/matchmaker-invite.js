"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
const member_1 = require("../../services/member");
const salon_1 = require("../../services/salon");
const invite_1 = require("../../utils/invite");
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
    return match ? decodeURIComponent(match[1] || '') : '';
}
function isAutoInviteSource(source) {
    return ['share', 'matchmakerShare', 'memberShare', 'salonShare', 'memberSalonShare'].includes(source);
}
function errorMessage(err) {
    return String((err && (err.message || err.errMsg)) || err || '处理失败');
}
function parseOptions(options) {
    const scene = options.scene ? decodeURIComponent(String(options.scene)) : '';
    const code = (0, invite_1.extractInviteCode)(options.code || options.inviteCode || options.matchmakerNo || scene);
    const source = String(options.source || queryValue(scene, 'source') || (scene ? 'scan' : 'share'));
    const eventId = String(options.eventId || queryValue(scene, 'eventId') || '');
    const autoRegister = String(options.autoRegister || queryValue(scene, 'autoRegister') || '') === '1' || source === 'salonShare' || source === 'memberSalonShare';
    return {
        code: (0, invite_1.normalizeInviteCode)(code),
        source,
        eventId,
        autoRegister
    };
}
Page({
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
        autoMessage: '',
        actionText: '提交添加申请',
        loading: false,
        submitting: false,
        errorText: '',
        sharePath: ''
    },
    async onLoad(options) {
        const parsed = parseOptions(options || {});
        this.setData({
            ...parsed,
            sourceText: sourceText(parsed.source),
            autoMode: isAutoInviteSource(parsed.source),
            actionText: isAutoInviteSource(parsed.source) ? '正在处理邀请' : '提交添加申请',
            sharePath: parsed.code ? (0, invite_1.invitePath)(parsed.code, parsed.source, {
                eventId: parsed.eventId,
                autoRegister: parsed.autoRegister
            }) : ''
        });
        await this.loadInvite();
    },
    async ensureLogin() {
        if (wx.getStorageSync('token'))
            return;
        await (0, auth_1.loginByWechat)('user');
    },
    async loadInvite() {
        const code = (0, invite_1.normalizeInviteCode)(this.data.code);
        if (!code) {
            this.setData({ errorText: '未识别到有效的邀请码或红娘编号' });
            return;
        }
        this.setData({ loading: true, errorText: '' });
        try {
            await this.ensureLogin();
            const invite = await member_1.memberApi.resolveMatchmakerInvite({
                code,
                source: this.data.source,
                eventId: this.data.eventId
            });
            const pending = invite && invite.existingRequest && invite.existingRequest.status === 'pending';
            const autoMode = isAutoInviteSource(this.data.source);
            this.setData({
                invite,
                autoMode,
                canSubmit: !autoMode && !(invite && invite.alreadyAssigned) && !pending,
                actionText: autoMode ? '正在处理邀请' : '提交添加申请'
            });
            if (autoMode)
                await this.acceptShareInvite();
        }
        catch (err) {
            console.warn('resolve matchmaker invite failed', err);
            this.setData({ errorText: err && err.message ? err.message : '邀请信息暂不可用', canSubmit: false });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async acceptShareInvite() {
        if (this.data.submitting || !this.data.code)
            return;
        this.setData({
            submitting: true,
            errorText: '',
            autoMessage: '',
            actionText: '正在处理邀请'
        });
        try {
            await this.ensureLogin();
            const result = await member_1.memberApi.acceptMatchmakerInvite({
                code: this.data.code,
                source: this.data.source,
                eventId: this.data.eventId
            });
            const invite = result && result.invite
                ? { ...result.invite, alreadyAssigned: true, existingRequest: result.request || null }
                : this.data.invite;
            this.setData({
                invite,
                canSubmit: false,
                autoDone: true,
                actionText: this.data.autoRegister && this.data.eventId ? '正在报名沙龙' : '已自动注册',
                autoMessage: '已成为该红娘名下免费会员。'
            });
            if (this.data.autoRegister && this.data.eventId) {
                await this.registerSharedSalon();
                return;
            }
            wx.showToast({ title: result && result.alreadyAssigned ? '已是名下会员' : '注册成功', icon: 'success' });
            setTimeout(() => {
                wx.redirectTo({ url: '/pages/user/profile' });
            }, 700);
        }
        catch (err) {
            console.warn('accept matchmaker invite failed', err);
            this.setData({
                errorText: errorMessage(err),
                autoDone: false,
                actionText: '重新处理邀请'
            });
        }
        finally {
            this.setData({ submitting: false });
        }
    },
    async registerSharedSalon() {
        try {
            await salon_1.salonApi.register(this.data.eventId);
            this.setData({
                actionText: '报名成功',
                autoMessage: '已成为该红娘名下免费会员，并成功报名沙龙。'
            });
            wx.showToast({ title: '报名成功', icon: 'success' });
            setTimeout(() => {
                this.goSalonDetail();
            }, 700);
        }
        catch (err) {
            const message = errorMessage(err);
            if (/already registered|已报名/i.test(message)) {
                this.setData({
                    actionText: '已报名沙龙',
                    autoMessage: '已成为该红娘名下免费会员，此沙龙已报名。'
                });
                setTimeout(() => {
                    this.goSalonDetail();
                }, 700);
                return;
            }
            console.warn('register shared salon failed', err);
            this.setData({
                autoDone: false,
                actionText: '重新报名沙龙',
                autoMessage: `已成为该红娘名下免费会员，沙龙报名未完成：${message}`
            });
            wx.showToast({ title: '报名未完成', icon: 'none' });
        }
    },
    async submitRequest() {
        if (this.data.submitting || !this.data.code)
            return;
        this.setData({ submitting: true });
        try {
            await this.ensureLogin();
            const result = await member_1.memberApi.requestMatchmaker({
                code: this.data.code,
                source: this.data.source
            });
            wx.showToast({ title: result && result.status === 'approved' ? '已是名下会员' : '申请已提交', icon: 'success' });
            setTimeout(() => {
                wx.redirectTo({ url: '/pages/user/profile' });
            }, 500);
        }
        catch (err) {
            console.warn('submit matchmaker invite failed', err);
        }
        finally {
            this.setData({ submitting: false });
        }
    },
    copyCode() {
        if (!this.data.code)
            return;
        wx.setClipboardData({ data: this.data.code });
    },
    goProfile() {
        wx.redirectTo({ url: '/pages/user/profile' });
    },
    goSalonDetail() {
        if (!this.data.eventId)
            return;
        wx.redirectTo({ url: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}` });
    },
    onShareAppMessage() {
        return {
            title: this.data.autoRegister ? '邀请你报名沙龙活动' : '邀请你注册成为会员',
            path: this.data.sharePath || (0, invite_1.invitePath)(this.data.code, 'matchmakerShare')
        };
    }
});
