"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dashboard_1 = require("../../controllers/matchmaker/dashboard");
const members_1 = require("../../controllers/matchmaker/members");
const messages_1 = require("../../controllers/matchmaker/messages");
const salon_1 = require("../../controllers/matchmaker/salon");
const mine_1 = require("../../controllers/matchmaker/mine");
const matchmaker_page_cache_1 = require("../../utils/matchmaker-page-cache");
const matchmaker_workspace_1 = require("../../utils/matchmaker-workspace");
const controllers = {
    dashboard: dashboard_1.dashboardController,
    members: members_1.membersController,
    messages: messages_1.messagesController,
    salon: salon_1.salonController,
    mine: mine_1.mineController
};
const titles = {
    dashboard: '工作台', members: '会员管理', messages: '消息', salon: '活动管理', mine: '主理人中心'
};
function eventHandlers() {
    const handlers = {};
    matchmaker_workspace_1.MATCHMAKER_WORKSPACE_TABS.forEach(tab => {
        Object.keys(controllers[tab]).forEach(method => {
            if (typeof controllers[tab][method] !== 'function' || method.startsWith('onLoad') || method === 'onShow' || method === 'onHide' || method === 'onUnload')
                return;
            handlers[`workspace_${tab}_${method}`] = function (event) {
                return this.dispatchControllerEvent(tab, method, event);
            };
        });
    });
    return handlers;
}
Page({
    ...eventHandlers(),
    _controllers: {},
    _workspaceScope: '',
    _workspaceSession: '',
    _workspaceRevision: 0,
    _workspaceUnloaded: false,
    _disposing: false,
    _viewGeneration: 0,
    _scrollPositions: {},
    data: {
        activeTab: 'dashboard',
        view: {}
    },
    onLoad(query) {
        const tab = (0, matchmaker_workspace_1.isMatchmakerWorkspaceTab)(query.tab) ? query.tab : 'dashboard';
        this.setData({ activeTab: tab });
        this.synchronizeControllers();
        if (this._workspaceScope)
            this.ensureController(tab);
    },
    onShow() {
        this._workspaceUnloaded = false;
        if (!this.synchronizeControllers())
            return;
        return this.showController(this.data.activeTab);
    },
    onReady() {
        wx.setNavigationBarTitle({ title: titles[this.data.activeTab] });
    },
    onHide() {
        const controller = this._controllers[this.data.activeTab];
        if (controller)
            (0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onHide');
    },
    onUnload() {
        this._workspaceUnloaded = true;
        this.disposeControllers();
    },
    onPullDownRefresh() {
        if (!this.synchronizeControllers()) {
            wx.stopPullDownRefresh();
            return;
        }
        const controller = this.ensureController(this.data.activeTab);
        return Promise.resolve((0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onPullDownRefresh')).then(() => undefined).finally(() => wx.stopPullDownRefresh());
    },
    onPageScroll(event) {
        this._scrollPositions[this.data.activeTab] = event.scrollTop;
    },
    onReachBottom() {
        if (this._workspaceUnloaded || !this.synchronizeControllers())
            return;
        const controller = this.ensureController(this.data.activeTab);
        return Promise.resolve((0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onReachBottom')).then(() => undefined);
    },
    onShareAppMessage(options) {
        if (!this.synchronizeControllers())
            return { title: 'HL 婚恋服务', path: '/pages/index/index' };
        const controller = this.ensureController(this.data.activeTab);
        return (0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onShareAppMessage', [options])
            || { title: 'HL 婚恋服务', path: '/pages/index/index' };
    },
    disposeControllers(keep) {
        this._disposing = true;
        this._viewGeneration += 1;
        const old = this._controllers;
        this._controllers = keep && old[keep] ? { [keep]: old[keep] } : {};
        matchmaker_workspace_1.MATCHMAKER_WORKSPACE_TABS.forEach(tab => {
            const controller = old[tab];
            if (controller && tab !== keep)
                (0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onUnload');
        });
        this._disposing = false;
    },
    synchronizeControllers(source) {
        const session = (0, matchmaker_page_cache_1.matchmakerPageSessionScope)();
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        const scope = session ? JSON.stringify([session, revision]) : '';
        if (session !== this._workspaceSession) {
            this.disposeControllers();
            this._workspaceScope = scope;
            this._workspaceSession = session;
            this._workspaceRevision = revision;
            this._scrollPositions = {};
            this.setData({ view: {} });
        }
        else if (revision !== this._workspaceRevision) {
            const keep = source === this.data.activeTab ? source : undefined;
            this.disposeControllers(keep);
            this._workspaceScope = scope;
            this._workspaceRevision = revision;
            if (!keep) {
                this._scrollPositions = {};
                this.setData({ view: {} });
                // A denied background read clears the visible panel without starting
                // another automatic request. Its next user visit revalidates normally.
                if (session && !this._workspaceUnloaded) {
                    const controller = this.ensureController(this.data.activeTab);
                    this.setData({ view: controller.data });
                }
            }
        }
        if (scope)
            return scope;
        if (!this._workspaceUnloaded)
            wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    ensureController(tab) {
        const existing = this._controllers[tab];
        if (existing)
            return existing;
        const controller = (0, matchmaker_workspace_1.instantiateMatchmakerController)(controllers[tab], tab, (instance, safePatch, callback) => {
            if (this._disposing || this._workspaceUnloaded || this._controllers[tab] !== instance)
                return;
            this.synchronizeControllers(tab);
            if (this._controllers[tab] !== instance)
                return;
            const session = this._workspaceSession;
            const revision = this._workspaceRevision;
            const guardedCallback = callback ? () => {
                if (!this._disposing && !this._workspaceUnloaded && this._controllers[tab] === instance
                    && (0, matchmaker_page_cache_1.matchmakerPageSessionScope)() === session && (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() === revision)
                    callback();
            } : undefined;
            if (this.data.activeTab === tab && Object.keys(safePatch).length) {
                const viewPatch = Object.fromEntries(Object.entries(safePatch).map(([path, value]) => [`view.${path}`, value]));
                this.setData(viewPatch, guardedCallback);
            }
            else if (guardedCallback)
                guardedCallback();
        });
        this._controllers[tab] = controller;
        (0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onLoad', [{}]);
        return controller;
    },
    showController(tab) {
        if (this._workspaceUnloaded || !this.synchronizeControllers())
            return Promise.resolve();
        const controller = this.ensureController(tab);
        this.setData({ view: controller.data });
        return Promise.resolve((0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onShow')).then(() => undefined);
    },
    activateTab(tab) {
        if (!(0, matchmaker_workspace_1.isMatchmakerWorkspaceTab)(tab) || this._workspaceUnloaded || !this.synchronizeControllers())
            return Promise.resolve();
        if (tab === this.data.activeTab && this._controllers[tab])
            return Promise.resolve();
        const previous = this._controllers[this.data.activeTab];
        if (previous)
            (0, matchmaker_workspace_1.invokeMatchmakerController)(previous, 'onHide');
        const controller = this.ensureController(tab);
        const generation = ++this._viewGeneration;
        this.setData({ activeTab: tab, view: controller.data }, () => {
            if (generation === this._viewGeneration && typeof wx.pageScrollTo === 'function') {
                wx.pageScrollTo({ scrollTop: this._scrollPositions[tab] || 0, duration: 0 });
            }
        });
        wx.setNavigationBarTitle({ title: titles[tab] });
        return Promise.resolve((0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'onShow')).then(() => undefined);
    },
    onTabChange(event) {
        return this.activateTab(event.detail.key);
    },
    dispatchControllerEvent(tab, method, event) {
        if (tab !== this.data.activeTab || this._workspaceUnloaded)
            return undefined;
        const session = this._workspaceSession;
        const revision = this._workspaceRevision;
        if (!this.synchronizeControllers() || session !== this._workspaceSession || revision !== this._workspaceRevision)
            return undefined;
        const controller = this.ensureController(tab);
        if (tab === 'dashboard' && (method === 'goMembers' || method === 'goSalon')) {
            if (!(0, matchmaker_workspace_1.invokeMatchmakerController)(controller, 'ensureCertified'))
                return undefined;
            return this.activateTab(method === 'goMembers' ? 'members' : 'salon');
        }
        if (tab === 'messages' && method === 'goMembers')
            return this.activateTab('members');
        if (typeof controllers[tab][method] !== 'function')
            return undefined;
        return (0, matchmaker_workspace_1.invokeMatchmakerController)(controller, method, [event]);
    }
});
