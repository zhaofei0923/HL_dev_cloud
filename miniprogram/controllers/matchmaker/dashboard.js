"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dashboardController = void 0;
const matchmaker_workspace_1 = require("../../utils/matchmaker-workspace");
const api_1 = require("../../services/api");
const matchmaker_1 = require("../../services/matchmaker");
const matchmaker_access_view_1 = require("../../utils/matchmaker-access-view");
const matchmaker_page_cache_1 = require("../../utils/matchmaker-page-cache");
const DASHBOARD_ROUTE = '/matchmaker/dashboard';
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
const certificationView = (matchmaker) => (0, matchmaker_access_view_1.matchmakerAccessView)(matchmaker, '主理人权限已开通，可使用会员经营、资源池互推和沙龙发起。');
function isAccessDenied(err) {
    const code = Number(err?.code);
    return (0, api_1.isSessionRecoverableError)(err) || code === 403 || code === 40300 || code === 40301;
}
function isMissingMatchmaker(err) {
    return Number(err?.code) === 40400 && (0, api_1.apiErrorMessage)(err) === 'matchmaker not found';
}
exports.dashboardController = (0, matchmaker_workspace_1.defineMatchmakerController)({
    _sessionScope: '',
    _dashboardGeneration: 0,
    _dashboardPending: null,
    _applying: false,
    _authorizationRevision: -1,
    data: {
        user: null,
        dashboard: defaultDashboard(),
        loading: false,
        canOperate: false,
        statusText: '待开通',
        statusTagClass: '',
        statusNote: '主理人一次性开通费 ¥6980，长期有效。付款确认后自动开通。'
    },
    onShow() {
        return this.loadDashboard();
    },
    onUnload() {
        this._dashboardGeneration += 1;
        this._dashboardPending = null;
    },
    onPullDownRefresh() {
        return this.loadDashboard(true).finally(() => wx.stopPullDownRefresh());
    },
    synchronizeSession() {
        const scope = (0, matchmaker_page_cache_1.matchmakerPageSessionScope)();
        if (scope !== this._sessionScope) {
            this._sessionScope = scope;
            this._dashboardGeneration += 1;
            this._dashboardPending = null;
            this._applying = false;
            this._authorizationRevision = -1;
            this.setData({ user: (0, api_1.currentUser)() || {}, dashboard: defaultDashboard(), loading: false, ...certificationView(undefined) });
        }
        if (this.data.canOperate && this._authorizationRevision !== (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)()) {
            this._dashboardGeneration += 1;
            this._dashboardPending = null;
            this.setData({ dashboard: defaultDashboard(), loading: false, ...certificationView(undefined) });
        }
        if (scope)
            return scope;
        wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    applyDashboard(dashboard, loadedAt, fromServer = false) {
        const view = certificationView(dashboard.matchmaker);
        if (!view.canOperate) {
            const matchmaker = {
                memberCount: 0,
                level: dashboard.matchmaker.level || 1,
                certificationStatus: dashboard.matchmaker.certificationStatus,
                certificationRemark: dashboard.matchmaker.certificationRemark || ''
            };
            dashboard = { ...defaultDashboard(), matchmaker };
            if (fromServer) {
                (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
                (0, matchmaker_page_cache_1.writeMatchmakerPageSnapshot)(DASHBOARD_ROUTE, dashboard, loadedAt);
            }
        }
        this._authorizationRevision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        this.setData({ user: (0, api_1.currentUser)() || {}, dashboard, ...view });
    },
    async loadOrCreateDashboard(isCurrent = () => true) {
        try {
            return await matchmaker_1.matchmakerApi.dashboard(false);
        }
        catch (err) {
            if (!isCurrent())
                throw new matchmaker_page_cache_1.MatchmakerPageRequestDiscarded();
            if (!isMissingMatchmaker(err))
                throw err;
            await matchmaker_1.matchmakerApi.apply();
            if (!isCurrent())
                throw new matchmaker_page_cache_1.MatchmakerPageRequestDiscarded();
            return matchmaker_1.matchmakerApi.dashboard(false);
        }
    },
    loadDashboard(force = false) {
        const scope = this.synchronizeSession();
        if (!scope)
            return Promise.resolve();
        if (!force && this._dashboardPending)
            return this._dashboardPending;
        const generation = ++this._dashboardGeneration;
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        const isPageCurrent = () => generation === this._dashboardGeneration && (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() === scope;
        const isCurrent = () => isPageCurrent() && (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() === revision;
        const cached = (0, matchmaker_page_cache_1.readMatchmakerPageSnapshot)(DASHBOARD_ROUTE);
        if (cached)
            this.applyDashboard(cached.data, cached.loadedAt);
        this.setData({ loading: !cached });
        if (cached && !force && Date.now() - cached.loadedAt < matchmaker_page_cache_1.MATCHMAKER_PAGE_TTL_MS)
            return Promise.resolve();
        const isSessionCurrent = () => (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() === scope && (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() === revision;
        const pending = Promise.resolve().then(async () => {
            try {
                const snapshot = await (0, matchmaker_page_cache_1.requestMatchmakerPageSnapshot)(DASHBOARD_ROUTE, () => this.loadOrCreateDashboard(isSessionCurrent), force, isCurrent);
                if (!isCurrent())
                    return;
                this.applyDashboard(snapshot.data, snapshot.loadedAt, true);
            }
            catch (err) {
                if (err instanceof matchmaker_page_cache_1.MatchmakerPageRequestDiscarded) {
                    if (isPageCurrent() && (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() !== revision)
                        this.synchronizeSession();
                    return;
                }
                if ((0, matchmaker_page_cache_1.matchmakerPageSessionScope)() !== scope) {
                    this.synchronizeSession();
                    return;
                }
                if (!isPageCurrent())
                    return;
                if (!isCurrent()) {
                    this.synchronizeSession();
                    return;
                }
                if (!cached || isAccessDenied(err) || isMissingMatchmaker(err)) {
                    if (isAccessDenied(err) || isMissingMatchmaker(err))
                        (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
                    this.setData({
                        user: (0, api_1.currentUser)() || {}, dashboard: defaultDashboard(), canOperate: false,
                        statusText: (0, api_1.isSessionRecoverableError)(err) ? '登录状态需刷新' : '服务暂不可用',
                        statusTagClass: 'rose', statusNote: (0, api_1.apiErrorMessage)(err) || '暂时无法读取，请稍后重试。'
                    });
                }
            }
            finally {
                if (isPageCurrent())
                    this.setData({ loading: false });
                if (this._dashboardPending === pending)
                    this._dashboardPending = null;
            }
        });
        this._dashboardPending = pending;
        return pending;
    },
    ensureCertified() {
        if (!this.synchronizeSession())
            return false;
        if (this.data.canOperate)
            return true;
        wx.showToast({ title: '开通主理人后可使用', icon: 'none' });
        return false;
    },
    async applyAgain() {
        const scope = this.synchronizeSession();
        if (!scope || this._applying || this.data.loading)
            return;
        const generation = this._dashboardGeneration;
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        const isCurrent = () => generation === this._dashboardGeneration && (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() === scope && (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() === revision;
        this._applying = true;
        this.setData({ loading: true });
        try {
            await matchmaker_1.matchmakerApi.apply();
            if (!isCurrent())
                return;
            (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
            wx.showToast({ title: '已重新提交' });
            await this.loadDashboard(true);
        }
        catch (err) {
            if ((0, matchmaker_page_cache_1.matchmakerPageSessionScope)() !== scope)
                this.synchronizeSession();
        }
        finally {
            if (this._sessionScope === scope && (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() === scope) {
                this._applying = false;
                this.setData({ loading: false });
            }
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
        wx.switchTab({ url: '/pages/user/profile' });
    },
    goActivation() {
        if (!this.synchronizeSession() || this.data.loading)
            return;
        wx.navigateTo({ url: '/pages/matchmaker/activation' });
    },
    logout() {
        const app = getApp();
        app.globalData.token = '';
        app.globalData.user = undefined;
        wx.removeStorageSync('token');
        wx.removeStorageSync('user');
        (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
        this._dashboardGeneration += 1;
        this._dashboardPending = null;
        this.setData({ user: {}, dashboard: defaultDashboard(), loading: false, ...certificationView(undefined) });
        wx.redirectTo({ url: '/pages/index/index' });
    }
});
