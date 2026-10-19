import { currentUser, apiErrorMessage } from '../../services/api'
import { chatApi } from '../../services/chat'
import { memberApi, type MemberVisitor, type WechatExchange, type OnlineSubscription, type MatchmakingPackage, type MatchmakingReadiness, type MatchmakingRequest, type MatchmakingProgress, type VipOverview } from '../../services/member'
import { messageApi, type NotificationMessage } from '../../services/messages'
import { pageSessionScope } from '../../utils/page-session'

type Section = 'visitors' | 'exchanges' | 'online' | 'matchmaking'
type VisitorView = MemberVisitor & { timeText: string }
type ExchangeView = WechatExchange & { otherId: number; otherName: string; incoming: boolean; canRespond: boolean; statusText: string; timeText: string }
type MatchmakingView = MatchmakingRequest & { otherId: number; otherName: string; canRespond: boolean; canCancel: boolean; statusText: string; timeText: string }

function userId() {
  const user = currentUser()
  return Number(user && (user.id || user.userId)) || 0
}

function timeText(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function decodedName(value?: string) {
  try { return decodeURIComponent(String(value || '')).slice(0, 60) }
  catch { return String(value || '').slice(0, 60) }
}

function readinessText(reason: string) {
  const labels: Record<string, string> = { profile_incomplete: '请先完善本人资料，再联系所属主理人确认服务准备。',
    matchmaker_required: '平台将安排主理人对接，完成服务准备。', matchmaker_confirmation_required: '等待所属主理人对接并确认服务准备。' }
  return labels[reason] || '请完善资料，由平台安排主理人完成服务准备。'
}

function matchmakingProgress(overview: VipOverview): MatchmakingProgress {
  if (overview.matchmakingProgress) return overview.matchmakingProgress
  const packages = overview.matchmakingPackages || []
  const active = packages.filter(item => item.status === 'active' && item.remainingCount > 0)
  const readiness = overview.matchmakingReadiness
  const assigned = readiness?.activeAssignment === undefined ? Number(readiness?.matchmakerId) > 0 : readiness.activeAssignment
  const profileComplete = readiness?.profileComplete === true, matchmakerConfirmed = readiness?.matchmakerConfirmed === true
  const earliestExpireAt = active.map(item => item.expireAt).filter(value => Number.isFinite(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || null
  const status: MatchmakingProgress['status'] = active.length
    ? !profileComplete ? 'needs_profile' : !assigned ? 'awaiting_assignment' : !matchmakerConfirmed || readiness?.ready !== true ? 'awaiting_contact' : 'ready'
    : !packages.length ? 'not_purchased' : packages.some(item => item.status === 'expired') ? 'expired'
      : packages.some(item => item.status === 'exhausted') ? 'exhausted' : 'refunded'
  return { status, purchased: packages.length > 0, profileComplete, assigned, matchmakerConfirmed,
    matchmakerId: readiness?.matchmakerId || null, matchmakerUserId: null, matchmakerName: '', requestedAt: null,
    remainingCount: active.reduce((total, item) => total + item.remainingCount, 0), earliestExpireAt }
}

function progressText(progress: MatchmakingProgress) {
  const titles: Record<MatchmakingProgress['status'], string> = { not_purchased: '尚未购买牵线服务', needs_profile: '下一步：完善资料',
    awaiting_assignment: '平台待分配', awaiting_contact: '主理人待对接', ready: '可申请人工牵线', expired: '服务已到期', exhausted: '次数已用完', refunded: '服务已退款' }
  const notes: Record<MatchmakingProgress['status'], string> = { not_purchased: '可直接购买2次或6次牵线套餐，付款确认后次数立即到账。',
    needs_profile: '次数已到账。请完善个人资料，平台会安排主理人对接后开展推荐服务。',
    awaiting_assignment: '个人资料已就绪，平台将安排主理人对接，请留意服务进度。',
    awaiting_contact: '平台已分配主理人，等待主理人对接并确认服务准备；也可主动联系咨询。',
    ready: '可选择对象申请牵线。每次具体牵线仍需主理人确认安排及双方本人同意。',
    expired: '到期套餐保留记录，新购套餐独立计期。', exhausted: '已购次数已用完，新购套餐独立计期。', refunded: '退款套餐保留记录，当前权益以服务记录为准。' }
  return { title: titles[progress.status], note: notes[progress.status] }
}

function exchangeView(row: WechatExchange, viewer: number): ExchangeView {
  const incoming = row.recipientId === viewer
  const otherId = incoming ? row.requesterId : row.recipientId
  const labels = { pending: incoming ? '等待你的回应' : '等待对方同意', accepted: '双方已同意', rejected: '已婉拒', cancelled: '已取消' }
  return { ...row, incoming, otherId, otherName: row.displayName || `会员 ${otherId}`,
    canRespond: incoming && row.status === 'pending', statusText: labels[row.status], timeText: timeText(row.createdAt) }
}

function matchmakingView(row: MatchmakingRequest, viewer: number): MatchmakingView {
  const own = row.memberUserId === viewer
  const otherId = own ? row.targetUserId : Number(row.memberUserId)
  const selfConfirmed = own ? row.memberConsent : row.targetConsent
  const otherConfirmed = own ? row.targetConsent : row.memberConsent
  const pendingText = !row.serviceConfirmed ? '等待主理人确认服务安排' : selfConfirmed ? '已同意，等待对方确认' : otherConfirmed ? '对方已同意，等待你的确认' : '等待双方确认'
  const labels = { pending: pendingText, connected: '已建立联系 · 已扣1次', rejected: '已婉拒 · 不扣次数', cancelled: '已取消 · 不扣次数' }
  return { ...row, otherId, otherName: row.displayName || `会员 ${otherId}`, canRespond: row.status === 'pending' && row.serviceConfirmed === true && !selfConfirmed,
    canCancel: row.status === 'pending' && own, statusText: labels[row.status], timeText: timeText(row.createdAt) }
}

Page({
  _vipGeneration: 0,
  _vipScope: '',
  _vipVisible: true,
  _vipUnloaded: false,
  _vipActionGeneration: 0,
  data: {
    section: 'visitors' as Section,
    sections: [{ id: 'visitors', label: '来访' }, { id: 'exchanges', label: '微信交换' }, { id: 'online', label: '上线提醒' }, { id: 'matchmaking', label: '人工牵线' }],
    isVip: false, invisible: false, loading: false, error: '', busy: '',
    vipStatusText: '正在确认会员状态',
    visitors: [] as VisitorView[], visitorTotal: 0, visitorPage: 1, visitorHasMore: false,
    exchanges: [] as ExchangeView[], subscriptions: [] as OnlineSubscription[],
    reminders: [] as Array<NotificationMessage & { timeText: string }>,
    packages: [] as Array<MatchmakingPackage & { expireText: string }>,
    requests: [] as MatchmakingView[], readiness: null as MatchmakingReadiness | null,
    matchmakingProgress: null as MatchmakingProgress | null, matchmakingReady: false,
    matchmakingProgressTitle: '', matchmakingProgressNote: '', hasMatchmakingService: false, canContactMatchmaker: false,
    targetUserId: 0, targetName: '', wechatId: '', matchmakingNote: '',
    managedMemberUserId: 0, managingMember: false,
    revealedExchangeId: '', revealedWechat: '',
    canRespondExchange: false, readinessNote: '',
    visitorError: '', exchangeError: '', onlineError: '', matchmakingError: ''
  },

  onLoad(options: Record<string, string | undefined>) {
    const target = Number(options.targetUserId)
    const section = String(options.section || options.tab || (options.type === 'matchmaking' ? 'matchmaking' : 'visitors'))
    const managedMemberUserId = Number(options.memberUserId)
    const user = currentUser()
    const managingMember = Number.isSafeInteger(managedMemberUserId) && managedMemberUserId > 0 && (user?.currentRole || user?.role) === 'matchmaker'
    this.setData({ targetUserId: Number.isSafeInteger(target) && target > 0 ? target : 0,
      targetName: decodedName(options.targetName),
      managedMemberUserId: managingMember ? managedMemberUserId : 0, managingMember,
      section: ['visitors', 'exchanges', 'online', 'matchmaking'].includes(section) ? section as Section : 'visitors' })
  },

  onShow() {
    this._vipVisible = true
    this._vipUnloaded = false
    return this.load()
  },

  onHide() {
    this._vipVisible = false
    this._vipGeneration += 1
    this._vipActionGeneration += 1
    this.setData({ revealedWechat: '', revealedExchangeId: '', wechatId: '', busy: '', loading: false })
  },

  onUnload() {
    this._vipUnloaded = true
    this._vipVisible = false
    this._vipGeneration += 1
    this._vipActionGeneration += 1
  },

  isCurrent(scope: string, generation: number) {
    return this._vipVisible && !this._vipUnloaded && scope === pageSessionScope() && generation === this._vipGeneration
  },

  async load() {
    const scope = pageSessionScope()
    if (!scope) {
      this.setData({ visitors: [], exchanges: [], reminders: [], requests: [], packages: [], revealedWechat: '', isVip: false,
        matchmakingProgress: null, matchmakingReady: false, matchmakingProgressTitle: '', matchmakingProgressNote: '', hasMatchmakingService: false, canContactMatchmaker: false })
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    if (scope !== this._vipScope) this.setData({ visitors: [], exchanges: [], subscriptions: [], reminders: [], requests: [], packages: [],
      readiness: null, revealedWechat: '', revealedExchangeId: '', invisible: false, isVip: false, wechatId: '', busy: '',
      matchmakingProgress: null, matchmakingReady: false, matchmakingProgressTitle: '', matchmakingProgressNote: '', hasMatchmakingService: false, canContactMatchmaker: false })
    const current = currentUser()
    if (this.data.managingMember && (current?.currentRole || current?.role) !== 'matchmaker') this.setData({ managingMember: false, managedMemberUserId: 0, targetUserId: 0, targetName: '' })
    this._vipScope = scope
    const generation = ++this._vipGeneration
    this.setData({ loading: true, error: '', visitorError: '', exchangeError: '', onlineError: '', matchmakingError: '' })
    if (this.data.managingMember) {
      const managedMemberUserId = this.data.managedMemberUserId
      const results = await Promise.allSettled([memberApi.matchmakingReadiness(managedMemberUserId), memberApi.matchmakingRequests()])
      if (!this.isCurrent(scope, generation)) return
      const [readiness, requests] = results
      this.setData({ section: 'matchmaking', isVip: false, visitors: [], exchanges: [], subscriptions: [], reminders: [], packages: [],
        matchmakingProgress: null, matchmakingReady: false, matchmakingProgressTitle: '', matchmakingProgressNote: '', hasMatchmakingService: false, canContactMatchmaker: false,
        vipStatusText: `为所属会员 ${managedMemberUserId} 跟进人工牵线`,
        readiness: readiness.status === 'fulfilled' ? readiness.value : null,
        readinessNote: readiness.status === 'fulfilled' ? readinessText(readiness.value.reason) : '',
        requests: requests.status === 'fulfilled' ? requests.value.list.filter(row => row.memberUserId === managedMemberUserId).map(row => ({
          ...matchmakingView(row, userId()), otherId: row.targetUserId, otherName: row.displayName || `推荐对象 ${row.targetUserId}`, canRespond: false, canCancel: false
        })) : [],
        matchmakingError: readiness.status === 'rejected' || requests.status === 'rejected' ? '所属会员牵线记录暂时无法加载，请重试。' : '', loading: false })
      return
    }
    const results = await Promise.allSettled([memberApi.vipOverview(), memberApi.matchmakingRequests(), memberApi.wechatExchanges(), memberApi.onlineSubscriptions()])
    if (!this.isCurrent(scope, generation)) return
    const [vip, matchmaking, exchanges, subscriptions] = results
    const isVip = vip.status === 'fulfilled' && vip.value.isPremiumMember === true
    const expiry = vip.status === 'fulfilled' ? vip.value.vipMembership?.expireAt || vip.value.expireAt : null
    const progress = vip.status === 'fulfilled' ? matchmakingProgress(vip.value) : null
    const nextStep = progress ? progressText(progress) : null
    this.setData({ isVip, invisible: isVip && vip.status === 'fulfilled' && (vip.value.privacy?.invisible === true || vip.value.invisible === true),
      vipStatusText: vip.status === 'rejected' ? '会员状态暂不可用，请重试' : isVip ? (vip.value.lifetime || vip.value.vipMembership?.lifetime ? 'VIP长期有效' : `VIP有效至 ${timeText(expiry) || '服务端确认日期'}`) : '开通VIP，使用专属权益',
      error: vip.status === 'rejected' ? '部分权益暂时无法加载，请重试。' : '',
      packages: vip.status === 'fulfilled' ? (vip.value.matchmakingPackages || []).map(row => ({ ...row, expireText: timeText(row.expireAt) })) : [],
      readiness: vip.status === 'fulfilled' ? vip.value.matchmakingReadiness || null : null,
      readinessNote: vip.status === 'fulfilled' && vip.value.matchmakingReadiness ? readinessText(vip.value.matchmakingReadiness.reason) : '',
      matchmakingProgress: progress, matchmakingReady: progress?.status === 'ready',
      matchmakingProgressTitle: nextStep?.title || '', matchmakingProgressNote: nextStep?.note || '',
      hasMatchmakingService: vip.status === 'fulfilled' && (vip.value.matchmakingPackages || []).some(row => row.status === 'active' && row.remainingCount > 0),
      canContactMatchmaker: progress?.assigned === true,
      requests: matchmaking.status === 'fulfilled' ? matchmaking.value.list.map(row => matchmakingView(row, userId())) : [],
      exchanges: exchanges.status === 'fulfilled' ? exchanges.value.list.map(row => exchangeView(row, userId())) : [],
      canRespondExchange: exchanges.status === 'fulfilled' && exchanges.value.list.some(row => row.recipientId === userId() && row.status === 'pending'),
      exchangeError: exchanges.status === 'rejected' ? '微信交换记录暂时无法加载。' : '',
      subscriptions: subscriptions.status === 'fulfilled' ? subscriptions.value.list.filter(row => row.active) : [],
      onlineError: subscriptions.status === 'rejected' ? '上线订阅暂时无法加载。' : '',
      matchmakingError: vip.status === 'rejected' || matchmaking.status === 'rejected' ? '牵线权益暂时无法加载，请重试。' : '' })
    if (!isVip) {
      this.setData({ visitors: [], reminders: [], visitorTotal: 0, visitorHasMore: false, revealedWechat: '', revealedExchangeId: '', loading: false })
      return
    }
    const details = await Promise.allSettled([memberApi.visitors({ page: 1, pageSize: 20 }), messageApi.list({ page: 1, pageSize: 50 })])
    if (!this.isCurrent(scope, generation)) return
    const [visitors, notifications] = details
    this.setData({ visitors: visitors.status === 'fulfilled' ? visitors.value.list.map(row => ({ ...row, timeText: timeText(row.visitedAt) })) : [],
      visitorTotal: visitors.status === 'fulfilled' ? visitors.value.total : 0, visitorPage: 1,
      visitorHasMore: visitors.status === 'fulfilled' && visitors.value.list.length < visitors.value.total,
      visitorError: visitors.status === 'rejected' ? '来访记录暂时无法加载。' : '',
      reminders: notifications.status === 'fulfilled' ? notifications.value.list.filter(row => row.contentType === 'online_reminder' || row.messageType === 'online_reminder').map(row => ({ ...row, timeText: timeText(row.createdAt) })) : [],
      onlineError: subscriptions.status === 'rejected' || notifications.status === 'rejected' ? '上线提醒暂时无法加载。' : '', loading: false })
  },

  switchSection(e: WechatMiniprogram.TouchEvent) {
    if (this.data.managingMember) return
    const section = String(e.currentTarget.dataset.section || '')
    if (['visitors', 'exchanges', 'online', 'matchmaking'].includes(section)) this.setData({ section: section as Section, revealedWechat: '', revealedExchangeId: '' })
  },

  goMembership() { wx.navigateTo({ url: `/pages/user/membership${this.data.section === 'matchmaking' ? '?type=matchmaking' : ''}` }) },
  goRecommend() { wx.switchTab({ url: '/pages/user/members' }) },
  goProfile() { wx.switchTab({ url: '/pages/user/profile' }) },

  async contactMatchmaker() {
    const scope = pageSessionScope(), generation = this._vipGeneration
    if (!this.data.canContactMatchmaker || this.data.managingMember || !scope || !this._vipVisible || this.data.busy) return
    try {
      const matchmakerUserId = this.data.matchmakingProgress?.matchmakerUserId
      const conversations = await chatApi.listConversations({ page: 1, pageSize: 100 })
      if (!this.isCurrent(scope, generation)) return
      const service = conversations.list.find(item => item.conversationType === 'member_matchmaker' && (!matchmakerUserId || item.peer?.id === matchmakerUserId))
      if (service) { wx.navigateTo({ url: `/pages/user/chat?id=${service.id}` }); return }
      if (matchmakerUserId) {
        const conversation = await chatApi.getOrCreateConversation({ targetUserId: matchmakerUserId })
        if (this.isCurrent(scope, generation)) wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` })
        return
      }
      wx.showToast({ title: '服务会话暂不可用，请稍后重试', icon: 'none' })
    } catch (error) {
      if (this.isCurrent(scope, generation)) wx.showToast({ title: apiErrorMessage(error) || '服务会话暂不可用，请稍后重试', icon: 'none' })
    }
  },

  async action(key: string, operation: () => Promise<unknown>, success: string) {
    const scope = pageSessionScope(), generation = this._vipGeneration
    if (!scope || this.data.busy || this.data.loading || !this._vipVisible) return
    this.setData({ busy: key })
    const actionGeneration = ++this._vipActionGeneration
    try {
      await operation()
      if (!this.isCurrent(scope, generation)) return
      wx.showToast({ title: success, icon: 'none' })
      await this.load()
    } catch (err) {
      if (this.isCurrent(scope, generation)) {
        wx.showToast({ title: apiErrorMessage(err) || '操作未完成，请重试', icon: 'none' })
        if (key === 'privacy') this.setData({ invisible: this.data.invisible })
      }
    } finally {
      if (!this._vipUnloaded && scope === pageSessionScope() && this._vipVisible && actionGeneration === this._vipActionGeneration) this.setData({ busy: '' })
    }
  },

  onPrivacyChange(e: WechatMiniprogram.SwitchChange) {
    if (!this.data.isVip) return this.goMembership()
    return this.action('privacy', () => memberApi.updatePrivacy({ invisible: e.detail.value }), e.detail.value ? '已开启隐身访问' : '已关闭隐身访问')
  },

  onWechatInput(e: WechatMiniprogram.Input) { this.setData({ wechatId: e.detail.value.trim() }) },
  onNoteInput(e: WechatMiniprogram.Input) { this.setData({ matchmakingNote: e.detail.value }) },

  validWechat() {
    if (!this.data.wechatId || this.data.wechatId.length > 64 || /[\x00-\x1f\x7f]/.test(this.data.wechatId)) {
      wx.showToast({ title: '请填写有效的本人微信号', icon: 'none' })
      return false
    }
    return true
  },

  requestExchange() {
    if (!this.data.isVip) return this.goMembership()
    if (!this.data.targetUserId || !this.validWechat()) return
    return this.action('exchange-new', () => memberApi.requestWechatExchange({ targetUserId: this.data.targetUserId, wechatId: this.data.wechatId }), '申请已发送，等待对方同意')
  },

  respondExchange(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || ''), accepted = e.currentTarget.dataset.accepted === true
    const item = this.data.exchanges.find(row => row.id === id)
    if (!item?.canRespond || (accepted && !this.validWechat())) return
    return this.action(`exchange-${id}`, () => memberApi.respondWechatExchange(id, { accepted, ...(accepted ? { wechatId: this.data.wechatId } : {}) }), accepted ? '已同意交换微信' : '已婉拒')
  },

  async revealWechat(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || ''), scope = pageSessionScope(), generation = this._vipGeneration
    if (!this.data.exchanges.some(row => row.id === id && row.status === 'accepted') || this.data.busy || !scope) return
    this.setData({ busy: `reveal-${id}`, revealedWechat: '', revealedExchangeId: '' })
    try {
      const item = await memberApi.wechatExchange(id)
      if (!this.isCurrent(scope, generation)) return
      if (item.status !== 'accepted' || !item.wechat?.peer) throw new Error('双方同意后才能查看微信号')
      this.setData({ revealedExchangeId: id, revealedWechat: item.wechat.peer })
    } catch (err) {
      if (this.isCurrent(scope, generation)) wx.showToast({ title: apiErrorMessage(err), icon: 'none' })
    } finally {
      if (this.isCurrent(scope, generation)) this.setData({ busy: '' })
    }
  },

  copyWechat() {
    if (this.data.revealedWechat && this._vipVisible) wx.setClipboardData({ data: this.data.revealedWechat })
  },

  subscribeTarget() {
    if (!this.data.isVip) return this.goMembership()
    if (!this.data.targetUserId) return
    return this.action('online-new', () => memberApi.subscribeOnline({ targetUserId: this.data.targetUserId, active: true }), '已开启站内上线提醒')
  },

  unsubscribe(e: WechatMiniprogram.TouchEvent) {
    const targetUserId = Number(e.currentTarget.dataset.id)
    if (!this.data.subscriptions.some(row => row.targetUserId === targetUserId)) return
    return this.action(`online-${targetUserId}`, () => memberApi.subscribeOnline({ targetUserId, active: false }), '已取消上线提醒')
  },

  markReminderRead(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id)
    if (!this.data.reminders.some(row => row.id === id)) return
    return this.action(`reminder-${id}`, () => messageApi.markRead(id), '已标记为已读')
  },

  applyMatchmaking() {
    if (this.data.managingMember) return
    if (!this.data.targetUserId || !this.data.matchmakingReady) return
    if (!this.data.packages.some(row => row.status === 'active' && row.remainingCount > 0)) return this.goMembership()
    return this.action('matchmaking-new', () => memberApi.requestMatchmaking({ targetUserId: this.data.targetUserId, note: this.data.matchmakingNote.trim() }), '牵线申请已提交')
  },

  respondMatchmaking(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || ''), accepted = e.currentTarget.dataset.accepted === true
    if (!this.data.requests.some(row => row.id === id && row.canRespond)) return
    return this.action(`matchmaking-${id}`, () => memberApi.respondMatchmaking(id, { accepted }), accepted ? '已确认同意，双方确认后建立联系' : '已婉拒，不扣次数')
  },

  cancelMatchmaking(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!this.data.requests.some(row => row.id === id && row.canCancel)) return
    return this.action(`matchmaking-${id}`, () => memberApi.cancelMatchmaking(id), '已取消，不扣次数')
  },

  approveMatchmaking(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const item = this.data.requests.find(row => row.id === id)
    if (!this.data.managingMember || !item || item.memberUserId !== this.data.managedMemberUserId || item.status !== 'pending' || item.serviceConfirmed) return
    return this.action(`approve-${id}`, () => memberApi.approveMatchmaking(id), '服务安排已确认，等待双方本人同意')
  },

  openConversation(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id)
    if (Number.isSafeInteger(id) && id > 0) wx.navigateTo({ url: `/pages/user/chat?id=${id}` })
  },

  openVisitor(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (this.data.isVip && id) wx.navigateTo({ url: `/pages/user/member-detail?id=${encodeURIComponent(id)}` })
  },

  async moreVisitors() {
    if (!this.data.isVip || !this.data.visitorHasMore || this.data.busy || this.data.loading) return
    const scope = pageSessionScope(), generation = this._vipGeneration, page = this.data.visitorPage + 1
    this.setData({ busy: 'visitors-more' })
    try {
      const result = await memberApi.visitors({ page, pageSize: 20 })
      if (!this.isCurrent(scope, generation)) return
      const rows = [...this.data.visitors, ...result.list.map(row => ({ ...row, timeText: timeText(row.visitedAt) }))]
      this.setData({ visitors: rows, visitorPage: page, visitorTotal: result.total, visitorHasMore: result.list.length > 0 && rows.length < result.total })
    } catch (err) {
      if (this.isCurrent(scope, generation)) wx.showToast({ title: apiErrorMessage(err) || '来访加载失败', icon: 'none' })
    } finally {
      if (this.isCurrent(scope, generation)) this.setData({ busy: '' })
    }
  }
})
