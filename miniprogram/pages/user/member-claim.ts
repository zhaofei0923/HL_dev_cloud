import {
  confirmManualMemberClaim,
  loginByWechat,
  previewManualMemberClaim,
  type ManualMemberClaimPreview
} from '../../services/auth'
import { apiErrorMessage, isSessionRecoverableError } from '../../services/api'

function safeDecode(value: string | undefined) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch (err) {
    return ''
  }
}

function expiryText(value?: string) {
  const date = new Date(value || '')
  if (!Number.isFinite(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hour}:${minute} 前有效`
}

Page({
  data: {
    token: '',
    preview: null as ManualMemberClaimPreview | null,
    expiresText: '',
    loggedIn: false,
    loading: true,
    loginLoading: false,
    confirmLoading: false,
    completed: false,
    errorText: '',
    actionErrorText: ''
  },

  onLoad(options: Record<string, string | undefined>) {
    const token = safeDecode(options.token)
    this.setData({
      token,
      loggedIn: !!wx.getStorageSync('token')
    })
    void this.loadPreview()
  },

  async loadPreview() {
    if (!this.data.token) {
      this.setData({ loading: false, errorText: '认领邀请不完整，请联系主理人重新发送。' })
      return
    }
    this.setData({ loading: true, errorText: '', actionErrorText: '' })
    try {
      const preview = await previewManualMemberClaim(this.data.token)
      this.setData({
        preview,
        completed: preview.status === 'claimed',
        expiresText: expiryText(preview.expiresAt)
      })
    } catch (err) {
      this.setData({ errorText: apiErrorMessage(err) || '认领邀请暂时无法读取，请稍后重试。' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async login() {
    if (this.data.loginLoading) return
    this.setData({ loginLoading: true })
    try {
      await loginByWechat('user')
      this.setData({ loggedIn: true, actionErrorText: '' })
    } catch (err) {
      console.warn('claim login failed', err)
      this.setData({ actionErrorText: apiErrorMessage(err) || '微信登录失败，请稍后重试。' })
    } finally {
      this.setData({ loginLoading: false })
    }
  },

  async confirmClaim(e: WechatMiniprogram.ButtonGetPhoneNumber) {
    if (this.data.confirmLoading) return
    const detail = e.detail as any
    const code = String(detail.code || '')
    if (!code) {
      wx.showToast({ title: '需要授权本人手机号完成核验', icon: 'none' })
      return
    }
    this.setData({ confirmLoading: true, actionErrorText: '' })
    try {
      await confirmManualMemberClaim(this.data.token, code)
      this.setData({ completed: true, errorText: '', actionErrorText: '' })
      wx.showToast({ title: '档案认领成功' })
    } catch (err) {
      console.warn('confirm manual member claim failed', err)
      const recoverable = isSessionRecoverableError(err)
      this.setData({
        actionErrorText: recoverable
          ? '登录状态已失效，请重新登录后继续。'
          : (apiErrorMessage(err) || '认领失败，请核对信息后重试。')
      })
      if (recoverable) {
        const app = getApp<IAppOption>()
        wx.removeStorageSync('token')
        wx.removeStorageSync('user')
        app.globalData.token = ''
        app.globalData.user = null
        this.setData({ loggedIn: false })
      }
    } finally {
      this.setData({ confirmLoading: false })
    }
  },

  goProfile() {
    wx.redirectTo({ url: '/pages/user/profile' })
  },

  goMembers() {
    wx.redirectTo({ url: '/pages/user/members' })
  }
})
