"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
const api_1 = require("../../services/api");
function safeDecode(value) {
    try {
        return decodeURIComponent(String(value || ''));
    }
    catch (err) {
        return '';
    }
}
function expiryText(value) {
    const date = new Date(value || '');
    if (!Number.isFinite(date.getTime()))
        return '';
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${month}月${day}日 ${hour}:${minute} 前有效`;
}
Page({
    data: {
        token: '',
        preview: null,
        expiresText: '',
        loggedIn: false,
        loading: true,
        loginLoading: false,
        confirmLoading: false,
        completed: false,
        errorText: '',
        actionErrorText: ''
    },
    onLoad(options) {
        const token = safeDecode(options.token);
        this.setData({
            token,
            loggedIn: !!wx.getStorageSync('token')
        });
        void this.loadPreview();
    },
    async loadPreview() {
        if (!this.data.token) {
            this.setData({ loading: false, errorText: '认领邀请不完整，请联系主理人重新发送。' });
            return;
        }
        this.setData({ loading: true, errorText: '', actionErrorText: '' });
        try {
            const preview = await (0, auth_1.previewManualMemberClaim)(this.data.token);
            this.setData({
                preview,
                completed: preview.status === 'claimed',
                expiresText: expiryText(preview.expiresAt)
            });
        }
        catch (err) {
            this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '认领邀请暂时无法读取，请稍后重试。' });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async login() {
        if (this.data.loginLoading)
            return;
        this.setData({ loginLoading: true });
        try {
            await (0, auth_1.loginByWechat)('user');
            this.setData({ loggedIn: true, actionErrorText: '' });
        }
        catch (err) {
            console.warn('claim login failed', err);
            this.setData({ actionErrorText: (0, api_1.apiErrorMessage)(err) || '微信登录失败，请稍后重试。' });
        }
        finally {
            this.setData({ loginLoading: false });
        }
    },
    async confirmClaim(e) {
        if (this.data.confirmLoading)
            return;
        const detail = e.detail;
        const code = String(detail.code || '');
        if (!code) {
            wx.showToast({ title: '需要授权本人手机号完成核验', icon: 'none' });
            return;
        }
        this.setData({ confirmLoading: true, actionErrorText: '' });
        try {
            await (0, auth_1.confirmManualMemberClaim)(this.data.token, code);
            this.setData({ completed: true, errorText: '', actionErrorText: '' });
            wx.showToast({ title: '档案认领成功' });
        }
        catch (err) {
            console.warn('confirm manual member claim failed', err);
            const recoverable = (0, api_1.isSessionRecoverableError)(err);
            this.setData({
                actionErrorText: recoverable
                    ? '登录状态已失效，请重新登录后继续。'
                    : ((0, api_1.apiErrorMessage)(err) || '认领失败，请核对信息后重试。')
            });
            if (recoverable) {
                const app = getApp();
                wx.removeStorageSync('token');
                wx.removeStorageSync('user');
                app.globalData.token = '';
                app.globalData.user = null;
                this.setData({ loggedIn: false });
            }
        }
        finally {
            this.setData({ confirmLoading: false });
        }
    },
    goProfile() {
        wx.switchTab({ url: '/pages/user/profile' });
    },
    goMembers() {
        wx.switchTab({ url: '/pages/user/members' });
    }
});
