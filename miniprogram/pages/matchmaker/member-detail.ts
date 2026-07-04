import { memberApi } from '../../services/member'
import { chatApi } from '../../services/chat'
import { normalizeMemberProfile } from '../../utils/member-format'

Page({
  data: {
    id: '',
    scope: 'own',
    isOwn: true,
    member: null as any,
    loading: false,
    chatStarting: false
  },

  onLoad(options: Record<string, string | undefined>) {
    const scope = options.scope === 'resource' ? 'resource' : 'own'
    this.setData({
      id: String(options.id || ''),
      scope,
      isOwn: scope === 'own'
    })
    this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      const cached = wx.getStorageSync('selectedMatchmakerMember')
      if (cached && String(cached.id) === this.data.id) {
        this.setData({ member: normalizeMemberProfile(cached, this.data.isOwn) })
        return
      }
      const result: any = this.data.isOwn
        ? await memberApi.list({ page: 1, pageSize: 100 })
        : await memberApi.resources({ page: 1, pageSize: 100 })
      const row = (result.list || []).find((item: any) => String(item.id) === this.data.id)
      this.setData({ member: row ? normalizeMemberProfile(row, this.data.isOwn) : null })
    } catch (err) {
      console.warn('load matchmaker member detail failed', err)
      this.setData({ member: null })
    } finally {
      this.setData({ loading: false })
    }
  },

  goBack() {
    wx.navigateBack()
  },

  async startChat() {
    const member = this.data.member
    const targetUserId = member && member.userId ? String(member.userId) : ''
    const memberId = member && member.id && /^\d+$/.test(String(member.id)) ? String(member.id) : ''
    if (!targetUserId && !memberId) {
      wx.showToast({ title: '暂不能发起聊天', icon: 'none' })
      return
    }
    if (this.data.chatStarting) return
    this.setData({ chatStarting: true })
    try {
      const conversation = await chatApi.getOrCreateConversation(targetUserId
        ? { targetUserId }
        : { targetMemberId: memberId })
      wx.navigateTo({ url: `/pages/matchmaker/chat?id=${conversation.id}` })
    } catch (err) {
      console.warn('start matchmaker chat failed', err)
    } finally {
      this.setData({ chatStarting: false })
    }
  }
})
