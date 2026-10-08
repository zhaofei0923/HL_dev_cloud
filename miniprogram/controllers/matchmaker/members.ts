import { defineMatchmakerController } from '../../utils/matchmaker-workspace'
import { memberApi } from '../../services/member'
import { normalizeMemberProfile } from '../../utils/member-format'
import { matchmakerApi } from '../../services/matchmaker'
import {
  invalidateMatchmakerPageSnapshots,
  MATCHMAKER_PAGE_TTL_MS,
  MatchmakerPageRequestDiscarded,
  matchmakerPageSessionScope,
  matchmakerPageSnapshotRevision,
  readMatchmakerPageSnapshot,
  requestMatchmakerPageSnapshot,
  writeMatchmakerPageSnapshot
} from '../../utils/matchmaker-page-cache'

const PAGE_ROUTE = '/pages/matchmaker/members'

function errorCode(error: unknown) {
  return error && typeof error === 'object' ? Number((error as Record<string, unknown>).code) : 0
}

function denied(error: unknown) {
  const code = errorCode(error)
  return code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403
}

function missingMatchmaker(error: unknown) {
  return errorCode(error) === 40400 && error !== null && typeof error === 'object'
    && (error as Record<string, unknown>).message === 'matchmaker not found'
}

function pickedRow(row: Record<string, unknown>, fields: string[]) {
  const result: Record<string, unknown> = {}
  fields.forEach(field => { if (row[field] !== undefined) result[field] = row[field] })
  return result
}

function normalizeMember(row: any) {
  const member = normalizeMemberProfile(row, true)
  return {
    ...member,
    idText: String(row.id || ''),
    needsAttention: Number((member.profileCompletion || {}).percent || 0) < 70,
    claimPending: (member as any).identityStatus === 'pending'
  }
}

function memberName(member: any) {
  return member ? (member.displayName || member.realName || member.nickname || '会员') : ''
}

function memberOption(member: any) {
  const name = memberName(member)
  const meta = member && member.metaText ? ` · ${member.metaText}` : ''
  return `${name}${meta}`
}

function recommendCard(member: any) {
  if (!member) return {}
  return {
    id: member.id,
    name: memberName(member),
    metaText: member.metaText || '基础信息待完善',
    occupationText: member.occupationText || '职业待完善',
    completionText: member.profileCompletionText || '0%',
    statusText: member.lastRecommendStatusText || '暂无推荐'
  }
}

function recommendState(list: any[], sourceIndex = 0, targetIndex = 0) {
  const members = Array.isArray(list) ? list : []
  const safeSourceIndex = members.length ? Math.min(Math.max(sourceIndex, 0), members.length - 1) : 0
  const source = members[safeSourceIndex] || null
  const targets = source ? members.filter(item => String(item.id) !== String(source.id)) : []
  const safeTargetIndex = targets.length ? Math.min(Math.max(targetIndex, 0), targets.length - 1) : 0
  const target = targets[safeTargetIndex] || null
  return {
    recommendAIndex: safeSourceIndex,
    recommendBIndex: safeTargetIndex,
    recommendAOptions: members.map(memberOption),
    recommendBOptions: targets.map(memberOption),
    recommendA: recommendCard(source),
    recommendB: recommendCard(target),
    recommendReady: !!source && !!target,
    recommendHint: members.length >= 2 ? '选择两名会员后可发起待跟进互推。' : '至少需要两名名下会员。'
  }
}

function normalizeRequest(row: any) {
  const user = row.user || {}
  const profile = row.profile || {}
  const ageText = profile.age ? `${profile.age}岁` : '年龄待补充'
  const cityText = profile.city || '城市待补充'
  return {
    ...row,
    idText: String(row.id || ''),
    displayName: profile.realName || user.nickname || '待完善会员',
    metaText: `${cityText} · ${ageText}`,
    noteText: row.applyMessage || '申请添加为你的名下会员'
  }
}

function certificationView(matchmaker: any) {
  const status = Number((matchmaker && matchmaker.certificationStatus) || 0)
  const remark = (matchmaker && matchmaker.certificationRemark) || ''
  if (status === 2) {
    return {
      canOperate: true,
      statusText: '已认证',
      statusTagClass: 'gold',
      statusNote: '主理人权限已开通，可录入会员并进入资源池协作。'
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
    statusNote: '主理人申请通过后，才可使用会员经营和资源池功能。'
  }
}

export const membersController = defineMatchmakerController({
  _pageScope: '',
  _pageRevision: 0,
  _pageLoadedAt: 0,
  _pageInitialized: false,
  _pageLoadedQuery: '',
  _pageGeneration: 0,
  _pagePendingKey: '',
  _pagePending: null as Promise<void> | null,
  _pageRestored: false,
  _pageUnloaded: false,
  _forceNextShow: false,
  _memberMorePromise: null as Promise<void> | null,

  data: {
    list: [] as any[],
    total: 0,
    page: 1,
    hasMore: false,
    loadingMore: false,
    paginationError: '',
    keyword: '',
    city: '',
    gender: '',
    memberType: '',
    serviceLevel: '',
    memberTypeOptions: ['全部类型', '待消费会员', '免费会员', '付费会员', 'VIP会员'],
    memberTypeValues: ['', 'no_consumption', 'free', 'paid', 'vip'],
    serviceLevelOptions: ['全部等级', 'S级', 'A级', 'B级', 'C级'],
    serviceLevelValues: ['', 'S', 'A', 'B', 'C'],
    memberTypeLabel: '全部类型',
    serviceLevelLabel: '全部等级',
    pendingRequests: [] as any[],
    requestProcessingId: '',
    recommendAIndex: 0,
    recommendBIndex: 0,
    recommendAOptions: [] as string[],
    recommendBOptions: [] as string[],
    recommendA: {} as any,
    recommendB: {} as any,
    recommendReady: false,
    recommendHint: '至少需要两名名下会员。',
    recommendLoading: false,
    filtersOpen: false,
    approvalsOpen: false,
    recommendOpen: false,
    activeMemberActionId: '',
    loading: false,
    initialized: false,
    refreshError: '',
    removingId: '',
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '主理人申请通过后，才可使用会员经营和资源池功能。'
  },

  onLoad() {
    this.restorePageSnapshot()
  },

  onShow() {
    this._pageUnloaded = false
    this.restorePageSnapshot()
    const force = this._forceNextShow
    this._forceNextShow = false
    return this.refreshGate(force)
  },

  onHide() {
    this.savePageSnapshot()
  },

  onUnload() {
    this.savePageSnapshot()
    this._pageUnloaded = true
    this._pageGeneration += 1
    this._pagePending = null
    this._memberMorePromise = null
  },

  ensurePageSession() {
    const scope = matchmakerPageSessionScope()
    const revision = matchmakerPageSnapshotRevision()
    if (scope === this._pageScope && revision === this._pageRevision) return scope
    this._pageScope = scope
    this._pageRevision = revision
    this._pageGeneration += 1
    this._pagePending = null
    this._pagePendingKey = ''
    this._pageLoadedAt = 0
    this._pageLoadedQuery = ''
    this._pageInitialized = false
    this._pageRestored = false
    this._forceNextShow = false
    this._memberMorePromise = null
    this.setData({
      list: [], total: 0, page: 1, hasMore: false, loadingMore: false, paginationError: '', pendingRequests: [], ...recommendState([]),
      keyword: '', city: '', gender: '', memberType: '', serviceLevel: '',
      memberTypeLabel: '全部类型', serviceLevelLabel: '全部等级',
      filtersOpen: false, approvalsOpen: false, recommendOpen: false,
      activeMemberActionId: '', removingId: '', requestProcessingId: '', recommendLoading: false,
      initialized: false, loading: false, refreshError: '', canOperate: false,
      statusText: '待审批', statusTagClass: '',
      statusNote: '主理人申请通过后，才可使用会员经营和资源池功能。'
    })
    return scope
  },

  restorePageSnapshot() {
    if (!this.ensurePageSession() || this._pageRestored) return
    this._pageRestored = true
    const snapshot = readMatchmakerPageSnapshot<Partial<typeof this.data> & { loadedQuery: string }>(PAGE_ROUTE)
    if (!snapshot) return
    const { loadedQuery, ...state } = snapshot.data
    this.setData({ ...state, page: Number(state.page || 1),
      hasMore: Number(state.total || 0) > (state.list || []).length,
      loading: false, loadingMore: false, removingId: '', requestProcessingId: '', recommendLoading: false })
    this._pageLoadedAt = snapshot.loadedAt
    this._pageLoadedQuery = loadedQuery
    this._pageInitialized = state.initialized === true
  },

  queryKey() {
    return JSON.stringify([this.data.keyword, this.data.city, this.data.gender, this.data.memberType, this.data.serviceLevel])
  },

  savePageSnapshot() {
    const scope = this.ensurePageSession()
    if (!scope || !this._pageInitialized || !this.data.canOperate
      || this._pageRevision !== matchmakerPageSnapshotRevision()) return
    const fields = [
      'id', 'userId', 'idText', 'displayName', 'realName', 'nickname', 'metaText',
      'avatarUrl', 'memberTypeText', 'occupationText', 'profileCompletionText', 'needsAttention',
      'lastRecommendStatusText', 'serviceLevelText', 'claimPending', 'identityStatusText', 'displayStatusText'
    ]
    const snapshot = {
      list: this.data.list.map(row => pickedRow(row, fields)),
      total: this.data.total,
      page: this.data.page, hasMore: this.data.hasMore,
      pendingRequests: this.data.pendingRequests.map(row => pickedRow(row, ['id', 'idText', 'displayName', 'metaText', 'noteText'])),
      keyword: this.data.keyword, city: this.data.city, gender: this.data.gender,
      memberType: this.data.memberType, serviceLevel: this.data.serviceLevel,
      memberTypeLabel: this.data.memberTypeLabel, serviceLevelLabel: this.data.serviceLevelLabel,
      filtersOpen: this.data.filtersOpen, approvalsOpen: this.data.approvalsOpen,
      recommendOpen: this.data.recommendOpen, activeMemberActionId: this.data.activeMemberActionId,
      ...recommendState(this.data.list, this.data.recommendAIndex, this.data.recommendBIndex),
      initialized: true, canOperate: this.data.canOperate,
      statusText: this.data.statusText, statusTagClass: this.data.statusTagClass, statusNote: this.data.statusNote,
      refreshError: this.data.refreshError,
      loadedQuery: this._pageLoadedQuery
    }
    writeMatchmakerPageSnapshot(PAGE_ROUTE, snapshot, this._pageLoadedAt)
  },

  clearRestrictedView(note = '访问权限已变化，请重新加载。') {
    this._pageLoadedAt = 0
    this._pageInitialized = false
    invalidateMatchmakerPageSnapshots()
    this._pageRevision = matchmakerPageSnapshotRevision()
    this._pageGeneration += 1
    this._pagePending = null
    this._pagePendingKey = ''
    this.setData({
      list: [], total: 0, page: 1, hasMore: false, loadingMore: false, paginationError: '', pendingRequests: [], ...recommendState([]),
      activeMemberActionId: '', canOperate: false, initialized: false, loading: false,
      refreshError: '', statusText: '待核验', statusTagClass: 'rose', statusNote: note
    })
  },

  markWriteRefresh() {
    invalidateMatchmakerPageSnapshots()
    this._pageRevision = matchmakerPageSnapshotRevision()
    this._pageLoadedAt = Date.now() - MATCHMAKER_PAGE_TTL_MS
    this._pageGeneration += 1
    this._pagePending = null
    this._pagePendingKey = ''
    this._forceNextShow = true
  },

  isPageCurrent(scope: string, generation?: number, query?: string, revision?: number) {
    return !this._pageUnloaded && this.ensurePageSession() === scope
      && (generation === undefined || this._pageGeneration === generation)
      && (query === undefined || this.queryKey() === query)
      && (revision === undefined || matchmakerPageSnapshotRevision() === revision)
  },

  refreshGate(force: unknown = true): Promise<void> {
    const scope = this.ensurePageSession()
    if (!scope || this._pageUnloaded) return Promise.resolve()
    const query = this.queryKey()
    const pendingKey = `${scope}:${query}`
    if (force === false && this._pagePending && this._pagePendingKey === pendingKey) return this._pagePending
    if (force === false && this._pageInitialized && this._pageLoadedQuery === query
      && Date.now() - this._pageLoadedAt < MATCHMAKER_PAGE_TTL_MS) return Promise.resolve()
    const generation = ++this._pageGeneration
    this._memberMorePromise = null
    const revision = matchmakerPageSnapshotRevision()
    const isCurrent = () => this.isPageCurrent(scope, generation, query, revision)
    this.setData({ loading: force !== false || !this.data.initialized, loadingMore: false, paginationError: '' })
    const filters = {
      page: 1, pageSize: 50, keyword: this.data.keyword, city: this.data.city,
      gender: this.data.gender, memberType: this.data.memberType, serviceLevel: this.data.serviceLevel
    }
    const promise = (async () => {
      await Promise.resolve()
      try {
        const dashboardSnapshot = await requestMatchmakerPageSnapshot('/matchmaker/dashboard', async () => {
          try {
            return await matchmakerApi.dashboard(false)
          } catch (err) {
            if (!missingMatchmaker(err)) throw err
            if (!isCurrent()) throw new MatchmakerPageRequestDiscarded()
            await matchmakerApi.apply()
            if (!isCurrent()) throw new MatchmakerPageRequestDiscarded()
            return matchmakerApi.dashboard()
          }
        }, force !== false, isCurrent)
        if (!isCurrent()) return
        const dashboard = dashboardSnapshot.data
        const view = certificationView(dashboard.matchmaker)
        if (!view.canOperate) {
          this.clearRestrictedView(view.statusNote)
          this.setData(view)
          return
        }
        this.setData(view)
        const [members, requests] = await Promise.allSettled([
          Promise.resolve().then(() => memberApi.list(filters)),
          Promise.resolve().then(() => matchmakerApi.memberRequests({ status: 'pending', page: 1, pageSize: 20 }, false))
        ])
        if (!isCurrent()) return
        if ((members.status === 'rejected' && denied(members.reason))
          || (requests.status === 'rejected' && denied(requests.reason))) {
          this.clearRestrictedView()
          return
        }
        if (members.status === 'fulfilled') {
          const list = (members.value.list || []).map(normalizeMember)
          const total = Number(members.value.total || list.length || 0)
          this.setData({ list, total, page: 1, hasMore: list.length < total,
            ...recommendState(list, this.data.recommendAIndex, this.data.recommendBIndex), initialized: true })
          this._pageInitialized = true
          this._pageLoadedQuery = query
        }
        if (requests.status === 'fulfilled') {
          this.setData({ pendingRequests: (requests.value.list || []).map(normalizeRequest) })
        }
        const complete = members.status === 'fulfilled' && requests.status === 'fulfilled'
        this._pageLoadedAt = complete ? Date.now() : Date.now() - MATCHMAKER_PAGE_TTL_MS
        this.setData({ refreshError: complete ? '' : '暂时无法完整更新，保留上次资料。请重试。' })
        this.savePageSnapshot()
      } catch (err) {
        if (!isCurrent() || err instanceof MatchmakerPageRequestDiscarded) return
        console.warn('refresh matchmaker member gate failed', err)
        if (denied(err)) this.clearRestrictedView()
        else {
          this._pageLoadedAt = Date.now() - MATCHMAKER_PAGE_TTL_MS
          this.setData({ refreshError: '暂时无法更新，请重试。',
            statusNote: this._pageInitialized ? this.data.statusNote : '暂时无法连接服务，请重新加载。' })
          this.savePageSnapshot()
        }
      } finally {
        if (this.isPageCurrent(scope, generation, undefined, revision)) {
          this.setData({ loading: false })
          this._pagePending = null
          this._pagePendingKey = ''
        }
      }
    })()
    this._pagePending = promise
    this._pagePendingKey = pendingKey
    return promise
  },

  load(force: unknown = true) {
    return this.refreshGate(force)
  },

  loadRequests() {
    return this.refreshGate(true)
  },

  onReachBottom() {
    return this.loadMore()
  },

  loadMore(): Promise<void> {
    const scope = this.ensurePageSession()
    if (!scope || !this.data.canOperate || !this.data.hasMore || this._pageUnloaded) return Promise.resolve()
    if (this._memberMorePromise) return this._memberMorePromise
    if (this._pagePending) return Promise.resolve()
    const generation = this._pageGeneration
    const revision = matchmakerPageSnapshotRevision()
    const query = this.queryKey()
    const page = this.data.page + 1
    const filters = { page, pageSize: 50, keyword: this.data.keyword, city: this.data.city,
      gender: this.data.gender, memberType: this.data.memberType, serviceLevel: this.data.serviceLevel }
    const isCurrent = () => this.isPageCurrent(scope, generation, query, revision)
    this.setData({ loadingMore: true, paginationError: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await memberApi.list(filters)
        if (!isCurrent()) return
        const incoming = (result.list || []).map(normalizeMember)
        const seen = new Set(this.data.list.map(row => String(row.id)))
        const list = [...this.data.list, ...incoming.filter((row: ReturnType<typeof normalizeMember>) => {
          const id = String(row.idText)
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })]
        const total = Number(result.total || 0)
        if (total < this.data.list.length) {
          await this.refreshGate(true)
          return
        }
        this.setData({ list, total, page: Number(result.page || page),
          hasMore: incoming.length > 0 && list.length < total,
          ...recommendState(list, this.data.recommendAIndex, this.data.recommendBIndex) })
        this.savePageSnapshot()
      } catch (err) {
        if (!isCurrent()) return
        if (denied(err)) this.clearRestrictedView()
        else this.setData({ paginationError: '更多会员暂时无法加载，请重试。' })
      } finally {
        if (isCurrent()) this.setData({ loadingMore: false })
        if (this._memberMorePromise === promise) this._memberMorePromise = null
      }
    })
    this._memberMorePromise = promise
    return promise
  },

  async approveRequest(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensurePageSession()
    if (!scope || !this.data.canOperate) return
    const id = e.currentTarget.dataset.id
    if (!id || this.data.requestProcessingId) return
    this.setData({ requestProcessingId: String(id) })
    try {
      await matchmakerApi.approveMemberRequest(id)
      if (!this.isPageCurrent(scope)) return
      this.markWriteRefresh()
      wx.showToast({ title: '已通过申请' })
      await this.load()
    } catch (err) {
      if (!this.isPageCurrent(scope)) return
      if (denied(err)) this.clearRestrictedView()
      console.warn('approve member request failed', err)
    } finally {
      if (this.isPageCurrent(scope)) this.setData({ requestProcessingId: '' })
    }
  },

  rejectRequest(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensurePageSession()
    if (!scope || !this.data.canOperate) return
    const id = e.currentTarget.dataset.id
    if (!id || this.data.requestProcessingId) return
    wx.showModal({
      title: '拒绝申请',
      content: '拒绝后会员可重新提交申请。',
      confirmText: '拒绝',
      confirmColor: '#963b35',
      success: async res => {
        if (!res.confirm || !this.isPageCurrent(scope)) return
        this.setData({ requestProcessingId: String(id) })
        try {
          await matchmakerApi.rejectMemberRequest(id)
          if (!this.isPageCurrent(scope)) return
          this.markWriteRefresh()
          wx.showToast({ title: '已拒绝' })
          await this.loadRequests()
        } catch (err) {
          if (!this.isPageCurrent(scope)) return
          if (denied(err)) this.clearRestrictedView()
          console.warn('reject member request failed', err)
        } finally {
          if (this.isPageCurrent(scope)) this.setData({ requestProcessingId: '' })
        }
      }
    })
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value })
  },

  onCity(e: WechatMiniprogram.Input) {
    this.setData({ city: e.detail.value })
  },

  setGender(e: WechatMiniprogram.TouchEvent) {
    this.setData({ gender: String(e.currentTarget.dataset.gender || '') })
    this.load()
  },

  onMemberTypeChange(e: any) {
    const index = Number(e.detail.value)
    this.setData({
      memberType: this.data.memberTypeValues[index],
      memberTypeLabel: this.data.memberTypeOptions[index]
    })
    this.load()
  },

  onServiceLevelChange(e: any) {
    const index = Number(e.detail.value)
    this.setData({
      serviceLevel: this.data.serviceLevelValues[index],
      serviceLevelLabel: this.data.serviceLevelOptions[index]
    })
    this.load()
  },

  clearFilters() {
    this.setData({
      keyword: '',
      city: '',
      gender: '',
      memberType: '',
      serviceLevel: '',
      memberTypeLabel: '全部类型',
      serviceLevelLabel: '全部等级'
    })
    this.load()
  },

  toggleFilters() {
    this.setData({ filtersOpen: !this.data.filtersOpen })
  },

  toggleApprovals() {
    this.setData({ approvalsOpen: !this.data.approvalsOpen })
  },

  toggleRecommend() {
    this.setData({ recommendOpen: !this.data.recommendOpen })
  },

  toggleMemberActions(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    this.setData({ activeMemberActionId: this.data.activeMemberActionId === id ? '' : id })
  },

  holdTap() {},

  onRecommendAChange(e: any) {
    const index = Number(e.detail.value || 0)
    this.setData(recommendState(this.data.list, index, 0))
  },

  onRecommendBChange(e: any) {
    const index = Number(e.detail.value || 0)
    this.setData(recommendState(this.data.list, this.data.recommendAIndex, index))
  },

  async recommendInternal() {
    const scope = this.ensurePageSession()
    if (!scope || !this.data.canOperate) return
    const source = this.data.recommendA
    const target = this.data.recommendB
    if (!source.id || !target.id) {
      wx.showToast({ title: '至少选择两名会员', icon: 'none' })
      return
    }
    if (this.data.recommendLoading) return
    this.setData({ recommendLoading: true })
    try {
      const result: any = await memberApi.recommend({
        mode: 'internal',
        myMemberId: source.id,
        targetMemberId: target.id,
        note: `${source.name} 与 ${target.name} 条件较匹配，进入互推待跟进。`
      })
      if (!this.isPageCurrent(scope)) return
      this.markWriteRefresh()
      wx.showToast({ title: result && result.duplicated ? '已有待跟进互推' : '互推已创建' })
      await this.load()
    } catch (err) {
      if (!this.isPageCurrent(scope)) return
      if (denied(err)) this.clearRestrictedView()
      console.warn('internal recommend failed', err)
    } finally {
      if (this.isPageCurrent(scope)) this.setData({ recommendLoading: false })
    }
  },

  goAdd() {
    if (!this.ensurePageSession() || !this.data.canOperate) return
    this._forceNextShow = true
    wx.navigateTo({ url: '/pages/matchmaker/member-form' })
  },

  goResources() {
    if (!this.ensurePageSession() || !this.data.canOperate) return
    this._forceNextShow = true
    wx.navigateTo({ url: '/pages/matchmaker/resources' })
  },

  async applyAgain() {
    const scope = this.ensurePageSession()
    if (!scope) return
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      await matchmakerApi.apply()
      if (!this.isPageCurrent(scope)) return
      this.markWriteRefresh()
      wx.showToast({ title: '已重新提交' })
      await this.refreshGate()
    } catch (err) {
      if (!this.isPageCurrent(scope)) return
      if (denied(err)) this.clearRestrictedView()
      console.warn('apply matchmaker failed', err)
    } finally {
      if (this.isPageCurrent(scope)) this.setData({ loading: false })
    }
  },

  openDetail(e: WechatMiniprogram.TouchEvent) {
    if (!this.ensurePageSession() || !this.data.canOperate) return
    const id = String(e.currentTarget.dataset.id || '')
    if (!this.data.list.some((item: any) => String(item.id) === id)) return
    this._forceNextShow = true
    wx.navigateTo({ url: `/pages/matchmaker/member-detail?id=${id}&scope=own` })
  },

  async remove(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensurePageSession()
    if (!scope || !this.data.canOperate) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '确认移除会员',
      content: '移除后该会员将不再出现在你的经营列表中。',
      confirmText: '移除',
      confirmColor: '#963b35',
      success: async res => {
        if (!res.confirm || !this.isPageCurrent(scope)) return
        this.setData({ removingId: id })
        try {
          await memberApi.remove(id)
          if (!this.isPageCurrent(scope)) return
          this.markWriteRefresh()
          wx.showToast({ title: '已移除' })
          await this.load()
        } catch (err) {
          if (!this.isPageCurrent(scope)) return
          if (denied(err)) this.clearRestrictedView()
          console.warn('remove member failed', err)
        } finally {
          if (this.isPageCurrent(scope)) this.setData({ removingId: '' })
        }
      }
    })
  }
})
