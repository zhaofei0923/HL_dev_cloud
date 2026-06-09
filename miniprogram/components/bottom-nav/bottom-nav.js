"use strict";
const USER_TABS = [
    { key: 'members', label: '会员', path: '/pages/user/members', icon: 'members' },
    { key: 'salon', label: '沙龙', path: '/pages/user/salon', icon: 'salon' },
    { key: 'mine', label: '我的', path: '/pages/user/profile', icon: 'mine' }
];
const MATCHMAKER_TABS = [
    { key: 'dashboard', label: '看板', path: '/pages/matchmaker/dashboard', icon: 'dashboard' },
    { key: 'members', label: '会员', path: '/pages/matchmaker/members', icon: 'members' },
    { key: 'salon', label: '沙龙', path: '/pages/matchmaker/salon', icon: 'salon' },
    { key: 'mine', label: '我的', path: '/pages/matchmaker/mine', icon: 'mine' }
];
function tabsForRole(role) {
    return role === 'matchmaker' ? MATCHMAKER_TABS : USER_TABS;
}
Component({
    properties: {
        role: {
            type: String,
            value: 'user',
            observer() {
                this.updateTabs();
            }
        },
        active: {
            type: String,
            value: ''
        }
    },
    data: {
        tabs: USER_TABS
    },
    lifetimes: {
        attached() {
            this.updateTabs();
        }
    },
    methods: {
        updateTabs() {
            this.setData({
                tabs: tabsForRole(this.data.role)
            });
        },
        switchTab(e) {
            const key = String(e.currentTarget.dataset.key || '');
            const path = String(e.currentTarget.dataset.path || '');
            if (!key || !path || key === this.data.active)
                return;
            wx.redirectTo({ url: path });
        }
    }
});
