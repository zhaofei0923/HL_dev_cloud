import { chatApi, ChatConversation } from '../../services/chat'
import { memberApi } from '../../services/member'
import type {
  RelationshipCounts,
  RelationshipItem,
  RelationshipKind,
  RelationshipResult
} from '../../services/member'
import { defaultAvatar, normalizeMemberProfile } from '../../utils/member-format'
import { pageSessionScope } from '../../utils/page-session'
import { syncUserTabBar } from '../../utils/user-navigation'

type ConversationItem = ChatConversation & {
  peerName: string
  peerAvatar: string
  preview: string
  timeText: string
  unreadText: string
  typeText: string
  avatarInitial: string
}

type RelationshipCard = {
  id: string
  userId: number
  displayName: string
  avatarUrl: string
  coverUrl: string
  metaText: string
  hint: string
  tags: string[]
  kind: RelationshipKind
  locked: boolean
  canViewDetail: boolean
  canRespond: boolean
  canChat: boolean
  coverToneClass: string
  raw: RelationshipItem | null
  checking?: boolean
}

type NormalizedRelationshipMember = {
  id?: string | number
  displayName?: string
  avatarUrl?: string
  coverUrl?: string
  metaText?: string
  workText?: string
  cityText?: string
  occupationText?: string
  highlightTags?: string[]
}

type RelationshipLoadOptions = {
  expanded?: boolean
  append?: boolean
  allowAutoSelect?: boolean
  force?: boolean
}

type ConversationLoadOptions = {
  force?: boolean
}

const EMPTY_COUNTS: RelationshipCounts = { incoming: 0, mutual: 0 }
const MESSAGES_REFRESH_TTL_MS = 10 * 1000

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
  return type === 'member_pair' ? '配对沟通' : '主理人服务'
}

function normalizeConversation(row: ChatConversation): ConversationItem {
  const peer = row.peer || { id: 0, nickname: row.title || '会话', avatarUrl: '' }
  const name = String(peer.nickname || row.title || '').trim()
  const peerName = !name || /^(新用户|微信用户|会话)$/.test(name) ? `会话 ${row.id}` : name
  return {
    ...row,
    peerName,
    peerAvatar: peer.avatarUrl || '',
    avatarInitial: peerName.slice(0, 1),
    preview: row.lastMessageContent || '暂无消息，进入后开始沟通',
    timeText: formatTime(row.lastMessageAt || row.updatedAt),
    unreadText: row.unreadCount > 99 ? '99+' : String(row.unreadCount || ''),
    typeText: typeText(row.conversationType)
  }
}

function compactStrings(values: Array<string | number | null | undefined>) {
  return values.map(value => String(value || '').trim()).filter(Boolean)
}

function normalizeRelationshipItem(
  row: RelationshipItem,
  index: number,
  kind: RelationshipKind
): RelationshipCard {
  const locked = row.locked === true || row.blurred === true
  if (locked) {
    const tags = compactStrings(row.tags || []).slice(0, 3)
    return {
      id: String(row.id || `locked_${kind}_${index + 1}`),
      userId: 0,
      displayName: row.displayName || (kind === 'mutual'
        ? `第 ${index + 1} 位与你互相喜欢的人`
        : `第 ${index + 1} 位喜欢你的人`),
      avatarUrl: '',
      coverUrl: '',
      metaText: row.metaText || tags.join(' · ') || '有会员对你感兴趣',
      hint: row.hint || (kind === 'mutual' ? '你们已经互相喜欢' : '等待你的回应'),
      tags: tags.length ? tags : ['资料完整'],
      kind,
      locked: true,
      canViewDetail: false,
      canRespond: false,
      canChat: false,
      coverToneClass: `tone-${Number(row.coverTone || index) % 4}`,
      raw: null
    }
  }

  const profile = normalizeMemberProfile(
    row as unknown as Parameters<typeof normalizeMemberProfile>[0]
  ) as NormalizedRelationshipMember
  const tags = compactStrings(profile.highlightTags || row.highlightTags || row.tags || []).slice(0, 3)
  return {
    id: String(profile.id || row.id || row.userId || index),
    userId: Number(row.userId || 0),
    displayName: profile.displayName || row.displayName || '优质会员',
    avatarUrl: profile.avatarUrl || defaultAvatar(row),
    coverUrl: profile.coverUrl || profile.avatarUrl || defaultAvatar(row),
    metaText: profile.metaText || profile.workText || '资料已完善',
    hint: kind === 'mutual'
      ? '你们已经互相喜欢'
      : (row.likedAt ? `${formatTime(row.likedAt)} 喜欢了你` : '喜欢了你'),
    tags: tags.length ? tags : compactStrings([profile.cityText, profile.occupationText]).slice(0, 3),
    kind,
    locked: false,
    canViewDetail: row.canViewDetail !== false,
    canRespond: kind === 'incoming' && row.canRespond !== false,
    canChat: kind === 'mutual' && row.canChat !== false,
    coverToneClass: '',
    raw: row
  }
}

function protectedRelationshipItems(items: RelationshipCard[]): RelationshipCard[] {
  return items.map((item, index) => item.locked && !item.checking ? item : {
    id: `checking_${item.kind}_${index + 1}`,
    userId: 0,
    displayName: item.kind === 'mutual' ? '与你互相喜欢的人' : '喜欢你的人',
    avatarUrl: '',
    coverUrl: '',
    metaText: '更新后查看最新资料',
    hint: item.kind === 'mutual' ? '互相喜欢' : '等待回应',
    tags: [],
    kind: item.kind,
    locked: true,
    canViewDetail: false,
    canRespond: false,
    canChat: false,
    coverToneClass: `tone-${index % 4}`,
    raw: null,
    checking: true
  })
}

function publicRelationshipProfile(row: RelationshipItem) {
  const source = row as unknown as Record<string, unknown>
  const profile: Record<string, unknown> = {}
  const fields = [
    'id', 'userId', 'realName', 'nickname', 'gender', 'age', 'height', 'education',
    'occupation', 'incomeRange', 'city', 'province', 'nativePlace', 'maritalStatus',
    'houseStatus', 'carStatus', 'selfIntro', 'partnerRequirement', 'photos', 'avatarUrl',
    'coverUrl', 'memberType', 'displayName', 'metaText', 'highlightTags'
  ]
  fields.forEach(field => { if (source[field] !== undefined) profile[field] = source[field] })
  return profile
}

Page({
  _messagesScope: '',
  _messagesVisible: true,
  _messagesUnloaded: false,
  _conversationRequestSerial: 0,
  _relationshipRequestSerial: 0,
  _conversationsLoadedAt: 0,
  _conversationsInitialized: false,
  _relationshipsLoadedAt: 0,
  _relationshipLoadedKey: '',
  _conversationPromise: null as Promise<void> | null,
  _relationshipPromise: null as Promise<void> | null,
  _relationshipPendingKey: '',

  data: {
    list: [] as ConversationItem[],
    total: 0,
    conversationLoading: false,
    conversationInitialized: false,
    conversationError: '',
    relationshipType: 'incoming' as RelationshipKind,
    relationshipItems: [] as RelationshipCard[],
    relationshipCounts: { ...EMPTY_COUNTS } as RelationshipCounts,
    relationshipTotal: 0,
    relationshipPage: 1,
    relationshipPageSize: 2,
    relationshipOpen: false,
    relationshipExpanded: false,
    relationshipHasMore: false,
    relationshipLoading: false,
    relationshipError: '',
    relationshipInitialized: false,
    relationshipPermissionVerified: false,
    isPremiumMember: false,
    respondingId: '',
    chatStartingId: '',
    emptyTitle: '暂无消息',
    emptyNote: '和主理人建立服务关系，或由主理人发起配对后，这里会出现会话。'
  },

  async onShow() {
    this._messagesVisible = true
    this._messagesUnloaded = false
    if (!this.ensureMessageSession()) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    syncUserTabBar(this, 'messages')
    const initial = !this.data.relationshipInitialized
    const type: RelationshipKind = initial ? 'incoming' : this.data.relationshipType
    await Promise.allSettled([
      this.loadConversations(),
      this.loadRelationships(type, {
        expanded: this.data.relationshipExpanded,
        allowAutoSelect: initial,
        force: this.data.relationshipOpen
      })
    ])
  },

  onHide() {
    this._messagesVisible = false
    this._relationshipRequestSerial += 1
    this._relationshipPromise = null
    this._relationshipPendingKey = ''
    this.protectRelationshipContent()
    this.setData({ relationshipLoading: false })
  },

  onUnload() {
    this.onHide()
    this._messagesUnloaded = true
    this._conversationRequestSerial += 1
    this._conversationPromise = null
  },

  ensureMessageSession() {
    const scope = pageSessionScope()
    if (scope === this._messagesScope) return scope
    this._messagesScope = scope
    this._conversationRequestSerial += 1
    this._relationshipRequestSerial += 1
    this._conversationPromise = null
    this._relationshipPromise = null
    this._relationshipPendingKey = ''
    this._conversationsLoadedAt = 0
    this._conversationsInitialized = false
    this._relationshipsLoadedAt = 0
    this._relationshipLoadedKey = ''
    this.setData({
      list: [], total: 0, conversationLoading: false, conversationInitialized: false, conversationError: '',
      relationshipItems: [], relationshipCounts: { ...EMPTY_COUNTS }, relationshipTotal: 0,
      relationshipPage: 1, relationshipPageSize: 2, relationshipOpen: false,
      relationshipExpanded: false, relationshipHasMore: false, relationshipLoading: false,
      relationshipError: '', relationshipInitialized: false, relationshipPermissionVerified: false,
      isPremiumMember: false, respondingId: '', chatStartingId: '',
      emptyTitle: '暂无消息',
      emptyNote: '和主理人建立服务关系，或由主理人发起配对后，这里会出现会话。'
    })
    return scope
  },

  isMessageSessionCurrent(scope: string) {
    return !this._messagesUnloaded && this.ensureMessageSession() === scope
  },

  protectRelationshipContent() {
    this.setData({
      relationshipItems: protectedRelationshipItems(this.data.relationshipItems),
      relationshipPermissionVerified: false,
      isPremiumMember: false
    })
  },

  async onPullDownRefresh() {
    await Promise.allSettled([
      this.loadConversations({ force: true }),
      this.loadRelationships(this.data.relationshipType, {
        expanded: this.data.relationshipExpanded,
        force: true
      })
    ]).finally(() => wx.stopPullDownRefresh())
  },

  loadConversations(options: ConversationLoadOptions = {}): Promise<void> {
    const scope = this.ensureMessageSession()
    if (!scope || this._messagesUnloaded) return Promise.resolve()
    if (this._conversationPromise) return this._conversationPromise
    if (!options.force && this._conversationsInitialized
      && Date.now() - this._conversationsLoadedAt < MESSAGES_REFRESH_TTL_MS) return Promise.resolve()
    const requestId = ++this._conversationRequestSerial
    this.setData({ conversationLoading: true, conversationError: '' })
    const promise = (async () => {
      await Promise.resolve()
      try {
        const result = await chatApi.listConversations({ page: 1, pageSize: 50 })
        if (!this.isMessageSessionCurrent(scope) || requestId !== this._conversationRequestSerial) return
        const list = (result.list || []).map(normalizeConversation)
        this._conversationsLoadedAt = Date.now()
        this._conversationsInitialized = true
        this.setData({
          list,
          conversationInitialized: true,
          total: Number(result.total || list.length || 0),
          emptyTitle: '暂无消息',
          emptyNote: '和主理人建立服务关系、开通互选聊天，或由主理人发起配对后，这里会出现会话。'
        })
      } catch (err) {
        if (!this.isMessageSessionCurrent(scope) || requestId !== this._conversationRequestSerial) return
        console.warn('load user conversations failed', err)
        this._conversationsInitialized = false
        this.setData({
          conversationError: '消息暂时无法更新，请稍后重试。',
          emptyTitle: '消息暂不可用',
          emptyNote: '请稍后下拉刷新重试。'
        })
      } finally {
        if (requestId === this._conversationRequestSerial && !this._messagesUnloaded) {
          this.setData({ conversationLoading: false })
          this._conversationPromise = null
        }
      }
    })()
    this._conversationPromise = promise
    return promise
  },

  loadRelationships(type: RelationshipKind, options: RelationshipLoadOptions = {}): Promise<void> {
    const scope = this.ensureMessageSession()
    if (!scope || this._messagesUnloaded || !this._messagesVisible) return Promise.resolve()
    const expanded = options.expanded === true
    const append = options.append === true
    const page = append ? this.data.relationshipPage + 1 : 1
    const pageSize = expanded ? 12 : 2
    const key = `${type}:${page}:${pageSize}`
    if (this._relationshipPromise && this._relationshipPendingKey === key) return this._relationshipPromise
    if (!options.force && !append && !this.data.relationshipOpen
      && this.data.relationshipInitialized && this._relationshipLoadedKey === key
      && Date.now() - this._relationshipsLoadedAt < MESSAGES_REFRESH_TTL_MS) return Promise.resolve()
    const requestId = ++this._relationshipRequestSerial
    const previousItems = append ? this.data.relationshipItems : []
    this.protectRelationshipContent()
    this.setData({
      relationshipLoading: true,
      relationshipError: '',
      relationshipType: type,
      relationshipExpanded: expanded
    })
    const promise = (async () => {
      await Promise.resolve()
      try {
        const result: RelationshipResult = await memberApi.relationships({ type, page, pageSize })
        if (!this.isMessageSessionCurrent(scope) || !this._messagesVisible
          || requestId !== this._relationshipRequestSerial) return
        const counts = result.counts || { ...EMPTY_COUNTS }
        if (options.allowAutoSelect && type === 'incoming' && counts.incoming === 0 && counts.mutual > 0) {
          this.setData({ relationshipCounts: counts, relationshipInitialized: true, relationshipLoading: false })
          this._relationshipPromise = null
          this._relationshipPendingKey = ''
          await this.loadRelationships('mutual', { expanded: false, force: true })
          return
        }

        const isPremiumMember = result.isPremiumMember === true
        const startIndex = append && isPremiumMember ? previousItems.length : 0
        // A downgrade must replace the previous premium page rather than append locked previews to it.
        const rows = (result.list || []).map((row, index) =>
          normalizeRelationshipItem(isPremiumMember ? row : { ...row, locked: true, blurred: true }, startIndex + index, type)
        )
        const items = append && isPremiumMember ? [...previousItems, ...rows] : rows
        const total = Number(result.total || 0)
        this._relationshipsLoadedAt = Date.now()
        this._relationshipLoadedKey = `${type}:1:${isPremiumMember && expanded ? 12 : 2}`
        this.setData({
          relationshipItems: items,
          relationshipCounts: counts,
          relationshipTotal: total,
          relationshipPage: Number(result.page || page),
          relationshipPageSize: Number(result.pageSize || pageSize),
          relationshipHasMore: isPremiumMember && items.length < total,
          relationshipInitialized: true,
          relationshipPermissionVerified: true,
          relationshipExpanded: isPremiumMember && expanded,
          isPremiumMember
        })
      } catch (err) {
        if (!this.isMessageSessionCurrent(scope) || !this._messagesVisible
          || requestId !== this._relationshipRequestSerial) return
        console.warn('load member relationships failed', err)
        this._relationshipsLoadedAt = 0
        this._relationshipLoadedKey = ''
        this.protectRelationshipContent()
        this.setData({
          relationshipError: '心动关系暂时无法加载，请稍后重试。',
          relationshipInitialized: true
        })
      } finally {
        if (requestId === this._relationshipRequestSerial && !this._messagesUnloaded) {
          this.setData({ relationshipLoading: false })
          this._relationshipPromise = null
          this._relationshipPendingKey = ''
        }
      }
    })()
    this._relationshipPromise = promise
    this._relationshipPendingKey = key
    return promise
  },

  switchRelationship(e: WechatMiniprogram.TouchEvent) {
    if (this.data.relationshipLoading) return
    const value = String(e.currentTarget.dataset.type || '')
    if (value !== 'incoming' && value !== 'mutual') return
    const type = value as RelationshipKind
    if (type === this.data.relationshipType && !this.data.relationshipError) {
      this.setData({ relationshipOpen: true })
      return this.loadRelationships(type, { expanded: this.data.relationshipExpanded, force: true })
    }
    this.setData({
      relationshipType: type,
      relationshipOpen: true,
      relationshipItems: [],
      relationshipTotal: Number(this.data.relationshipCounts[type] || 0),
      relationshipExpanded: false,
      relationshipHasMore: false
    })
    return this.loadRelationships(type, { force: true })
  },

  async openRelationshipShortcut(e: WechatMiniprogram.TouchEvent) {
    await this.switchRelationship(e)
    if (this.data.relationshipOpen) wx.pageScrollTo({ selector: '.relationship-shell', duration: 250 })
  },

  onConversationAvatarError(e: WechatMiniprogram.CustomEvent) {
    const id = Number(e.currentTarget.dataset.id)
    const index = this.data.list.findIndex(item => item.id === id)
    if (index >= 0) this.setData({ [`list[${index}].peerAvatar`]: '' })
  },

  toggleRelationshipOpen() {
    const relationshipOpen = !this.data.relationshipOpen
    this.setData({ relationshipOpen })
    if (!relationshipOpen) {
      this.protectRelationshipContent()
      return
    }
    return this.loadRelationships(this.data.relationshipType, {
      expanded: this.data.relationshipExpanded,
      force: true
    })
  },

  retryRelationships() {
    return this.loadRelationships(this.data.relationshipType, {
      expanded: this.data.relationshipExpanded,
      force: true
    })
  },

  retryConversations() {
    return this.loadConversations({ force: true })
  },

  toggleRelationshipExpanded() {
    if (this.data.relationshipLoading || !this.data.relationshipPermissionVerified) return
    if (!this.data.isPremiumMember) {
      this.promptOpenMembership()
      return
    }
    const expanded = !this.data.relationshipExpanded
    this.setData({ relationshipItems: [], relationshipHasMore: false })
    return this.loadRelationships(this.data.relationshipType, { expanded, force: true })
  },

  loadMoreRelationships() {
    if (!this.data.relationshipExpanded || !this.data.relationshipHasMore) return
    return this.loadRelationships(this.data.relationshipType, {
      expanded: true,
      append: true,
      force: true
    })
  },

  findRelationship(id: string) {
    return this.data.relationshipItems.find(row => row.id === id)
  },

  async verifyRelationshipMember(id: string): Promise<RelationshipCard | null> {
    const scope = this.ensureMessageSession()
    if (!scope || this.data.relationshipLoading || !this._messagesVisible || !this.findRelationship(id)) return null
    await this.loadRelationships(this.data.relationshipType, {
      expanded: this.data.relationshipExpanded,
      force: true
    })
    if (!this.isMessageSessionCurrent(scope) || !this._messagesVisible
      || !this.data.relationshipPermissionVerified || this.data.relationshipError) return null
    const item = this.findRelationship(id)
    if (!this.data.isPremiumMember) {
      this.promptOpenMembership()
      return null
    }
    if (!item) {
      wx.showToast({ title: '心动关系已更新，请重新选择', icon: 'none' })
      return null
    }
    if (item.locked) {
      this.promptOpenMembership()
      return null
    }
    return item
  },

  async openRelationshipMember(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const item = await this.verifyRelationshipMember(id)
    if (!item || !item.canViewDetail) return
    if (item.raw) wx.setStorageSync('selectedUserMember', publicRelationshipProfile(item.raw))
    wx.navigateTo({ url: `/pages/user/member-detail?id=${encodeURIComponent(item.id)}` })
  },

  async respondFavorite(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensureMessageSession()
    if (!scope) return
    if (this.data.relationshipLoading || !this.data.relationshipPermissionVerified || !this._messagesVisible) return
    const id = String(e.currentTarget.dataset.id || '')
    let item = this.findRelationship(id)
    if (!item || !item.userId || this.data.respondingId) return
    if (!this.data.isPremiumMember || !item.canRespond) {
      this.promptOpenMembership()
      return
    }
    this.setData({ respondingId: id })
    try {
      item = await this.verifyRelationshipMember(id) || undefined
      if (!item || !item.userId || !item.canRespond || !this.isMessageSessionCurrent(scope)) return
      const result: any = await memberApi.interact({
        targetUserId: item.userId,
        actionType: 'favorite',
        active: true
      })
      if (!this.isMessageSessionCurrent(scope) || !this._messagesVisible) return
      wx.showToast({
        title: result && result.canChat
          ? '已互相喜欢，可以聊天'
          : '已回应爱心',
        icon: 'none'
      })
      this.setData({
        relationshipType: 'mutual',
        relationshipItems: [],
        relationshipExpanded: false,
        relationshipHasMore: false
      })
      await this.loadRelationships('mutual', { force: true })
      await this.loadConversations({ force: true })
    } catch (err) {
      if (!this.isMessageSessionCurrent(scope)) return
      console.warn('respond relationship favorite failed', err)
      this.protectRelationshipContent()
      await this.loadRelationships(this.data.relationshipType, { force: true })
    } finally {
      if (this.isMessageSessionCurrent(scope)) this.setData({ respondingId: '' })
    }
  },

  async openRelationshipChat(e: WechatMiniprogram.TouchEvent) {
    const scope = this.ensureMessageSession()
    if (!scope) return
    if (this.data.relationshipLoading || !this.data.relationshipPermissionVerified || !this._messagesVisible) return
    const id = String(e.currentTarget.dataset.id || '')
    const item = this.findRelationship(id)
    if (!item || !item.userId || this.data.chatStartingId) return
    if (!this.data.isPremiumMember || !item.canChat) {
      this.promptOpenMembership()
      return
    }
    this.setData({ chatStartingId: id })
    try {
      const conversation = await chatApi.getOrCreateConversation({
        targetUserId: item.userId
      })
      if (!this.isMessageSessionCurrent(scope) || !this._messagesVisible) return
      wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` })
    } catch (err) {
      if (!this.isMessageSessionCurrent(scope)) return
      console.warn('open mutual relationship chat failed', err)
      this.protectRelationshipContent()
      await this.loadRelationships(this.data.relationshipType, { force: true })
    } finally {
      if (this.isMessageSessionCurrent(scope)) this.setData({ chatStartingId: '' })
    }
  },

  openChat(e: WechatMiniprogram.TouchEvent) {
    if (!this.ensureMessageSession() || !this._messagesVisible) return
    const id = String(e.currentTarget.dataset.id || '')
    if (!id || !this.data.list.some(item => String(item.id) === id)) return
    wx.navigateTo({ url: `/pages/user/chat?id=${id}` })
  },

  promptOpenMembership() {
    wx.navigateTo({ url: '/pages/user/membership' })
  },

  goMembers() {
    wx.switchTab({ url: '/pages/user/members' })
  }
})
