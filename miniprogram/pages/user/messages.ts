import { chatApi, ChatConversation } from '../../services/chat'

type ConversationItem = ChatConversation & {
  peerName: string
  peerAvatar: string
  preview: string
  timeText: string
  unreadText: string
  typeText: string
}

function pad(value: number) {
  return value < 10 ? `0${value}` : String(value)
}

function formatTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function typeText(type: ChatConversation['conversationType']) {
  return type === 'member_pair' ? '配对沟通' : '红娘服务'
}

function normalizeConversation(row: ChatConversation): ConversationItem {
  const peer = row.peer || { id: 0, nickname: row.title || '会话', avatarUrl: '' }
  return {
    ...row,
    peerName: peer.nickname || row.title || '会话',
    peerAvatar: peer.avatarUrl || '/assets/members/avatar-female-1.png',
    preview: row.lastMessageContent || '暂无消息，进入后开始沟通',
    timeText: formatTime(row.lastMessageAt || row.updatedAt),
    unreadText: row.unreadCount > 99 ? '99+' : String(row.unreadCount || ''),
    typeText: typeText(row.conversationType)
  }
}

Page({
  data: {
    list: [] as ConversationItem[],
    total: 0,
    loading: false,
    emptyTitle: '暂无消息',
    emptyNote: '和红娘建立服务关系，或由红娘发起配对后，这里会出现会话。'
  },

  onShow() {
    const token = wx.getStorageSync('token')
    if (!token) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      const result = await chatApi.listConversations({ page: 1, pageSize: 50 })
      const list = (result.list || []).map(normalizeConversation)
      this.setData({
        list,
        total: Number(result.total || list.length || 0),
        emptyTitle: '暂无消息',
        emptyNote: '和红娘建立服务关系，或由红娘发起配对后，这里会出现会话。'
      })
    } catch (err) {
      console.warn('load user conversations failed', err)
      this.setData({
        list: [],
        total: 0,
        emptyTitle: '消息暂不可用',
        emptyNote: '请确认云函数已部署后重试。'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  openChat(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    wx.navigateTo({ url: `/pages/user/chat?id=${id}` })
  },

  goMembers() {
    wx.redirectTo({ url: '/pages/user/members' })
  }
})
