import { operate, isResource, RESOURCE_TITLES, filterOptions, KIND_LABELS, listCard, detailRoute, errorMessage, apiCode,
  type AdminResource, type AdminList, type ListCard, type FilterOption, type AdminArgs } from '../../services/admin-console'
import { pageSessionScope } from '../../utils/page-session'

Page({
  _visible: false, _generation: 0, _scope: '', _valid: false,
  data: {
    resource: 'matchmakers' as AdminResource, title: '', keyword: '', filterIndex: 0, kindIndex: 0,
    filters: [] as FilterOption[], kinds: [{ label: '全部认证类型', value: '' }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))],
    fulfillmentIndex: 0, fulfillmentOptions: [{ label: '全部履约状态', value: '' }, { label: '已履约', value: 'fulfilled' }, { label: '待核查', value: 'requires_review' }],
    productIndex: 0, productOptions: [{ label: '全部产品类型', value: '' }, { label: '会员服务', value: 'vip' }, { label: '婚恋服务', value: 'matchmaking' }, { label: '历史产品', value: 'legacy' }],
    userIdFilter: '', rows: [] as ListCard[], page: 1, pageSize: 10, total: 0, loading: false, ready: false, error: '', hasNext: false
  },
  onLoad(options: Record<string, string | undefined>) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    this._valid = isResource(options.resource)
    if (this._valid && isResource(options.resource)) {
      const resource = options.resource
      this.setData({ resource, title: RESOURCE_TITLES[resource], filters: filterOptions(resource) })
      wx.setNavigationBarTitle({ title: RESOURCE_TITLES[resource] })
    }
  },
  onShow() {
    this.clearPrivate()
    this._visible = true
    this._scope = pageSessionScope()
    return this.loadPage(1)
  },
  onHide() { this.clearPrivate() },
  onUnload() { this.clearPrivate() },
  clearPrivate() {
    this._visible = false; this._generation += 1; this._scope = ''
    this.setData({ rows: [], keyword: '', userIdFilter: '', ready: false, loading: false, error: '', total: 0, page: 1, hasNext: false })
  },
  current(generation: number, scope: string) {
    if (!this._visible || generation !== this._generation || scope !== this._scope) return false
    if (this._visible && scope !== pageSessionScope()) { this.clearPrivate(); return false }
    return this._visible && !!scope && scope === this._scope && generation === this._generation
  },
  async loadPage(page: number) {
    if (!this._visible || this.data.loading) return
    if (!this._valid || !this._scope) { this.setData({ error: this._valid ? '请先登录管理员账号。' : '管理模块无效，请返回总览重新进入。' }); return }
    const scope = this._scope, generation = ++this._generation
    const selected = this.data.filters[this.data.filterIndex]?.value || ''
    const args: AdminArgs = { page, pageSize: this.data.pageSize, keyword: this.data.keyword.trim() }
    if (selected) args[this.data.resource === 'plans' ? 'active' : 'status'] = this.data.resource === 'plans' ? selected === 'true' : selected
    if (this.data.resource === 'certifications' && this.data.kindIndex) args.kind = this.data.kinds[this.data.kindIndex].value
    if (this.data.resource === 'orders') {
      if (this.data.fulfillmentIndex) args.fulfillmentStatus = this.data.fulfillmentOptions[this.data.fulfillmentIndex].value
      if (this.data.productIndex) args.productType = this.data.productOptions[this.data.productIndex].value
      if (this.data.userIdFilter.trim()) {
        const id = Number(this.data.userIdFilter)
        if (!/^[1-9]\d*$/.test(this.data.userIdFilter.trim()) || !Number.isSafeInteger(id)) { this.setData({ error: '会员编号须为正整数。' }); return }
        args.userId = id
      }
    }
    this.setData({ loading: true, ready: false, rows: [], error: '' })
    try {
      // Every operation checks the current administrator on the server.
      const result = await operate<AdminList>(`${this.data.resource}.list`, args)
      if (!this.current(generation, scope)) return
      if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.page !== page || result.pageSize !== this.data.pageSize || result.list.length > this.data.pageSize) throw new Error('INVALID_LIST')
      this.setData({ loading: false, ready: true, rows: result.list.map(row => listCard(this.data.resource, row)),
        total: result.total, page: result.page, hasNext: result.page * result.pageSize < result.total })
    } catch (failure) {
      if (!this.current(generation, scope)) return
      const code = apiCode(failure)
      if (code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403) this.clearPrivate()
      this.setData({ loading: false, error: errorMessage(failure), rows: [], ready: false, total: 0, hasNext: false })
    }
  },
  onKeyword(event: WechatMiniprogram.Input) {
    if (this.current(this._generation, this._scope) && !this.data.loading) this.setData({ keyword: event.detail.value.slice(0, 80) })
  },
  onUserId(event: WechatMiniprogram.Input) {
    if (this.current(this._generation, this._scope) && !this.data.loading) this.setData({ userIdFilter: event.detail.value.slice(0, 16) })
  },
  setFilter(event: WechatMiniprogram.PickerChange) {
    if (!this.current(this._generation, this._scope) || this.data.loading) return
    const field: unknown = event.currentTarget.dataset.field, index = Number(event.detail.value)
    const options = field === 'kindIndex' ? this.data.kinds : field === 'fulfillmentIndex' ? this.data.fulfillmentOptions : field === 'productIndex' ? this.data.productOptions : field === 'filterIndex' ? this.data.filters : null
    if (!options || !Number.isInteger(index) || !options[index]) return
    if (field === 'kindIndex') this.setData({ kindIndex: index })
    else if (field === 'fulfillmentIndex') this.setData({ fulfillmentIndex: index })
    else if (field === 'productIndex') this.setData({ productIndex: index })
    else this.setData({ filterIndex: index })
    return this.loadPage(1)
  },
  search() { if (this.current(this._generation, this._scope)) return this.loadPage(1) },
  previous() { if (this.current(this._generation, this._scope) && this.data.page > 1) return this.loadPage(this.data.page - 1) },
  next() { if (this.current(this._generation, this._scope) && this.data.hasNext) return this.loadPage(this.data.page + 1) },
  openDetail(event: WechatMiniprogram.TouchEvent) {
    if (!this.current(this._generation, this._scope) || this.data.loading || !this.data.ready) return
    const index = Number(event.currentTarget.dataset.index), row = this.data.rows[index]
    if (row?.canOpen) wx.navigateTo({ url: detailRoute(this.data.resource, row.key) })
  },
  goOverview() { wx.navigateBack({ delta: 1 }) }
})
