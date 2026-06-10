"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const matchmaker_1 = require("../../services/matchmaker");
const invite_1 = require("../../utils/invite");
function defaultDashboard() {
    return {
        matchmaker: {
            memberCount: 0,
            certificationStatus: 0,
            certificationRemark: '',
            level: 1,
            matchmakerNo: ''
        },
        operations: {
            salonCount: 0
        }
    };
}
function defaultInviteCard() {
    return {
        matchmakerNo: '',
        inviteCode: '',
        sharePath: '',
        qrCodeFileID: '',
        matchmaker: {
            nickname: '',
            avatarUrl: '',
            level: 1
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
            statusNote: '红娘权限已开通，可进入资源池和运营页面。'
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
        statusNote: '红娘申请已提交，后台审批通过后将开放资源池、会员经营和沙龙发起权限。'
    };
}
Page({
    data: {
        user: null,
        dashboard: defaultDashboard(),
        loading: false,
        inviteCard: defaultInviteCard(),
        inviteLoading: false,
        inviteResetting: false,
        canOperate: false,
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '申请已提交，后台审核通过后将开放资源池、会员经营和沙龙发起权限。'
    },
    async onShow() {
        await this.loadDashboard();
    },
    async loadDashboard() {
        this.setData({ loading: true });
        try {
            let dashboard;
            try {
                dashboard = await matchmaker_1.matchmakerApi.dashboard(false);
            }
            catch (err) {
                await matchmaker_1.matchmakerApi.apply();
                dashboard = await matchmaker_1.matchmakerApi.dashboard();
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
            if (view.canOperate)
                await this.loadInviteCard(false);
        }
        catch (err) {
            console.warn('load matchmaker mine failed', err);
            this.setData({
                user: (0, api_1.currentUser)() || {},
                dashboard: defaultDashboard(),
                canOperate: false,
                statusText: '云服务未连接',
                statusTagClass: 'rose',
                statusNote: '请确认 hlApi 云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
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
    async loadInviteCard(showError = true) {
        this.setData({ inviteLoading: true });
        try {
            const inviteCard = await matchmaker_1.matchmakerApi.inviteCard(showError);
            this.setData({ inviteCard });
        }
        catch (err) {
            console.warn('load invite card failed', err);
            this.setData({ inviteCard: defaultInviteCard() });
        }
        finally {
            this.setData({ inviteLoading: false });
        }
    },
    copyInviteCode() {
        const code = this.data.inviteCard && this.data.inviteCard.inviteCode;
        if (!code)
            return;
        wx.setClipboardData({ data: code });
    },
    previewInviteQr() {
        const fileID = this.data.inviteCard && this.data.inviteCard.qrCodeFileID;
        if (!fileID)
            return;
        wx.previewImage({ urls: [fileID] });
    },
    async resetInviteCode() {
        if (this.data.inviteResetting)
            return;
        wx.showModal({
            title: '重置邀请码',
            content: '重置后旧邀请码和旧二维码将失效，已有待审批申请不受影响。',
            success: async (res) => {
                if (!res.confirm)
                    return;
                this.setData({ inviteResetting: true });
                try {
                    const inviteCard = await matchmaker_1.matchmakerApi.resetInviteCode();
                    this.setData({ inviteCard });
                    wx.showToast({ title: '已重置' });
                }
                catch (err) {
                    console.warn('reset invite code failed', err);
                }
                finally {
                    this.setData({ inviteResetting: false });
                }
            }
        });
    },
    goResources() {
        if (!this.data.canOperate) {
            wx.showToast({ title: '红娘认证通过后可使用', icon: 'none' });
            return;
        }
        wx.navigateTo({ url: '/pages/matchmaker/resources' });
    },
    logout() {
        wx.removeStorageSync('token');
        wx.removeStorageSync('user');
        wx.redirectTo({ url: '/pages/index/index' });
    },
    onShareAppMessage() {
        const card = this.data.inviteCard || {};
        const code = card.inviteCode || '';
        return {
            title: `${(this.data.user && this.data.user.nickname) || '红娘顾问'}邀请你添加红娘`,
            path: card.sharePath || (0, invite_1.invitePath)(code, 'share')
        };
    }
});
