import { memberApi } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { memberOrderAuthError, memberOrderView, validMemberOrderNumber, type MemberOrderView } from '../../utils/member-order-view'

Page({
  _scope: '', _visible: false, _lifecycle: 0, _serial: 0, _outTradeNo: '',
  _readPromise: null as Promise<void> | null,
  data: { order: null as MemberOrderView | null, loading: false, refreshing: false, errorText: '', invalidLink: false },
  onLoad(options: Record<string, string | undefined>) {
    this._outTradeNo = String(options.outTradeNo || '')
    this.setData({ invalidLink: !validMemberOrderNumber(this._outTradeNo) })
  },
  clearPrivate() { this.setData({ order: null, loading: false, refreshing: false, errorText: '' }) },
  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope; this._serial += 1; this._readPromise = null; this.clearPrivate()
    }
    return scope
  },
  onShow() {
    this._visible = true
    const scope = this.synchronizeSession()
    if (!scope) { wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return Promise.resolve() }
    return this.loadOrder()
  },
  onHide() {
    this._visible = false; this._lifecycle += 1; this._serial += 1; this._readPromise = null; this.clearPrivate()
  },
  onUnload() { this.onHide() },
  ownsRequest(scope: string, lifecycle: number, serial: number) {
    return this._visible && this._scope === scope && lifecycle === this._lifecycle && serial === this._serial
  },
  isCurrent(scope: string, lifecycle: number, serial: number) {
    return this.ownsRequest(scope, lifecycle, serial) && pageSessionScope() === scope
  },
  loadOrder(force = false): Promise<void> {
    if (!this._visible) return Promise.resolve()
    const scope = this.synchronizeSession()
    if (!scope || !this._visible || !validMemberOrderNumber(this._outTradeNo)) return Promise.resolve()
    if (!force && this._readPromise) return this._readPromise
    const outTradeNo = this._outTradeNo, lifecycle = this._lifecycle, serial = ++this._serial
    this.setData({ loading: !this.data.order, refreshing: !!this.data.order, errorText: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(scope, lifecycle, serial)) return
        const result = await memberApi.orderDetail(outTradeNo)
        if (!this.isCurrent(scope, lifecycle, serial)) return
        if (!result || result.outTradeNo !== outTradeNo) throw new Error('订单记录不匹配')
        this.setData({ order: memberOrderView(result) })
      } catch (error) {
        const currentScope = pageSessionScope()
        if (memberOrderAuthError(error) && this.ownsRequest(scope, lifecycle, serial)
          && (!currentScope || currentScope === scope)) {
          this._serial += 1; this._readPromise = null; this.clearPrivate()
          wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return
        }
        if (!this.isCurrent(scope, lifecycle, serial)) return
        this.setData({ order: null, errorText: '订单暂时无法读取，请确认订单后重试。' })
      } finally {
        if (this.isCurrent(scope, lifecycle, serial)) {
          this._readPromise = null; this.setData({ loading: false, refreshing: false })
        }
      }
    })
    this._readPromise = promise
    return promise
  },
  onPullDownRefresh() {
    const reading = this.loadOrder(true)
    const scope = this._scope, lifecycle = this._lifecycle, serial = this._serial
    return reading.finally(() => { if (this.isCurrent(scope, lifecycle, serial)) wx.stopPullDownRefresh() })
  },
  refresh() { return this.loadOrder(true) },
  copyOrderNumber() {
    if (!this._visible || !this.synchronizeSession() || !this.data.order) return
    wx.setClipboardData({ data: this.data.order.outTradeNo })
  },
  openPrivileges() {
    if (!this._visible || !this.synchronizeSession() || !this.data.order) return
    wx.navigateTo({ url: this.data.order.productType === 'matchmaker' ? '/pages/matchmaker/activation' : this.data.order.productType === 'matchmaking'
      ? '/pages/user/vip-privileges?type=matchmaking' : '/pages/user/vip-privileges' })
  },
  openOrders() {
    if (!this._visible || !this.synchronizeSession()) return
    wx.redirectTo({ url: '/pages/user/orders' })
  }
})
