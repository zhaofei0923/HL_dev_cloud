import { currentUser, request } from '../../services/api'
import { memberApi } from '../../services/member'
import { matchmakerApi } from '../../services/matchmaker'
import { chooseLocalImages, isImageChooseCancel, resolveImageUrls, type ChosenImage } from '../../utils/local-image'
import { PHOTO_WALL_LIMIT, defaultPhotos, mergePhotoLists, normalizeMemberProfile, photosFromText } from '../../utils/member-format'
import { extractInviteCode, invitePath } from '../../utils/invite'
import { pageSessionScope } from '../../utils/page-session'
import { syncUserTabBar } from '../../utils/user-navigation'
import { certificationDefinition, certificationMenuRows, validCertificationOverview } from '../../utils/certification-form'
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
const PROFILE_TTL_MS = 30 * 1000

const FORM_DEFAULTS: ProfileForm = {
  realName: '',
  photoText: '',
  photoDisplayUrls: [],
  displayEnabled: false,
  assetCategoryConsent: false,
  assetRangeDisclosure: false,
  gender: '',
  age: '',
  height: '',
  city: '',
  nativePlace: '',
  education: '',
  occupation: '',
  incomeRange: '',
  maritalStatus: '',
  houseStatus: '',
  carStatus: '',
  selfIntro: '',
  partnerRequirement: ''
}

const COMPLETION_FIELDS = [
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

// Photos and disclosure preferences save immediately. Text fields remain a draft
// until the member explicitly saves, and must never leak into those PATCH-like PUTs.
const DRAFT_FIELDS = COMPLETION_FIELDS.filter(field => field !== 'photoText')

function draftPayload(form: ProfileForm) {
  return DRAFT_FIELDS.reduce<ProfileForm>((payload, field) => {
    payload[field] = form[field]
    return payload
  }, {})
}

function hasDraftChanges(form: ProfileForm, saved: ProfileForm) {
  return DRAFT_FIELDS.some(field => String(form[field] || '') !== String(saved[field] || ''))
}

function profileRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function userFromProfileResult(result: Record<string, unknown>, payload: ProfileForm) {
  const serverUser = { ...profileRecord(result.user || result) }
  delete serverUser.profile
  const user = { ...profileRecord(currentUser()), ...serverUser }
  if (payload.realName) user.nickname = payload.realName
  if (payload.gender !== undefined) user.gender = Number(payload.gender || 0)
  return user
}

function certificationSummaryFor(rows: ReturnType<typeof certificationMenuRows>) {
  const approved = rows.filter(row => row.verified).length
  const pending = rows.filter(row => row.state.includes('待审核')).length
  const followUp = rows.filter(row => row.state.includes('未通过') || row.state === '已撤销').length
  return [approved ? `${approved}项已认证` : '尚未完成认证', pending ? `${pending}项待审核` : '', followUp ? `${followUp}项需处理` : ''].filter(Boolean).join(' · ')
}

function photosToText(photos: string[] | undefined) {
  return Array.isArray(photos) ? photosFromText(photos.join('\n')).join('\n') : ''
}

function photoCountFor(form: ProfileForm) {
  return photosFromText(String(form.photoText || '')).length
}

function appendChosenPhotos(form: ProfileForm, images: ChosenImage[]) {
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

function removePhotoAt(form: ProfileForm, index: number) {
  const existingPhotos = photosFromText(String(form.photoText || ''))
  const existingDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : []
  const entries = existingPhotos
    .map((photo, photoIndex) => ({
      photo,
      displayUrl: String(existingDisplayUrls[photoIndex] || photo)
    }))
    .filter((_, photoIndex) => photoIndex !== index)

  return {
    photoText: entries.map(item => item.photo).join('\n'),
    photoDisplayUrls: entries.map(item => item.displayUrl)
  }
}

function normalizeForm(raw: ProfileForm, user: any) {
  const form: ProfileForm = {
    ...FORM_DEFAULTS,
    ...(raw || {})
  }
  form.realName = form.realName || (user && user.nickname) || ''
  form.displayEnabled = form.displayEnabled === true || form.displayEnabled === 1 || form.displayEnabled === '1' || form.displayEnabled === 'true'
  form.assetCategoryConsent = form.assetCategoryConsent === true
  form.assetRangeDisclosure = form.assetRangeDisclosure === true
  form.gender = String(form.gender || (user && user.gender) || '')
  form.photoText = form.photoText ? photosFromText(String(form.photoText)).join('\n') : photosToText(form.photos)
  form.photoDisplayUrls = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
    ? form.photoDisplayUrls.slice(0, PHOTO_WALL_LIMIT)
    : photosFromText(form.photoText)
  return form
}

function payloadFromForm(form: ProfileForm) {
  const photos = photosFromText(form.photoText)
  const payload: ProfileForm = {
    ...form,
    photos
  }
  delete payload.photoText
  delete payload.avatarUrl
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
    note: percent >= 85 ? '个人档案较完整，适合进入后续推荐。' : '补齐形象、生活状态和择偶期待后，主理人判断会更准确。'
  }
}

function previewFor(form: ProfileForm) {
  const payload = payloadFromForm(form)
  const photoDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls.slice(0, PHOTO_WALL_LIMIT) : []
  const displayPhotos = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
    ? photoDisplayUrls
    : (payload.photos.length ? payload.photos : defaultPhotos(form))
  const preview = normalizeMemberProfile({
    ...payload,
    photos: payload.photos
  })
  return {
    ...preview,
    avatarUrl: photoDisplayUrls[0] || preview.avatarUrl,
    photos: displayPhotos,
    coverUrl: photoDisplayUrls[0] || preview.coverUrl
  }
}

function hydrateImageDisplay(form: ProfileForm) {
  const payload = payloadFromForm(form)
  return {
    ...form,
    photoDisplayUrls: Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
      ? form.photoDisplayUrls.slice(0, PHOTO_WALL_LIMIT)
      : payload.photos.slice(0, PHOTO_WALL_LIMIT)
  }
}

function preserveImageDisplay(form: ProfileForm, source?: ProfileForm) {
  if (!source) return form

  const photos = photosFromText(String(form.photoText || ''))
  const sourcePhotos = photosFromText(String(source.photoText || ''))
  const sourceDisplayUrls = Array.isArray(source.photoDisplayUrls) ? source.photoDisplayUrls : []
  const currentDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : []
  const displayUrlByPhoto = sourcePhotos.reduce<Record<string, string>>((map, photo, index) => {
    map[photo] = String(sourceDisplayUrls[index] || photo)
    return map
  }, {})

  return {
    ...form,
    photoDisplayUrls: photos.map((photo, index) => displayUrlByPhoto[photo] || currentDisplayUrls[index] || photo)
  }
}

async function resolveFormDisplayUrls(form: ProfileForm) {
  const photoDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : []
  const resolved = await resolveImageUrls(photoDisplayUrls)
  return {
    ...form,
    photoDisplayUrls: resolved
  }
}

async function prepareProfileForm(raw: ProfileForm, user: ProfileForm, source?: ProfileForm): Promise<ProfileForm> {
  const form = preserveImageDisplay(hydrateImageDisplay(normalizeForm(raw, user)), source)
  return resolveFormDisplayUrls(form)
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
      matchmakerEntryTitle: '主理人端入口',
      matchmakerEntryNote: '主理人权限已开通，可进入主理人端使用会员经营、资源池和沙龙管理。',
      matchmakerEntryButton: '进入主理人端'
    }
  }
  if (status === 1) {
    return {
      matchmakerApproved: false,
      matchmakerEntryTitle: '主理人申请未通过',
      matchmakerEntryNote: remark || '本次申请暂未通过，可完善资料后重新提交申请。',
      matchmakerEntryButton: '重新申请 / 查看状态'
    }
  }
  if (status === 0) {
    return {
      matchmakerApproved: false,
      matchmakerEntryTitle: '主理人申请待审批',
      matchmakerEntryNote: '申请已提交，后台审批通过后将开放会员经营、资源池和沙龙管理。',
      matchmakerEntryButton: '查看申请状态'
    }
  }
  return {
    matchmakerApproved: false,
    matchmakerEntryTitle: '申请成为主理人',
    matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
    matchmakerEntryButton: '申请 / 查看状态'
  }
}

Page({
  _profileScope: '',
  _profileGeneration: 0,
  _profileLoadedAt: 0,
  _profileInitialized: false,
  _profileLoadPromise: null as Promise<void> | null,
  _formRevision: 0,
  _formDirty: false,
  _savedForm: { ...FORM_DEFAULTS } as ProfileForm,
  _leaveGuardActive: false,
  _profileVisible: false,
  _choosingPhotos: false,
  _refreshOnShow: false,
  _panelLoadedAt: 0,
  _panelLoadPromise: null as Promise<void> | null,
  _panelGeneration: -1,
  _certificationGeneration: 0,
  _certificationLoadPromise: null as Promise<void> | null,
  _certificationRefreshOnShow: false,

  data: {
    user: null as any,
    loading: false,
    profileReady: false,
    saving: false,
    uploadingPhotos: false,
    completionText: '0%',
    completionNote: '补齐形象、生活状态和择偶期待后，主理人判断会更准确。',
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
    matchmakerEntryTitle: '申请成为主理人',
    matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
    matchmakerEntryButton: '申请 / 查看状态',
    matchmakerCode: '',
    matchmakerRequesting: false,
    referralCard: { canShare: false } as any,
    referralLoading: false,
    editingProfile: false,
    formDirty: false,
    saveState: 'idle',
    saveStatus: '资料已同步',
    previewOpen: false,
    matchmakerPanelOpen: false,
    accountPanelOpen: false,
    ...selectorTextFor(FORM_DEFAULTS),
    form: { ...FORM_DEFAULTS },
    preview: previewFor(FORM_DEFAULTS),
    photoCount: 0,
    certificationRows: certificationMenuRows(),
    certificationSummary: '读取认证状态中',
    certificationsExpanded: false,
    certificationsLoading: false,
    certificationsError: ''
  },

  onShow() {
    if (!this.synchronizeSession()) return
    this._profileVisible = true
    this.syncLeaveGuard()
    wx.setNavigationBarTitle({ title: this.data.editingProfile ? '编辑资料' : '我的资料' })
    syncUserTabBar(this, 'mine')
    const force = this._refreshOnShow
    this._refreshOnShow = false
    const refreshCertifications = this._certificationRefreshOnShow
    this._certificationRefreshOnShow = false
    return Promise.all([this.loadProfile(force), this.loadCertifications(refreshCertifications)]).then(() => undefined)
  },

  synchronizeSession() {
    const scope = pageSessionScope()
    if (scope !== this._profileScope) {
      this._profileScope = scope
      this._profileGeneration += 1
      this._profileLoadPromise = null
      this._profileLoadedAt = 0
      this._profileInitialized = false
      this._formDirty = false
      this._choosingPhotos = false
      this.clearLeaveGuard()
      this._formRevision += 1
      this._panelLoadedAt = 0
      this._panelLoadPromise = null
      this._panelGeneration = -1
      this._certificationGeneration += 1
      this._certificationLoadPromise = null
      this._certificationRefreshOnShow = false
      const user = currentUser() || {}
      const form = hydrateImageDisplay(normalizeForm({}, user))
      this._savedForm = form
      const completion = completionFor(form)
      this.setData({
        user, form, preview: previewFor(form), photoCount: 0,
        ...selectorTextFor(form),
        ...matchmakerEntryView(null),
        completionText: completion.text,
        completionNote: completion.note,
        loading: false, profileReady: false, saving: false, uploadingPhotos: false, referralLoading: false,
        referralCard: { canShare: false }, matchmakerCode: '',
        editingProfile: false, previewOpen: false,
        formDirty: false, saveState: 'idle', saveStatus: '资料已同步',
        matchmakerPanelOpen: false, accountPanelOpen: false,
        certificationRows: certificationMenuRows(),
        certificationSummary: '读取认证状态中', certificationsExpanded: false,
        certificationsLoading: false, certificationsError: ''
      })
    }
    if (scope) return scope
    wx.redirectTo({ url: '/pages/index/index' })
    return ''
  },

  loadProfile(force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope) return Promise.resolve()
    if (this.data.saving) return Promise.resolve()
    if (!force && this._profileLoadPromise) return this._profileLoadPromise
    this._profileLoadPromise = null
    if (!force && this._profileInitialized && Date.now() - this._profileLoadedAt < PROFILE_TTL_MS) {
      return Promise.resolve()
    }
    const generation = ++this._profileGeneration
    const formRevision = this._formRevision
    const isCurrent = () => generation === this._profileGeneration && pageSessionScope() === scope
    this.setData({ loading: !this._profileInitialized })
    if (force) this._panelLoadedAt = 0
    if (this.data.matchmakerPanelOpen) void this.loadMatchmakerPanel(force)
    const promise = Promise.resolve().then(async () => {
      try {
        const result: any = await request('/user/profile')
        if (!isCurrent()) return
        const user = currentUser() || result
        const form = await prepareProfileForm(result.profile || {}, user)
        if (!isCurrent()) return
        // A tab return/background refresh must not overwrite unsaved edits.
        if (!this._formDirty && this._formRevision === formRevision && !this.data.saving) {
          this._savedForm = form
          const completion = completionFor(form)
          this.setData({
            user, form, preview: previewFor(form), photoCount: photoCountFor(form),
            ...selectorTextFor(form),
            completionText: completion.text, completionNote: completion.note,
            saveState: 'saved', saveStatus: '资料已同步'
          })
        } else {
          this.setData({ user })
        }
        this._profileLoadedAt = Date.now()
        this._profileInitialized = true
        this.setData({ profileReady: true })
      } catch (err) {
        if (!isCurrent()) return
        console.warn('load user profile failed', err)
        this._profileLoadedAt = 0
      } finally {
        if (isCurrent()) {
          this._profileLoadPromise = null
          this.setData({ loading: false })
        }
      }
    })
    this._profileLoadPromise = promise
    return promise
  },

  onPullDownRefresh() {
    return Promise.all([this.loadProfile(true), this.loadCertifications(true)]).then(() => undefined).finally(() => wx.stopPullDownRefresh())
  },

  onUnload() {
    this._profileVisible = false
    this.clearLeaveGuard()
    this._profileGeneration += 1
    this._profileLoadPromise = null
    this._panelLoadPromise = null
    this._certificationGeneration += 1
    this._certificationLoadPromise = null
  },

  onHide() {
    this._profileVisible = false
    // Tab pages keep their form in memory; the next shown page owns its guard.
    this.clearLeaveGuard()
  },

  syncLeaveGuard() {
    if (!this._profileVisible) return
    if (this._formDirty && !this._leaveGuardActive && typeof wx.enableAlertBeforeUnload === 'function') {
      wx.enableAlertBeforeUnload({ message: '资料修改尚未保存，离开后可能丢失。' })
      this._leaveGuardActive = true
    } else if (!this._formDirty) this.clearLeaveGuard()
  },

  clearLeaveGuard() {
    if (this._leaveGuardActive && typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload()
    this._leaveGuardActive = false
  },

  loadCertifications(force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope) return Promise.resolve()
    if (!force && this._certificationLoadPromise) return this._certificationLoadPromise
    const generation = ++this._certificationGeneration
    const isCurrent = () => generation === this._certificationGeneration && pageSessionScope() === scope
    this.setData({ certificationsLoading: true, certificationsError: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        const overview: unknown = await memberApi.certifications()
        if (!isCurrent()) return
        if (!validCertificationOverview(overview)) throw new Error('认证状态不完整')
        const certificationRows = certificationMenuRows(overview.entries)
        this.setData({ certificationRows, certificationSummary: certificationSummaryFor(certificationRows) })
      } catch (error) {
        if (!isCurrent()) return
        console.warn('load certifications failed', error)
        this.setData({ certificationsError: '认证状态读取失败，请重试' })
      } finally {
        if (isCurrent()) {
          this._certificationLoadPromise = null
          this.setData({ certificationsLoading: false })
        }
      }
    })
    this._certificationLoadPromise = promise
    return promise
  },

  retryCertifications() {
    return this.loadCertifications(true)
  },

  toggleCertifications() {
    this.setData({ certificationsExpanded: !this.data.certificationsExpanded })
  },

  openCertification(e: WechatMiniprogram.TouchEvent) {
    const kind = String(e.currentTarget.dataset.kind || '')
    if (!certificationDefinition(kind) || this.data.saving) return
    if (this._formDirty) {
      wx.showToast({ title: '请先保存资料，再申请认证', icon: 'none' })
      this.openProfileEditor()
      return
    }
    this._certificationRefreshOnShow = true
    wx.navigateTo({ url: `/pages/user/certification?kind=${kind}` })
  },

  loadMatchmakerPanel(force = false): Promise<void> {
    const scope = this.synchronizeSession()
    if (!scope || !this.data.matchmakerPanelOpen) return Promise.resolve()
    if (!force && this._panelLoadPromise && this._panelGeneration === this._profileGeneration) return this._panelLoadPromise
    if (!force && this._panelLoadedAt > 0 && Date.now() - this._panelLoadedAt < PROFILE_TTL_MS) return Promise.resolve()
    const generation = this._profileGeneration
    this._panelGeneration = generation
    const promise = Promise.all([
      this.refreshMatchmakerEntry(scope, generation),
      this.loadReferralCard(scope, generation)
    ]).then(results => {
      if (generation === this._profileGeneration && pageSessionScope() === scope) {
        this._panelLoadedAt = results.every(Boolean) ? Date.now() : 0
      }
    }).finally(() => {
      if (this._panelLoadPromise === promise) this._panelLoadPromise = null
    })
    this._panelLoadPromise = promise
    return promise
  },

  async refreshMatchmakerEntry(scope?: string, generation?: number) {
    const requestScope = scope === undefined ? this._profileScope : scope
    const requestGeneration = generation === undefined ? this._profileGeneration : generation
    const isCurrent = () => requestScope === pageSessionScope() && requestGeneration === this._profileGeneration
    try {
      const result = await matchmakerApi.status(false)
      if (!isCurrent()) return false
      this.setData(matchmakerEntryView(result.matchmaker))
      return true
    } catch (err) {
      if (!isCurrent()) return false
      this.setData(matchmakerEntryView(null))
      return false
    }
  },

  async loadReferralCard(scope?: string, generation?: number) {
    const requestScope = scope === undefined ? this._profileScope : scope
    const requestGeneration = generation === undefined ? this._profileGeneration : generation
    const isCurrent = () => requestScope === pageSessionScope() && requestGeneration === this._profileGeneration
    this.setData({ referralLoading: !this._profileInitialized })
    try {
      const referralCard = await memberApi.referralCard(false)
      if (!isCurrent()) return false
      this.setData({ referralCard })
      return true
    } catch (err) {
      if (!isCurrent()) return false
      console.warn('load member referral card failed', err)
      this.setData({ referralCard: { canShare: false } })
      return false
    } finally {
      if (isCurrent()) this.setData({ referralLoading: false })
    }
  },

  renderForm(form: ProfileForm, saveStatus?: string, saveState?: string) {
    this._formDirty = hasDraftChanges(form, this._savedForm)
    const completion = completionFor(form)
    this.setData({
      form,
      formDirty: this._formDirty,
      saveStatus: saveStatus || (this._formDirty ? '资料有修改，尚未保存' : '资料已保存'),
      saveState: saveState || (this._formDirty ? 'dirty' : 'saved'),
      preview: previewFor(form),
      photoCount: photoCountFor(form),
      ...selectorTextFor(form),
      completionText: completion.text,
      completionNote: completion.note
    })
    this.syncLeaveGuard()
  },

  setForm(form: ProfileForm) {
    this._formRevision += 1
    this.renderForm(form)
  },

  updateForm(field: string, value: string) {
    this.setForm({ ...this.data.form, [field]: value })
  },

  openProfileEditor() {
    wx.setNavigationBarTitle({ title: '编辑资料' })
    this.setData({ editingProfile: true, previewOpen: false }, () => {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    })
  },

  closeProfileEditor() {
    wx.setNavigationBarTitle({ title: '我的资料' })
    this.setData({ editingProfile: false }, () => wx.pageScrollTo({ scrollTop: 0, duration: 0 }))
  },

  toggleProfileEditor() {
    if (!this.data.editingProfile) return this.openProfileEditor()
    if (this.data.saving || this._choosingPhotos) return
    if (!this._formDirty) return this.closeProfileEditor()
    const scope = this._profileScope
    wx.showModal({
      title: '资料尚未保存',
      content: '返回后可继续本次编辑。关闭小程序或退出登录前，请先保存资料。',
      confirmText: '返回我的', cancelText: '继续编辑',
      success: result => {
        if (result.confirm && pageSessionScope() === scope) this.closeProfileEditor()
      }
    })
  },

  togglePreview() {
    this.setData({ previewOpen: !this.data.previewOpen })
  },

  toggleMatchmakerPanel() {
    this.setData({ matchmakerPanelOpen: !this.data.matchmakerPanelOpen })
    if (this.data.matchmakerPanelOpen) return this.loadMatchmakerPanel()
    return Promise.resolve()
  },

  toggleAccountPanel() {
    this.setData({ accountPanelOpen: !this.data.accountPanelOpen })
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = String(e.currentTarget.dataset.field || '')
    if (!field) return
    this.updateForm(field, e.detail.value)
  },

  async onDisplayEnabledChange(e: any) {
    const displayEnabled = e.detail.value === true
    await this.saveImmediatePatch({ displayEnabled }, { displayEnabled }, displayEnabled ? '已开启展示' : '已关闭展示')
  },

  async onAssetPreferenceChange(e: { currentTarget: { dataset: { field?: string } }; detail: { value: boolean } }) {
    const field = e.currentTarget.dataset.field
    if (field !== 'assetCategoryConsent' && field !== 'assetRangeDisclosure') return
    await this.saveImmediatePatch({ [field]: e.detail.value === true }, { [field]: e.detail.value === true }, '资产展示设置已保存')
  },

  onMatchmakerCodeInput(e: WechatMiniprogram.Input) {
    this.setData({ matchmakerCode: e.detail.value })
  },

  async submitMatchmakerRequest() {
    const code = String(this.data.matchmakerCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请输入主理人编号', icon: 'none' })
      return
    }
    this._refreshOnShow = true
    wx.navigateTo({ url: invitePath(code, 'inviteCode') })
  },

  scanMatchmakerInvite() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: res => {
        const code = extractInviteCode(res.result || res.path)
        if (!code) {
          wx.showToast({ title: '未识别到主理人邀请码', icon: 'none' })
          return
        }
        this._refreshOnShow = true
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
      content: '打开主理人或会员发来的微信分享卡片后，系统会自动注册为对应主理人名下免费会员；扫码和手动邀请码仍需提交申请。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  async choosePhotos() {
    if (this.data.saving || this.data.loading || this._choosingPhotos) return
    const scope = this._profileScope
    this._choosingPhotos = true
    this.setData({ uploadingPhotos: true })
    try {
      const existingPhotos = photosFromText(String(this.data.form.photoText || ''))
      const remaining = PHOTO_WALL_LIMIT - existingPhotos.length
      if (remaining <= 0) {
        wx.showToast({ title: '照片墙最多3张', icon: 'none' })
        return
      }

      const images = await chooseLocalImages(remaining, { crop: true })
      if (scope !== pageSessionScope()) return
      if (images.length) {
        const photoPatch = appendChosenPhotos(this.data.form, images)
        await this.saveImmediatePatch({ photos: photosFromText(photoPatch.photoText) }, photoPatch, '照片已保存')
      }
    } catch (err) {
      if (scope === pageSessionScope() && !isImageChooseCancel(err)) {
        console.warn('upload photos failed', err)
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' })
      }
    } finally {
      if (scope === pageSessionScope()) {
        this._choosingPhotos = false
        this.setData({ uploadingPhotos: false })
      }
    }
  },

  deletePhoto(e: WechatMiniprogram.TouchEvent) {
    if (this.data.saving || this.data.loading || this._choosingPhotos) return
    const index = Number(e.currentTarget.dataset.index)
    const photos = photosFromText(String(this.data.form.photoText || ''))
    if (!Number.isInteger(index) || index < 0 || index >= photos.length) return
    const photo = photos[index]
    const scope = this._profileScope
    wx.showModal({
      title: '删除照片',
      content: '确定从照片墙删除这张照片吗？',
      confirmText: '删除',
      confirmColor: '#8b332c',
      success: res => {
        if (!res.confirm || scope !== pageSessionScope()) return
        const currentIndex = photosFromText(String(this.data.form.photoText || '')).indexOf(photo)
        if (currentIndex < 0) return
        const photoPatch = removePhotoAt(this.data.form, currentIndex)
        void this.saveImmediatePatch({ photos: photosFromText(photoPatch.photoText) }, photoPatch, '照片已删除')
      }
    })
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

  async saveImmediatePatch(payload: ProfileForm, formPatch: ProfileForm, toastTitle: string) {
    if (this.data.saving || this.data.loading || !this._profileInitialized) return false
    const scope = pageSessionScope()
    if (!scope || scope !== this._profileScope) return false
    const previous = this.data.form
    const generation = ++this._profileGeneration
    const isCurrent = () => pageSessionScope() === scope && this._profileGeneration === generation
    this._profileLoadPromise = null
    this.setData({ saving: true, loading: false, referralLoading: false })
    this.renderForm({ ...previous, ...formPatch }, '正在保存…', 'saving')
    try {
      const result = await request<Record<string, unknown>>('/user/profile', { method: 'PUT', data: payload })
      if (!isCurrent()) return false
      const user = userFromProfileResult(result, payload)
      const savedForm = await prepareProfileForm({
        ...payloadFromForm(this._savedForm), ...payload, ...profileRecord(result.profile)
      }, user, { ...previous, ...formPatch })
      if (!isCurrent()) return false
      this._savedForm = savedForm
      // Update only the immediate fields; text typed before/during the request stays a draft.
      const applied = Object.keys(formPatch).reduce<ProfileForm>((patch, field) => {
        patch[field] = savedForm[field]
        return patch
      }, {})
      const next = { ...this.data.form, ...applied }
      wx.setStorageSync('user', user)
      getApp<IAppOption>().globalData.user = user
      this.setData({ user })
      this.renderForm(next, hasDraftChanges(next, savedForm) ? `${toastTitle}；资料修改尚未保存` : toastTitle)
      this._profileLoadedAt = Date.now()
      wx.showToast({ title: toastTitle })
      return true
    } catch (err) {
      if (!isCurrent()) return false
      console.warn('save profile preference or photos failed', err)
      const rollback = Object.keys(formPatch).reduce<ProfileForm>((patch, field) => {
        patch[field] = previous[field]
        return patch
      }, {})
      const message = Object.prototype.hasOwnProperty.call(payload, 'photos')
        ? '照片未保存，已恢复原照片，请重试' : '设置未保存，已恢复原设置，请重试'
      this.renderForm({ ...this.data.form, ...rollback }, message, 'error')
      wx.showToast({ title: Object.prototype.hasOwnProperty.call(payload, 'photos') ? '照片未保存，请重试' : '设置未保存，请重试', icon: 'none' })
      return false
    } finally {
      if (isCurrent()) this.setData({ saving: false })
    }
  },

  async save() {
    if (this.data.saving || this.data.loading || this._choosingPhotos) return false
    const scope = pageSessionScope()
    if (!scope || scope !== this._profileScope) return false
    const submitted = { ...this.data.form }
    const payload = draftPayload(submitted)
    const generation = ++this._profileGeneration
    const isCurrent = () => pageSessionScope() === scope && this._profileGeneration === generation
    this._profileLoadPromise = null
    this.setData({ saving: true, loading: false, referralLoading: false, saveStatus: '正在保存资料…', saveState: 'saving' })
    try {
      const result = await request<Record<string, unknown>>('/user/profile', { method: 'PUT', data: payload })
      if (!isCurrent()) return false
      const user = userFromProfileResult(result, payload)
      const savedForm = await prepareProfileForm({
        ...payloadFromForm(this._savedForm), ...payload, ...profileRecord(result.profile)
      }, user, this.data.form)
      if (!isCurrent()) return false
      const next = { ...savedForm }
      // A slow response must not erase text entered after the Save tap.
      DRAFT_FIELDS.forEach(field => {
        if (this.data.form[field] !== submitted[field]) next[field] = this.data.form[field]
      })
      this._savedForm = savedForm
      wx.setStorageSync('user', user)
      getApp<IAppOption>().globalData.user = user
      this.setData({ user })
      this.renderForm(next)
      this._profileLoadedAt = Date.now()
      this._profileInitialized = true
      wx.showToast({ title: this._formDirty ? '已保存，新修改待保存' : '资料已保存', icon: this._formDirty ? 'none' : 'success' })
      return true
    } catch (err) {
      if (!isCurrent()) return false
      console.warn('save user profile failed', err)
      this.setData({ saveState: 'error', saveStatus: '保存失败，修改仍保留，请重试' })
      return false
    } finally {
      if (isCurrent()) this.setData({ saving: false })
    }
  },

  goMatchmaker() {
    if (this._formDirty) {
      wx.showToast({ title: '请先保存资料，再进入主理人端', icon: 'none' })
      this.openProfileEditor()
      return
    }
    this._refreshOnShow = true
    wx.redirectTo({ url: '/pages/matchmaker/workspace' })
  },

  goMembership() {
    this._refreshOnShow = true
    wx.navigateTo({ url: '/pages/user/membership' })
  },

  logout() {
    if (this.data.saving || this._choosingPhotos) return
    if (this._formDirty) {
      const scope = this._profileScope
      wx.showModal({
        title: '资料尚未保存', content: '退出登录将丢失本次资料修改，是否仍要退出？',
        confirmText: '退出登录', cancelText: '继续编辑',
        success: result => {
          if (pageSessionScope() !== scope) return
          if (result.confirm) this.completeLogout()
          else this.openProfileEditor()
        }
      })
      return
    }
    this.completeLogout()
  },

  completeLogout() {
    this.clearLeaveGuard()
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
    const app = getApp<IAppOption>()
    app.globalData.token = ''
    app.globalData.user = null
    this.synchronizeSession()
  },

  onShareAppMessage() {
    const card = this.data.referralCard || {}
    return {
      title: '邀请你注册成为 HL 会员',
      path: card.sharePath || '/pages/user/members'
    }
  }
})
