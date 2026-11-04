import { memberApi } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { cancelledMemberOrderView, memberOrderAuthError, memberOrderCancellationError, memberOrderView, validMemberOrderNumber, type MemberOrderView } from '../../utils/member-order-view'

Page({
  _scope: '', _generation: 0, _visible: false,
  _cancelPromise: null as Promise<void> | null, _cancelScope: '', _cancelVersion: 0,
  data: { outTradeNo: '', order: null as MemberOrderView | null, loading: false, cancelling: false, errorText: '' },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ outTradeNo: String(options.outTradeNo || '') })
  },
  onShow() {
    this._visible = true
    const scope = pageSessionScope()
    if (!scope) {
      this._scope = ''; this._generation += 1
      this._cancelVersion += 1; this._cancelPromise = null; this._cancelScope = ''
      this.setData({ order: null, loading: false, cancelling: false, errorText: '' })
      wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return Promise.resolve()
    }
    if (this._scope !== scope) {
      this._scope = scope
      this._generation += 1
      this._cancelVersion += 1; this._cancelPromise = null; this._cancelScope = ''
      this.setData({ order: null, loading: false, cancelling: false, errorText: '' })
    }
    if (this._cancelPromise && this._cancelScope === scope) {
      const generation = this._generation
      this.setData({ cancelling: true })
      return this._cancelPromise.then(() => {
        if (!this._visible || generation !== this._generation || this._scope !== scope || pageSessionScope() !== scope) return
        this.setData({ cancelling: false })
        return this.refresh()
      })
    }
    return this.refresh()
  },
  onHide() {
    this._visible = false
    this._generation += 1
    this.setData({ order: null, loading: false, cancelling: false })
  },
  onUnload() { this.onHide() },
  async refresh(preserveCancellation = false) {
    if (!this._visible || !this._scope || pageSessionScope() !== this._scope || this.data.loading || this._cancelPromise) return
    const scope = this._scope, generation = ++this._generation
    const isCurrent = () => this._visible && this._scope === scope && pageSessionScope() === scope && generation === this._generation
    const outTradeNo = this.data.outTradeNo
    if (!validMemberOrderNumber(outTradeNo)) {
      this.setData({ errorText: '订单链接无效，请前往我的订单查看。' })
      return
    }
    const cancelledFallback = preserveCancellation === true && this.data.order?.isCancelled ? this.data.order : null
    this.setData({ loading: true, order: cancelledFallback, errorText: '' })
    try {
      const result = await memberApi.orderDetail(outTradeNo)
      if (!isCurrent()) return
      if (result.outTradeNo !== outTradeNo) throw new Error('订单记录不匹配')
      this.setData({ order: memberOrderView(result) })
    } catch (error) {
      if (isCurrent()) this.setData({ errorText: cancelledFallback
        ? '订单已取消，最新详情暂时无法读取，请稍后刷新。'
        : '订单状态暂未确认，请稍后刷新或到我的订单查询。确认前请勿重复付款。' })
    } finally {
      if (isCurrent()) this.setData({ loading: false })
    }
  },
  cancelOrder(): Promise<void> {
    if (!this._visible || !this._scope || pageSessionScope() !== this._scope) return Promise.resolve()
    if (this._cancelPromise) return this._cancelPromise
    const order = this.data.order
    if (!order?.canCancel || this.data.loading) return Promise.resolve()
    const scope = this._scope, generation = ++this._generation, version = ++this._cancelVersion
    const isCurrent = () => this._visible && this._scope === scope && pageSessionScope() === scope && generation === this._generation
    this._cancelScope = scope
    this.setData({ cancelling: true, errorText: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return
        const confirmed = await new Promise<boolean>(resolve => wx.showModal({
          title: '取消订单', content: '确认取消这笔订单？系统会先核对支付结果；如已付款，不会直接取消或退款。',
          confirmText: '取消订单', cancelText: '保留订单',
          success: result => resolve(result.confirm), fail: () => resolve(false)
        }))
        if (!confirmed || !isCurrent()) return
        const result = await memberApi.cancelPaymentOrder(order.outTradeNo)
        if (!isCurrent()) return
        this.setData({ order: cancelledMemberOrderView(order, result), cancelling: false })
        this._cancelPromise = null
        await this.refresh(true)
      } catch (error) {
        const currentScope = pageSessionScope()
        if (memberOrderAuthError(error) && this._visible && this._scope === scope && generation === this._generation
          && (!currentScope || currentScope === scope)) {
          this._generation += 1
          this.setData({ order: null, loading: false, cancelling: false, errorText: '' })
          wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return
        }
        if (isCurrent()) this.setData({ errorText: memberOrderCancellationError(error) })
      } finally {
        if (version === this._cancelVersion) {
          this._cancelPromise = null
          if (isCurrent()) this.setData({ cancelling: false })
        }
      }
    })
    this._cancelPromise = promise
    return promise
  },
  openOrder() {
    if (!this._visible || pageSessionScope() !== this._scope) return
    wx.navigateTo({ url: validMemberOrderNumber(this.data.outTradeNo)
      ? `/pages/user/order-detail?outTradeNo=${encodeURIComponent(this.data.outTradeNo)}` : '/pages/user/orders' })
  },
  returnToMembership() {
    if (!this._visible || pageSessionScope() !== this._scope) return
    wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/user/membership' }) })
  },
  continueBrowsing() { wx.switchTab({ url: '/pages/user/members' }) }
})
