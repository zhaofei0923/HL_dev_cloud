import { loginByWechat } from '../../services/auth'
import { memberApi } from '../../services/member'
import { apiErrorMessage, request } from '../../services/api'
import { extractInviteCode, invitePath, normalizeInviteCode } from '../../utils/invite'
import { pageSessionScope } from '../../utils/page-session'

function sourceText(source: string) {
  if (source === 'scan') return '扫码添加'
  if (source === 'share' || source === 'matchmakerShare' || source === 'memberShare') return '微信注册链接'
  if (source === 'salonShare' || source === 'memberSalonShare') return '沙龙邀请'
  if (source === 'inviteCode') return '邀请码'
  return '手动输入'
}

function queryValue(raw: string, key: string) {
  const match = raw.match(new RegExp(`[?&#]?${key}=([^&#]+)`, 'i'))
  return match ? safeDecode(match[1]) : ''
}

function safeDecode(value: unknown) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch (err) {
    return ''
  }
}

function eventIdFrom(value: string) {
  const id = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(id) && id > 0 ? String(id) : ''
}

function isAutoInviteSource(source: string) {
  return ['share', 'matchmakerShare', 'memberShare', 'salonShare', 'memberSalonShare'].includes(source)
}

function errorMessage(err: any) {
  return String((err && (err.message || err.errMsg)) || err || '处理失败')
}

function parseOptions(options: Record<string, any>) {
  const scene = options.scene ? safeDecode(options.scene) : ''
  const code = extractInviteCode(options.code || options.inviteCode || options.matchmakerNo || scene)
  const source = String(options.source || queryValue(scene, 'source') || (scene ? 'scan' : 'share'))
  const rawEventId = String(options.eventId || queryValue(scene, 'eventId') || '').trim()
  const eventId = eventIdFrom(rawEventId)
  const autoRegister = String(options.autoRegister || queryValue(scene, 'autoRegister') || '') === '1' || source === 'salonShare' || source === 'memberSalonShare'
  return {
    code: normalizeInviteCode(code),
    source,
    eventId,
    autoRegister,
    invalidEvent: (!!rawEventId || autoRegister || source === 'salonShare' || source === 'memberSalonShare') && !eventId
  }
}

Page({
  _inviteUnloaded: false,
  _inviteGeneration: 0,
  _activityScope: '',
  _activityPending: null as Promise<void> | null,

  data: {
    code: '',
    source: 'share',
    sourceText: '微信链接',
    invite: null as any,
    canSubmit: false,
    autoMode: false,
    autoRegister: false,
    autoDone: false,
    eventId: '',
    activityInvite: false,
    activityReady: false,
    invalidEvent: false,
    autoMessage: '',
    actionText: '提交添加申请',
    loading: false,
    submitting: false,
    errorText: '',
    sharePath: ''
  },

  async onLoad(options: Record<string, any>) {
    const parsed = parseOptions(options || {})
    this.setData({
      ...parsed,
      activityInvite: !!parsed.eventId || parsed.invalidEvent,
      sourceText: sourceText(parsed.source),
      autoMode: isAutoInviteSource(parsed.source),
      actionText: isAutoInviteSource(parsed.source) ? '正在处理邀请' : '提交添加申请',
      sharePath: parsed.code ? invitePath(parsed.code, parsed.source, {
        eventId: parsed.eventId,
        autoRegister: parsed.autoRegister
      }) : ''
    })
    if (parsed.invalidEvent) {
      this.setData({ errorText: '活动链接不完整，请重新打开活动邀请。' })
      return
    }
    await this.loadInvite()
  },

  onUnload() {
    this._inviteUnloaded = true
    this._inviteGeneration += 1
    this._activityPending = null
  },

  onShow() {
    if (this.data.eventId && this._activityScope && this._activityScope !== pageSessionScope()) {
      return this.loadActivityInvite()
    }
    return Promise.resolve()
  },

  loadActivityInvite(): Promise<void> {
    if (!this.data.eventId || this._inviteUnloaded) return Promise.resolve()
    const scope = pageSessionScope()
    if (this._activityPending && this._activityScope === scope) return this._activityPending
    if (this._activityScope !== scope) {
      this._inviteGeneration += 1
      this._activityPending = null
      this._activityScope = scope
      this.setData({ loading: false, activityReady: false, errorText: '' })
    }
    if (!scope) {
      this.goRegistration()
      return Promise.resolve()
    }
    const generation = ++this._inviteGeneration
    this._activityScope = scope
    const isCurrent = () => !this._inviteUnloaded && generation === this._inviteGeneration
      && pageSessionScope() === scope
    this.setData({ loading: true, errorText: '', activityReady: false,
      actionText: '查看活动并确认报名', autoMessage: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        const status = await request<{ completed: boolean }>('/user/minimum-registration', {
          showError: false,
          unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
        })
        if (!isCurrent()) return
        if (!status.completed) {
          this.goRegistration()
          return
        }
        this.setData({ activityReady: true })
        this.goSalonDetail()
      } catch (err) {
        if (!isCurrent()) {
          return
        }
        this.setData({ errorText: apiErrorMessage(err) || '报名资料暂时无法读取，请重试。' })
      } finally {
        if (isCurrent()) this.setData({ loading: false })
        if (this._activityPending === promise) this._activityPending = null
      }
    })
    this._activityPending = promise
    return promise
  },

  goRegistration() {
    if (!this.data.eventId || this._inviteUnloaded) return
    wx.redirectTo({ url: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}` })
  },

  async ensureLogin() {
    if (wx.getStorageSync('token')) return
    await loginByWechat('user')
  },

  async loadInvite() {
    if (this.data.invalidEvent) return
    if (this.data.eventId) {
      await this.loadActivityInvite()
      return
    }
    const code = normalizeInviteCode(this.data.code)
    if (!code) {
      this.setData({ errorText: '未识别到有效的邀请码或主理人编号' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    try {
      await this.ensureLogin()
      const invite = await memberApi.resolveMatchmakerInvite({
        code,
        source: this.data.source,
        eventId: this.data.eventId
      })
      const pending = invite && invite.existingRequest && invite.existingRequest.status === 'pending'
      const autoMode = isAutoInviteSource(this.data.source)
      this.setData({
        invite,
        autoMode,
        canSubmit: !autoMode && !(invite && invite.alreadyAssigned) && !pending,
        actionText: autoMode ? '正在处理邀请' : '提交添加申请'
      })
      if (autoMode) await this.acceptShareInvite()
    } catch (err: any) {
      console.warn('resolve matchmaker invite failed', err)
      this.setData({ errorText: err && err.message ? err.message : '邀请信息暂不可用', canSubmit: false })
    } finally {
      this.setData({ loading: false })
    }
  },

  async acceptShareInvite() {
    if (this.data.eventId) {
      await this.loadActivityInvite()
      return
    }
    if (this.data.submitting || !this.data.code) return
    this.setData({
      submitting: true,
      errorText: '',
      autoMessage: '',
      actionText: '正在处理邀请'
    })
    try {
      await this.ensureLogin()
      const result: any = await memberApi.acceptMatchmakerInvite({
        code: this.data.code,
        source: this.data.source,
        eventId: this.data.eventId
      })
      const invite = result && result.invite
        ? { ...result.invite, alreadyAssigned: true, existingRequest: result.request || null }
        : this.data.invite
      this.setData({
        invite,
        canSubmit: false,
        autoDone: true,
        actionText: '已自动注册',
        autoMessage: '已成为该主理人名下免费会员。'
      })
      wx.showToast({ title: result && result.alreadyAssigned ? '已是名下会员' : '注册成功', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/user/profile' })
      }, 700)
    } catch (err) {
      console.warn('accept matchmaker invite failed', err)
      this.setData({
        errorText: errorMessage(err),
        autoDone: false,
        actionText: '重新处理邀请'
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async submitRequest() {
    if (this.data.submitting || !this.data.code) return
    this.setData({ submitting: true })
    try {
      await this.ensureLogin()
      const result: any = await memberApi.requestMatchmaker({
        code: this.data.code,
        source: this.data.source
      })
      wx.showToast({ title: result && result.status === 'approved' ? '已是名下会员' : '申请已提交', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/user/profile' })
      }, 500)
    } catch (err) {
      console.warn('submit matchmaker invite failed', err)
    } finally {
      this.setData({ submitting: false })
    }
  },

  copyCode() {
    if (!this.data.code) return
    wx.setClipboardData({ data: this.data.code })
  },

  goProfile() {
    wx.switchTab({ url: '/pages/user/profile' })
  },

  goSalonDetail() {
    if (!this.data.eventId) return
    const ready = this.data.activityReady && this._activityScope === pageSessionScope()
    wx.redirectTo({ url: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}${ready ? '&registrationReady=1' : ''}` })
  },

  onShareAppMessage() {
    if (this.data.activityInvite && this.data.eventId) {
      return {
        title: '邀请你参加沙龙活动',
        path: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}&source=salonShare`
      }
    }
    return {
      title: this.data.autoRegister ? '邀请你报名沙龙活动' : '邀请你注册成为会员',
      path: this.data.sharePath || invitePath(this.data.code, 'matchmakerShare')
    }
  }
})
