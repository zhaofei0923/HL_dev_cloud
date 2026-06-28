import { salonApi } from '../../services/salon'
import { matchmakerApi } from '../../services/matchmaker'
import { memberApi } from '../../services/member'
import { invitePath } from '../../utils/invite'

function pad(value: number) {
  return value < 10 ? `0${value}` : String(value)
}

function formatDate(value: string) {
  if (!value) return '时间待定'
  const date = new Date(value)
  if (isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeSalonRow(row: any) {
  const maxParticipants = Number(row.maxParticipants || 0)
  const currentParticipants = Number(row.currentParticipants || 0)
  const price = Number(row.price || 0)
  const statusMap: Record<string, string> = {
    pending: '待审核',
    upcoming: '报名中',
    rejected: '未通过',
    cancelled: '已取消',
    ended: '已结束'
  }
  return {
    ...row,
    idText: String(row.id || ''),
    eventDateText: formatDate(row.eventDate || ''),
    locationText: row.location || '地点待定',
    statusText: statusMap[row.status] || row.status || '待定',
    canInvite: row.status === 'upcoming',
    participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
    seatText: maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 席` : '席位不限',
    priceText: price > 0 ? `¥${price}` : '免费'
  }
}

function certificationView(matchmaker: any) {
  const status = Number((matchmaker && matchmaker.certificationStatus) || 0)
  const remark = (matchmaker && matchmaker.certificationRemark) || ''
  if (status === 2) {
    return {
      canOperate: true,
      statusText: '已认证',
      statusTagClass: 'gold',
      statusNote: '红娘权限已开通，可创建和管理沙龙活动。'
    }
  }
  if (status === 1) {
    return {
      canOperate: false,
      statusText: '已拒绝',
      statusTagClass: 'rose',
      statusNote: remark || '本次申请暂未通过，请完善资料后重新提交。'
    }
  }
  return {
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '红娘认证通过后，才可以发起沙龙并管理活动。'
  }
}

Page({
  data: {
    active: 'mine',
    list: [] as any[],
    members: [] as any[],
    memberOptions: [] as string[],
    selectedMemberIndex: 0,
    selectedMemberName: '',
    loading: false,
    cancellingId: '',
    invitingId: '',
    canOperate: false,
    shareCode: '',
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '红娘认证通过后，才可以发起沙龙并管理活动。'
  },

  onShow() {
    this.refreshGate()
  },

  async refreshGate() {
    this.setData({ loading: true })
    try {
      let dashboard: any
      try {
        dashboard = await matchmakerApi.dashboard(false)
      } catch (err) {
        await matchmakerApi.apply()
        dashboard = await matchmakerApi.dashboard()
      }
      const view = certificationView(dashboard.matchmaker)
      this.setData({
        canOperate: view.canOperate,
        shareCode: dashboard.matchmaker && dashboard.matchmaker.inviteCode ? dashboard.matchmaker.inviteCode : '',
        statusText: view.statusText,
        statusTagClass: view.statusTagClass,
        statusNote: view.statusNote
      })
      if (view.canOperate) {
        await this.loadMembers()
        await this.loadMine()
      } else {
        this.setData({ list: [], active: 'mine' })
      }
    } catch (err) {
      console.warn('refresh matchmaker salon gate failed', err)
      this.setData({
        list: [],
        active: 'mine',
        canOperate: false,
        statusText: '云服务未连接',
        statusTagClass: 'rose',
        statusNote: '请确认 hlApi 云函数已部署后重试。'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadMembers() {
    try {
      const result: any = await memberApi.list({ page: 1, pageSize: 100 })
      const members = result.list || []
      const first = members[0]
      this.setData({
        members,
        memberOptions: members.map((item: any) => item.realName || item.nickname || '我的会员'),
        selectedMemberIndex: 0,
        selectedMemberName: first ? (first.realName || first.nickname || '我的会员') : ''
      })
    } catch (err) {
      console.warn('load invite members failed', err)
      this.setData({ members: [], memberOptions: [], selectedMemberIndex: 0, selectedMemberName: '' })
    }
  },

  onInviteMemberChange(e: any) {
    const index = Number(e.detail.value || 0)
    const selected = this.data.members[index]
    this.setData({
      selectedMemberIndex: index,
      selectedMemberName: selected ? (selected.realName || selected.nickname || '我的会员') : ''
    })
  },

  async loadMine() {
    if (!this.data.canOperate) return
    this.setData({ active: 'mine', loading: true })
    try {
      const result: any = await salonApi.myEvents({ page: 1, pageSize: 50 })
      const list = (result.list || []).map((row: any) => normalizeSalonRow(row))
      this.setData({ list })
    } catch (err) {
      console.warn('load matchmaker salon events failed', err)
      this.setData({ list: [] })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadAll() {
    if (!this.data.canOperate) return
    this.setData({ active: 'all', loading: true })
    try {
      const result: any = await salonApi.list({ page: 1, pageSize: 50 })
      const list = (result.list || []).map((row: any) => normalizeSalonRow(row))
      this.setData({ list })
    } catch (err) {
      console.warn('load salon events failed', err)
      this.setData({ list: [] })
    } finally {
      this.setData({ loading: false })
    }
  },

  goCreate() {
    if (!this.data.canOperate) {
      wx.showToast({ title: '红娘认证通过后可创建沙龙', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/matchmaker/salon-form' })
  },

  async applyAgain() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      await matchmakerApi.apply()
      wx.showToast({ title: '已重新提交' })
      await this.refreshGate()
    } catch (err) {
      console.warn('apply matchmaker failed', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  async inviteSelected(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id
    const member = this.data.members[this.data.selectedMemberIndex]
    if (!id || !member) {
      wx.showToast({ title: '请先选择会员', icon: 'none' })
      return
    }
    this.setData({ invitingId: `${id}:one` })
    try {
      await salonApi.invite(id, [Number(member.userId || member.id)])
      wx.showToast({ title: '已推送会员' })
    } catch (err) {
      console.warn('invite selected member failed', err)
    } finally {
      this.setData({ invitingId: '' })
    }
  },

  async inviteAll(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id
    if (!id || !this.data.members.length) {
      wx.showToast({ title: '暂无可推送会员', icon: 'none' })
      return
    }
    this.setData({ invitingId: `${id}:all` })
    try {
      await salonApi.invite(id, [], true)
      wx.showToast({ title: '已推送全部' })
    } catch (err) {
      console.warn('invite all members failed', err)
    } finally {
      this.setData({ invitingId: '' })
    }
  },

  async cancel(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '确认取消活动',
      content: '取消后该沙龙将不再接受报名。',
      confirmText: '取消活动',
      confirmColor: '#963b35',
      success: async res => {
        if (!res.confirm) return
        this.setData({ cancellingId: String(id) })
        try {
          await salonApi.cancelEvent(id)
          wx.showToast({ title: '已取消' })
          await this.loadMine()
        } catch (err) {
          console.warn('cancel salon event failed', err)
        } finally {
          this.setData({ cancellingId: '' })
        }
      }
    })
  },

  onShareAppMessage(options?: any) {
    const dataset = options && options.target && options.target.dataset ? options.target.dataset : {}
    const eventId = dataset.id || ''
    const title = dataset.title || '沙龙活动'
    const code = this.data.shareCode || ''
    if (eventId && code) {
      return {
        title: `邀请你报名沙龙《${title}》`,
        path: invitePath(code, 'salonShare', { eventId, autoRegister: true })
      }
    }
    return {
      title: '邀请你注册成为会员',
      path: code ? invitePath(code, 'matchmakerShare') : '/pages/user/members'
    }
  }
})
