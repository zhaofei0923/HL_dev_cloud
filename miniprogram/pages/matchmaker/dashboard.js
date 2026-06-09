"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const auth_1 = require("../../services/auth");
const matchmaker_1 = require("../../services/matchmaker");
function defaultDashboard() {
    return {
        matchmaker: {
            memberCount: 0,
            certificationStatus: 0,
            certificationRemark: '',
            level: 1
        },
        operations: {
            salonCount: 0,
            resourceCount: 0,
            registrationCount: 0,
            recentRecommendationCount: 0,
            todoCounts: {
                incompleteMembers: 0,
                pendingRecommendations: 0,
                upcomingSalons: 0,
                salonRegistrations: 0
            }
        },
        resourceCount: 0,
        recentRecommendationCount: 0,
        registrationCount: 0,
        todoCounts: {
            incompleteMembers: 0,
            pendingRecommendations: 0,
            upcomingSalons: 0,
            salonRegistrations: 0
        }
    };
}
function certificationView(matchmaker) {
    const status = Number((matchmaker && matchmaker.certificationStatus) || 0);
    const remark = (matchmaker && matchmaker.certificationRemark) || '';
    if (status === 2) {
        return {
            canOperate: true,
            statusText: '已认证',
            statusTagClass: 'gold',
            statusNote: '红娘权限已开通，可使用会员经营、资源池互推和沙龙发起。'
        };
    }
    if (status === 1) {
        return {
            canOperate: false,
            statusText: '已拒绝',
            statusTagClass: 'rose',
            statusNote: remark || '本次申请暂未通过，请完善资料后重新提交。'
        };
    }
    return {
        canOperate: false,
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '红娘申请已提交，后台审批通过后将开放会员经营、资源池和沙龙发起权限。'
    };
}
Page({
    data: {
        user: null,
        dashboard: defaultDashboard(),
        loading: false,
        canOperate: false,
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '申请已提交，后台审核通过后将开放会员经营、资源池和沙龙发起权限。'
    },
    async onShow() {
        await this.loadDashboard();
    },
    async loadOrCreateDashboard() {
        try {
            return await matchmaker_1.matchmakerApi.dashboard(false);
        }
        catch (err) {
            await matchmaker_1.matchmakerApi.apply();
            return matchmaker_1.matchmakerApi.dashboard();
        }
    },
    async loadDashboard() {
        this.setData({ loading: true });
        try {
            let dashboard;
            try {
                dashboard = await this.loadOrCreateDashboard();
            }
            catch (err) {
                if (!(0, api_1.isSessionRecoverableError)(err))
                    throw err;
                await (0, auth_1.loginByWechat)('matchmaker');
                dashboard = await this.loadOrCreateDashboard();
            }
            const view = certificationView(dashboard.matchmaker);
            this.setData({
                user: (0, api_1.currentUser)() || {},
                dashboard,
                canOperate: view.canOperate,
                statusText: view.statusText,
                statusTagClass: view.statusTagClass,
                statusNote: view.statusNote
            });
        }
        catch (err) {
            console.warn('load matchmaker dashboard failed', err);
            const message = (0, api_1.apiErrorMessage)(err);
            this.setData({
                user: (0, api_1.currentUser)() || {},
                dashboard: defaultDashboard(),
                canOperate: false,
                statusText: (0, api_1.isSessionRecoverableError)(err) ? '登录状态需刷新' : '服务暂不可用',
                statusTagClass: 'rose',
                statusNote: message || '请在云开发控制台查看 hlApi 运行日志后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    ensureCertified() {
        if (this.data.canOperate)
            return true;
        wx.showToast({ title: '红娘认证通过后可使用', icon: 'none' });
        return false;
    },
    async applyAgain() {
        if (this.data.loading)
            return;
        this.setData({ loading: true });
        try {
            await matchmaker_1.matchmakerApi.apply();
            wx.showToast({ title: '已重新提交' });
            await this.loadDashboard();
        }
        catch (err) {
            console.warn('apply matchmaker failed', err);
        }
        finally {
            this.setData({ loading: false });
        }
    },
    goMembers() {
        if (!this.ensureCertified())
            return;
        wx.navigateTo({ url: '/pages/matchmaker/members' });
    },
    goResources() {
        if (!this.ensureCertified())
            return;
        wx.navigateTo({ url: '/pages/matchmaker/resources' });
    },
    goSalon() {
        if (!this.ensureCertified())
            return;
        wx.navigateTo({ url: '/pages/matchmaker/salon' });
    },
    goUserProfile() {
        wx.redirectTo({ url: '/pages/user/profile' });
    },
    logout() {
        wx.removeStorageSync('token');
        wx.removeStorageSync('user');
        wx.redirectTo({ url: '/pages/index/index' });
    }
});
