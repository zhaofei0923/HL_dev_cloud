import { currentUser, request } from '../../services/api'
import { matchmakerApi } from '../../services/matchmaker'
import { chooseLocalImages } from '../../utils/local-image'
import { defaultAvatar, defaultPhotos, normalizeMemberProfile, photosFromText } from '../../utils/member-format'
import { extractInviteCode, invitePath } from '../../utils/invite'
import {
  AGE_OPTIONS,
  EDUCATION_OPTIONS,
  HEIGHT_OPTIONS,
  INCOME_OPTIONS,
  OCCUPATION_OPTIONS,
  agePickerText,
  heightPickerText,
  pickerText,
  regionPickerText,
  regionValueText
} from '../../utils/profile-options'

type ProfileForm = Record<string, any>

const FORM_DEFAULTS: ProfileForm = {
  realName: '',
  avatarUrl: '',
  avatarDisplayUrl: '',
  photoText: '',
  photoDisplayUrls: [],
  displayEnabled: false,
  gender: '2',
  age: '',
  height: '',
  city: '',
  nativePlace: '',
  education: '',
  occupation: '',
  incomeRange: '',
  maritalStatus: '未婚',
  houseStatus: '计划购房',
  carStatus: '无车',
  selfIntro: '',
  partnerRequirement: ''
}

const COMPLETION_FIELDS = [
  'avatarUrl',
  'photoText',
  'realName',
  'gender',
  'age',
  'height',
  'city',
  'nativePlace',
  'education',
  'occupation',
  'incomeRange',
  'maritalStatus',
  'houseStatus',
  'carStatus',
  'selfIntro',
  'partnerRequirement'
]

function photosToText(photos: string[] | undefined) {
  return Array.isArray(photos) ? photos.slice(0, 3).join('\n') : ''
}

function normalizeForm(raw: ProfileForm, user: any) {
  const form: ProfileForm = {
    ...FORM_DEFAULTS,
    ...(raw || {})
  }
  form.realName = form.realName || (user && user.nickname) || ''
  form.avatarUrl = form.avatarUrl || (user && user.avatarUrl) || defaultAvatar(form)
  form.avatarDisplayUrl = form.avatarDisplayUrl || form.avatarUrl
  form.displayEnabled = form.displayEnabled === true || form.displayEnabled === 1 || form.displayEnabled === '1' || form.displayEnabled === 'true'
  form.gender = String(form.gender || (user && user.gender) || '2')
  form.photoText = form.photoText || photosToText(form.photos) || defaultPhotos(form).join('\n')
  form.photoDisplayUrls = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
    ? form.photoDisplayUrls.slice(0, 3)
    : photosFromText(form.photoText)
  return form
}

function payloadFromForm(form: ProfileForm) {
  const photos = photosFromText(form.photoText)
  const payload: ProfileForm = {
    ...form,
    avatarUrl: form.avatarUrl || defaultAvatar(form),
    photos: photos.length ? photos : defaultPhotos(form)
  }
  delete payload.photoText
  delete payload.avatarDisplayUrl
  delete payload.photoDisplayUrls
  return payload
}

function completionFor(form: ProfileForm) {
  const payload = payloadFromForm(form)
  const filled = COMPLETION_FIELDS.filter(field => {
    if (field === 'photoText') return Array.isArray(payload.photos) && payload.photos.length > 0
    return !!String(payload[field] || '').trim()
  }).length
  const percent = Math.round((filled / COMPLETION_FIELDS.length) * 100)
  return {
    percent,
    text: `${percent}%`,
    note: percent >= 85 ? '个人档案较完整，适合进入后续推荐。' : '补齐形象、生活状态和择偶期待后，红娘判断会更准确。'
  }
}

function previewFor(form: ProfileForm) {
  const payload = payloadFromForm(form)
  const displayPhotos = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
    ? form.photoDisplayUrls.slice(0, 3)
    : payload.photos
  return normalizeMemberProfile({
    ...payload,
    avatarUrl: form.avatarDisplayUrl || payload.avatarUrl,
    photos: displayPhotos
  })
}

function hydrateImageDisplay(form: ProfileForm) {
  const payload = payloadFromForm(form)
  return {
    ...form,
    avatarDisplayUrl: form.avatarDisplayUrl || payload.avatarUrl,
    photoDisplayUrls: Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
      ? form.photoDisplayUrls.slice(0, 3)
      : payload.photos.slice(0, 3)
  }
}

function selectorTextFor(form: ProfileForm) {
  return {
    ageText: agePickerText(form.age),
    heightText: heightPickerText(form.height),
    nativePlaceText: regionPickerText(form.nativePlace, '请选择籍贯'),
    cityText: regionPickerText(form.city, '请选择城市'),
    educationText: pickerText(form.education, '请选择学历'),
    incomeText: pickerText(form.incomeRange, '请选择收入'),
    occupationText: pickerText(form.occupation, '请选择职业')
  }
}

function matchmakerEntryView(matchmaker: any) {
  const status = matchmaker ? Number(matchmaker.certificationStatus || 0) : -1
  const remark = matchmaker && matchmaker.certificationRemark ? String(matchmaker.certificationRemark) : ''
  if (status === 2) {
    return {
      matchmakerApproved: true,
      matchmakerEntryTitle: '红娘端入口',
      matchmakerEntryNote: '红娘权限已开通，可进入红娘端使用会员经营、资源池和沙龙管理。',
      matchmakerEntryButton: '进入红娘端'
    }
  }
  if (status === 1) {
    return {
      matchmakerApproved: false,
      matchmakerEntryTitle: '红娘申请未通过',
      matchmakerEntryNote: remark || '本次申请暂未通过，可完善资料后重新提交申请。',
      matchmakerEntryButton: '重新申请 / 查看状态'
    }
  }
  if (status === 0) {
    return {
      matchmakerApproved: false,
      matchmakerEntryTitle: '红娘申请待审批',
      matchmakerEntryNote: '申请已提交，后台审批通过后将开放会员经营、资源池和沙龙管理。',
      matchmakerEntryButton: '查看申请状态'
    }
  }
  return {
    matchmakerApproved: false,
    matchmakerEntryTitle: '申请成为红娘',
    matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
    matchmakerEntryButton: '申请 / 查看状态'
  }
}

Page({
  data: {
    user: null as any,
    loading: false,
    saving: false,
    completionText: '0%',
    completionNote: '补齐形象、生活状态和择偶期待后，红娘判断会更准确。',
    genderOptions: ['男', '女'],
    maritalOptions: ['未婚', '离异', '丧偶'],
    houseOptions: ['已购房', '计划购房', '与父母同住', '租住'],
    carOptions: ['有车', '无车', '计划购车'],
    ageOptions: AGE_OPTIONS,
    heightOptions: HEIGHT_OPTIONS,
    educationOptions: EDUCATION_OPTIONS,
    incomeOptions: INCOME_OPTIONS,
    occupationOptions: OCCUPATION_OPTIONS,
    matchmakerApproved: false,
    matchmakerEntryTitle: '申请成为红娘',
    matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
    matchmakerEntryButton: '申请 / 查看状态',
    matchmakerCode: '',
    matchmakerRequesting: false,
    ...selectorTextFor(FORM_DEFAULTS),
    form: { ...FORM_DEFAULTS },
    preview: previewFor(FORM_DEFAULTS)
  },

  async onShow() {
    this.setData({ loading: true })
    try {
      const result: any = await request('/user/profile')
      const user = currentUser() || result
      const form = hydrateImageDisplay(normalizeForm(result.profile || {}, user))
      const completion = completionFor(form)
      this.setData({
        user,
        form,
        preview: previewFor(form),
        ...selectorTextFor(form),
        completionText: completion.text,
        completionNote: completion.note
      })
      void this.refreshMatchmakerEntry()
    } catch (err) {
      console.warn('load user profile failed', err)
      const form = hydrateImageDisplay(normalizeForm({}, currentUser() || {}))
      const completion = completionFor(form)
      this.setData({
        user: currentUser() || {},
        form,
        preview: previewFor(form),
        ...selectorTextFor(form),
        completionText: completion.text,
        completionNote: completion.note
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  async refreshMatchmakerEntry() {
    try {
      const dashboard: any = await matchmakerApi.dashboard(false)
      this.setData(matchmakerEntryView(dashboard.matchmaker))
    } catch (err) {
      this.setData(matchmakerEntryView(null))
    }
  },

  setForm(form: ProfileForm) {
    const completion = completionFor(form)
    this.setData({
      form,
      preview: previewFor(form),
      ...selectorTextFor(form),
      completionText: completion.text,
      completionNote: completion.note
    })
  },

  updateForm(field: string, value: string) {
    this.setForm({ ...this.data.form, [field]: value })
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field || '')
    if (!field) return
    this.updateForm(field, e.detail.value)
  },

  async onDisplayEnabledChange(e: any) {
    const next = { ...this.data.form, displayEnabled: !!e.detail.value }
    this.setForm(next)
    await this.saveProfile(next, next.displayEnabled ? '已开启展示' : '已关闭展示')
  },

  onMatchmakerCodeInput(e: WechatMiniprogram.Input) {
    this.setData({ matchmakerCode: e.detail.value })
  },

  async submitMatchmakerRequest() {
    const code = String(this.data.matchmakerCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请输入红娘编号', icon: 'none' })
      return
    }
    wx.navigateTo({ url: invitePath(code, 'inviteCode') })
  },

  scanMatchmakerInvite() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: res => {
        const code = extractInviteCode(res.result || res.path)
        if (!code) {
          wx.showToast({ title: '未识别到红娘邀请码', icon: 'none' })
          return
        }
        wx.navigateTo({ url: invitePath(code, 'scan') })
      },
      fail: err => {
        if (!/cancel/i.test(String(err && err.errMsg))) {
          wx.showToast({ title: '扫码失败，请重试', icon: 'none' })
        }
      }
    })
  },

  showInviteLinkTip() {
    wx.showModal({
      title: '微信链接添加',
      content: '请打开红娘发来的微信分享卡片，系统会自动识别邀请码，并进入确认申请页面。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  async chooseAvatar() {
    try {
      wx.showLoading({ title: '上传中' })
      const images = await chooseLocalImages(1)
      const image = images[0]
      if (image) {
        this.setForm({
          ...this.data.form,
          avatarUrl: image.fileID,
          avatarDisplayUrl: image.displayUrl
        })
      }
    } catch (err) {
      // 用户取消选择时无需提示。
    } finally {
      wx.hideLoading()
    }
  },

  async choosePhotos() {
    try {
      wx.showLoading({ title: '上传中' })
      const images = await chooseLocalImages(3)
      if (images.length) {
        this.setForm({
          ...this.data.form,
          photoText: images.map(item => item.fileID).join('\n'),
          photoDisplayUrls: images.map(item => item.displayUrl)
        })
      }
    } catch (err) {
      // 用户取消选择时无需提示。
    } finally {
      wx.hideLoading()
    }
  },

  onGenderChange(e: any) {
    this.updateForm('gender', String(Number(e.detail.value) + 1))
  },

  onAgeChange(e: any) {
    this.updateForm('age', this.data.ageOptions[Number(e.detail.value)])
  },

  onHeightChange(e: any) {
    this.updateForm('height', this.data.heightOptions[Number(e.detail.value)])
  },

  onNativePlaceChange(e: any) {
    this.updateForm('nativePlace', regionValueText(e.detail.value))
  },

  onCityChange(e: any) {
    this.updateForm('city', regionValueText(e.detail.value))
  },

  onEducationChange(e: any) {
    this.updateForm('education', this.data.educationOptions[Number(e.detail.value)])
  },

  onIncomeChange(e: any) {
    this.updateForm('incomeRange', this.data.incomeOptions[Number(e.detail.value)])
  },

  onOccupationChange(e: any) {
    this.updateForm('occupation', this.data.occupationOptions[Number(e.detail.value)])
  },

  onMaritalChange(e: any) {
    this.updateForm('maritalStatus', this.data.maritalOptions[Number(e.detail.value)])
  },

  onHouseChange(e: any) {
    this.updateForm('houseStatus', this.data.houseOptions[Number(e.detail.value)])
  },

  onCarChange(e: any) {
    this.updateForm('carStatus', this.data.carOptions[Number(e.detail.value)])
  },

  async saveProfile(form: ProfileForm, toastTitle = '已保存') {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const payload = payloadFromForm(form)
      const result: any = await request('/user/profile', { method: 'PUT', data: payload })
      const user = {
        ...(currentUser() || {}),
        ...(result.user || {}),
        nickname: payload.realName || (result.user && result.user.nickname) || ((currentUser() || {}).nickname) || '',
        avatarUrl: payload.avatarUrl,
        gender: Number(payload.gender || 0)
      }
      wx.setStorageSync('user', user)
      getApp<IAppOption>().globalData.user = user
      const nextForm = hydrateImageDisplay(normalizeForm(result.profile || payload, user))
      const completion = completionFor(nextForm)
      this.setData({
        user,
        form: nextForm,
        preview: previewFor(nextForm),
        ...selectorTextFor(nextForm),
        completionText: completion.text,
        completionNote: completion.note
      })
      wx.showToast({ title: toastTitle })
    } catch (err) {
      console.warn('save user profile failed', err)
    } finally {
      this.setData({ saving: false })
    }
  },

  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const payload = payloadFromForm(this.data.form)
      const result: any = await request('/user/profile', { method: 'PUT', data: payload })
      const user = {
        ...(currentUser() || {}),
        ...(result.user || {}),
        nickname: payload.realName || (result.user && result.user.nickname) || ((currentUser() || {}).nickname) || '',
        avatarUrl: payload.avatarUrl,
        gender: Number(payload.gender || 0)
      }
      wx.setStorageSync('user', user)
      getApp<IAppOption>().globalData.user = user
      const form = hydrateImageDisplay(normalizeForm(result.profile || payload, user))
      const completion = completionFor(form)
      this.setData({
        user,
        form,
        preview: previewFor(form),
        ...selectorTextFor(form),
        completionText: completion.text,
        completionNote: completion.note
      })
      wx.showToast({ title: '已保存' })
    } catch (err) {
      console.warn('save user profile failed', err)
    } finally {
      this.setData({ saving: false })
    }
  },

  goMatchmaker() {
    wx.redirectTo({ url: '/pages/matchmaker/dashboard' })
  },

  logout() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
    wx.redirectTo({ url: '/pages/index/index' })
  }
})
