"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindWechatPhone = exports.loginByWechat = void 0;
const api_1 = require("./api");
function loginByWechat(role) {
    return new Promise((resolve, reject) => {
        wx.login({
            success: async (loginRes) => {
                try {
                    if (!loginRes.code)
                        throw new Error('微信登录未返回有效 code');
                    const session = await (0, api_1.request)('/auth/wx-login', {
                        method: 'POST',
                        auth: false,
                        data: {
                            code: loginRes.code,
                            role,
                            nickname: role === 'matchmaker' ? '主理人' : '新用户'
                        }
                    });
                    (0, api_1.setSession)(session);
                    resolve(session);
                }
                catch (err) {
                    reject(err);
                }
            },
            fail: reject
        });
    });
}
exports.loginByWechat = loginByWechat;
async function bindWechatPhone(code) {
    if (!code)
        throw new Error('手机号授权 code 不能为空');
    const user = await (0, api_1.request)('/auth/wechat-phone', {
        method: 'POST',
        data: { code }
    });
    const app = getApp();
    app.globalData.user = user;
    wx.setStorageSync('user', user);
    return user;
}
exports.bindWechatPhone = bindWechatPhone;
