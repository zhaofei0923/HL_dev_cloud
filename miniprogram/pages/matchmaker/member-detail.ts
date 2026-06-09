import { memberApi } from '../../services/member'
import { normalizeMemberProfile } from '../../utils/member-format'

Page({
  data: {
    id: '',
    scope: 'own',
    isOwn: true,
    member: null as any,
    loading: false
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
  }
})
