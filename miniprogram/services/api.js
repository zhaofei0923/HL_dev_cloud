"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentUser = exports.setSession = exports.request = exports.isSessionRecoverableError = exports.apiErrorMessage = void 0;
const cloud_1 = require("../config/cloud");
function isUnauthorized(code) {
    return code === 401 || code === 40100 || code === 40102;
}
function errorText(err) {
    if (!err)
        return '';
    return String(err.errMsg || err.message || err);
}
function apiErrorMessage(err) {
    return errorText(err);
}
exports.apiErrorMessage = apiErrorMessage;
function isSessionRecoverableError(err) {
    const code = Number(err && err.code);
    const raw = errorText(err);
    return isUnauthorized(code) || /invalid token|unauthorized|user not found/i.test(raw);
}
exports.isSessionRecoverableError = isSessionRecoverableError;
function cloudFailMessage(err) {
    const raw = errorText(err);
    if (/timeout/i.test(raw)) {
        return `云函数 ${cloud_1.CLOUD_FUNCTION_NAME} 调用超时，请确认已部署到 ${cloud_1.CLOUD_ENV_ID}`;
    }
    if (/not found|function/i.test(raw)) {
        return `云函数 ${cloud_1.CLOUD_FUNCTION_NAME} 未部署，请先部署到 ${cloud_1.CLOUD_ENV_ID}`;
    }
    return `无法连接云函数 ${cloud_1.CLOUD_FUNCTION_NAME}，请检查 ${cloud_1.CLOUD_ENV_ID}`;
}
function request(path, options = {}) {
    const method = options.method || 'GET';
    const app = getApp();
    const env = app.globalData.env || cloud_1.CLOUD_ENV_ID;
    const token = options.token !== undefined
        ? options.token
        : (options.auth === false ? '' : app.globalData.token || wx.getStorageSync('token'));
    return new Promise((resolve, reject) => {
        wx.cloud.callFunction({
            name: cloud_1.CLOUD_FUNCTION_NAME,
            config: { env },
            slow: true,
            data: {
                path,
                method,
                data: options.data || {},
                token
            },
            success(res) {
                const body = res.result;
                if (body && body.code === 0) {
                    resolve(body.data);
                    return;
                }
                const code = body && body.code;
                if (isUnauthorized(code) && !options.preserveSessionOnUnauthorized) {
                    wx.removeStorageSync('token');
                    wx.removeStorageSync('user');
                    app.globalData.token = '';
                    app.globalData.user = null;
                    wx.redirectTo({ url: '/pages/index/index' });
                }
                const message = body && body.message ? body.message : '请求失败';
                if (options.showError !== false)
                    wx.showToast({ title: message, icon: 'none' });
                const apiError = new Error(message);
                apiError.code = code;
                apiError.response = body;
                apiError.path = path;
                reject(apiError);
            },
            fail(err) {
                const message = cloudFailMessage(err);
                if (options.showError !== false)
                    wx.showToast({ title: message, icon: 'none', duration: 3000 });
                const apiError = new Error(message);
                apiError.raw = err;
                apiError.path = path;
                reject(apiError);
            }
        });
    });
}
exports.request = request;
function setSession(session) {
    const app = getApp();
    app.globalData.token = session.token;
    app.globalData.user = session.user;
    wx.setStorageSync('token', session.token);
    wx.setStorageSync('user', session.user);
}
exports.setSession = setSession;
function currentUser() {
    const app = getApp();
    return app.globalData.user || wx.getStorageSync('user');
}
exports.currentUser = currentUser;
