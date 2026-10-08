import { defineMatchmakerController } from '../../utils/matchmaker-workspace'
import { apiErrorMessage, currentUser, isSessionRecoverableError } from '../../services/api'
import { matchmakerApi } from '../../services/matchmaker'
import { invitePath } from '../../utils/invite'
import {
  MATCHMAKER_PAGE_TTL_MS,
  MatchmakerPageRequestDiscarded,
  invalidateMatchmakerPageSnapshots,
  matchmakerPageSnapshotRevision,
  matchmakerPageSessionScope,
  readMatchmakerPageSnapshot,
  requestMatchmakerPageSnapshot,
  writeMatchmakerPageSnapshot
} from '../../utils/matchmaker-page-cache'

const DASHBOARD_ROUTE = '/matchmaker/dashboard'
const INVITE_ROUTE = '/matchmaker/invite-card'
const MINE_ROUTE = '/pages/matchmaker/mine'

function defaultDashboard() {
  return {
    matchmaker: {
      memberCount: 0,
      certificationStatus: 0,
      certificationRemark: '',
      level: 1,
      matchmakerNo: ''
    },
    operations: {
      salonCount: 0
    }
  }
}

function defaultInviteCard() {
  return {
    matchmakerNo: '',
    inviteCode: '',
    sharePath: '',
    qrCodeFileID: '',
    matchmaker: {
      nickname: '',
      avatarUrl: '',
      level: 1
    }
  }
}

type Dashboard = ReturnType<typeof defaultDashboard>
type InviteCard = ReturnType<typeof defaultInviteCard>

function certificationView(matchmaker: { certificationStatus?: number | string; certificationRemark?: string } | undefined) {
  const status = Number((matchmaker && matchmaker.certificationStatus) || 0)
  const remark = (matchmaker && matchmaker.certificationRemark) || ''
  if (status === 2) {
    return {
      canOperate: true,
      statusText: '已认证',
      statusTagClass: 'gold',
      statusNote: '主理人权限已开通，可进入资源池和运营页面。'
    }
  }
  if (status === 1) {
    return {
      canOperate: false,
      statusText: '已拒绝',
      statusTagClass: 'rose',
      statusNote: remark || '本次申请暂未通过，请完善资料后重新提交。'
    }
  }
  return {
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '主理人申请已提交，后台审批通过后将开放资源池、会员经营和沙龙发起权限。'
  }
}

function isAccessDenied(err: unknown) {
  const code = Number((err as { code?: number } | null)?.code)
  return isSessionRecoverableError(err) || code === 403 || code === 40300 || code === 40301
}

function isMissingMatchmaker(err: unknown) {
  return Number((err as { code?: number } | null)?.code) === 40400 && apiErrorMessage(err) === 'matchmaker not found'
}

export const mineController = defineMatchmakerController({
  _sessionScope: '',
  _dashboardGeneration: 0,
  _inviteGeneration: 0,
  _dashboardPending: null as Promise<void> | null,
  _invitePending: null as Promise<void> | null,
  _applying: false,
  _authorizationRevision: -1,

  data: {
    user: null as any,
    dashboard: defaultDashboard() as any,
    loading: false,
    inviteCard: defaultInviteCard() as any,
    inviteLoading: false,
    inviteResetting: false,
    inviteOpen: false,
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '申请已提交，后台审核通过后将开放资源池、会员经营和沙龙发起权限。'
  },

  onShow() {
    return this.loadDashboard()
  },

  onUnload() {
    this._dashboardGeneration += 1
    this._inviteGeneration += 1
    this._dashboardPending = null
    this._invitePending = null
  },

  onPullDownRefresh() {
    return this.loadDashboard(true).finally(() => wx.stopPullDownRefresh())
  },

  synchronizeSession() {
    const scope = matchmakerPageSessionScope()
    if (scope !== this._sessionScope) {
      this._sessionScope = scope
      this._dashboardGeneration += 1
      this._inviteGeneration += 1
      this._dashboardPending = null
      this._invitePending = null
      this._applying = false
      this._authorizationRevision = -1
      this.setData({
        user: currentUser() || {}, dashboard: defaultDashboard(), loading: false,
        inviteCard: defaultInviteCard(), inviteLoading: false, inviteResetting: false,
        inviteOpen: false, ...certificationView(undefined)
      })
      const cached = readMatchmakerPageSnapshot<{ inviteOpen: boolean }>(MINE_ROUTE)
      if (cached) this.setData({ inviteOpen: cached.data.inviteOpen === true })
    }
    if (this.data.canOperate && this._authorizationRevision !== matchmakerPageSnapshotRevision()) {
      this._dashboardGeneration += 1
      this._inviteGeneration += 1
      this._dashboardPending = null
      this._invitePending = null
      this.setData({
        dashboard: defaultDashboard(), loading: false, inviteCard: defaultInviteCard(),
        inviteOpen: false, inviteLoading: false, inviteResetting: false, ...certificationView(undefined)
      })
    }
    if (scope) return scope
    wx.redirectTo({ url: '/pages/index/index' })
    return ''
  },

  applyDashboard(dashboard: Dashboard, loadedAt: number, fromServer = false) {
    const view = certificationView(dashboard.matchmaker)
    if (!view.canOperate) {
      const matchmaker = {
        memberCount: 0,
        level: dashboard.matchmaker.level || 1,
        certificationStatus: dashboard.matchmaker.certificationStatus,
        certificationRemark: dashboard.matchmaker.certificationRemark || '',
        matchmakerNo: dashboard.matchmaker.matchmakerNo || ''
      }
      dashboard = { ...defaultDashboard(), matchmaker }
      if (fromServer) {
        invalidateMatchmakerPageSnapshots()
        writeMatchmakerPageSnapshot(DASHBOARD_ROUTE, dashboard, loadedAt)
      }
      this._inviteGeneration += 1
      this._invitePending = null
      this.setData({ inviteCard: defaultInviteCard(), inviteOpen: false, inviteLoading: false, inviteResetting: false })
    }
    this._authorizationRevision = matchmakerPageSnapshotRevision()
    this.setData({ user: currentUser() || {}, dashboard, ...view })
  },

  async loadOrCreateDashboard(isCurrent: () => boolean = () => true): Promise<Dashboard> {
    try {
      return await matchmakerApi.dashboard(false)
    } catch (err) {
      if (!isCurrent()) throw new MatchmakerPageRequestDiscarded()
      if (!isMissingMatchmaker(err)) throw err
      await matchmakerApi.apply()
      if (!isCurrent()) throw new MatchmakerPageRequestDiscarded()
      return matchmakerApi.dashboard(false)
    }
  },

  loadDashboard(force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope) return Promise.resolve()
    if (!force && this._dashboardPending) return this._dashboardPending
    const generation = ++this._dashboardGeneration
    const revision = matchmakerPageSnapshotRevision()
    const isPageCurrent = () => generation === this._dashboardGeneration && matchmakerPageSessionScope() === scope
    const isCurrent = () => isPageCurrent() && matchmakerPageSnapshotRevision() === revision
    const cached = readMatchmakerPageSnapshot<Dashboard>(DASHBOARD_ROUTE)
    if (cached) {
      this.applyDashboard(cached.data, cached.loadedAt)
      if (this.data.canOperate) {
        const invite = readMatchmakerPageSnapshot<InviteCard>(INVITE_ROUTE)
        if (invite) this.setData({ inviteCard: invite.data, inviteLoading: false })
      }
    }
    this.setData({ loading: !cached })
    if (cached && !force && Date.now() - cached.loadedAt < MATCHMAKER_PAGE_TTL_MS) {
      return this.data.canOperate ? this.loadInviteCard(false) : Promise.resolve()
    }
    const isSessionCurrent = () => matchmakerPageSessionScope() === scope && matchmakerPageSnapshotRevision() === revision

    const pending = Promise.resolve().then(async () => {
      try {
        const snapshot = await requestMatchmakerPageSnapshot(DASHBOARD_ROUTE, () => this.loadOrCreateDashboard(isSessionCurrent), force, isCurrent)
        if (!isCurrent()) return
        this.applyDashboard(snapshot.data, snapshot.loadedAt, true)
        if (this.data.canOperate) await this.loadInviteCard(false, force)
      } catch (err) {
        if (err instanceof MatchmakerPageRequestDiscarded) {
          if (isPageCurrent() && matchmakerPageSnapshotRevision() !== revision) this.synchronizeSession()
          return
        }
        if (matchmakerPageSessionScope() !== scope) {
          this.synchronizeSession()
          return
        }
        if (!isPageCurrent()) return
        if (!isCurrent()) {
          this.synchronizeSession()
          return
        }
        if (!cached || isAccessDenied(err) || isMissingMatchmaker(err)) {
          if (isAccessDenied(err) || isMissingMatchmaker(err)) invalidateMatchmakerPageSnapshots()
          this._inviteGeneration += 1
          this._invitePending = null
          this.setData({
            user: currentUser() || {}, dashboard: defaultDashboard(), canOperate: false,
            inviteCard: defaultInviteCard(), inviteOpen: false, inviteLoading: false,
            statusText: isSessionRecoverableError(err) ? '登录状态需刷新' : '服务暂不可用',
            statusTagClass: 'rose', statusNote: apiErrorMessage(err) || '暂时无法读取，请稍后重试。'
          })
        }
      } finally {
        if (isPageCurrent()) this.setData({ loading: false })
        if (this._dashboardPending === pending) this._dashboardPending = null
      }
    })
    this._dashboardPending = pending
    return pending
  },

  async applyAgain() {
    const scope = this.synchronizeSession()
    if (!scope || this._applying || this.data.loading) return
    const generation = this._dashboardGeneration
    const revision = matchmakerPageSnapshotRevision()
    const isCurrent = () => generation === this._dashboardGeneration && matchmakerPageSessionScope() === scope && matchmakerPageSnapshotRevision() === revision
    this._applying = true
    this.setData({ loading: true })
    try {
      await matchmakerApi.apply()
      if (!isCurrent()) return
      invalidateMatchmakerPageSnapshots()
      wx.showToast({ title: '已重新提交' })
      await this.loadDashboard(true)
    } catch (err) {
      if (matchmakerPageSessionScope() !== scope) this.synchronizeSession()
    } finally {
      if (this._sessionScope === scope && matchmakerPageSessionScope() === scope) {
        this._applying = false
        this.setData({ loading: false })
      }
    }
  },

  loadInviteCard(showError = true, force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope || !this.data.canOperate) return Promise.resolve()
    if (!force && this._invitePending) return this._invitePending
    const generation = ++this._inviteGeneration
    const revision = matchmakerPageSnapshotRevision()
    const isPageCurrent = () => generation === this._inviteGeneration && matchmakerPageSessionScope() === scope
    const isCurrent = () => isPageCurrent() && matchmakerPageSnapshotRevision() === revision && this.data.canOperate
    const cached = readMatchmakerPageSnapshot<InviteCard>(INVITE_ROUTE)
    this.setData({ inviteCard: cached ? cached.data : this.data.inviteCard, inviteLoading: !cached })
    if (cached && !force && Date.now() - cached.loadedAt < MATCHMAKER_PAGE_TTL_MS) return Promise.resolve()

    const pending = Promise.resolve().then(async () => {
      try {
        const snapshot = await requestMatchmakerPageSnapshot<InviteCard>(INVITE_ROUTE, () => matchmakerApi.inviteCard(showError && !cached), force, isCurrent)
        if (isCurrent()) this.setData({ inviteCard: snapshot.data })
      } catch (err) {
        if (err instanceof MatchmakerPageRequestDiscarded) {
          if (isPageCurrent() && matchmakerPageSnapshotRevision() !== revision) this.synchronizeSession()
          return
        }
        if (matchmakerPageSessionScope() !== scope) {
          this.synchronizeSession()
          return
        }
        if (!isPageCurrent()) return
        if (!isCurrent()) {
          this.synchronizeSession()
          return
        }
        if (isAccessDenied(err) || isMissingMatchmaker(err)) {
          invalidateMatchmakerPageSnapshots()
          this.setData({
            dashboard: defaultDashboard(), canOperate: false, inviteCard: defaultInviteCard(), inviteOpen: false,
            statusText: '认证状态需确认', statusTagClass: 'rose', statusNote: '权限已更新，请重新确认主理人认证状态。'
          })
        } else if (!cached) this.setData({ inviteCard: defaultInviteCard() })
      } finally {
        if (generation === this._inviteGeneration && matchmakerPageSessionScope() === scope) this.setData({ inviteLoading: false })
        if (this._invitePending === pending) this._invitePending = null
      }
    })
    this._invitePending = pending
    return pending
  },

  copyInviteCode() {
    if (!this.synchronizeSession() || !this.data.canOperate) return
    const code = this.data.inviteCard && this.data.inviteCard.inviteCode
    if (!code) return
    wx.setClipboardData({ data: code })
  },

  previewInviteQr() {
    if (!this.synchronizeSession() || !this.data.canOperate) return
    const fileID = this.data.inviteCard && this.data.inviteCard.qrCodeFileID
    if (!fileID) return
    wx.previewImage({ urls: [fileID] })
  },

  toggleInvite() {
    if (!this.synchronizeSession() || !this.data.canOperate) return
    this.setData({ inviteOpen: !this.data.inviteOpen })
    writeMatchmakerPageSnapshot(MINE_ROUTE, { inviteOpen: this.data.inviteOpen })
  },

  async resetInviteCode() {
    const scope = this.synchronizeSession()
    if (!scope || !this.data.canOperate || this.data.inviteResetting) return
    const generation = this._inviteGeneration
    const revision = matchmakerPageSnapshotRevision()
    const isCurrent = () => generation === this._inviteGeneration && matchmakerPageSessionScope() === scope && matchmakerPageSnapshotRevision() === revision && this.data.canOperate
    wx.showModal({
      title: '重置邀请码',
      content: '重置后旧注册链接、邀请码和二维码将失效，已有会员关系不受影响。',
      success: async res => {
        if (!res.confirm || !isCurrent()) return
        this._inviteGeneration += 1
        const resetGeneration = this._inviteGeneration
        this._invitePending = null
        invalidateMatchmakerPageSnapshots()
        this._authorizationRevision = matchmakerPageSnapshotRevision()
        const resetRevision = this._authorizationRevision
        const isResetCurrent = () => resetGeneration === this._inviteGeneration && matchmakerPageSessionScope() === scope && matchmakerPageSnapshotRevision() === resetRevision && this.data.canOperate
        this.setData({ inviteResetting: true })
        try {
          const inviteCard = await matchmakerApi.resetInviteCode()
          if (!isResetCurrent()) return
          invalidateMatchmakerPageSnapshots()
          this._authorizationRevision = matchmakerPageSnapshotRevision()
          writeMatchmakerPageSnapshot(INVITE_ROUTE, inviteCard)
          writeMatchmakerPageSnapshot(MINE_ROUTE, { inviteOpen: this.data.inviteOpen })
          this.setData({ inviteCard })
          wx.showToast({ title: '已重置' })
        } catch (err) {
          if (matchmakerPageSessionScope() !== scope) this.synchronizeSession()
          else if (isResetCurrent() && isAccessDenied(err)) {
            invalidateMatchmakerPageSnapshots()
            this.setData({ canOperate: false, inviteCard: defaultInviteCard(), inviteOpen: false })
          }
        } finally {
          if (resetGeneration === this._inviteGeneration && matchmakerPageSessionScope() === scope) this.setData({ inviteResetting: false })
        }
      }
    })
  },

  goResources() {
    if (!this.synchronizeSession()) return
    if (!this.data.canOperate) {
      wx.showToast({ title: '主理人认证通过后可使用', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/matchmaker/resources' })
  },

  logout() {
    const app = getApp<IAppOption>()
    app.globalData.token = ''
    app.globalData.user = undefined
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
    invalidateMatchmakerPageSnapshots()
    this._dashboardGeneration += 1
    this._inviteGeneration += 1
    this._dashboardPending = null
    this._invitePending = null
    this.setData({ user: {}, dashboard: defaultDashboard(), inviteCard: defaultInviteCard(), inviteOpen: false, ...certificationView(undefined) })
    wx.redirectTo({ url: '/pages/index/index' })
  },

  onShareAppMessage() {
    const allowed = this._sessionScope === matchmakerPageSessionScope() && this.data.canOperate
      && this._authorizationRevision === matchmakerPageSnapshotRevision()
    const card = allowed ? this.data.inviteCard || {} : {}
    const code = card.inviteCode || ''
    return {
      title: `${(this.data.user && this.data.user.nickname) || '主理人'}邀请你注册成为会员`,
      path: card.sharePath || invitePath(code, 'matchmakerShare')
    }
  }
})
