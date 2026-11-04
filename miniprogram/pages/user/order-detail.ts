import { memberApi } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { cancelledMemberOrderView, memberOrderAuthError, memberOrderCancellationError, memberOrderView, validMemberOrderNumber, type MemberOrderView } from '../../utils/member-order-view'

Page({
  _scope: '', _visible: false, _lifecycle: 0, _serial: 0, _outTradeNo: '',
  _readPromise: null as Promise<void> | null,
  _cancelPromise: null as Promise<void> | null, _cancelScope: '', _cancelVersion: 0,
  data: { order: null as MemberOrderView | null, loading: false, refreshing: false, cancelling: false, errorText: '', invalidLink: false },
  onLoad(options: Record<string, string | undefined>) {
    this._outTradeNo = String(options.outTradeNo || '')
    this.setData({ invalidLink: !validMemberOrderNumber(this._outTradeNo) })
  },
  clearPrivate() { this.setData({ order: null, loading: false, refreshing: false, cancelling: false, errorText: '' }) },
  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope; this._serial += 1; this._readPromise = null; this.clearPrivate()
      this._cancelVersion += 1; this._cancelPromise = null; this._cancelScope = ''
    }
    return scope
  },
  onShow() {
    this._visible = true
    const scope = this.synchronizeSession()
    if (!scope) { wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return Promise.resolve() }
    if (this._cancelPromise && this._cancelScope === scope) {
      const lifecycle = this._lifecycle
      this.setData({ cancelling: true })
      return this._cancelPromise.then(() => {
        if (!this._visible || this._lifecycle !== lifecycle || pageSessionScope() !== scope || this._scope !== scope) return
        this.setData({ cancelling: false })
        return this.loadOrder()
      })
    }
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
  loadOrder(force = false, preserveCancellation = false): Promise<void> {
    if (!this._visible) return Promise.resolve()
    const scope = this.synchronizeSession()
    if (!scope || !this._visible || !validMemberOrderNumber(this._outTradeNo)) return Promise.resolve()
    if (this._cancelPromise && this._cancelScope === scope) return Promise.resolve()
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
        if (preserveCancellation && this.data.order?.isCancelled) {
          this.setData({ errorText: '订单已取消，最新详情暂时无法读取，请稍后刷新。' })
        } else this.setData({ order: null, errorText: '订单暂时无法读取，请确认订单后重试。' })
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
    if (this._cancelPromise) { wx.stopPullDownRefresh(); return Promise.resolve() }
    const reading = this.loadOrder(true)
    const scope = this._scope, lifecycle = this._lifecycle, serial = this._serial
    return reading.finally(() => { if (this.isCurrent(scope, lifecycle, serial)) wx.stopPullDownRefresh() })
  },
  refresh() { return this.loadOrder(true) },
  cancelOrder(): Promise<void> {
    if (!this._visible) return Promise.resolve()
    const scope = this.synchronizeSession()
    if (this._cancelPromise && this._cancelScope === scope) return this._cancelPromise
    const order = this.data.order
    if (!scope || !order?.canCancel || this.data.loading || this.data.refreshing) return Promise.resolve()
    const lifecycle = this._lifecycle, serial = ++this._serial, version = ++this._cancelVersion
    this._cancelScope = scope
    this.setData({ cancelling: true, errorText: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(scope, lifecycle, serial)) return
        const confirmed = await new Promise<boolean>(resolve => wx.showModal({
          title: '取消订单', content: '确认取消这笔订单？系统会先核对支付结果；如已付款，不会直接取消或退款。',
          confirmText: '取消订单', cancelText: '保留订单',
          success: result => resolve(result.confirm), fail: () => resolve(false)
        }))
        if (!confirmed || !this.isCurrent(scope, lifecycle, serial)) return
        const result = await memberApi.cancelPaymentOrder(order.outTradeNo)
        if (!this.isCurrent(scope, lifecycle, serial)) return
        const cancelled = cancelledMemberOrderView(order, result)
        this.setData({ order: cancelled, cancelling: false })
        this._cancelPromise = null
        await this.loadOrder(true, true)
      } catch (error) {
        const currentScope = pageSessionScope()
        if (memberOrderAuthError(error) && this.ownsRequest(scope, lifecycle, serial)
          && (!currentScope || currentScope === scope)) {
          this._serial += 1; this._readPromise = null; this.clearPrivate()
          wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return
        }
        if (this.isCurrent(scope, lifecycle, serial)) this.setData({ errorText: memberOrderCancellationError(error) })
      } finally {
        if (this._cancelVersion === version) {
          this._cancelPromise = null
          if (this._visible && this._scope === scope && pageSessionScope() === scope && this._lifecycle === lifecycle) {
            this.setData({ cancelling: false })
          }
        }
      }
    })
    this._cancelPromise = promise
    return promise
  },
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
