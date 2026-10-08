import { salonApi } from '../../services/salon'
import { pageSessionScope } from '../../utils/page-session'
import { syncUserTabBar } from '../../utils/user-navigation'
import { salonAvailability } from '../../utils/salon-availability'

type SalonTab = 'all' | 'mine'
type SalonSnapshot = { list: any[]; loadedAt: number }
const SALON_TTL_MS = 30 * 1000

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
  const event = row.event || row
  const maxParticipants = Number(event.maxParticipants || 0)
  const currentParticipants = Number(event.currentParticipants || 0)
  const price = Number(event.price || 0)
  const registered = row.status === 'registered' || row.registered === true
  const availability = salonAvailability(event)
  const status = registered ? `${availability.statusText} · 已报名` : availability.statusText

  return {
    id: event.id || row.eventId || row.id,
    title: event.title || '精选沙龙',
    description: event.description || '主理人精选线下活动，适合轻松交流和初步了解。',
    location: event.location || '地点待定',
    eventDate: formatDate(event.eventDate || ''),
    statusText: status,
    participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
    seatText: availability.canRegister
      ? (maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 席` : '席位不限')
      : availability.statusText,
    priceText: price > 0 ? `¥${price}` : '免费',
    raw: event,
    registered
  }
}

Page({
  _sessionScope: '',
  _salonGeneration: 0,
  _salonSnapshots: {} as Partial<Record<SalonTab, SalonSnapshot>>,
  _salonPending: null as { key: SalonTab; promise: Promise<void> } | null,
  _refreshOnShow: false,

  data: {
    active: 'all' as SalonTab,
    list: [] as any[],
    loading: false,
    listTitle: '近期精选',
    listNote: '点击活动卡片查看详情和报名。'
  },

  onShow() {
    if (!this.synchronizeSession()) return
    syncUserTabBar(this, 'salon')
    const force = this._refreshOnShow
    this._refreshOnShow = false
    return this.loadSalons(this.data.active, force)
  },

  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._sessionScope) {
      this._sessionScope = scope
      this._salonGeneration += 1
      this._salonSnapshots = {}
      this._salonPending = null
      this.setData({ active: 'all', list: [], loading: false, listTitle: '近期精选', listNote: '点击活动卡片查看详情和报名。' })
    }
    if (scope) return scope
    wx.redirectTo({ url: '/pages/index/index' })
    return ''
  },

  loadAll() {
    return this.loadSalons('all', true)
  },

  loadMine() {
    return this.loadSalons('mine', true)
  },

  loadSalons(active: SalonTab, force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope) return Promise.resolve()
    if (!force && this._salonPending && this._salonPending.key === active && this.data.active === active) {
      return this._salonPending.promise
    }
    this._salonPending = null
    const generation = ++this._salonGeneration
    const cached = this._salonSnapshots[active]
    const listTitle = active === 'mine' ? '我的报名' : '近期精选'
    const listNote = active === 'mine' ? '已报名活动会显示在这里。' : '点击活动卡片查看详情和报名。'
    const cachedList = cached ? cached.list.map((row: { raw: Record<string, unknown>; registered?: boolean }) => normalizeSalonRow({ event: row.raw, registered: row.registered })) : []
    this.setData({ active, list: cachedList, listTitle, listNote, loading: !cached })
    const isCurrent = () => this._salonGeneration === generation && pageSessionScope() === scope
    if (cached && !force && Date.now() - cached.loadedAt < SALON_TTL_MS) return Promise.resolve()
    const promise = Promise.resolve().then(async () => {
      try {
        const result: any = active === 'mine'
          ? await salonApi.myRegistrations({ page: 1, pageSize: 30 })
          : await salonApi.list({ page: 1, pageSize: 30 })
        if (!isCurrent()) return
        const list = (result.list || []).map((row: any) => normalizeSalonRow(row))
        this._salonSnapshots[active] = { list, loadedAt: Date.now() }
        this.setData({ list, listTitle, listNote })
      } catch (err) {
        if (!isCurrent()) return
        console.warn('load salons failed', err)
        if (cached) {
          cached.loadedAt = 0
          this.setData({ listNote: '暂未更新成功，下拉可重试。' })
        } else {
          this.setData({ list: [], listTitle: '云服务暂不可用', listNote: '请稍后下拉刷新重试。' })
        }
      } finally {
        if (isCurrent()) {
          this._salonPending = null
          this.setData({ loading: false })
        }
      }
    })
    this._salonPending = { key: active, promise }
    return promise
  },

  onPullDownRefresh() {
    return this.loadSalons(this.data.active, true).finally(() => wx.stopPullDownRefresh())
  },

  onUnload() {
    this._salonGeneration += 1
    this._salonPending = null
  },

  openDetail(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id
    if (id) {
      this._refreshOnShow = true
      wx.navigateTo({ url: `/pages/user/salon-detail?id=${id}` })
    }
  }
})
