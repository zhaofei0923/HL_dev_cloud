"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const admin_entry_1 = require("../../services/admin-entry");
const admin_console_1 = require("../../services/admin-console");
const page_session_1 = require("../../utils/page-session");
Page({
    _entryGeneration: 0, _entryVisible: false, _scope: '',
    data: {
        checking: false, ready: false, title: '正在确认管理权限', note: '请稍候。', canRetry: false,
        periodDays: 30, periods: [7, 30, 90], metrics: [], memberMetrics: [],
        matchmakerMetrics: [], products: [], ranking: [],
        memberTrend: [], revenueTrend: [], quality: '', updatedAt: '',
        modules: Object.keys(admin_console_1.RESOURCE_TITLES).map(id => ({ id, title: admin_console_1.RESOURCE_TITLES[id],
            note: ({ matchmakers: '申请详情与认证审核', certifications: '五类认证、核验材料与审核', salons: '活动审核、状态与取消', plans: '固定套餐启用与停用', orders: '支付、履约与退款记录查询', services: '已购人工服务分配、联系进展与延误延期' })[id] }))
    },
    onLoad() { wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }); },
    onShow() {
        this.clearEntry();
        this._entryVisible = true;
        this._scope = (0, page_session_1.pageSessionScope)();
        return this.loadEntry();
    },
    onHide() { this.clearEntry(); },
    onUnload() { this.clearEntry(); },
    clearEntry() {
        this._entryVisible = false;
        this._entryGeneration += 1;
        this._scope = '';
        this.setData({ ready: false, checking: false, canRetry: false, metrics: [], memberMetrics: [], matchmakerMetrics: [],
            products: [], ranking: [], memberTrend: [], revenueTrend: [], quality: '', updatedAt: '' });
    },
    current(generation, scope) {
        if (!this._entryVisible || generation !== this._entryGeneration || scope !== this._scope)
            return false;
        if (this._entryVisible && scope !== (0, page_session_1.pageSessionScope)()) {
            this.clearEntry();
            return false;
        }
        return this._entryVisible && generation === this._entryGeneration && !!scope && this._scope === scope;
    },
    async loadEntry() {
        if (this.data.checking || !this._entryVisible)
            return;
        const scope = (0, page_session_1.pageSessionScope)(), generation = ++this._entryGeneration;
        const retainAccess = !!scope && scope === this._scope && this.data.ready;
        this._scope = scope;
        this.setData({ ready: retainAccess, checking: true, canRetry: false, metrics: [], memberMetrics: [], matchmakerMetrics: [],
            products: [], ranking: [], memberTrend: [], revenueTrend: [], quality: '', updatedAt: '',
            title: retainAccess ? '管理后台' : '正在确认管理权限', note: retainAccess ? '' : '请稍候。' });
        if (!scope) {
            this.setData({ checking: false, title: '请先登录', note: '请登录已授权的管理员账号。' });
            return;
        }
        try {
            if (!retainAccess) {
                const entry = await (0, admin_entry_1.readAdminEntry)();
                if (!this.current(generation, scope))
                    return;
                if (!entry.allowed) {
                    this.setData({ checking: false, title: '当前账号没有管理权限', note: '请使用已授权的管理员账号。' });
                    return;
                }
                if (!entry.ready || entry.mode !== 'native') {
                    this.setData({ checking: false, canRetry: true, title: '管理后台尚未开放', note: '准备完成后可从这里进入。' });
                    return;
                }
                this.setData({ ready: true, title: '管理后台', note: '' });
            }
            // Refreshes keep module navigation available; overview independently checks permission.
            const overview = await (0, admin_console_1.operate)('overview', { periodDays: this.data.periodDays });
            if (!this.current(generation, scope))
                return;
            if (!overview || !overview.members || !overview.matchmakers || !overview.revenue)
                throw new Error('INVALID_OVERVIEW');
            const m = overview.members, k = overview.matchmakers, r = overview.revenue;
            const pairs = (rows) => rows.map(([label, value]) => ({ label, value }));
            const warnings = [...(overview.quality?.warnings || []), ...(m.quality?.warnings || []), ...(r.quality?.warnings || [])];
            this.setData({ checking: false, canRetry: true,
                metrics: pairs([['会员建档', (0, admin_console_1.countText)(m.total)], ['本期新增', (0, admin_console_1.countText)(m.newCount)], ['已认证主理人', (0, admin_console_1.countText)(k.approved)], ['实付', (0, admin_console_1.money)(r.paidFen)], ['退款', (0, admin_console_1.money)(r.refundFen)], ['净收款', (0, admin_console_1.money)(r.netFen)]]),
                memberMetrics: pairs([['付费会员', (0, admin_console_1.countText)(m.vip)], ['普通会员', (0, admin_console_1.countText)(m.ordinary)], ['已核验会员', (0, admin_console_1.countText)(m.verified)], ['公开资料', (0, admin_console_1.countText)(m.publicCount)]]),
                matchmakerMetrics: pairs([['待审核', (0, admin_console_1.countText)(k.pending)], ['近30天活跃', (0, admin_console_1.countText)(k.active30d)]]),
                products: (r.products || []).map(row => ({ label: row.title, value: (0, admin_console_1.money)(row.paidFen) })),
                ranking: (k.ranking || []).slice(0, 10).map(row => ({ label: (row.name ? Array.from(row.name)[0] + '**' : '未命名') + ' · ' + (row.city || '未填城市'), value: '会员 ' + (0, admin_console_1.countText)(row.memberCount) + ' / 新增 ' + (0, admin_console_1.countText)(row.newAssignments) })),
                memberTrend: (m.trend || []).map(row => ({ label: row.date, value: '新增 ' + (0, admin_console_1.countText)(row.newCount) + ' / 累计 ' + (0, admin_console_1.countText)(row.cumulative) })),
                revenueTrend: (r.trend || []).map(row => ({ label: row.date, value: '实付 ' + (0, admin_console_1.money)(row.paidFen) + ' / 退款 ' + (0, admin_console_1.money)(row.refundFen) + ' / 净收 ' + (0, admin_console_1.money)(row.netFen) })),
                quality: '— 表示暂不可统计，0 表示已核实零值。净收款未扣手续费，不代表会计收入。' + (warnings.length ? '\n' + [...new Set(warnings)].join('；') : ''),
                updatedAt: overview.asOf ? '统计截至 ' + overview.asOf : '' });
        }
        catch (failure) {
            if (!this.current(generation, scope))
                return;
            const code = (0, admin_console_1.apiCode)(failure);
            if (code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403) {
                this.clearEntry();
                this.setData({ title: code === 401 || Math.floor(code / 100) === 401 ? '登录已失效' : '当前账号没有管理权限', note: (0, admin_console_1.errorMessage)(failure) });
                return;
            }
            this.setData({ checking: false, canRetry: true, title: this.data.ready ? '经营统计暂时无法加载' : '管理权限暂时无法确认', note: (0, admin_console_1.errorMessage)(failure) });
        }
    },
    setPeriod(event) {
        if (!this.current(this._entryGeneration, this._scope) || this.data.checking)
            return;
        const days = Number(event.currentTarget.dataset.days);
        if (![7, 30, 90].includes(days) || days === this.data.periodDays)
            return;
        this.setData({ periodDays: days });
        return this.loadEntry();
    },
    openModule(event) {
        if (!this.current(this._entryGeneration, this._scope) || !this.data.ready)
            return;
        const resource = event.currentTarget.dataset.resource;
        if ((0, admin_console_1.isResource)(resource))
            wx.navigateTo({ url: '/admin-console/workspace/index?resource=' + resource });
    },
    returnToProfile() { wx.switchTab({ url: '/pages/user/profile' }); }
});
