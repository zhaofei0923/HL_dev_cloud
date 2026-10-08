import { salonApi } from '../../services/salon'
import { pageSessionScope } from '../../utils/page-session'

function buildIso(dateValue: string, timeValue: string) {
  const [year, month, day] = dateValue.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

Page({
  _session: '',
  _generation: 0,
  _visible: false,

  data: {
    saving: false,
    minDate: '',
    dateValue: '',
    timeValue: '10:00',
    form: {
      title: '',
      description: '',
      location: '',
      eventDate: '',
      maxParticipants: '12',
      price: '0'
    }
  },

  onLoad() {
    this._session = pageSessionScope()
    this.initializeForm()
  },

  onShow() {
    this._visible = true
    this.synchronizeSession()
  },

  onHide() {
    this._visible = false
    this._generation += 1
    this.setData({ saving: false })
  },

  onUnload() {
    this.onHide()
  },

  initializeForm() {
    const today = new Date()
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    const dateValue = localDate(tomorrow)
    this.setData({ saving: false, minDate: localDate(today), dateValue, timeValue: '10:00',
      form: { title: '', description: '', location: '', eventDate: buildIso(dateValue, '10:00'), maxParticipants: '12', price: '0' } })
  },

  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._session) {
      this._session = scope
      this._generation += 1
      this.initializeForm()
    }
    return scope
  },

  isCurrent(generation: number, scope: string) {
    return this._visible && generation === this._generation && pageSessionScope() === scope
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onDateChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const dateValue = e.detail.value
    this.setData({
      dateValue,
      'form.eventDate': buildIso(dateValue, this.data.timeValue)
    })
  },

  onTimeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const timeValue = e.detail.value
    this.setData({
      timeValue,
      'form.eventDate': buildIso(this.data.dateValue, timeValue)
    })
  },

  async save() {
    const scope = this.synchronizeSession()
    if (!this._visible || !scope || this.data.saving) return
    if (!this.data.form.title.trim() || !this.data.form.location.trim()) {
      wx.showToast({ title: '请填写活动标题和地点', icon: 'none' }); return
    }
    const startsAt = new Date(this.data.form.eventDate).getTime()
    if (!Number.isFinite(startsAt) || startsAt <= Date.now()) {
      wx.showToast({ title: '请选择未来的活动时间', icon: 'none' }); return
    }
    if (!Number.isInteger(Number(this.data.form.maxParticipants)) || Number(this.data.form.maxParticipants) < 0
      || !Number.isFinite(Number(this.data.form.price)) || Number(this.data.form.price) < 0) {
      wx.showToast({ title: '请填写有效的席位和费用', icon: 'none' }); return
    }
    const generation = ++this._generation
    const form = { ...this.data.form }
    this.setData({ saving: true })
    try {
      await salonApi.create(form)
      if (!this.isCurrent(generation, scope)) return
      wx.showToast({ title: '已提交审核' })
      wx.navigateBack()
    } catch (err) {
      if (this.isCurrent(generation, scope)) console.warn('create salon failed', err)
    } finally {
      if (this.isCurrent(generation, scope)) this.setData({ saving: false })
    }
  }
})
