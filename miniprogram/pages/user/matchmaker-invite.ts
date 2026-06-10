import { loginByWechat } from '../../services/auth'
import { memberApi } from '../../services/member'
import { extractInviteCode, invitePath, normalizeInviteCode } from '../../utils/invite'

function sourceText(source: string) {
  if (source === 'scan') return '扫码添加'
  if (source === 'share') return '微信链接'
  if (source === 'inviteCode') return '邀请码'
  return '手动输入'
}

function parseOptions(options: Record<string, any>) {
  const scene = options.scene ? decodeURIComponent(String(options.scene)) : ''
  const code = extractInviteCode(options.code || options.inviteCode || options.matchmakerNo || scene)
  const source = String(options.source || (scene ? 'scan' : 'share'))
  return {
    code: normalizeInviteCode(code),
    source
  }
}

Page({
  data: {
    code: '',
    source: 'share',
    sourceText: '微信链接',
    invite: null as any,
    canSubmit: false,
    loading: false,
    submitting: false,
    errorText: '',
    sharePath: ''
  },

  async onLoad(options: Record<string, any>) {
    const parsed = parseOptions(options || {})
    this.setData({
      ...parsed,
      sourceText: sourceText(parsed.source),
      sharePath: parsed.code ? invitePath(parsed.code, parsed.source) : ''
    })
    await this.loadInvite()
  },

  async ensureLogin() {
    if (wx.getStorageSync('token')) return
    await loginByWechat('user')
  },

  async loadInvite() {
    const code = normalizeInviteCode(this.data.code)
    if (!code) {
      this.setData({ errorText: '未识别到有效的邀请码或红娘编号' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    try {
      await this.ensureLogin()
      const invite = await memberApi.resolveMatchmakerInvite({
        code,
        source: this.data.source
      })
      const pending = invite && invite.existingRequest && invite.existingRequest.status === 'pending'
      this.setData({ invite, canSubmit: !(invite && invite.alreadyAssigned) && !pending })
    } catch (err: any) {
      console.warn('resolve matchmaker invite failed', err)
      this.setData({ errorText: err && err.message ? err.message : '邀请信息暂不可用', canSubmit: false })
    } finally {
      this.setData({ loading: false })
    }
  },

  async submitRequest() {
    if (this.data.submitting || !this.data.code) return
    this.setData({ submitting: true })
    try {
      await this.ensureLogin()
      const result: any = await memberApi.requestMatchmaker({
        code: this.data.code,
        source: this.data.source
      })
      wx.showToast({ title: result && result.status === 'approved' ? '已是名下会员' : '申请已提交', icon: 'success' })
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/user/profile' })
      }, 500)
    } catch (err) {
      console.warn('submit matchmaker invite failed', err)
    } finally {
      this.setData({ submitting: false })
    }
  },

  copyCode() {
    if (!this.data.code) return
    wx.setClipboardData({ data: this.data.code })
  },

  goProfile() {
    wx.redirectTo({ url: '/pages/user/profile' })
  },

  onShareAppMessage() {
    return {
      title: '邀请你添加红娘顾问',
      path: this.data.sharePath || invitePath(this.data.code, 'share')
    }
  }
})
