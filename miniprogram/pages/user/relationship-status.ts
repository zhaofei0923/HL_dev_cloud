import { relationshipApi, type CoupleInvitation, type RelationshipOverview } from '../../services/relationship'
import { pageSessionScope } from '../../utils/page-session'

const REASONS = ['说话不礼貌、骚扰', '发广告、色情信息', '消息不回复', '接触后发现不合适']
const STATUS_TEXT = { pending: '等待回应', accepted: '已接受', declined: '已婉拒', cancelled: '已取消' }

function invitationRows(rows: CoupleInvitation[]) {
  return rows.map(row => ({ ...row, statusText: STATUS_TEXT[row.status] || '已处理' }))
}

function confirm(title: string, content: string, confirmText: string) {
  return new Promise<boolean>(resolve => wx.showModal({
    title, content, confirmText, cancelText: '再想想',
    success: result => resolve(result.confirm), fail: () => resolve(false)
  }))
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作未完成，请稍后重试'
}

Page({
  _scope: '',
  _targetUserId: 0,
  _generation: 0,
  data: {
    loading: false, busy: false, ready: false, error: '', feedback: '',
    relationshipStatus: 'single', displayEnabled: false,
    incomingInvitations: [] as ReturnType<typeof invitationRows>,
    outgoingInvitations: [] as ReturnType<typeof invitationRows>,
    candidates: [] as RelationshipOverview['candidates'],
    selectedIndex: -1, selectedName: '', reasonIndex: -1, reasonOptions: REASONS,
    targetUnavailable: false
  },

  onLoad(options: Record<string, string>) {
    this._targetUserId = Number(options.targetUserId) || 0
  },

  onShow() {
    this._scope = pageSessionScope()
    if (!this._scope) {
      wx.redirectTo({ url: '/pages/index/index?login=1&returnTo=profile' })
      return
    }
    return this.load()
  },

  onUnload() {
    this._generation += 1
    this._scope = ''
  },

  async load() {
    const scope = this._scope
    const generation = ++this._generation
    if (!scope || pageSessionScope() !== scope) return
    this.setData({ loading: true, error: '' })
    try {
      const result = await relationshipApi.overview()
      if (generation !== this._generation || pageSessionScope() !== scope) return
      const selectedId = this.data.candidates[this.data.selectedIndex]?.userId || this._targetUserId
      const selectedIndex = result.candidates.findIndex(row => row.userId === selectedId)
      this.setData({
        ready: true, relationshipStatus: result.relationshipStatus, displayEnabled: result.displayEnabled,
        candidates: result.candidates, selectedIndex,
        selectedName: result.candidates[selectedIndex]?.displayName || '',
        incomingInvitations: invitationRows(result.incomingInvitations),
        outgoingInvitations: invitationRows(result.outgoingInvitations),
        targetUnavailable: this._targetUserId > 0 && selectedIndex < 0
      })
    } catch (error) {
      if (generation === this._generation && pageSessionScope() === scope) this.setData({ ready: false, error: errorMessage(error) })
    } finally {
      if (generation === this._generation && pageSessionScope() === scope) this.setData({ loading: false })
    }
  },

  onCandidateChange(event: WechatMiniprogram.PickerChange) {
    const selectedIndex = Number(event.detail.value)
    this.setData({ selectedIndex, selectedName: this.data.candidates[selectedIndex]?.displayName || '', reasonIndex: -1, feedback: '', targetUnavailable: false })
  },

  onReasonChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ reasonIndex: Number(event.detail.value) })
  },

  async runMutation(action: () => Promise<unknown>, feedback: string) {
    if (this.data.busy || !this.data.ready || pageSessionScope() !== this._scope) return
    const scope = this._scope
    this.setData({ busy: true, error: '', feedback: '' })
    try {
      await action()
      if (pageSessionScope() !== scope) return
      this.setData({ feedback })
      await this.load()
    } catch (error) {
      if (pageSessionScope() === scope) this.setData({ error: errorMessage(error) })
    } finally {
      if (pageSessionScope() === scope) this.setData({ busy: false })
    }
  },

  async declareSuccess() {
    if (this.data.busy || !this.data.ready) return
    if (!await confirm('确认已脱单', '确认后，你将进入已脱单状态，资料自动隐藏并退出公开推荐。此操作只修改你自己的状态。', '确认脱单')) return
    return this.runMutation(() => relationshipApi.setStatus('coupled'), '已进入脱单状态，资料已隐藏')
  },

  async restoreSingle() {
    if (this.data.busy || !this.data.ready) return
    if (!await confirm('恢复单身状态', '未回应的脱单邀请将取消，资料继续隐藏。需要展示时，请到“公开与账号设置”主动开启。', '恢复单身')) return
    return this.runMutation(() => relationshipApi.setStatus('single'), '已恢复单身状态，资料保持隐藏')
  },

  async invitePartner() {
    const peer = this.data.candidates[this.data.selectedIndex]
    if (!peer || this.data.busy || !this.data.ready) return
    if (!await confirm('邀请对方脱单', `向${peer.displayName}发送邀请后，你将进入已脱单状态并隐藏资料。对方接受后才会修改对方的状态。`, '发送邀请')) return
    return this.runMutation(() => relationshipApi.invite(peer.userId), '邀请已发送，你的资料已隐藏；等待对方确认')
  },

  async respondInvitation(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id)
    const accept = event.currentTarget.dataset.accept === true || event.currentTarget.dataset.accept === 'true'
    if (!id || this.data.busy || !this.data.ready) return
    if (accept && !await confirm('接受脱单邀请', '接受后，你将进入已脱单状态并自动隐藏资料。', '接受邀请')) return
    return this.runMutation(() => relationshipApi.respond(id, accept), accept ? '已接受邀请，资料已隐藏' : '已婉拒邀请，你的状态保持不变')
  },

  async unmatch() {
    const peer = this.data.candidates[this.data.selectedIndex]
    const reason = REASONS[this.data.reasonIndex]
    if (!peer || !reason || this.data.busy || !this.data.ready) return
    if (!await confirm('解除匹配', `确认与${peer.displayName}解除匹配？双方心动与聊天将停止。原因：${reason}。`, '解除匹配')) return
    return this.runMutation(() => relationshipApi.unmatch(peer.userId, reason), '已解除匹配，双方不能继续聊天')
  }
})
