"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pageSessionScope = void 0;
const showcase_cache_1 = require("./showcase-cache");
// Retained pages use a credential fingerprint, never credentials in cache keys.
function pageSessionScope() {
    const app = getApp();
    return (0, showcase_cache_1.showcaseSessionScope)(app.globalData.token || wx.getStorageSync('token'), app.globalData.user || wx.getStorageSync('user'), app.globalData.env);
}
exports.pageSessionScope = pageSessionScope;
