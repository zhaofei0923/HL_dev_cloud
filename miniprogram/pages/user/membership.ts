import { bindWechatPhone } from '../../services/auth'
import { chatApi } from '../../services/chat'
import { pageSessionScope } from '../../utils/page-session'
import {
  memberApi,
  type MembershipOrderCheckout,
  type MembershipOverview,
  type MembershipPaymentOrder,
  type MembershipPlan
} from '../../services/member'

type MembershipPlanView = MembershipPlan & {
  durationText: string
  descriptionText: string
}

type PaymentParams = {
  timeStamp: string
  nonceStr: string
  package: string
  signType?: 'MD5' | 'HMAC-SHA256' | 'RSA'
  paySign: string
}

const EMPTY_OVERVIEW: MembershipOverview = {
  isPremiumMember: false,
  phoneBound: false,
  phoneMasked: '',
  needsMatchmaker: false,
  membership: null,
  plans: [],
  payment: {
    available: false,
    reason: 'merchant_not_configured',
    functionName: '',
    createPath: ''
  }
}

function durationText(days: number) {
  if (days % 365 === 0) return `${days / 365} 年`
  if (days % 30 === 0) return `${days / 30} 个月`
  return `${days} 天`
}

function expiryText(overview: MembershipOverview) {
  if (!overview.membership) return '尚未建立会员服务关系'
  if (overview.membership.lifetime) return '长期有效'
  if (!overview.membership.expireAt) return '尚未开通付费权益'
  const date = new Date(overview.membership.expireAt)
  if (Number.isNaN(date.getTime())) return '会员有效期待确认'
  return `有效期至 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function paymentReasonText(reason: string) {
  const labels: Record<string, string> = {
    merchant_not_configured: '请联系主理人开通会员',
    integration_incomplete: '请联系主理人开通会员',
    member_assignment_required: '绑定主理人后可开通会员',
    phone_required: '授权微信手机号后可付款',
    plans_not_configured: '请联系主理人了解会员方案'
  }
  return labels[reason] || '微信支付暂不可用'
}

function paymentParamsFrom(result: any): PaymentParams {
  const body = result && result.data
  const payload = (body && body.data) || (body && body.payment) || body || {}
  const params = payload.payment || payload
  if (!params.timeStamp || !params.nonceStr || !params.package || !params.paySign) {
    throw new Error('支付函数未返回完整的调起参数')
  }
  return {
    timeStamp: String(params.timeStamp),
    nonceStr: String(params.nonceStr),
    package: String(params.package),
    signType: params.signType || 'RSA',
    paySign: String(params.paySign)
  }
}

function wait(delay: number) {
  return new Promise<void>(resolve => setTimeout(resolve, delay))
}

function orderFeedback(status: string) {
  const feedback: Record<string, { title: string; note: string }> = {
    paid: { title: '会员已开通', note: '付款已确认，会员权益已经生效。' },
    closed: { title: '订单已关闭', note: '此订单已关闭，未开通会员权益。需要开通时可重新选择套餐。' },
    failed: { title: '支付未成功', note: '此订单支付失败，未开通会员权益。请查看订单结果后重试。' },
    refunded: { title: '订单已退款', note: '此订单已退款，到账情况请查看微信支付账单。会员状态以当前权益为准。' }
  }
  return feedback[status] || { title: '付款结果确认中', note: '暂未收到最终结果，请查询订单状态。确认前请勿重复付款。' }
}

Page({
  _membershipScope: '',
  _resumableCheckout: null as MembershipOrderCheckout | null,
  data: {
    loading: true,
    refreshing: false,
    phoneAuthorizing: false,
    paymentStarting: false,
    confirming: false,
    overview: EMPTY_OVERVIEW,
    plans: [] as MembershipPlanView[],
    selectedPlanCode: '',
    statusTitle: '会员权益',
    expiryText: '',
    paymentActionText: '联系主理人开通',
    onlineCheckout: false,
    lastOrderId: '',
    orderTitle: '',
    orderNote: '',
    orderStatus: '',
    orderChecking: false,
    orderCanResume: false,
    orderPlanText: '',
    errorText: ''
  },

  onShow() {
    this.loadOverview()
  },

  onPullDownRefresh() {
    this.loadOverview({ pullDown: true })
  },

  async loadOverview(options: { pullDown?: boolean } = {}) {
    const scope = pageSessionScope()
    if (scope !== this._membershipScope) {
      this._membershipScope = scope
      this._resumableCheckout = null
      this.setData({ overview: EMPTY_OVERVIEW, plans: [], onlineCheckout: false, selectedPlanCode: '',
        lastOrderId: '', orderTitle: '', orderNote: '', orderStatus: '', orderChecking: false, orderCanResume: false,
        orderPlanText: '', paymentStarting: false, confirming: false })
    }
    if (options.pullDown) this.setData({ refreshing: true })
    else this.setData({ loading: true })
    try {
      const overview = await memberApi.membershipOverview()
      if (pageSessionScope() !== scope) return
      const plans = overview.plans.map(plan => ({
        ...plan,
        durationText: durationText(plan.durationDays),
        descriptionText: plan.description || `${durationText(plan.durationDays)}会员权益`
      }))
      const selectedPlanCode = plans.some(plan => plan.planCode === this.data.selectedPlanCode)
        ? this.data.selectedPlanCode
        : (plans[0] ? plans[0].planCode : '')
      this.setData({
        overview,
        plans,
        selectedPlanCode,
        onlineCheckout: plans.length > 0 && (overview.payment.available || overview.payment.reason === 'phone_required'),
        statusTitle: overview.isPremiumMember ? '会员权益已开通' : '开通会员权益',
        expiryText: expiryText(overview),
        paymentActionText: overview.payment.available
          ? (overview.isPremiumMember ? '微信支付续费' : '微信支付开通会员')
          : paymentReasonText(overview.payment.reason),
        errorText: ''
      })
    } catch (err) {
      if (pageSessionScope() !== scope) return
      console.warn('load membership overview failed', err)
      this.setData({ errorText: '会员信息暂时无法加载，请稍后重试。' })
    } finally {
      if (pageSessionScope() === scope) this.setData({ loading: false, refreshing: false })
      if (options.pullDown) wx.stopPullDownRefresh()
    }
  },

  selectPlan(e: WechatMiniprogram.TouchEvent) {
    const planCode = String(e.currentTarget.dataset.code || '')
    if (!planCode || this.data.paymentStarting || this.data.confirming || this.data.orderCanResume) return
    this.setData({ selectedPlanCode: planCode })
  },

  onPlanChange(e: WechatMiniprogram.RadioGroupChange) {
    if (this.data.paymentStarting || this.data.confirming || this.data.orderCanResume) return
    if (this.data.plans.some(plan => plan.planCode === e.detail.value)) this.setData({ selectedPlanCode: e.detail.value })
  },

  async authorizePhone(e: WechatMiniprogram.ButtonGetPhoneNumber) {
    if (this.data.phoneAuthorizing) return
    const detail = e.detail as any
    const code = String(detail.code || '')
    if (!code) {
      wx.showToast({ title: '未授权手机号', icon: 'none' })
      return
    }
    this.setData({ phoneAuthorizing: true })
    try {
      await bindWechatPhone(code)
      wx.showToast({ title: '手机号已授权' })
      await this.loadOverview()
    } catch (err) {
      console.warn('bind wechat phone failed', err)
    } finally {
      this.setData({ phoneAuthorizing: false })
    }
  },

  async contactMatchmaker() {
    try {
      const conversations = await chatApi.listConversations({ page: 1, pageSize: 100 })
      const serviceConversation = conversations.list.find(item => item.conversationType === 'member_matchmaker')
      if (serviceConversation) {
        wx.navigateTo({ url: `/pages/user/chat?id=${serviceConversation.id}` })
        return
      }
    } catch (err) {
      console.warn('load principal conversation failed', err)
    }
    wx.showModal({
      title: '绑定主理人',
      content: '请先在“我的”页面添加主理人，再联系主理人完成会员服务。',
      confirmText: '前往绑定',
      success: res => {
        if (res.confirm) wx.switchTab({ url: '/pages/user/profile' })
      }
    })
  },

  async callPaymentFunction(checkout: MembershipOrderCheckout) {
    const payment = checkout.payment
    const callHTTPFunction = (wx.cloud as any).callHTTPFunction
    if (typeof callHTTPFunction !== 'function') throw new Error('当前微信基础库不支持支付函数调用')
    const result = await new Promise<any>((resolve, reject) => {
      callHTTPFunction({
        name: payment.functionName,
        path: payment.createPath,
        method: 'POST',
        config: { env: getApp<IAppOption>().globalData.env },
        header: { 'Content-Type': 'application/json' },
        data: { outTradeNo: checkout.order.outTradeNo },
        success: resolve,
        fail: reject
      })
    })
    return paymentParamsFrom(result)
  },

  requestPayment(params: PaymentParams) {
    return new Promise<void>((resolve, reject) => {
      wx.requestPayment({
        ...params,
        success: () => resolve(),
        fail: reject
      })
    })
  },

  async pollPaymentOrder(outTradeNo: string) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const order: MembershipPaymentOrder = await memberApi.membershipOrder(outTradeNo)
      if (order.status === 'paid') return order
      if (['closed', 'failed', 'refunded'].includes(order.status)) return order
      await wait(1500)
    }
    return memberApi.membershipOrder(outTradeNo)
  },

  async showOrderResult(order: MembershipPaymentOrder, modal = false) {
    const feedback = orderFeedback(order.status)
    if (['paid', 'closed', 'failed', 'refunded'].includes(order.status)) {
      this._resumableCheckout = null
      this.setData({ orderCanResume: false })
    }
    this.setData({ orderTitle: feedback.title, orderNote: feedback.note, orderStatus: order.status })
    if (order.status === 'paid' || order.status === 'refunded') await this.loadOverview()
    if (modal) wx.showModal({ title: feedback.title, content: feedback.note, showCancel: false })
  },

  async refreshOrderStatus() {
    if (!this.data.lastOrderId || this.data.orderChecking || this.data.confirming) return
    const scope = pageSessionScope()
    const orderId = this.data.lastOrderId
    this.setData({ orderChecking: true })
    try {
      const order = await memberApi.membershipOrder(orderId)
      if (pageSessionScope() !== scope || this.data.lastOrderId !== orderId) return
      await this.showOrderResult(order)
    } catch (error) {
      if (pageSessionScope() !== scope) return
      this.setData({ orderNote: '暂时无法查询订单，请稍后重试。确认结果前请勿重复付款。' })
      console.warn('refresh membership order failed', error)
    } finally {
      if (pageSessionScope() === scope) this.setData({ orderChecking: false })
    }
  },

  async startPayment() {
    if (this.data.paymentStarting || this.data.confirming) return
    const scope = pageSessionScope()
    if (this.data.lastOrderId && !this.data.orderCanResume && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus)) {
      await this.refreshOrderStatus()
      if (pageSessionScope() === scope) wx.showToast({ title: '请查看上一笔订单结果', icon: 'none' })
      return
    }
    const overview = this.data.overview as MembershipOverview
    if (!overview.payment.available) {
      if (overview.payment.reason === 'member_assignment_required') {
        this.contactMatchmaker()
        return
      }
      wx.showToast({ title: paymentReasonText(overview.payment.reason), icon: 'none' })
      return
    }
    if (!this.data.selectedPlanCode) {
      wx.showToast({ title: '请选择会员套餐', icon: 'none' })
      return
    }

    this.setData({ paymentStarting: true })
    let paymentRequested = false
    try {
      const checkout = this.data.orderCanResume && this._resumableCheckout
        ? this._resumableCheckout : await memberApi.createMembershipOrder(this.data.selectedPlanCode)
      if (pageSessionScope() !== scope) return
      this._resumableCheckout = checkout
      const orderPlanText = `${checkout.order.planTitle || '会员套餐'}${Number.isFinite(checkout.order.amountFen) ? ` · ¥${(checkout.order.amountFen / 100).toFixed(2)}` : ''}`
      this.setData({ lastOrderId: checkout.order.outTradeNo, orderStatus: 'pending', orderTitle: '订单待支付',
        orderNote: '请在微信支付中完成付款。', orderPlanText, orderCanResume: true })
      const paymentParams = await this.callPaymentFunction(checkout)
      if (pageSessionScope() !== scope) return
      paymentRequested = true
      this.setData({ orderCanResume: false })
      await this.requestPayment(paymentParams)
      if (pageSessionScope() !== scope) return
      this.setData({ paymentStarting: false, confirming: true })
      wx.showLoading({ title: '正在确认付款', mask: true })
      const order = await this.pollPaymentOrder(checkout.order.outTradeNo)
      wx.hideLoading()
      if (pageSessionScope() !== scope) return
      await this.showOrderResult(order, true)
    } catch (err) {
      wx.hideLoading()
      if (pageSessionScope() !== scope) return
      const error = err && typeof err === 'object' ? err as Record<string, unknown> : {}
      const message = String(error.errMsg || error.message || err)
      if (/cancel/i.test(message)) {
        this.setData({ orderStatus: 'pending', orderTitle: '已取消支付', orderCanResume: !!this._resumableCheckout,
          orderNote: '你已取消本次支付，可继续支付原订单。若已扣款，请先查询订单状态。' })
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else {
        if (this.data.lastOrderId) this.setData(!paymentRequested && this._resumableCheckout
          ? { orderCanResume: true, orderTitle: '支付尚未开始', orderNote: '未能拉起微信支付，请继续支付原订单，不会重新创建订单。' }
          : { orderCanResume: false, orderTitle: '支付结果待核实', orderNote: '本次支付未能完成确认，请查询订单状态后再操作。' })
        wx.showToast({ title: message || '支付未完成', icon: 'none', duration: 3000 })
      }
      console.warn('membership payment failed', err)
    } finally {
      if (pageSessionScope() === scope) this.setData({ paymentStarting: false, confirming: false })
    }
  }
})
