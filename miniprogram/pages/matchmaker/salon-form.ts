import { salonApi } from '../../services/salon'

function buildIso(dateValue: string, timeValue: string) {
  return `${dateValue}T${timeValue}:00.000Z`
}

Page({
  data: {
    saving: false,
    dateValue: '2026-06-20',
    timeValue: '10:00',
    form: {
      title: '',
      description: '',
      location: '',
      eventDate: '2026-06-20T10:00:00.000Z',
      maxParticipants: '12',
      price: '0'
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onDateChange(e: any) {
    const dateValue = e.detail.value
    this.setData({
      dateValue,
      'form.eventDate': buildIso(dateValue, this.data.timeValue)
    })
  },

  onTimeChange(e: any) {
    const timeValue = e.detail.value
    this.setData({
      timeValue,
      'form.eventDate': buildIso(this.data.dateValue, timeValue)
    })
  },

  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await salonApi.create(this.data.form)
      wx.showToast({ title: '已提交审核' })
      wx.navigateBack()
    } catch (err) {
      console.warn('create salon failed', err)
    } finally {
      this.setData({ saving: false })
    }
  }
})
