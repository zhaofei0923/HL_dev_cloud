"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginByWechat = void 0;
const api_1 = require("./api");
function loginByWechat(role) {
    return new Promise((resolve, reject) => {
        wx.login({
            success: async (loginRes) => {
                try {
                    const session = await (0, api_1.request)('/auth/wx-login', {
                        method: 'POST',
                        auth: false,
                        data: {
                            code: loginRes.code || `${role}-${Date.now()}`,
                            role,
                            nickname: role === 'matchmaker' ? '红娘顾问' : '新用户'
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
