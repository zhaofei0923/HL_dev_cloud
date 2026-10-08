import { memberApi } from '../../services/member'
import { chatApi } from '../../services/chat'
import { apiErrorMessage } from '../../services/api'
import { normalizeMemberProfile } from '../../utils/member-format'
import { publicCertificationRows, type PublicCertificationRow } from '../../utils/member-certification'
import { pageSessionScope } from '../../utils/page-session'
import { SHOWCASE_CACHE_TTL_MS, applyShowcaseInteraction, invalidateShowcaseCategory } from '../../utils/showcase-cache'

function publicMember(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

Page({
  _detailGeneration: 0,
  _detailScope: '',
  _detailUnloaded: false,
  _detailLoadedAt: 0,
  _detailRefreshOnShow: false,
  data: {
    id: '',
    member: null as any,
    certificationRows: [] as PublicCertificationRow[],
    loading: false,
    chatStarting: false,
    favoriteLoading: false,
    isFavorite: false,
    chatAccess: 'unknown',
    loadError: '',
    unavailable: false
  },

  onLoad(options: Record<string, string | undefined>) {
    this._detailUnloaded = false
    this.setData({ id: String(options.id || '') })
    this.load()
  },

  onShow() {
    const refresh = this._detailRefreshOnShow || (this._detailLoadedAt > 0 && Date.now() - this._detailLoadedAt >= SHOWCASE_CACHE_TTL_MS)
    this._detailRefreshOnShow = false
    if (this._detailScope !== pageSessionScope() || refresh) return this.load()
  },

  onHide() {
    this._detailRefreshOnShow = true
  },

  onUnload() {
    this._detailUnloaded = true
    this._detailGeneration += 1
  },

  async load() {
    if (!this.data.id) return
    const scope = pageSessionScope()
    this._detailScope = scope
    this._detailLoadedAt = 0
    const generation = ++this._detailGeneration
    const isCurrent = () => !this._detailUnloaded && generation === this._detailGeneration && pageSessionScope() === scope
    this.setData({ member: null, certificationRows: [], loading: !!scope, chatAccess: 'unknown',
      loadError: '', unavailable: false, isFavorite: false })
    if (!scope) return
    try {
      const cached = publicMember(wx.getStorageSync('selectedUserMember'))
      if (cached && String(cached.id) === this.data.id && wx.getStorageSync('selectedUserMemberScope') === scope) {
        const preview = { ...cached }
        delete preview.financialAssetRange
        this.setData({ member: normalizeMemberProfile(preview), certificationRows: publicCertificationRows(preview) })
      }
      const row = await memberApi.showcaseDetail(this.data.id)
      if (!isCurrent()) return
      const state = publicMember(row.viewerState) || {}
      this.setData({ member: normalizeMemberProfile(row), certificationRows: publicCertificationRows(row),
        isFavorite: state.isFavorite === true,
        chatAccess: ['allowed', 'membership_required', 'unavailable'].includes(String(state.chatAccess)) ? String(state.chatAccess) : 'unknown' })
      this._detailLoadedAt = Date.now()
    } catch (err) {
      if (!isCurrent()) return
      console.warn('load user member detail failed', err)
      const code = Number((err as { code?: number }).code)
      const unavailable = [404, 40400, 403, 40300].includes(code) || /not found/i.test(apiErrorMessage(err))
      this.setData({ member: null, certificationRows: [], unavailable,
        loadError: unavailable ? '该会员已暂停公开资料或暂不可查看，请返回推荐页。' : '暂时无法加载资料，请检查网络后重试。' })
    } finally {
      if (isCurrent()) this.setData({ loading: false })
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/user/members' }) })
  },

  goProfile() {
    wx.switchTab({ url: '/pages/user/profile' })
  },

  primaryAction() {
    if (this.data.loading || this.data.favoriteLoading || this.data.chatStarting) return
    if (this.data.chatAccess === 'unknown') return this.load()
    if (this.data.chatAccess === 'allowed') return this.startChat()
    if (this.data.chatAccess === 'membership_required') {
      wx.navigateTo({ url: '/pages/user/membership' })
      return
    }
    if (!this.data.isFavorite) return this.toggleFavorite()
  },

  async toggleFavorite() {
    const targetUserId = Number(this.data.member?.userId)
    if (!targetUserId || this.data.loading || this.data.favoriteLoading) return
    const scope = pageSessionScope()
    const generation = this._detailGeneration
    const isCurrent = () => !this._detailUnloaded && pageSessionScope() === scope && generation === this._detailGeneration
    const active = !this.data.isFavorite
    this.setData({ favoriteLoading: true })
    try {
      const response = await memberApi.interact({ targetUserId, targetMemberId: this.data.id, actionType: 'favorite', active }, false)
      if (!isCurrent()) return
      const savedActive = response?.viewerState?.isFavorite === true
      applyShowcaseInteraction(scope, { page: 1, pageSize: 50, keyword: '', city: '', gender: '' }, targetUserId, 'favorite', response.favoriteQuota, savedActive)
      invalidateShowcaseCategory(scope, 'popularity')
      this.setData({ isFavorite: savedActive })
      wx.showToast({ title: savedActive ? '爱心已送出' : '爱心已撤回', icon: 'none' })
      await this.load()
    } catch (err) {
      if (isCurrent()) wx.showToast({ title: apiErrorMessage(err) || '操作未完成，请重试', icon: 'none' })
    } finally {
      if (!this._detailUnloaded && pageSessionScope() === scope) this.setData({ favoriteLoading: false })
    }
  },

  async startChat() {
    if (this.data.chatAccess !== 'allowed' || this.data.loading) return
    const member = this.data.member
    const targetUserId = Number(member && member.userId ? member.userId : 0)
    const memberId = String(member && member.id ? member.id : '')
    if (!targetUserId && !/^\d+$/.test(memberId)) {
      wx.showToast({ title: '互相关注或配对后才能聊天', icon: 'none' })
      return
    }
    if (this.data.chatStarting) return
    const scope = pageSessionScope()
    this.setData({ chatStarting: true })
    try {
      const conversation = await chatApi.getOrCreateConversation(targetUserId
        ? { targetUserId }
        : { targetMemberId: memberId })
      if (!this._detailUnloaded && pageSessionScope() === scope) wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` })
    } catch (err) {
      console.warn('start user chat failed', err)
    } finally {
      this.setData({ chatStarting: false })
    }
  }
})
