import { memberApi } from '../../services/member'
import { normalizeMemberProfile } from '../../utils/member-format'

Page({
  data: {
    id: '',
    member: null as any,
    loading: false
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
  }
})
