"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cloud_1 = require("./config/cloud");
const member_1 = require("./services/member");
const page_session_1 = require("./utils/page-session");
let presenceTimer = null;
let presenceForeground = false;
let presenceInFlight = '';
function heartbeat() {
    if (!presenceForeground)
        return;
    const app = getApp();
    if (!app || !app.globalData)
        return;
    const user = app.globalData.user || wx.getStorageSync('user');
    const token = app.globalData.token || wx.getStorageSync('token');
    if (typeof token !== 'string' || !token || !user || !Number(user.id || user.userId))
        return;
    const scope = (0, page_session_1.pageSessionScope)();
    if (!scope || presenceInFlight === scope)
        return;
    presenceInFlight = scope;
    member_1.memberApi.updatePresence().catch(err => {
        if (presenceForeground && scope === (0, page_session_1.pageSessionScope)())
            console.warn('presence heartbeat failed', err);
    }).finally(() => {
        if (presenceInFlight === scope)
            presenceInFlight = '';
    });
}
App({
    globalData: {
        env: cloud_1.CLOUD_ENV_ID,
        token: wx.getStorageSync('token') || '',
        user: wx.getStorageSync('user') || null
    },
    onShow() {
        presenceForeground = true;
        if (presenceTimer !== null)
            clearInterval(presenceTimer);
        heartbeat();
        presenceTimer = setInterval(heartbeat, 60 * 1000);
    },
    onHide() {
        presenceForeground = false;
        if (presenceTimer !== null)
            clearInterval(presenceTimer);
        presenceTimer = null;
    },
    onLaunch() {
        if (!wx.cloud) {
            console.error('请使用 2.2.3 或以上基础库以使用云能力');
            return;
        }
        wx.cloud.init({
            env: this.globalData.env,
            traceUser: true
        });
    }
});
