import { memberApi } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { memberOrderAuthError, memberOrderView, validMemberOrderNumber, type MemberOrderView } from '../../utils/member-order-view'

const PAGE_SIZE = 20

Page({
  _scope: '', _visible: false, _lifecycle: 0, _serial: 0,
  _readPromise: null as Promise<void> | null,
  data: {
    list: [] as MemberOrderView[], page: 0, total: 0, hasMore: false,
    initialized: false, loading: false, refreshing: false, loadingMore: false, errorText: '', moreError: ''
  },
  clearPrivate() {
    this.setData({ list: [], page: 0, total: 0, hasMore: false, initialized: false,
      loading: false, refreshing: false, loadingMore: false, errorText: '', moreError: '' })
  },
  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope; this._serial += 1; this._readPromise = null
      this.clearPrivate()
    }
    return scope
  },
  onShow() {
    this._visible = true
    const scope = this.synchronizeSession()
    if (!scope) { wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return Promise.resolve() }
    return this.loadOrders(true)
  },
  onHide() {
    this._visible = false; this._lifecycle += 1; this._serial += 1; this._readPromise = null
    this.clearPrivate()
  },
  onUnload() { this.onHide() },
  ownsRequest(scope: string, lifecycle: number, serial: number) {
    return this._visible && this._scope === scope && lifecycle === this._lifecycle && serial === this._serial
  },
  isCurrent(scope: string, lifecycle: number, serial: number) {
    return this.ownsRequest(scope, lifecycle, serial) && pageSessionScope() === scope
  },
  loadOrders(reset = false, force = false): Promise<void> {
    if (!this._visible) return Promise.resolve()
    const scope = this.synchronizeSession()
    if (!scope || !this._visible) return Promise.resolve()
    if (!force && this._readPromise) return this._readPromise
    if (!reset && (!this.data.hasMore || !this.data.initialized)) return Promise.resolve()
    const page = reset ? 1 : this.data.page + 1
    const lifecycle = this._lifecycle, serial = ++this._serial
    this.setData({ loading: reset && !this.data.list.length, refreshing: reset && !!this.data.list.length,
      loadingMore: !reset, errorText: '', moreError: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(scope, lifecycle, serial)) return
        const result = await memberApi.orders(page, PAGE_SIZE)
        if (!this.isCurrent(scope, lifecycle, serial)) return
        if (!result || !Array.isArray(result.list) || result.page !== page || result.pageSize !== PAGE_SIZE
          || !Number.isSafeInteger(result.total) || result.total < 0 || typeof result.hasMore !== 'boolean'
          || result.list.length > PAGE_SIZE) throw new Error('订单列表不完整')
        const incoming = result.list.map(memberOrderView)
        const previous = reset ? [] : this.data.list
        const seen = new Set(previous.map(order => order.outTradeNo))
        const list = [...previous, ...incoming.filter(order => {
          if (seen.has(order.outTradeNo)) return false
          seen.add(order.outTradeNo); return true
        })]
        this.setData({ list, page, total: result.total, hasMore: result.hasMore, initialized: true })
      } catch (error) {
        const currentScope = pageSessionScope()
        if (memberOrderAuthError(error) && this.ownsRequest(scope, lifecycle, serial)
          && (!currentScope || currentScope === scope)) {
          this._serial += 1; this._readPromise = null; this.clearPrivate()
          wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return
        }
        if (!this.isCurrent(scope, lifecycle, serial)) return
        this.setData(reset ? { errorText: '订单暂时无法读取，请稍后重试。' } : { moreError: '更多订单暂时无法读取，请重试。' })
      } finally {
        if (this.isCurrent(scope, lifecycle, serial)) {
          this._readPromise = null
          this.setData({ loading: false, refreshing: false, loadingMore: false })
        }
      }
    })
    this._readPromise = promise
    return promise
  },
  onPullDownRefresh() {
    const reading = this.loadOrders(true, true)
    const scope = this._scope, lifecycle = this._lifecycle, serial = this._serial
    return reading.finally(() => { if (this.isCurrent(scope, lifecycle, serial)) wx.stopPullDownRefresh() })
  },
  retry() { return this.loadOrders(true, true) },
  loadMore() { return this.loadOrders(false) },
  onReachBottom() { return this.loadMore() },
  openOrder(e: WechatMiniprogram.TouchEvent) {
    if (!this._visible) return
    const scope = this.synchronizeSession()
    const outTradeNo = e.currentTarget.dataset.outTradeNo
    if (!scope || !this._visible || !validMemberOrderNumber(outTradeNo)
      || !this.data.list.some(order => order.outTradeNo === outTradeNo)) return
    wx.navigateTo({ url: `/pages/user/order-detail?outTradeNo=${encodeURIComponent(outTradeNo)}` })
  }
})
