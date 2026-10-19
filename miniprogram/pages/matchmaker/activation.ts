import { bindWechatPhone } from '../../services/auth'
import { matchmakerApi, type MatchmakerActivationResult } from '../../services/matchmaker'
import { memberApi, type MembershipOrderCheckout, type MembershipPaymentOrder } from '../../services/member'
import { pageSessionScope } from '../../utils/page-session'
import { invalidateMatchmakerPageSnapshots } from '../../utils/matchmaker-page-cache'
import { memberOrderAuthError } from '../../utils/member-order-view'
import { assertPaymentQueryResponse, isTransientPaymentQueryError, paymentRecord, virtualPaymentParamsFrom, type PaymentQueryState } from '../../utils/payment-response'
import {
  assertMatchmakerActivationOrder, assertMatchmakerActivationOverview,
  matchmakerPaymentReason, matchmakerPaymentSupport, requestMatchmakerPayment
} from '../../utils/matchmaker-activation-payment'

type ActivationOrder = MembershipPaymentOrder & PaymentQueryState
const terminal = (status: string) => ['paid', 'closed', 'failed', 'refunded'].includes(status)
const currentUserId = () => Number(getApp<IAppOption>().globalData.user?.id)
const wait = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration))

function privateDefaults() {
  return {
    overview: null as MatchmakerActivationResult | null,
    active: false, loading: false, paymentStarting: false, orderChecking: false, phoneAuthorizing: false,
    errorText: '', paymentNote: '', paymentRestricted: false, order: null as MembershipPaymentOrder | null,
    orderTitle: '', orderNote: '', orderCanResume: false, phoneBound: false, paymentAvailable: false, foreignOrder: false
  }
}

Page({
  _scope: '', _generation: 0, _readSerial: 0, _visible: false, _disposed: false, _nativeOpen: false,
  _readPromise: null as Promise<void> | null,
  _checkout: null as MembershipOrderCheckout | null,
  _nativeSuccessOrderNo: '', _submittedAttempts: [] as string[],
  data: privateDefaults(),

  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope; this._generation += 1; this._readSerial += 1
      this._nativeOpen = false
      this._readPromise = null; this._checkout = null; this._nativeSuccessOrderNo = ''; this._submittedAttempts = []
      this.setData(privateDefaults())
    }
    return scope
  },
  onShow() {
    this._visible = true
    const scope = this.synchronizeSession()
    if (!scope) { wx.redirectTo({ url: '/pages/index/index' }); return Promise.resolve() }
    if (this._nativeOpen) return Promise.resolve()
    return this.loadOverview()
  },
  onHide() {
    this._visible = false
    // The owned native cashier can hide the page. Keep its one in-flight
    // checkout alive; ordinary navigation still discards private page state.
    if (this._nativeOpen && pageSessionScope() === this._scope) return
    this._generation += 1; this._readSerial += 1; this._readPromise = null; this._checkout = null
    this.setData(privateDefaults())
  },
  onUnload() {
    this._disposed = true; this._nativeOpen = false; this.onHide()
  },
  isCurrent(scope: string, generation: number) {
    return !this._disposed && (this._visible || this._nativeOpen) && !!scope && this._scope === scope
      && pageSessionScope() === scope && this._generation === generation
  },
  assertCurrent(scope: string, generation: number) {
    if (!this.isCurrent(scope, generation)) throw new Error('登录状态已变化，请重新进入主理人开通页')
  },
  handleAuthError(error: unknown, scope: string, generation: number) {
    const currentScope = pageSessionScope()
    if (!memberOrderAuthError(error) || this._generation !== generation || this._scope !== scope
      || (currentScope && currentScope !== scope) || this._disposed) return false
    this._generation += 1; this._readSerial += 1; this._readPromise = null; this._checkout = null
    this.setData(privateDefaults())
    wx.redirectTo({ url: '/pages/index/index' })
    return true
  },
  applyOverview(result: MatchmakerActivationResult) {
    assertMatchmakerActivationOverview(result)
    this.setData({ overview: result, active: result.active, phoneBound: result.phoneBound,
      paymentAvailable: result.payment.available && result.payment.provider === 'virtual' && !result.active && !this.data.paymentRestricted,
      paymentNote: result.active ? '主理人权限已开通，无需重复付款。'
        : this.data.paymentRestricted ? '当前支付能力受限，请联系平台。仍可查询已有订单，确认结果前勿重复付款。'
        : result.payment.available ? '付款确认后自动开通，无需管理员审批。' : matchmakerPaymentReason(result.payment.reason),
      errorText: '' })
  },
  loadOverview(force = false): Promise<void> {
    if (!this._visible || this._disposed) return Promise.resolve()
    const scope = this.synchronizeSession(), generation = this._generation
    if (!scope) return Promise.resolve()
    if (!force && this._readPromise) return this._readPromise
    const serial = ++this._readSerial
    const isCurrent = () => this.isCurrent(scope, generation) && serial === this._readSerial
    this.setData({ loading: true, errorText: '' })
    const reading = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return
        const result = await matchmakerApi.activation(false)
        if (!isCurrent()) return
        this.applyOverview(result)
        if (result.active) {
          this._checkout = null
          this.setData({ order: null, orderCanResume: false, orderTitle: '', orderNote: '' })
          return
        }
        if (result.pendingOrder) {
          if (result.pendingOrder.productType !== 'matchmaker') {
            if (!['vip', 'matchmaking'].includes(String(result.pendingOrder.productType))
              || Number(result.pendingOrder.userId) !== currentUserId()) throw new Error('原订单与当前账号不一致')
            assertPaymentQueryResponse({ order: result.pendingOrder }, result.pendingOrder.outTradeNo)
            this._checkout = null
            this.setData({ order: result.pendingOrder, orderTitle: '请先处理已有会员订单', foreignOrder: true,
              orderNote: '当前账号有一笔会员或牵线服务订单待处理。请从我的订单核对，确认前勿重复付款。',
              orderCanResume: false, paymentAvailable: false })
            return
          }
          assertMatchmakerActivationOrder(result.pendingOrder, currentUserId())
          this._checkout = { order: result.pendingOrder, payment: result.pendingOrderPayment || result.payment }
          this.setData({ order: result.pendingOrder, orderTitle: '正在恢复原订单', orderCanResume: false, foreignOrder: false,
            orderNote: '正在查询上一笔订单，确认结果前请勿重复付款。' })
          await this.refreshOrderStatus()
        } else {
          this._checkout = null
          this.setData({ order: null, orderCanResume: false, orderTitle: '', orderNote: '', foreignOrder: false })
        }
      } catch (error) {
        if (this.handleAuthError(error, scope, generation) || !isCurrent()) return
        this.setData({ errorText: '主理人开通信息暂时无法读取，请刷新重试。', paymentAvailable: false })
      } finally {
        if (isCurrent()) { this._readPromise = null; this.setData({ loading: false }) }
      }
    })
    this._readPromise = reading
    return reading
  },
  refresh() { return this.data.paymentStarting || this.data.orderChecking ? Promise.resolve() : this.loadOverview(true) },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()) },

  async authorizePhone(event: WechatMiniprogram.ButtonGetPhoneNumber) {
    const scope = this.synchronizeSession(), generation = this._generation, userId = currentUserId()
    if (!this.isCurrent(scope, generation) || this.data.phoneAuthorizing || this.data.paymentStarting) return
    const detail: unknown = event.detail
    const code = paymentRecord(detail) && typeof detail.code === 'string' ? detail.code : ''
    if (!code) { wx.showToast({ title: '未授权手机号', icon: 'none' }); return }
    this.setData({ phoneAuthorizing: true })
    try {
      await bindWechatPhone(code)
      // Binding can rotate the same account's token. Only this owned request
      // can adopt that rotation; unrelated account/lifecycle changes discard it.
      if (this._disposed || !this._visible || this._generation !== generation || currentUserId() !== userId) return
      this._scope = pageSessionScope()
      invalidateMatchmakerPageSnapshots()
      await this.loadOverview(true)
    } catch (error) {
      if (this.handleAuthError(error, scope, generation) || !this.isCurrent(scope, generation)) return
      wx.showToast({ title: '手机号授权未完成，请重试', icon: 'none' })
    } finally {
      if (!this._disposed && this._visible && this._generation === generation && currentUserId() === userId) {
        this.setData({ phoneAuthorizing: false })
      }
    }
  },

  async queryOrder(outTradeNo: string, scope: string, generation: number): Promise<ActivationOrder> {
    this.assertCurrent(scope, generation)
    const result = await memberApi.virtualPaymentQuery(outTradeNo)
    this.assertCurrent(scope, generation)
    const query = assertPaymentQueryResponse(result, outTradeNo)
    assertMatchmakerActivationOrder(result.order, currentUserId())
    return { ...result.order, ...query }
  },
  async showOrderResult(order: ActivationOrder, scope: string, generation: number) {
    this.assertCurrent(scope, generation)
    assertMatchmakerActivationOrder(order, currentUserId())
    let title = '付款结果确认中', note = '正在核对付款结果，请稍后查询，确认前请勿重复付款。'
    let canResume = false
    if (order.status === 'paid' && order.fulfillmentStatus === 'fulfilled') {
      const overview = await matchmakerApi.activation(false)
      this.assertCurrent(scope, generation)
      this.applyOverview(overview)
      if (overview.active) {
        invalidateMatchmakerPageSnapshots()
        title = '主理人已开通'; note = '付款与权限均已确认，主理人权限长期有效。可进入工作台。'
      } else {
        title = '主理人权限确认中'; note = '付款已确认，权限暂未生效。请稍后查询原订单或联系平台，勿重复付款。'
      }
    } else if (order.status === 'paid') {
      title = order.fulfillmentStatus === 'requires_review' ? '付款已确认，开通待核查' : '主理人权限确认中'
      note = order.fulfillmentMessage || '付款已确认，开通结果正在核实。请稍后查询原订单或联系平台，勿重复付款。'
    } else if (order.status === 'closed') {
      title = '订单已关闭'; note = '此订单已关闭，未开通主理人。需要时可重新发起开通。'
    } else if (order.status === 'failed') {
      title = '支付未成功'; note = '此订单未确认付款成功，可重新发起开通。'
    } else if (order.status === 'refunded') {
      title = '订单已退款'; note = '此订单已退款，主理人权限以平台当前记录为准。'
    } else if ((order.tradeState === 'NOTPAY' || order.providerOrderAbsent === true)
      && this._nativeSuccessOrderNo !== order.outTradeNo) {
      title = '订单尚未付款'
      const payment = this._checkout?.payment
      canResume = !!payment?.available && payment.provider === 'virtual' && !!this._checkout && !this.data.paymentRestricted
      note = canResume ? '原订单尚未付款，可以继续支付原订单。' : '原订单尚未付款，当前支付暂不可用，请联系平台。'
    }
    if (terminal(order.status)) this._checkout = null
    this.setData({ order, orderTitle: title, orderNote: note, orderCanResume: canResume })
  },
  async refreshOrderStatus() {
    if (this.data.foreignOrder) { this.openOrders(); return }
    const scope = this._scope, generation = this._generation, order = this.data.order
    if (!order || this.data.orderChecking || !this.isCurrent(scope, generation)) return
    this.setData({ orderChecking: true, orderCanResume: false })
    try {
      const result = await this.queryOrder(order.outTradeNo, scope, generation)
      if (this.data.order?.outTradeNo !== order.outTradeNo) return
      await this.showOrderResult(result, scope, generation)
    } catch (error) {
      if (this.handleAuthError(error, scope, generation) || !this.isCurrent(scope, generation)) return
      this.setData({ orderCanResume: false, orderTitle: '订单状态暂未确认',
        orderNote: '暂时无法查询原订单，请稍后重试。确认结果前请勿重复付款。' })
    } finally { if (this.isCurrent(scope, generation)) this.setData({ orderChecking: false }) }
  },
  async pollOrder(outTradeNo: string, scope: string, generation: number) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const order = await this.queryOrder(outTradeNo, scope, generation)
        if (terminal(order.status) || attempt === 5) return order
      } catch (error) { if (!isTransientPaymentQueryError(error) || attempt === 5) throw error }
      await wait(1200)
      this.assertCurrent(scope, generation)
    }
    throw new Error('订单状态暂未确认')
  },

  async startPayment() {
    const scope = this.synchronizeSession(), generation = this._generation
    if (!this.isCurrent(scope, generation) || this.data.paymentStarting || this.data.orderChecking
      || this.data.loading || this.data.phoneAuthorizing) return
    const overview = this.data.overview
    if (!overview || this.data.errorText) { wx.showToast({ title: '请先刷新开通信息', icon: 'none' }); return }
    if (overview.active) { this.openWorkbench(); return }
    if (this.data.foreignOrder) { this.openOrders(); return }
    const prior = this.data.order
    if (prior && (prior.status === 'paid' || (!terminal(prior.status) && !this.data.orderCanResume))) {
      await this.refreshOrderStatus(); return
    }
    if (!overview.phoneBound) { wx.showToast({ title: '请先授权微信手机号', icon: 'none' }); return }
    if (!this.data.paymentAvailable) { wx.showToast({ title: matchmakerPaymentReason(overview.payment.reason), icon: 'none' }); return }
    const support = matchmakerPaymentSupport()
    if (support.reason || (support.platform === 'ios' && overview.payment.testMode)) {
      wx.showModal({ title: '暂无法支付', content: support.reason || '苹果支付暂不支持当前测试商品，请联系平台。', showCancel: false }); return
    }
    const resuming = !!prior && this.data.orderCanResume && !!this._checkout
    this.setData({ paymentStarting: true, orderCanResume: false })
    let nativeRequested = false
    try {
      const checkout = prior && this._checkout ? this._checkout : await matchmakerApi.createActivationOrder()
      this.assertCurrent(scope, generation)
      if (checkout.order.productType !== 'matchmaker') {
        if (!['vip', 'matchmaking'].includes(String(checkout.order.productType)) || Number(checkout.order.userId) !== currentUserId()) {
          throw new Error('原订单与当前账号不一致')
        }
        assertPaymentQueryResponse({ order: checkout.order }, checkout.order.outTradeNo)
        this._checkout = null
        this.setData({ order: checkout.order, foreignOrder: true, paymentAvailable: false, orderCanResume: false,
          orderTitle: '请先处理已有会员订单', orderNote: '当前账号已有会员或牵线服务订单，请从我的订单核对后再开通主理人。' })
        return
      }
      assertMatchmakerActivationOrder(checkout.order, currentUserId())
      this._checkout = checkout
      this.setData({ order: checkout.order, orderTitle: '主理人订单待支付', orderNote: '一次性付款 ¥6980，长期有效。' })
      if ((!resuming && (checkout.reused || checkout.recoveryRequired)) || terminal(checkout.order.status)) {
        // Restore first. A recovered unpaid order requires another explicit
        // tap after a provider NOTPAY/absence result before any native charge.
        await this.refreshOrderStatus(); return
      }
      if (!checkout.payment.available || checkout.payment.provider !== 'virtual') {
        throw new Error(matchmakerPaymentReason(checkout.payment.reason))
      }
      const loginCode = await new Promise<string>((resolve, reject) => wx.login({
        success: result => result.code ? resolve(result.code) : reject(new Error('微信登录态获取失败，请重试')),
        fail: () => reject(new Error('微信登录态获取失败，请重试'))
      }))
      this.assertCurrent(scope, generation)
      const response = await memberApi.virtualPaymentCheckout(checkout.order.outTradeNo, loginCode)
      this.assertCurrent(scope, generation)
      assertPaymentQueryResponse({ order: response.order }, checkout.order.outTradeNo)
      assertMatchmakerActivationOrder(response.order, currentUserId())
      if (terminal(response.order.status)) { await this.showOrderResult(response.order, scope, generation); return }
      if (typeof response.paymentAttemptNo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_|*@-]{7,31}$/.test(response.paymentAttemptNo)) {
        throw new Error('付款尝试编号无效，请查询原订单')
      }
      const params = virtualPaymentParamsFrom(response, { paymentAttemptNo: response.paymentAttemptNo,
        productId: checkout.order.planCode, goodsPrice: checkout.order.amountFen })
      nativeRequested = true; this._nativeOpen = true
      await requestMatchmakerPayment(params, this._submittedAttempts)
      this.assertCurrent(scope, generation)
      this._nativeSuccessOrderNo = checkout.order.outTradeNo
      this.setData({ orderTitle: '付款结果确认中', orderNote: '正在确认付款与主理人权限，请勿重复付款。' })
      const result = await this.pollOrder(checkout.order.outTradeNo, scope, generation)
      await this.showOrderResult(result, scope, generation)
    } catch (error) {
      if (this.handleAuthError(error, scope, generation) || !this.isCurrent(scope, generation)) return
      const nativeRestricted = nativeRequested && paymentRecord(error)
        && (error.errCode === -15017 || error.errCode === -15019
          || (typeof error.errMsg === 'string' && /^requestVirtualPayment:fail(?:[\s:]|$)/i.test(error.errMsg)
            && /\bbanned\b|\bno[\s_-]*permission\b|\baccess[\s_-]*denied\b/i.test(error.errMsg)))
      if (nativeRestricted) this.setData({ paymentRestricted: true, paymentAvailable: false, orderCanResume: false,
        paymentNote: '当前支付能力受限，请联系平台。仍可查询已有订单，确认结果前勿重复付款。' })
      if (nativeRequested && this.data.order) {
        // A native cancellation/failure can race with a late payment. Query
        // the same order before allowing any further payment attempt.
        await this.refreshOrderStatus()
      } else if (this.data.order) {
        this.setData({ orderCanResume: false, orderTitle: '支付尚未完成',
          orderNote: '请先查询原订单状态，再继续付款。不会重新创建未确认的订单。' })
      }
      if (this.isCurrent(scope, generation) && !this.data.active) wx.showToast({ title: '支付未完成，请查看订单结果', icon: 'none' })
    } finally {
      if (this.isCurrent(scope, generation)) this.setData({ paymentStarting: false })
      if (this._scope === scope && this._generation === generation) {
        this._nativeOpen = false
        if (!this._visible && !this._disposed) this.onHide()
      }
    }
  },
  openWorkbench() {
    const scope = this.synchronizeSession()
    if (!this.isCurrent(scope, this._generation) || !this.data.active) return
    invalidateMatchmakerPageSnapshots()
    wx.redirectTo({ url: '/pages/matchmaker/workspace' })
  },
  openOrders() { if (this._visible && this.synchronizeSession()) wx.navigateTo({ url: '/pages/user/orders' }) },
  openCertifications() { if (this._visible && this.synchronizeSession()) wx.switchTab({ url: '/pages/user/profile' }) }
})
