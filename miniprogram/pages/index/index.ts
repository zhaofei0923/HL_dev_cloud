import { loginByWechat } from '../../services/auth'
import { apiErrorMessage, currentUser, request } from '../../services/api'
import { chooseLocalImages, isImageChooseCancel, resolveImageUrls } from '../../utils/local-image'
import { pageSessionScope } from '../../utils/page-session'
import { publicBrowseApi } from '../../services/public-browse'
import type { PublicSalonSummary, PublicServicePlan } from '../../services/public-browse'

type ReturnTab = 'members' | 'salon' | 'messages' | 'profile'
type PublicSalonCard = PublicSalonSummary & { dateText: string; priceText: string }
type PublicPlanCard = PublicServicePlan & { priceText: string; termsText: string }

function returnTab(value: string | undefined): ReturnTab {
  return value === 'salon' || value === 'messages' || value === 'profile' ? value : 'members'
}

function publicContext() {
  const app = getApp<IAppOption>()
  return `${app.globalData.env || ''}|${pageSessionScope() || 'guest'}`
}

function publicDate(value: string | undefined) {
  const date = new Date(value || '')
  if (!Number.isFinite(date.getTime())) return '时间待定'
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

type MinimumRegistration = {
  completed: boolean
  missingFields?: string[]
  user: { id: number; nickname?: string; phone?: string; avatarUrl?: string }
  profile: { realName?: string; photos?: string[]; photoDisplayUrls?: string[] }
  phoneStatus: 'filled' | 'verified'
}

function eventIdFrom(value: string | undefined) {
  const raw = String(value || '').trim()
  const id = Number(raw)
  return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? String(id) : ''
}

function registrationName(value: string | undefined) {
  const name = String(value || '').trim()
  return /^(新用户|用户\d+)$/.test(name) ? '' : name
}

Page({
  _registrationScope: '',
  _registrationGeneration: 0,
  _registrationInitialized: false,
  _registrationUnloaded: false,
  _registrationPending: null as Promise<void> | null,
  _publicGeneration: 0,
  _publicVisible: false,
  _publicContext: '',
  _publicLoadedAt: 0,
  _publicPending: null as Promise<void> | null,

  data: {
    loading: false,
    registrationMode: false,
    loginIntent: false,
    returnTab: 'members' as ReturnTab,
    returnToOrders: false,
    publicLoading: false,
    publicError: '',
    publicSalons: [] as PublicSalonCard[],
    publicPlans: [] as PublicPlanCard[],
    eventId: '',
    loggedIn: false,
    checking: false,
    saving: false,
    photoUploading: false,
    phone: '',
    nickname: '',
    photoFileId: '',
    photoDisplayUrl: '',
    phoneStatus: 'filled',
    errorText: ''
  },

  onLoad(options: Record<string, string | undefined>) {
    const registrationMode = String(options.register || '') === '1'
    const eventId = eventIdFrom(options.eventId)
    this.setData({ registrationMode, eventId, returnToOrders: !registrationMode && options.returnTo === 'orders',
      loginIntent: options.login === '1' || options.returnTo === 'orders', returnTab: returnTab(options.returnTo),
      errorText: registrationMode && !eventId ? '活动链接不完整，请重新打开活动邀请。' : '' })
  },

  onShow() {
    this._registrationUnloaded = false
    this._publicVisible = true
    const scope = this.synchronizeRegistrationSession()
    if (this.data.registrationMode) {
      if (scope && this.data.eventId) return this.loadRegistration()
      return Promise.resolve()
    }
    if (scope) {
      this.continueAfterLogin()
      return Promise.resolve()
    }
    return this.data.loginIntent ? Promise.resolve() : this.loadPublicContent()
  },

  onHide() {
    this._publicVisible = false
    this._publicGeneration += 1
    this._publicPending = null
    this.setData({ publicLoading: false })
  },

  onUnload() {
    this._registrationUnloaded = true
    this._registrationGeneration += 1
    this._registrationPending = null
    this._publicVisible = false
    this._publicGeneration += 1
    this._publicPending = null
  },

  continueAfterLogin() {
    if (this.data.returnToOrders) wx.redirectTo({ url: '/pages/user/orders' })
    else wx.switchTab({ url: `/pages/user/${this.data.returnTab}` })
  },

  loadPublicContent(force = false): Promise<void> {
    if (this.data.registrationMode || this.data.loginIntent || pageSessionScope()) return Promise.resolve()
    const context = publicContext()
    if (context !== this._publicContext) {
      this._publicContext = context
      this._publicGeneration += 1
      this._publicLoadedAt = 0
      this._publicPending = null
      this.setData({ publicSalons: [], publicPlans: [], publicError: '' })
    }
    if (this._publicPending && !force) return this._publicPending
    if (!force && this._publicLoadedAt && Date.now() - this._publicLoadedAt < 30000) return Promise.resolve()
    const generation = ++this._publicGeneration
    this.setData({ publicLoading: true, publicError: '' })
    const isCurrent = () => this._publicVisible && !this._registrationUnloaded
      && this._publicGeneration === generation && publicContext() === context && !pageSessionScope()
    const promise = Promise.allSettled([publicBrowseApi.salons(), publicBrowseApi.plans()]).then(results => {
      if (!isCurrent()) return
      const [salons, plans] = results
      const update: { publicSalons?: PublicSalonCard[]; publicPlans?: PublicPlanCard[]; publicError: string } = { publicError: '' }
      const validSalons = salons.status === 'fulfilled' && Array.isArray(salons.value.list)
      const validPlans = plans.status === 'fulfilled' && Array.isArray(plans.value.plans)
      if (salons.status === 'fulfilled' && validSalons) update.publicSalons = salons.value.list.map(event => ({
        ...event, dateText: publicDate(event.eventDate),
        priceText: Number(event.price || 0) > 0 ? `¥${Number(event.price).toFixed(2)}` : '免费'
      }))
      if (plans.status === 'fulfilled' && validPlans) update.publicPlans = plans.value.plans.map(plan => ({
        ...plan, priceText: `¥${(plan.priceFen / 100).toFixed(2)}`,
        termsText: `${plan.durationDays}天${plan.serviceTimes > 0 ? ` · ${plan.serviceTimes}次牵线` : ' VIP权益'}`
      }))
      const failed = !validSalons || !validPlans
      update.publicError = failed ? '部分内容暂时无法更新，可继续浏览或重试。' : ''
      this._publicLoadedAt = failed ? 0 : Date.now()
      this.setData(update)
    }).finally(() => {
      if (isCurrent()) this.setData({ publicLoading: false })
      if (this._publicPending === promise) this._publicPending = null
    })
    this._publicPending = promise
    return promise
  },

  retryPublicContent() { return this.loadPublicContent(true) },

  browseActivities() { wx.switchTab({ url: '/pages/user/salon' }) },

  openPublicSalon(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (/^\d+$/.test(id)) wx.navigateTo({ url: `/pages/user/salon-detail?id=${encodeURIComponent(id)}` })
  },

  onPullDownRefresh() {
    const task = this.data.registrationMode ? this.retryRegistration() : this.loadPublicContent(true)
    return Promise.resolve(task).finally(() => wx.stopPullDownRefresh())
  },

  synchronizeRegistrationSession() {
    const scope = pageSessionScope()
    if (scope !== this._registrationScope) {
      this._registrationScope = scope
      this._registrationGeneration += 1
      this._registrationPending = null
      this._registrationInitialized = false
      this.setData({ loggedIn: !!scope, checking: false, saving: false, photoUploading: false,
        phone: '', nickname: '', photoFileId: '', photoDisplayUrl: '', phoneStatus: 'filled' })
    } else {
      this.setData({ loggedIn: !!scope })
    }
    return scope
  },

  isRegistrationCurrent(scope: string, generation: number) {
    return !this._registrationUnloaded && pageSessionScope() === scope
      && this._registrationGeneration === generation
  },

  loadRegistration(): Promise<void> {
    const scope = this.synchronizeRegistrationSession()
    if (!scope || !this.data.eventId) return Promise.resolve()
    if (this._registrationPending) return this._registrationPending
    if (this._registrationInitialized) return Promise.resolve()
    const generation = this._registrationGeneration
    this.setData({ checking: true, errorText: '' })
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await request<MinimumRegistration>('/user/minimum-registration', {
          showError: false,
          unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
        })
        if (!this.isRegistrationCurrent(scope, generation)) return
        if (result.completed) {
          this.returnToEvent()
          return
        }
        const photos = result.profile && Array.isArray(result.profile.photos) ? result.profile.photos : []
        const photoFileId = photos[0] || (result.user && result.user.avatarUrl) || ''
        const serverDisplayUrl = result.profile && Array.isArray(result.profile.photoDisplayUrls)
          ? result.profile.photoDisplayUrls[0] : ''
        const displayUrls = await resolveImageUrls(serverDisplayUrl ? [serverDisplayUrl] : photoFileId ? [photoFileId] : [])
        if (!this.isRegistrationCurrent(scope, generation)) return
        this.setData({ phone: (result.user && result.user.phone) || '',
          nickname: registrationName((result.profile && result.profile.realName) || (result.user && result.user.nickname)),
          photoFileId, photoDisplayUrl: displayUrls[0] || photoFileId,
          phoneStatus: result.phoneStatus === 'verified' ? 'verified' : 'filled' })
        this._registrationInitialized = true
      } catch (err) {
        if (!this.isRegistrationCurrent(scope, generation)) {
          if (!pageSessionScope()) this.synchronizeRegistrationSession()
          return
        }
        this.setData({ errorText: apiErrorMessage(err) || '报名资料暂时无法读取，请重试。' })
      } finally {
        if (this.isRegistrationCurrent(scope, generation)) this.setData({ checking: false })
        if (this._registrationPending === promise) this._registrationPending = null
      }
    })
    this._registrationPending = promise
    return promise
  },

  async login() {
    if (this.data.loading || (this.data.registrationMode && !this.data.eventId)) return
    this.setData({ loading: true, errorText: '' })
    try {
      await loginByWechat('user')
      if (this._registrationUnloaded) return
      if (this.data.registrationMode) {
        await this.loadRegistration()
        return
      }
      this.continueAfterLogin()
    } catch (err) {
      console.warn('login failed', err)
      if (!this._registrationUnloaded) this.setData({ errorText: apiErrorMessage(err) || '微信登录失败，请重试。' })
    } finally {
      if (!this._registrationUnloaded) this.setData({ loading: false })
    }
  },

  onRegistrationPhone(e: WechatMiniprogram.Input) {
    if (this.data.saving) return
    this.setData({ phone: e.detail.value, phoneStatus: 'filled' })
  },

  retryRegistration() {
    if (this.data.saving || this.data.photoUploading || this.data.checking) return Promise.resolve()
    this._registrationInitialized = false
    return this.loadRegistration()
  },

  onRegistrationName(e: WechatMiniprogram.Input) {
    if (this.data.saving) return
    this.setData({ nickname: e.detail.value })
  },

  async chooseRegistrationPhoto() {
    const scope = this.synchronizeRegistrationSession()
    if (!scope || this.data.photoUploading || this.data.saving || this.data.checking) return
    const generation = this._registrationGeneration
    this.setData({ photoUploading: true, errorText: '' })
    try {
      const images = await chooseLocalImages(1, { crop: true })
      if (!this.isRegistrationCurrent(scope, generation)) return
      const photo = images[0]
      if (photo) this.setData({ photoFileId: photo.fileID, photoDisplayUrl: photo.displayUrl })
    } catch (err) {
      if (this.isRegistrationCurrent(scope, generation) && !isImageChooseCancel(err)) {
        this.setData({ errorText: apiErrorMessage(err) || '照片上传失败，请重试。' })
      }
    } finally {
      if (this.isRegistrationCurrent(scope, generation)) this.setData({ photoUploading: false })
    }
  },

  async saveRegistration() {
    const scope = this.synchronizeRegistrationSession()
    if (!scope || !this.data.eventId || this.data.saving || this.data.photoUploading || this.data.checking) return
    const phone = String(this.data.phone || '').trim()
    const nickname = registrationName(this.data.nickname)
    const photo = this.data.photoFileId
    const errorText = !/^1\d{10}$/.test(phone) ? '请填写有效的 11 位手机号。'
      : !nickname || nickname.length > 40 ? '请填写 1 至 40 个字的称呼。'
        : !/^cloud:\/\/\S+\/(?:hl_uploads\/profile|hl_moderated\/images)\/\S+$/.test(photo) ? '请上传一张本人照片。' : ''
    if (errorText) {
      this.setData({ errorText })
      return
    }
    const generation = this._registrationGeneration
    this.setData({ saving: true, errorText: '' })
    try {
      const result = await request<MinimumRegistration>('/user/minimum-registration', {
        method: 'PUT', showError: false, data: { phone, nickname, photos: [photo] },
        unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
      })
      if (!this.isRegistrationCurrent(scope, generation)) return
      if (!result.completed) {
        this.setData({ errorText: '报名资料尚未完整，请核对手机号、称呼和照片。' })
        return
      }
      const user = { ...(currentUser() || {}), ...result.user }
      getApp<IAppOption>().globalData.user = user
      wx.setStorageSync('user', user)
      this.returnToEvent()
    } catch (err) {
      if (this.isRegistrationCurrent(scope, generation)) {
        this.setData({ errorText: apiErrorMessage(err) || '报名资料保存失败，请重试。' })
      } else if (!pageSessionScope()) {
        this.synchronizeRegistrationSession()
      }
    } finally {
      if (this.isRegistrationCurrent(scope, generation)) this.setData({ saving: false })
    }
  },

  returnToEvent() {
    if (this.data.eventId) wx.redirectTo({
      url: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}&registrationReady=1`
    })
  }
})
