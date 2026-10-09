import { bindWechatPhone } from '../../services/auth'
import { chatApi } from '../../services/chat'
import { pageSessionScope } from '../../utils/page-session'
import { assertPaymentQueryResponse, paymentParamsFrom, paymentRecord, type PaymentParams } from '../../utils/payment-response'
import {
  memberApi,
  type MembershipOrderCheckout,
  type MembershipOverview,
  type MembershipPaymentConfig,
  type MembershipPaymentOrder,
  type MembershipPlan
} from '../../services/member'

type MembershipPlanView = MembershipPlan & {
  durationText: string
  descriptionText: string
}

type PaymentHTTPCloud = {
  callHTTPFunction(options: {
    name: string
    path: string
    method: 'POST'
    config: { env: string }
    header: { 'Content-Type': string }
    data: { outTradeNo: string }
    success: (result: unknown) => void
    fail: (error: unknown) => void
  }): unknown
}

function isPaymentHTTPCloud(value: unknown): value is PaymentHTTPCloud {
  return paymentRecord(value) && typeof value.callHTTPFunction === 'function'
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
    createPath: '',
    queryPath: ''
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
  _membershipUnloaded: false,
  _overviewRequestSerial: 0,
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
    this._membershipUnloaded = false
    return this.loadOverview()
  },

  onPullDownRefresh() {
    return this.loadOverview({ pullDown: true })
  },

  onUnload() {
    this._membershipUnloaded = true
    this._overviewRequestSerial += 1
    if (this.data.confirming) wx.hideLoading()
  },

  isMembershipSessionCurrent(scope: string) {
    return !!scope && !this._membershipUnloaded && this._membershipScope === scope && pageSessionScope() === scope
  },

  assertMembershipSession(scope: string) {
    if (!this.isMembershipSessionCurrent(scope)) throw new Error('会员会话已变化，请重新进入')
  },

  async loadOverview(options: { pullDown?: boolean } = {}) {
    if (this._membershipUnloaded) return
    const scope = pageSessionScope()
    if (scope !== this._membershipScope) {
      if (this.data.confirming) wx.hideLoading()
      this._membershipScope = scope
      this._resumableCheckout = null
      this.setData({ overview: EMPTY_OVERVIEW, plans: [], onlineCheckout: false, selectedPlanCode: '',
        lastOrderId: '', orderTitle: '', orderNote: '', orderStatus: '', orderChecking: false, orderCanResume: false,
        orderPlanText: '', paymentStarting: false, confirming: false, phoneAuthorizing: false })
    }
    if (!scope) return
    const requestSerial = ++this._overviewRequestSerial
    const isCurrent = () => this.isMembershipSessionCurrent(scope) && requestSerial === this._overviewRequestSerial
    if (options.pullDown) this.setData({ refreshing: true })
    else this.setData({ loading: true })
    try {
      const overview = await memberApi.membershipOverview()
      if (!isCurrent()) return
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
      if (!isCurrent()) return
      console.warn('load membership overview failed', err)
      this.setData({ errorText: '会员信息暂时无法加载，请稍后重试。' })
    } finally {
      if (isCurrent()) {
        this.setData({ loading: false, refreshing: false })
        if (options.pullDown) wx.stopPullDownRefresh()
      }
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
    const scope = pageSessionScope()
    if (this.data.phoneAuthorizing || !this.isMembershipSessionCurrent(scope)) return
    const detail: unknown = e.detail
    const code = paymentRecord(detail) && typeof detail.code === 'string' ? detail.code : ''
    if (!code) {
      wx.showToast({ title: '未授权手机号', icon: 'none' })
      return
    }
    this.setData({ phoneAuthorizing: true })
    try {
      await bindWechatPhone(code)
      if (!this.isMembershipSessionCurrent(scope)) return
      wx.showToast({ title: '手机号已授权' })
      await this.loadOverview()
    } catch (err) {
      if (this.isMembershipSessionCurrent(scope)) console.warn('bind wechat phone failed', err)
    } finally {
      if (this.isMembershipSessionCurrent(scope)) this.setData({ phoneAuthorizing: false })
    }
  },

  async contactMatchmaker() {
    const scope = pageSessionScope()
    const isCurrent = () => !!scope && !this._membershipUnloaded && pageSessionScope() === scope
    if (!isCurrent()) return
    try {
      const conversations = await chatApi.listConversations({ page: 1, pageSize: 100 })
      if (!isCurrent()) return
      const serviceConversation = conversations.list.find(item => item.conversationType === 'member_matchmaker')
      if (serviceConversation) {
        wx.navigateTo({ url: `/pages/user/chat?id=${serviceConversation.id}` })
        return
      }
    } catch (err) {
      if (!isCurrent()) return
      console.warn('load principal conversation failed', err)
    }
    wx.showModal({
      title: '绑定主理人',
      content: '请先在“我的”页面添加主理人，再联系主理人完成会员服务。',
      confirmText: '前往绑定',
      success: res => {
        if (res.confirm && isCurrent()) wx.switchTab({ url: '/pages/user/profile' })
      }
    })
  },

  async callPaymentHTTP(payment: MembershipPaymentConfig, path: string, outTradeNo: string, scope: string): Promise<unknown> {
    this.assertMembershipSession(scope)
    const cloud: unknown = wx.cloud
    if (!isPaymentHTTPCloud(cloud)) throw new Error('当前微信基础库不支持支付函数调用')
    if (!payment.functionName || !path || !path.startsWith('/') || !outTradeNo) throw new Error('支付服务暂不可用')
    const result = await new Promise<unknown>((resolve, reject) => {
      cloud.callHTTPFunction({
        name: payment.functionName,
        path,
        method: 'POST',
        config: { env: getApp<IAppOption>().globalData.env },
        header: { 'Content-Type': 'application/json' },
        data: { outTradeNo },
        success: resolve,
        fail: reject
      })
    })
    this.assertMembershipSession(scope)
    return result
  },

  async callPaymentFunction(checkout: MembershipOrderCheckout, requestScope?: string) {
    const scope = requestScope || this._membershipScope
    const result = await this.callPaymentHTTP(checkout.payment, checkout.payment.createPath, checkout.order.outTradeNo, scope)
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

  async queryPaymentOrder(outTradeNo: string, requestScope?: string): Promise<MembershipPaymentOrder> {
    const scope = requestScope || this._membershipScope
    this.assertMembershipSession(scope)
    const payment = this.data.overview.payment
    // Undefined belongs to the legacy API. An empty new query path cannot
    // silently fall back to potentially stale local order state.
    if (payment.queryPath !== undefined) {
      const response = await this.callPaymentHTTP(payment, payment.queryPath, outTradeNo, scope)
      assertPaymentQueryResponse(response, outTradeNo)
    }
    this.assertMembershipSession(scope)
    const order = await memberApi.membershipOrder(outTradeNo)
    this.assertMembershipSession(scope)
    return order
  },

  async pollPaymentOrder(outTradeNo: string, requestScope?: string) {
    const scope = requestScope || this._membershipScope
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const order = await this.queryPaymentOrder(outTradeNo, scope)
      if (order.status === 'paid') return order
      if (['closed', 'failed', 'refunded'].includes(order.status)) return order
      await wait(1500)
      this.assertMembershipSession(scope)
    }
    return this.queryPaymentOrder(outTradeNo, scope)
  },

  async showOrderResult(order: MembershipPaymentOrder, modal = false, requestScope?: string) {
    const scope = requestScope || this._membershipScope
    if (!this.isMembershipSessionCurrent(scope)) return
    const feedback = orderFeedback(order.status)
    if (['paid', 'closed', 'failed', 'refunded'].includes(order.status)) {
      this._resumableCheckout = null
      this.setData({ orderCanResume: false })
    }
    this.setData({ orderTitle: feedback.title, orderNote: feedback.note, orderStatus: order.status })
    if (order.status === 'paid' || order.status === 'refunded') await this.loadOverview()
    if (modal && this.isMembershipSessionCurrent(scope)) wx.showModal({ title: feedback.title, content: feedback.note, showCancel: false })
  },

  async refreshOrderStatus() {
    if (!this.data.lastOrderId || this.data.orderChecking || this.data.confirming) return
    const scope = pageSessionScope()
    if (!this.isMembershipSessionCurrent(scope)) return
    const orderId = this.data.lastOrderId
    this.setData({ orderChecking: true })
    try {
      const order = await this.queryPaymentOrder(orderId, scope)
      if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== orderId) return
      await this.showOrderResult(order, false, scope)
    } catch (error) {
      if (!this.isMembershipSessionCurrent(scope) || this.data.lastOrderId !== orderId) return
      this.setData({ orderStatus: 'confirming', orderTitle: '付款结果确认中', orderCanResume: false,
        orderNote: '暂时无法查询订单，请稍后重试。确认结果前请勿重复付款。' })
      console.warn('refresh membership order failed', error)
    } finally {
      if (this.isMembershipSessionCurrent(scope)) this.setData({ orderChecking: false })
    }
  },

  async startPayment() {
    if (this.data.paymentStarting || this.data.confirming) return
    const scope = pageSessionScope()
    if (!this.isMembershipSessionCurrent(scope)) return
    if (this.data.lastOrderId && !this.data.orderCanResume && !['paid', 'closed', 'failed', 'refunded'].includes(this.data.orderStatus)) {
      await this.refreshOrderStatus()
      if (this.isMembershipSessionCurrent(scope)) wx.showToast({ title: '请查看上一笔订单结果', icon: 'none' })
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
      if (!this.isMembershipSessionCurrent(scope)) return
      this._resumableCheckout = checkout
      const orderPlanText = `${checkout.order.planTitle || '会员套餐'}${Number.isFinite(checkout.order.amountFen) ? ` · ¥${(checkout.order.amountFen / 100).toFixed(2)}` : ''}`
      this.setData({ lastOrderId: checkout.order.outTradeNo, orderStatus: 'pending', orderTitle: '订单待支付',
        orderNote: '请在微信支付中完成付款。', orderPlanText, orderCanResume: true })
      const paymentParams = await this.callPaymentFunction(checkout, scope)
      if (!this.isMembershipSessionCurrent(scope)) return
      paymentRequested = true
      this.setData({ orderCanResume: false })
      await this.requestPayment(paymentParams)
      if (!this.isMembershipSessionCurrent(scope)) return
      this.setData({ paymentStarting: false, confirming: true, orderStatus: 'confirming',
        orderTitle: '付款结果确认中', orderNote: '正在核对微信支付结果，请勿重复付款。' })
      wx.showLoading({ title: '正在确认付款', mask: true })
      const order = await this.pollPaymentOrder(checkout.order.outTradeNo, scope)
      if (!this.isMembershipSessionCurrent(scope)) return
      wx.hideLoading()
      await this.showOrderResult(order, true, scope)
    } catch (err) {
      if (!this.isMembershipSessionCurrent(scope)) return
      wx.hideLoading()
      const error = err && typeof err === 'object' ? err as Record<string, unknown> : {}
      const message = String(error.errMsg || error.message || err)
      if (/cancel/i.test(message)) {
        this.setData({ orderStatus: 'pending', orderTitle: '已取消支付', orderCanResume: !!this._resumableCheckout,
          orderNote: '你已取消本次支付，可继续支付原订单。若已扣款，请先查询订单状态。' })
        wx.showToast({ title: '已取消支付', icon: 'none' })
      } else {
        if (this.data.lastOrderId) this.setData(!paymentRequested && this._resumableCheckout
          ? { orderCanResume: true, orderTitle: '支付尚未开始', orderNote: '未能拉起微信支付，请继续支付原订单，不会重新创建订单。' }
          : { orderCanResume: false, orderStatus: 'confirming', orderTitle: '付款结果确认中', orderNote: '本次支付未能完成确认，请查询订单状态后再操作。' })
        wx.showToast({ title: message || '支付未完成', icon: 'none', duration: 3000 })
      }
      console.warn('membership payment failed', err)
    } finally {
      if (this.isMembershipSessionCurrent(scope)) this.setData({ paymentStarting: false, confirming: false })
    }
  }
})
