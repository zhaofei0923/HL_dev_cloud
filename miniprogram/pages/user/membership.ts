import { bindWechatPhone } from '../../services/auth'
import { chatApi } from '../../services/chat'
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
    merchant_not_configured: '微信支付开通准备中',
    integration_incomplete: '微信支付配置待完善',
    member_assignment_required: '绑定主理人后可开通会员',
    phone_required: '授权微信手机号后可付款',
    plans_not_configured: '会员套餐待配置'
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

Page({
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
    paymentActionText: '微信支付开通准备中',
    errorText: ''
  },

  onShow() {
    this.loadOverview()
  },

  onPullDownRefresh() {
    this.loadOverview({ pullDown: true })
  },

  async loadOverview(options: { pullDown?: boolean } = {}) {
    if (options.pullDown) this.setData({ refreshing: true })
    else this.setData({ loading: true })
    try {
      const overview = await memberApi.membershipOverview()
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
        statusTitle: overview.isPremiumMember ? '会员权益已开通' : '开通会员权益',
        expiryText: expiryText(overview),
        paymentActionText: overview.payment.available
          ? (overview.isPremiumMember ? '微信支付续费' : '微信支付开通会员')
          : paymentReasonText(overview.payment.reason),
        errorText: ''
      })
    } catch (err) {
      console.warn('load membership overview failed', err)
      this.setData({ errorText: '会员信息暂时无法加载，请稍后重试。' })
    } finally {
      this.setData({ loading: false, refreshing: false })
      if (options.pullDown) wx.stopPullDownRefresh()
    }
  },

  selectPlan(e: WechatMiniprogram.TouchEvent) {
    const planCode = String(e.currentTarget.dataset.code || '')
    if (!planCode || this.data.paymentStarting) return
    this.setData({ selectedPlanCode: planCode })
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
        if (res.confirm) wx.redirectTo({ url: '/pages/user/profile' })
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

  async startPayment() {
    if (this.data.paymentStarting || this.data.confirming) return
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
    try {
      const checkout = await memberApi.createMembershipOrder(this.data.selectedPlanCode)
      const paymentParams = await this.callPaymentFunction(checkout)
      await this.requestPayment(paymentParams)
      this.setData({ paymentStarting: false, confirming: true })
      wx.showLoading({ title: '正在确认付款', mask: true })
      const order = await this.pollPaymentOrder(checkout.order.outTradeNo)
      wx.hideLoading()
      if (order.status === 'paid') {
        await this.loadOverview()
        wx.showModal({ title: '会员已开通', content: '会员权益已经生效。', showCancel: false })
      } else {
        wx.showModal({
          title: '付款结果确认中',
          content: '微信正在处理最终结果，请稍后下拉刷新查看会员状态。',
          showCancel: false
        })
      }
    } catch (err) {
      wx.hideLoading()
      const message = String((err as any).errMsg || (err as any).message || err)
      if (/cancel/i.test(message)) wx.showToast({ title: '已取消支付', icon: 'none' })
      else wx.showToast({ title: message || '支付未完成', icon: 'none', duration: 3000 })
      console.warn('membership payment failed', err)
    } finally {
      this.setData({ paymentStarting: false, confirming: false })
    }
  }
})
