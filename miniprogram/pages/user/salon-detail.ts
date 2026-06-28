import { salonApi } from '../../services/salon'

function pad(value: number) {
  return value < 10 ? `0${value}` : String(value)
}

function formatDate(value: string) {
  if (!value) return '时间待定'
  const date = new Date(value)
  if (isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeEvent(event: any) {
  if (!event) return null
  const maxParticipants = Number(event.maxParticipants || 0)
  const currentParticipants = Number(event.currentParticipants || 0)
  const price = Number(event.price || 0)
  const registered = event.isRegistered || event.registrationStatus === 'registered'
  const isFull = event.isFull || (maxParticipants > 0 && currentParticipants >= maxParticipants)
  const cancelled = event.status === 'cancelled'
  const ended = event.status === 'ended'
  let primaryAction = {
    type: 'register',
    text: '立即报名',
    className: 'gold',
    disabled: false,
    note: '报名后红娘可根据活动安排继续跟进提醒。'
  }
  if (registered) {
    primaryAction = {
      type: 'cancel',
      text: '取消报名',
      className: 'danger',
      disabled: false,
      note: '你已报名，如行程变化可在这里取消。'
    }
  } else if (cancelled || ended) {
    primaryAction = {
      type: 'disabled',
      text: cancelled ? '活动已取消' : '活动已结束',
      className: 'secondary',
      disabled: true,
      note: '该活动当前不可报名，请返回列表选择其他活动。'
    }
  } else if (isFull) {
    primaryAction = {
      type: 'disabled',
      text: '席位已满',
      className: 'secondary',
      disabled: true,
      note: '该活动名额已满，可关注后续新活动。'
    }
  }
  return {
    ...event,
    eventDateText: formatDate(event.eventDate || ''),
    locationText: event.location || '地点待定',
    descriptionText: event.description || '红娘精选线下活动，适合轻松交流和初步了解。',
    statusText: event.status === 'upcoming' ? '报名中' : (event.status || '待定'),
    participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
    seatHint: maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 个席位` : '席位不限',
    priceText: price > 0 ? `¥${price}` : '免费',
    primaryAction
  }
}

Page({
  data: {
    id: '',
    event: null as any,
    shareCard: { canShare: false } as any,
    loading: false,
    shareLoading: false,
    actionLoading: false
  },

  onLoad(options: Record<string, string | undefined>) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      const event = await salonApi.detail(this.data.id)
      const normalized = normalizeEvent(event)
      this.setData({ event: normalized })
      if (normalized && normalized.isRegistered && normalized.status === 'upcoming') {
        await this.loadShareCard()
      } else {
        this.setData({ shareCard: { canShare: false } })
      }
    } catch (err) {
      console.warn('load salon detail failed', err)
      this.setData({ event: null, shareCard: { canShare: false } })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadShareCard() {
    if (!this.data.id) return
    this.setData({ shareLoading: true })
    try {
      const shareCard = await salonApi.shareCard(this.data.id, false)
      this.setData({ shareCard })
    } catch (err) {
      console.warn('load salon share card failed', err)
      this.setData({ shareCard: { canShare: false } })
    } finally {
      this.setData({ shareLoading: false })
    }
  },

  async register() {
    if (this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      await salonApi.register(this.data.id)
      wx.showToast({ title: '报名成功' })
      await this.load()
    } catch (err) {
      console.warn('register salon failed', err)
    } finally {
      this.setData({ actionLoading: false })
    }
  },

  async cancel() {
    if (this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      await salonApi.cancelRegistration(this.data.id)
      wx.showToast({ title: '已取消' })
      await this.load()
    } catch (err) {
      console.warn('cancel salon registration failed', err)
    } finally {
      this.setData({ actionLoading: false })
    }
  },

  primaryAction() {
    const action = this.data.event && this.data.event.primaryAction
    if (!action || action.disabled) return
    if (action.type === 'cancel') {
      this.cancel()
      return
    }
    this.register()
  },

  onShareAppMessage() {
    const card = this.data.shareCard || {}
    const event = this.data.event || {}
    return {
      title: card.title || `邀请你参加沙龙《${event.title || '精选沙龙'}》`,
      path: card.sharePath || `/pages/user/salon-detail?id=${encodeURIComponent(this.data.id)}`
    }
  }
})
