"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncUserTabBar = exports.userTabKeyForRoute = void 0;
const USER_TAB_ROUTES = {
    'pages/user/members': 'members',
    'pages/user/salon': 'salon',
    'pages/user/messages': 'messages',
    'pages/user/profile': 'mine'
};
function userTabKeyForRoute(route) {
    return USER_TAB_ROUTES[route.replace(/^\//, '')] || null;
}
exports.userTabKeyForRoute = userTabKeyForRoute;
function syncUserTabBar(page, activeKey) {
    if (!page || typeof page !== 'object' || !('getTabBar' in page) || typeof page.getTabBar !== 'function')
        return;
    const tabBar = page.getTabBar();
    if (!tabBar || typeof tabBar !== 'object' || !('setData' in tabBar) || typeof tabBar.setData !== 'function')
        return;
    tabBar.setData({ active: activeKey });
}
exports.syncUserTabBar = syncUserTabBar;
