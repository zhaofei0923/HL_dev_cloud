import { readAdminEntry } from '../../services/admin-entry'
import { operate, RESOURCE_TITLES, isResource, countText, money, errorMessage, apiCode,
  type AdminResource, type LabelValue, type Overview } from '../../services/admin-console'
import { pageSessionScope } from '../../utils/page-session'

Page({
  _entryGeneration: 0, _entryVisible: false, _scope: '',
  data: {
    checking: false, ready: false, title: '正在确认管理权限', note: '请稍候。', canRetry: false,
    periodDays: 30, periods: [7, 30, 90], metrics: [] as LabelValue[], memberMetrics: [] as LabelValue[],
    matchmakerMetrics: [] as LabelValue[], products: [] as LabelValue[], ranking: [] as LabelValue[],
    memberTrend: [] as LabelValue[], revenueTrend: [] as LabelValue[], quality: '', updatedAt: '',
    modules: (Object.keys(RESOURCE_TITLES) as AdminResource[]).map(id => ({ id, title: RESOURCE_TITLES[id],
      note: ({ matchmakers: '申请详情与认证审核', certifications: '五类认证、核验材料与审核', salons: '活动审核、状态与取消', plans: '固定套餐启用与停用', orders: '支付、履约与退款记录查询', services: '已购人工服务分配、联系进展与延误延期' })[id] }))
  },
  onLoad() { wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }) },
  onShow() {
    this.clearEntry()
    this._entryVisible = true
    this._scope = pageSessionScope()
    return this.loadEntry()
  },
  onHide() { this.clearEntry() },
  onUnload() { this.clearEntry() },
  clearEntry() {
    this._entryVisible = false
    this._entryGeneration += 1
    this._scope = ''
    this.setData({ ready: false, checking: false, canRetry: false, metrics: [], memberMetrics: [], matchmakerMetrics: [],
      products: [], ranking: [], memberTrend: [], revenueTrend: [], quality: '', updatedAt: '' })
  },
  current(generation: number, scope: string) {
    if (!this._entryVisible || generation !== this._entryGeneration || scope !== this._scope) return false
    if (this._entryVisible && scope !== pageSessionScope()) { this.clearEntry(); return false }
    return this._entryVisible && generation === this._entryGeneration && !!scope && this._scope === scope
  },
  async loadEntry() {
    if (this.data.checking || !this._entryVisible) return
    const scope = pageSessionScope(), generation = ++this._entryGeneration
    const retainAccess = !!scope && scope === this._scope && this.data.ready
    this._scope = scope
    this.setData({ ready: retainAccess, checking: true, canRetry: false, metrics: [], memberMetrics: [], matchmakerMetrics: [],
      products: [], ranking: [], memberTrend: [], revenueTrend: [], quality: '', updatedAt: '',
      title: retainAccess ? '管理后台' : '正在确认管理权限', note: retainAccess ? '' : '请稍候。' })
    if (!scope) { this.setData({ checking: false, title: '请先登录', note: '请登录已授权的管理员账号。' }); return }
    try {
      if (!retainAccess) {
        const entry = await readAdminEntry()
        if (!this.current(generation, scope)) return
        if (!entry.allowed) { this.setData({ checking: false, title: '当前账号没有管理权限', note: '请使用已授权的管理员账号。' }); return }
        if (!entry.ready || entry.mode !== 'native') { this.setData({ checking: false, canRetry: true, title: '管理后台尚未开放', note: '准备完成后可从这里进入。' }); return }
        this.setData({ ready: true, title: '管理后台', note: '' })
      }
      // Refreshes keep module navigation available; overview independently checks permission.
      const overview = await operate<Overview>('overview', { periodDays: this.data.periodDays })
      if (!this.current(generation, scope)) return
      if (!overview || !overview.members || !overview.matchmakers || !overview.revenue) throw new Error('INVALID_OVERVIEW')
      const m = overview.members, k = overview.matchmakers, r = overview.revenue
      const pairs = (rows: [string, string][]) => rows.map(([label, value]) => ({ label, value }))
      const warnings = [...(overview.quality?.warnings || []), ...(m.quality?.warnings || []), ...(r.quality?.warnings || [])]
      this.setData({ checking: false, canRetry: true,
        metrics: pairs([['会员建档', countText(m.total)], ['本期新增', countText(m.newCount)], ['已认证主理人', countText(k.approved)], ['实付', money(r.paidFen)], ['退款', money(r.refundFen)], ['净收款', money(r.netFen)]]),
        memberMetrics: pairs([['付费会员', countText(m.vip)], ['普通会员', countText(m.ordinary)], ['已核验会员', countText(m.verified)], ['公开资料', countText(m.publicCount)]]),
        matchmakerMetrics: pairs([['待审核', countText(k.pending)], ['近30天活跃', countText(k.active30d)]]),
        products: (r.products || []).map(row => ({ label: row.title, value: money(row.paidFen) })),
        ranking: (k.ranking || []).slice(0, 10).map(row => ({ label: (row.name ? Array.from(row.name)[0] + '**' : '未命名') + ' · ' + (row.city || '未填城市'), value: '会员 ' + countText(row.memberCount) + ' / 新增 ' + countText(row.newAssignments) })),
        memberTrend: (m.trend || []).map(row => ({ label: row.date, value: '新增 ' + countText(row.newCount) + ' / 累计 ' + countText(row.cumulative) })),
        revenueTrend: (r.trend || []).map(row => ({ label: row.date, value: '实付 ' + money(row.paidFen) + ' / 退款 ' + money(row.refundFen) + ' / 净收 ' + money(row.netFen) })),
        quality: '— 表示暂不可统计，0 表示已核实零值。净收款未扣手续费，不代表会计收入。' + (warnings.length ? '\n' + [...new Set(warnings)].join('；') : ''),
        updatedAt: overview.asOf ? '统计截至 ' + overview.asOf : '' })
    } catch (failure) {
      if (!this.current(generation, scope)) return
      const code = apiCode(failure)
      if (code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403) {
        this.clearEntry()
        this.setData({ title: code === 401 || Math.floor(code / 100) === 401 ? '登录已失效' : '当前账号没有管理权限', note: errorMessage(failure) })
        return
      }
      this.setData({ checking: false, canRetry: true, title: this.data.ready ? '经营统计暂时无法加载' : '管理权限暂时无法确认', note: errorMessage(failure) })
    }
  },
  setPeriod(event: WechatMiniprogram.TouchEvent) {
    if (!this.current(this._entryGeneration, this._scope) || this.data.checking) return
    const days = Number(event.currentTarget.dataset.days)
    if (![7, 30, 90].includes(days) || days === this.data.periodDays) return
    this.setData({ periodDays: days })
    return this.loadEntry()
  },
  openModule(event: WechatMiniprogram.TouchEvent) {
    if (!this.current(this._entryGeneration, this._scope) || !this.data.ready) return
    const resource: unknown = event.currentTarget.dataset.resource
    if (isResource(resource)) wx.navigateTo({ url: '/admin-console/workspace/index?resource=' + resource })
  },
  returnToProfile() { wx.switchTab({ url: '/pages/user/profile' }) }
})
