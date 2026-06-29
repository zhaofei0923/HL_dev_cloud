import { memberApi } from '../../services/member'
import { chooseLocalImages, isImageChooseCancel, type ChosenImage } from '../../utils/local-image'
import { PHOTO_WALL_LIMIT, defaultAvatar, defaultPhotos, mergePhotoLists, normalizeMemberProfile, photosFromText } from '../../utils/member-format'
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

function payloadFromForm(form: Record<string, any>) {
  const photos = photosFromText(form.photoText)
  const payload: Record<string, any> = {
    ...form,
    avatarUrl: form.avatarUrl || defaultAvatar(form),
    photos: photos.length ? photos : defaultPhotos(form)
  }
  delete payload.photoText
  delete payload.avatarDisplayUrl
  delete payload.photoDisplayUrls
  return payload
}

function appendChosenPhotos(form: Record<string, any>, images: ChosenImage[]) {
  const existingPhotos = photosFromText(String(form.photoText || ''))
  const existingDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : []
  const displayUrlByPhoto = existingPhotos.reduce<Record<string, string>>((map, photo, index) => {
    map[photo] = String(existingDisplayUrls[index] || photo)
    return map
  }, {})

  images.forEach(image => {
    if (!displayUrlByPhoto[image.fileID]) displayUrlByPhoto[image.fileID] = image.displayUrl
  })

  const photos = mergePhotoLists(existingPhotos, images.map(item => item.fileID))
  return {
    photoText: photos.join('\n'),
    photoDisplayUrls: photos.map(photo => displayUrlByPhoto[photo] || photo)
  }
}

function previewFor(form: Record<string, any>) {
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

function selectorTextFor(form: Record<string, any>) {
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

const FORM_DEFAULTS: Record<string, any> = {
  realName: '',
  avatarUrl: '',
  avatarDisplayUrl: '',
  photoText: '',
  photoDisplayUrls: [],
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
  memberType: 'no_consumption',
  serviceLevel: 'A',
  selfIntro: '',
  partnerRequirement: '',
  remark: ''
}

Page({
  data: {
    saving: false,
    genderOptions: ['男', '女'],
    memberTypeOptions: ['待消费会员', '免费会员', '付费会员', 'VIP会员'],
    memberTypeValues: ['no_consumption', 'free', 'paid', 'vip'],
    serviceLevelOptions: ['S级', 'A级', 'B级', 'C级'],
    serviceLevelValues: ['S', 'A', 'B', 'C'],
    maritalOptions: ['未婚', '离异', '丧偶'],
    houseOptions: ['已购房', '计划购房', '与父母同住', '租住'],
    carOptions: ['有车', '无车', '计划购车'],
    ageOptions: AGE_OPTIONS,
    heightOptions: HEIGHT_OPTIONS,
    educationOptions: EDUCATION_OPTIONS,
    incomeOptions: INCOME_OPTIONS,
    occupationOptions: OCCUPATION_OPTIONS,
    memberTypeLabel: '待消费会员',
    ...selectorTextFor(FORM_DEFAULTS),
    form: { ...FORM_DEFAULTS },
    preview: previewFor({
      realName: '',
      gender: '2',
      photoText: ''
    })
  },

  updateForm(field: string, value: string) {
    const form = { ...this.data.form, [field]: value }
    this.setData({
      [`form.${field}`]: value,
      preview: previewFor(form),
      ...selectorTextFor(form)
    })
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field || '')
    if (!field) return
    this.updateForm(field, e.detail.value)
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

  onMemberTypeChange(e: any) {
    const index = Number(e.detail.value)
    const memberType = this.data.memberTypeValues[index]
    const form = { ...this.data.form, memberType }
    this.setData({
      'form.memberType': memberType,
      memberTypeLabel: this.data.memberTypeOptions[index],
      preview: previewFor(form),
      ...selectorTextFor(form)
    })
  },

  onServiceLevelChange(e: any) {
    const index = Number(e.detail.value)
    const serviceLevel = this.data.serviceLevelValues[index]
    const form = { ...this.data.form, serviceLevel }
    this.setData({
      'form.serviceLevel': serviceLevel,
      preview: previewFor(form),
      ...selectorTextFor(form)
    })
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

  async chooseAvatar() {
    try {
      wx.showLoading({ title: '上传中' })
      const images = await chooseLocalImages(1)
      const image = images[0]
      if (!image) return
      const form = {
        ...this.data.form,
        avatarUrl: image.fileID,
        avatarDisplayUrl: image.displayUrl
      }
      this.setData({
        form,
        preview: previewFor(form),
        ...selectorTextFor(form)
      })
    } catch (err) {
      if (!isImageChooseCancel(err)) {
        console.warn('upload avatar failed', err)
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
    }
  },

  async choosePhotos() {
    let added = false
    try {
      const existingPhotos = photosFromText(String(this.data.form.photoText || ''))
      const remaining = PHOTO_WALL_LIMIT - existingPhotos.length
      if (remaining <= 0) {
        wx.showToast({ title: '照片墙最多3张', icon: 'none' })
        return
      }

      wx.showLoading({ title: '上传中' })
      const images = await chooseLocalImages(remaining)
      if (!images.length) return
      const form = {
        ...this.data.form,
        ...appendChosenPhotos(this.data.form, images)
      }
      this.setData({
        form,
        preview: previewFor(form),
        ...selectorTextFor(form)
      })
      added = true
    } catch (err) {
      if (!isImageChooseCancel(err)) {
        console.warn('upload photos failed', err)
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      if (added) wx.showToast({ title: '已添加，请点保存资料', icon: 'none' })
    }
  },

  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const form = this.data.form as Record<string, any>
      await memberApi.addManual(payloadFromForm(form))
      wx.showToast({ title: '录入成功' })
      wx.navigateBack()
    } catch (err) {
      console.warn('save member failed', err)
    } finally {
      this.setData({ saving: false })
    }
  }
})
