import { memberApi } from '../../services/member'
import { chatApi } from '../../services/chat'
import { normalizeMemberProfile } from '../../utils/member-format'
import { apiErrorMessage } from '../../services/api'
import { pageSessionScope } from '../../utils/page-session'

function normalizeResource(row: any) {
  return {
    ...normalizeMemberProfile(row),
    userIdText: String(row.userId || '')
  }
}

Page({
  _scope: '',
  _generation: 0,
  _visible: true,
  data: {
    list: [] as any[],
    total: 0,
    myMembers: [] as any[],
    memberOptions: [] as string[],
    selectedMemberIndex: 0,
    primaryMemberName: '',
    recommendButtonText: '先录入自己的会员',
    accessNote: '已认证主理人可查看其他主理人的会员资源，并用自己的会员发起互推。',
    selectorOpen: false,
    loading: false,
    recommendLoadingId: '',
    resourcePage: 1,
    resourceHasMore: false,
    resourceLoadingMore: false,
    resourceError: '',
    ownPage: 1,
    ownHasMore: false,
    ownLoadingMore: false,
    ownError: ''
  },

  onShow() {
    this._visible = true
    return this.load()
  },

  onHide() {
    this._visible = false
    this._generation += 1
    this.setData({ loading: false, resourceLoadingMore: false, ownLoadingMore: false, recommendLoadingId: '' })
  },

  onUnload() { this.onHide(); this.clearResources() },

  clearResources() {
    this.setData({ list: [], total: 0, myMembers: [], memberOptions: [], selectedMemberIndex: 0,
      primaryMemberName: '', recommendButtonText: '先录入自己的会员', selectorOpen: false,
      resourcePage: 1, resourceHasMore: false, resourceLoadingMore: false,
      ownPage: 1, ownHasMore: false, ownLoadingMore: false, loading: false, recommendLoadingId: '' })
  },

  ensureSession() {
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope
      this._generation += 1
      this.clearResources()
    }
    if (!scope && this._visible) wx.redirectTo({ url: '/pages/index/index' })
    return scope
  },

  isCurrent(scope: string, generation: number) {
    return this._visible && scope === pageSessionScope() && generation === this._generation
  },

  setOwnMembers(myMembers: any[]) {
    const selectedId = this.data.myMembers[this.data.selectedMemberIndex]?.id
    const index = Math.max(myMembers.findIndex(item => String(item.id) === String(selectedId)), 0)
    const selected = myMembers[index]
    const name = selected ? selected.realName || selected.nickname || '我的会员' : ''
    this.setData({ myMembers, memberOptions: myMembers.map(item => item.realName || item.nickname || '我的会员'),
      selectedMemberIndex: index, primaryMemberName: name,
      recommendButtonText: selected ? `用 ${name} 发起互推` : '先录入自己的会员' })
  },

  async load() {
    const scope = this.ensureSession()
    if (!scope || !this._visible) return
    const generation = ++this._generation
    this.setData({ loading: true, resourceLoadingMore: false, ownLoadingMore: false, resourceError: '', ownError: '' })
    try {
      const [resources, own]: any[] = await Promise.all([
        memberApi.resources({ page: 1, pageSize: 50 }),
        memberApi.inviteOptions({ page: 1, pageSize: 20 })
      ])
      if (!this.isCurrent(scope, generation)) return
      const list = (resources.list || []).map((row: any) => normalizeResource(row))
      const myMembers = own.list || []
      this.setOwnMembers(myMembers)
      this.setData({
        list,
        total: Number(resources.total ?? list.length),
        resourcePage: 1, resourceHasMore: list.length < Number(resources.total || 0),
        ownPage: 1, ownHasMore: myMembers.length < Number(own.total || 0),
        accessNote: '已为你整理可协作会员，可选择合适对象发起主理人协作。'
      })
    } catch (err) {
      if (!this.isCurrent(scope, generation)) return
      console.warn('load matchmaker resources failed', err)
      this.clearResources()
      this.setData({ resourceError: apiErrorMessage(err) || '合作资源暂时无法读取，请重试。',
        accessNote: '合作资源暂时无法读取，请重试或确认主理人权限。' })
    } finally {
      if (this.isCurrent(scope, generation)) this.setData({ loading: false })
    }
  },

  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() { return this.loadMoreResources() },

  async loadMoreResources() {
    const scope = this.ensureSession(), generation = this._generation
    if (!scope || !this._visible || this.data.loading || this.data.resourceLoadingMore || !this.data.resourceHasMore) return
    const page = this.data.resourcePage + 1
    this.setData({ resourceLoadingMore: true, resourceError: '' })
    try {
      const result: any = await memberApi.resources({ page, pageSize: 50 })
      if (!this.isCurrent(scope, generation)) return
      const seen = new Set(this.data.list.map(row => String(row.id)))
      const incoming = (result.list || []).filter((row: any) => !seen.has(String(row.id))).map(normalizeResource)
      const list = [...this.data.list, ...incoming]
      this.setData({ list, total: Number(result.total ?? list.length), resourcePage: page,
        resourceHasMore: incoming.length > 0 && list.length < Number(result.total || 0) })
    } catch (err: any) {
      if (!this.isCurrent(scope, generation)) return
      if ([401, 403, 40100, 40300].includes(Number(err?.code))) this.clearResources()
      this.setData({ resourceError: apiErrorMessage(err) || '更多合作资源暂时无法读取，请重试。' })
    } finally { if (this.isCurrent(scope, generation)) this.setData({ resourceLoadingMore: false }) }
  },

  async loadMoreOwnMembers() {
    const scope = this.ensureSession(), generation = this._generation
    if (!scope || !this._visible || this.data.loading || this.data.ownLoadingMore || !this.data.ownHasMore) return
    const page = this.data.ownPage + 1
    this.setData({ ownLoadingMore: true, ownError: '' })
    try {
      const result = await memberApi.inviteOptions({ page, pageSize: 20 })
      if (!this.isCurrent(scope, generation)) return
      const seen = new Set(this.data.myMembers.map(row => String(row.id)))
      const incoming = result.list.filter(row => !seen.has(String(row.id)))
      const myMembers = [...this.data.myMembers, ...incoming]
      this.setOwnMembers(myMembers)
      this.setData({ ownPage: page, ownHasMore: incoming.length > 0 && myMembers.length < result.total })
    } catch (err: any) {
      if (!this.isCurrent(scope, generation)) return
      if ([401, 403, 40100, 40300].includes(Number(err?.code))) this.clearResources()
      this.setData({ ownError: apiErrorMessage(err) || '更多服务会员暂时无法读取，请重试。' })
    } finally { if (this.isCurrent(scope, generation)) this.setData({ ownLoadingMore: false }) }
  },

  onMemberChange(e: any) {
    if (!this.ensureSession() || !this._visible) return
    const index = Number(e.detail.value || 0)
    const selected = this.data.myMembers[index]
    const name = selected ? (selected.realName || selected.nickname || '我的会员') : ''
    this.setData({
      selectedMemberIndex: index,
      primaryMemberName: name,
      recommendButtonText: selected ? `用 ${name} 发起互推` : '先录入自己的会员',
      selectorOpen: false
    })
  },

  toggleMemberSelector() {
    if (!this.ensureSession() || !this._visible) return
    this.setData({ selectorOpen: !this.data.selectorOpen })
  },

  async recommend(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensureSession(), generation = this._generation
    if (!scope || !this._visible || this.data.loading || this.data.recommendLoadingId) return
    const resourceUserId = e.currentTarget.dataset.userId
    const myMember = this.data.myMembers[this.data.selectedMemberIndex]
    if (!myMember) {
      wx.showToast({ title: '请先录入自己的会员', icon: 'none' })
      return
    }
    this.setData({ recommendLoadingId: String(resourceUserId) })
    try {
      await memberApi.recommend({
        myMemberId: myMember.id,
        resourceUserId,
        note: `${myMember.realName || myMember.nickname} 与对方条件较匹配`
      })
      if (!this.isCurrent(scope, generation)) return
      wx.showModal({
        title: '互推成功',
        content: '已创建互推记录，可继续和自己的会员跟进沟通。',
        confirmText: '去聊天',
        cancelText: '留在此页',
        success: res => {
          if (res.confirm && this.isCurrent(scope, generation)) this.openChatForMember(myMember)
        }
      })
    } catch (err) {
      console.warn('recommend member failed', err)
    } finally {
      if (this.isCurrent(scope, generation)) this.setData({ recommendLoadingId: '' })
    }
  },

  openDetail(e: WechatMiniprogram.TouchEvent) {
    if (!this.ensureSession() || !this._visible) return
    const id = String(e.currentTarget.dataset.id || '')
    const member = this.data.list.find((item: any) => String(item.id) === id)
    if (!member) return
    wx.navigateTo({ url: `/pages/matchmaker/member-detail?id=${id}&scope=resource` })
  },

  async openChatForMember(member: any) {
    const scope = this.ensureSession(), generation = this._generation
    if (!scope || !this._visible) return
    const targetUserId = member && member.userId ? String(member.userId) : ''
    if (!targetUserId) {
      wx.showToast({ title: '会员账号暂不可用', icon: 'none' })
      return
    }
    try {
      const conversation = await chatApi.getOrCreateConversation({ targetUserId })
      if (!this.isCurrent(scope, generation)) return
      wx.navigateTo({ url: `/pages/matchmaker/chat?id=${conversation.id}` })
    } catch (err) {
      console.warn('open recommend follow-up chat failed', err)
    }
  }
})
