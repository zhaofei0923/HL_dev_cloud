"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
Page({
    data: {
        loading: false
    },
    onShow() {
        const token = wx.getStorageSync('token');
        if (token) {
            wx.redirectTo({ url: '/pages/user/members' });
        }
    },
    async login() {
        this.setData({ loading: true });
        try {
            await (0, auth_1.loginByWechat)('user');
            wx.redirectTo({ url: '/pages/user/members' });
        }
        catch (err) {
            console.warn('login failed', err);
        }
        finally {
            this.setData({ loading: false });
        }
    }
});
