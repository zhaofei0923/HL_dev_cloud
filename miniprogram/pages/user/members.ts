import { memberApi } from '../../services/member'
import { normalizeMemberProfile } from '../../utils/member-format'

type MemberView = Record<string, any>

const SWIPE_DISTANCE = 56
let touchStartX = 0
let touchStartY = 0
let suppressCardTap = false

function compactList(values: Array<string | number | null | undefined>) {
  return values.map(value => String(value || '').trim()).filter(Boolean)
}

function textWithUnit(value: string | number | null | undefined, unit: string, fallback: string) {
  const text = String(value || '').trim()
  if (!text) return fallback
  return text.indexOf(unit) >= 0 ? text : `${text}${unit}`
}

function truncateText(value: string, limit: number) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function uniqueLocationParts(city: string, nativePlace: string | number | null | undefined) {
  const cityText = String(city || '').trim()
  const nativeText = String(nativePlace || '').trim()
  if (!cityText) return compactList([nativeText])
  if (!nativeText || nativeText === cityText || nativeText.indexOf(cityText) >= 0 || cityText.indexOf(nativeText) >= 0) {
    return [cityText]
  }
  return [cityText, nativeText]
}

function normalizeMember(row: any) {
  const member = normalizeMemberProfile(row)
  const ageText = textWithUnit(row.age, '岁', '年龄保密')
  const heightText = textWithUnit(row.height, 'cm', '')
  const city = String(member.cityText || row.city || row.province || '').trim()
  const education = String(row.education || '').trim()
  const occupation = String(row.occupation || '').trim()
  const income = String(row.incomeRange || '').trim()
  const primaryMeta = uniqueLocationParts(city, row.nativePlace).join(' · ') || member.metaText
  const profileLine = compactList([heightText, education, occupation]).join(' · ') || member.workText
  const cardTags = compactList([city, education, occupation, income]).slice(0, 3)
  const partnerPreview = truncateText(row.partnerRequirement || member.partnerText, 44)
  const introPreview = truncateText(row.selfIntro || member.introText, 42)

  return {
    ...member,
    ageText,
    primaryMeta,
    profileLine,
    cardTags,
    partnerPreview,
    introPreview,
    statusText: row.memberType === 'vip' ? 'VIP精选' : '精选推荐'
  }
}

function safeIndex(list: MemberView[], index: number) {
  if (!list.length) return 0
  const normalized = Number(index) || 0
  return ((normalized % list.length) + list.length) % list.length
}

function avatarPreviews(list: MemberView[], currentIndex: number) {
  const count = Math.min(list.length, 3)
  return Array.from({ length: count }, (_, offset) => {
    const member = list[(currentIndex + offset) % list.length]
    return {
      key: `${member.id || member.userId || offset}-${offset}`,
      url: member.avatarUrl,
      className: `stack-${offset}`
    }
  })
}

function selectionState(list: MemberView[], index: number) {
  const currentIndex = safeIndex(list, index)
  return {
    currentIndex,
    currentMember: list[currentIndex] || null,
    previewAvatars: avatarPreviews(list, currentIndex),
    positionText: list.length ? `${currentIndex + 1}/${list.length}` : ''
  }
}

Page({
  data: {
    keyword: '',
    city: '',
    gender: '',
    filterOpen: false,
    list: [] as MemberView[],
    currentIndex: 0,
    currentMember: null as MemberView | null,
    previewAvatars: [] as any[],
    positionText: '',
    total: 0,
    countText: '正在整理会员资料',
    emptyTitle: '暂无可推荐会员',
    emptyNote: '可以调整筛选条件，或稍后再查看红娘精选的公开会员。',
    loading: false
  },

  onShow() {
    const token = wx.getStorageSync('token')
    if (!token) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      const result: any = await memberApi.showcase({
        page: 1,
        pageSize: 50,
        keyword: this.data.keyword,
        city: this.data.city,
        gender: this.data.gender
      })
      const list = (result.list || []).map((row: any) => normalizeMember(row))
      const total = result.total || list.length
      this.setData({
        list,
        ...selectionState(list, 0),
        total,
        countText: total ? `${total} 位会员可浏览 · 左滑/上滑换一位` : '暂无可浏览会员',
        emptyTitle: this.hasFilters() ? '暂无匹配会员' : '暂无可推荐会员',
        emptyNote: this.hasFilters()
          ? '可以调整城市、性别或关键词后再试。'
          : '红娘精选会员资料后，会在这里展示脱敏信息。'
      })
    } catch (err) {
      console.warn('load user members failed', err)
      this.setData({
        list: [],
        ...selectionState([], 0),
        total: 0,
        countText: '云服务暂不可用',
        emptyTitle: '数据暂不可用',
        emptyNote: '请确认 hlApi 云函数已部署后重试。'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value })
  },

  onCity(e: WechatMiniprogram.Input) {
    this.setData({ city: e.detail.value })
  },

  setGender(e: WechatMiniprogram.TouchEvent) {
    this.setData({ gender: String(e.currentTarget.dataset.gender || '') })
  },

  toggleFilter() {
    this.setData({ filterOpen: !this.data.filterOpen })
  },

  hasFilters() {
    return !!(this.data.keyword || this.data.city || this.data.gender)
  },

  search() {
    this.setData({ filterOpen: false })
    this.load()
  },

  clearKeyword() {
    this.setData({ keyword: '', city: '', gender: '', filterOpen: false })
    this.load()
  },

  nextMember() {
    if (!this.data.list.length) return
    this.setData(selectionState(this.data.list, this.data.currentIndex + 1))
  },

  previousMember() {
    if (!this.data.list.length) return
    this.setData(selectionState(this.data.list, this.data.currentIndex - 1))
  },

  onCardTouchStart(e: WechatMiniprogram.TouchEvent) {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    touchStartX = touch.clientX
    touchStartY = touch.clientY
    suppressCardTap = false
  },

  onCardTouchEnd(e: WechatMiniprogram.TouchEvent) {
    const touch = e.changedTouches && e.changedTouches[0]
    if (!touch || !this.data.list.length) return

    const deltaX = touch.clientX - touchStartX
    const deltaY = touch.clientY - touchStartY
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)
    const isHorizontalSwipe = absX >= SWIPE_DISTANCE && absX >= absY
    const isVerticalSwipe = absY >= SWIPE_DISTANCE && absY > absX

    if (!isHorizontalSwipe && !isVerticalSwipe) return

    suppressCardTap = true
    if ((isHorizontalSwipe && deltaX < 0) || (isVerticalSwipe && deltaY < 0)) {
      this.nextMember()
      return
    }
    this.previousMember()
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/user/profile' })
  },

  openCurrentDetail() {
    if (suppressCardTap) {
      suppressCardTap = false
      return
    }
    const member = this.data.currentMember
    if (!member) return
    wx.setStorageSync('selectedUserMember', member)
    wx.navigateTo({ url: `/pages/user/member-detail?id=${member.id}` })
  }
})
