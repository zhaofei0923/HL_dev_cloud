import { memberApi } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { memberOrderView, validMemberOrderNumber, type MemberOrderView } from '../../utils/member-order-view'

Page({
  _scope: '', _generation: 0, _visible: false,
  data: { outTradeNo: '', order: null as MemberOrderView | null, loading: false, errorText: '' },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ outTradeNo: String(options.outTradeNo || '') })
  },
  onShow() {
    this._visible = true
    const scope = pageSessionScope()
    if (!scope) {
      this._scope = ''; this._generation += 1
      this.setData({ order: null, loading: false, errorText: '' })
      wx.redirectTo({ url: '/pages/index/index?returnTo=orders' }); return Promise.resolve()
    }
    if (this._scope !== scope) {
      this._scope = scope
      this._generation += 1
      this.setData({ order: null, loading: false, errorText: '' })
    }
    return this.refresh()
  },
  onHide() {
    this._visible = false
    this._generation += 1
    this.setData({ order: null, loading: false })
  },
  onUnload() { this.onHide() },
  async refresh() {
    if (!this._visible || !this._scope || this.data.loading) return
    const scope = this._scope, generation = ++this._generation
    const isCurrent = () => this._visible && this._scope === scope && pageSessionScope() === scope && generation === this._generation
    const outTradeNo = this.data.outTradeNo
    if (!validMemberOrderNumber(outTradeNo)) {
      this.setData({ errorText: '订单链接无效，请前往我的订单查看。' })
      return
    }
    this.setData({ loading: true, order: null, errorText: '' })
    try {
      const result = await memberApi.orderDetail(outTradeNo)
      if (!isCurrent()) return
      if (result.outTradeNo !== outTradeNo) throw new Error('订单记录不匹配')
      this.setData({ order: memberOrderView(result) })
    } catch (error) {
      if (isCurrent()) this.setData({ errorText: '订单状态暂未确认，请稍后刷新或到我的订单查询。确认前请勿重复付款。' })
    } finally {
      if (isCurrent()) this.setData({ loading: false })
    }
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
