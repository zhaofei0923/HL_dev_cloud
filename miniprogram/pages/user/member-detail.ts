import { memberApi } from '../../services/member'
import { chatApi } from '../../services/chat'
import { normalizeMemberProfile } from '../../utils/member-format'

Page({
  data: {
    id: '',
    member: null as any,
    loading: false,
    chatStarting: false
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ id: String(options.id || '') })
    this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      const cached = wx.getStorageSync('selectedUserMember')
      if (cached && String(cached.id) === this.data.id) {
        this.setData({ member: normalizeMemberProfile(cached) })
        return
      }
      const result: any = await memberApi.showcase({ page: 1, pageSize: 100 })
      const row = (result.list || []).find((item: any) => String(item.id) === this.data.id)
      this.setData({ member: row ? normalizeMemberProfile(row) : null })
    } catch (err) {
      console.warn('load user member detail failed', err)
      this.setData({ member: null })
    } finally {
      this.setData({ loading: false })
    }
  },

  goBack() {
    wx.navigateBack()
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/user/profile' })
  },

  async startChat() {
    const member = this.data.member
    const targetUserId = Number(member && member.userId ? member.userId : 0)
    const memberId = String(member && member.id ? member.id : '')
    if (!targetUserId && !/^\d+$/.test(memberId)) {
      wx.showToast({ title: '互相关注或配对后才能聊天', icon: 'none' })
      return
    }
    if (this.data.chatStarting) return
    this.setData({ chatStarting: true })
    try {
      const conversation = await chatApi.getOrCreateConversation(targetUserId
        ? { targetUserId }
        : { targetMemberId: memberId })
      wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` })
    } catch (err) {
      console.warn('start user chat failed', err)
    } finally {
      this.setData({ chatStarting: false })
    }
  }
})
