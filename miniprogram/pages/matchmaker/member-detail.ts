import { memberApi } from '../../services/member'
import { chatApi } from '../../services/chat'
import { normalizeMemberProfile } from '../../utils/member-format'

type DetailRow = {
  label: string
  value: string
  sensitive?: boolean
}

type DetailSection = {
  title: string
  rows: DetailRow[]
}

const INCOME_SOURCE_LABELS: Record<string, string> = {
  salary: '工资',
  business: '企业经营',
  investment: '投资收益',
  other: '其他'
}

const EVIDENCE_LABELS: Record<string, string> = {
  salary_statement: '工资流水截图',
  business_proof: '企业经营证明',
  tax_record: '个税记录',
  other_asset_proof: '其他资产证明'
}

const ASSET_RANGE_LABELS: Record<string, string> = {
  under_500k: '50万以内',
  '500k_2m': '50–200万',
  '2m_5m': '200–500万',
  '5m_10m': '500万–1000万',
  over_10m: '千万以上'
}

const CUSTOMER_SOURCE_LABELS: Record<string, string> = {
  short_video: '短视频',
  xiaohongshu: '小红书',
  event_registration: '活动报名',
  friend_referral: '朋友转介绍',
  boss_or_other: 'BOSS / 其他渠道'
}

const PACKAGE_LABELS: Record<string, string> = {
  unpaid: '未付费',
  '9980_3m': '9980 三个月',
  other: '其他套餐'
}

function text(value: unknown, fallback = '未填写') {
  const result = String(value === null || value === undefined ? '' : value).trim()
  return result || fallback
}

function listText(values: unknown, labels: Record<string, string> = {}) {
  if (!Array.isArray(values) || !values.length) return '未填写'
  return values.map(value => labels[String(value)] || String(value)).join('、')
}

function incomeSourceText(career: any) {
  const values = Array.isArray(career.incomeSources) ? career.incomeSources : []
  const sources = values.map((value: unknown) => {
    const key = String(value)
    if (key !== 'other') return INCOME_SOURCE_LABELS[key] || key
    const detail = text(career.otherIncomeSource, '')
    return detail ? `其他：${detail}` : INCOME_SOURCE_LABELS.other
  })
  if (!sources.length) {
    const detail = text(career.otherIncomeSource, '')
    if (detail) sources.push(`其他：${detail}`)
  }
  return sources.join('、') || '未填写'
}

function archiveSections(archive: any): DetailSection[] {
  if (!archive) return []
  const basic = archive.basic || {}
  const career = archive.career || {}
  const assets = archive.assetVerification || {}
  const personal = archive.personalProfile || {}
  const partner = archive.partnerPreferences || {}
  const business = archive.businessRegistration || {}
  return [
    {
      title: '基础与联络',
      rows: [
        { label: '联系电话', value: text(basic.phone), sensitive: true },
        { label: '出生年月', value: text(basic.birthDate) },
        { label: '体重', value: basic.weightKg ? `${basic.weightKg}kg` : '未填写' },
        { label: '毕业院校', value: text(basic.graduateSchool) },
        { label: '有无子女', value: basic.hasChildren ? `有（${basic.childrenCount || 0}名）` : '无' }
      ]
    },
    {
      title: '职业与收入验资',
      rows: [
        { label: '公司名称', value: text(career.companyName) },
        { label: '职位', value: text(career.jobTitle) },
        { label: '税前年收入', value: career.annualIncomePreTax ? `${career.annualIncomePreTax}万元` : '未填写', sensitive: true },
        { label: '收入来源', value: incomeSourceText(career), sensitive: true },
        { label: '验资凭证', value: listText(career.verificationEvidenceTypes, EVIDENCE_LABELS), sensitive: true },
        { label: '凭证位置', value: text(career.verificationCredentialLocation), sensitive: true }
      ]
    },
    {
      title: '资产验资存档',
      rows: [
        { label: '房产', value: `${assets.propertyCount || 0}套 · ${text(assets.propertyCities, '无城市记录')}`, sensitive: true },
        { label: '房产凭证', value: listText(assets.propertyProofTypes, { property_certificate: '房产证照片', purchase_contract: '购房合同' }), sensitive: true },
        { label: '车辆', value: `${assets.vehicleCount || 0}辆 · ${text(assets.vehicleModels, '无车型记录')}`, sensitive: true },
        { label: '车辆凭证', value: listText(assets.vehicleProofTypes, { vehicle_license: '行驶证照片' }), sensitive: true },
        { label: '金融资产', value: ASSET_RANGE_LABELS[String(assets.financialAssetRange)] || '未填写', sensitive: true },
        { label: '家庭背景', value: text(assets.familyBackground, '未补充'), sensitive: true }
      ]
    },
    {
      title: '个人情况',
      rows: [
        { label: '性格', value: text(personal.personalitySummary, '未补充') },
        { label: '爱好', value: text(personal.hobbies, '未补充') },
        { label: '生活作息', value: text(personal.dailyRoutine, '未补充') },
        { label: '抽烟', value: personal.smokingStatus === 'yes' ? '是' : personal.smokingStatus === 'no' ? '否' : '未填写' },
        { label: '喝酒', value: ({ frequent: '经常', occasional: '偶尔', never: '从不' } as Record<string, string>)[String(personal.drinkingStatus)] || '未填写' }
      ]
    },
    {
      title: '择偶要求',
      rows: [
        { label: '年龄区间', value: partner.ageMin && partner.ageMax ? `${partner.ageMin}–${partner.ageMax}岁` : '未填写' },
        { label: '身高要求', value: text(partner.heightRequirement) },
        { label: '学历底线', value: text(partner.educationMinimum) },
        { label: '婚姻状态', value: listText(partner.maritalStatuses) },
        { label: '收入 / 资产预期', value: text(partner.incomeAssetExpectation) },
        { label: '地域要求', value: text(partner.regionRequirement) },
        { label: '不能接受点', value: text(partner.dealBreakers) },
        { label: '相处模式', value: text(partner.relationshipMode) }
      ]
    },
    {
      title: '业务登记',
      rows: [
        { label: '客户来源', value: business.customerSource === 'boss_or_other' ? text(business.otherCustomerSource, CUSTOMER_SOURCE_LABELS.boss_or_other) : (CUSTOMER_SOURCE_LABELS[String(business.customerSource)] || '未填写') },
        { label: '办理套餐', value: business.packageType === 'other' ? text(business.otherPackageName, PACKAGE_LABELS.other) : (PACKAGE_LABELS[String(business.packageType)] || '未填写') },
        { label: '负责人', value: text(business.responsibleMatchmaker) },
        { label: '服务周期', value: `${text(business.joinDate)} 至 ${text(business.expiryDate, '长期 / 未设置')}` },
        { label: '备注标签', value: [listText(business.tags, {}), text(business.otherTags, '')].filter(value => value && value !== '未填写').join('、') || '未填写' },
        { label: '重要风险备注', value: text(business.riskNotes, '未填写 / 未核验'), sensitive: true }
      ]
    }
  ]
}

Page({
  data: {
    id: '',
    scope: 'own',
    isOwn: true,
    member: null as any,
    privateSections: [] as DetailSection[],
    profilePrivateSections: [] as DetailSection[],
    matchingPrivateSections: [] as DetailSection[],
    servicePrivateSections: [] as DetailSection[],
    privateLifePhotos: [] as string[],
    complianceVerified: false,
    activeDetailTab: 'profile',
    loading: false,
    displaySaving: false,
    chatStarting: false,
    claimInviteLoading: false,
    claimInvite: null as any,
    claimPhone: '',
    claimPhoneFocus: false,
    claimPhoneSaving: false
  },

  onLoad(options: Record<string, string | undefined>) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    const scope = options.scope === 'resource' ? 'resource' : 'own'
    this.setData({
      id: String(options.id || ''),
      scope,
      isOwn: scope === 'own'
    })
  },

  onShow() {
    if (this.data.id) void this.load()
  },

  async load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    try {
      let row: any = null
      if (this.data.isOwn) {
        row = await memberApi.detail(this.data.id)
      } else {
        const cached = wx.getStorageSync('selectedMatchmakerMember')
        if (cached && String(cached.id) === this.data.id) {
          row = cached
        } else {
          const result: any = await memberApi.resources({ page: 1, pageSize: 100 })
          row = (result.list || []).find((item: any) => String(item.id) === this.data.id)
        }
      }
      const archive = row && row.privateArchive
      const privateSections = archiveSections(archive)
      const privateLifePhotos = archive && archive.personalProfile
        ? (Array.isArray(archive.personalProfile.lifePhotos) ? archive.personalProfile.lifePhotos : [])
          .filter((photo: unknown): photo is string => typeof photo === 'string' && !!photo.trim())
        : []
      const compliance = archive && archive.compliance
      this.setData({
        member: row ? normalizeMemberProfile(row, this.data.isOwn) : null,
        privateSections,
        profilePrivateSections: privateSections.filter(section => ['基础与联络', '职业与收入验资', '资产验资存档', '个人情况'].includes(section.title)),
        matchingPrivateSections: privateSections.filter(section => section.title === '择偶要求'),
        servicePrivateSections: privateSections.filter(section => section.title === '业务登记'),
        privateLifePhotos,
        complianceVerified: !!(compliance && compliance.partialVerificationConfirmed && compliance.voluntarySubmissionConfirmed),
        claimInvite: row && row.identityStatus === 'pending' ? this.data.claimInvite : null,
        claimPhone: row && row.phone ? String(row.phone) : this.data.claimPhone
      })
    } catch (err) {
      console.warn('load matchmaker member detail failed', err)
      this.setData({ member: null })
    } finally {
      this.setData({ loading: false })
    }
  },

  goBack() {
    wx.navigateBack()
  },

  setDetailTab(e: WechatMiniprogram.TouchEvent) {
    const tab = String(e.currentTarget.dataset.tab || 'profile')
    if (!['profile', 'matching', 'service'].includes(tab)) return
    this.setData({ activeDetailTab: tab })
  },

  async onDisplayEnabledChange(e: any) {
    if (!this.data.isOwn || !this.data.member || this.data.displaySaving) return
    const displayEnabled = !!e.detail.value
    const previousMember = this.data.member
    const completionPercent = Number((previousMember.profileCompletion || {}).percent || 0)
    const nextMember = {
      ...previousMember,
      displayEnabled,
      displayStatusText: displayEnabled ? (completionPercent >= 70 ? '可展示' : '待完善') : '未展示'
    }
    this.setData({
      displaySaving: true,
      member: nextMember
    })
    try {
      const updated: any = await memberApi.update(this.data.id, { displayEnabled })
      const member = {
        ...normalizeMemberProfile(updated, true),
        privateArchive: previousMember.privateArchive
      }
      this.setData({ member })
      wx.showToast({ title: displayEnabled ? '已开启展示' : '已关闭展示', icon: 'none' })
    } catch (err) {
      console.warn('update member display failed', err)
      this.setData({ member: previousMember })
    } finally {
      this.setData({ displaySaving: false })
    }
  },

  async startChat() {
    const member = this.data.member
    if (member && member.identityStatus === 'pending') {
      wx.showToast({ title: '会员认领后才能在线联系', icon: 'none' })
      return
    }
    const targetUserId = member && member.userId ? String(member.userId) : ''
    const memberId = member && member.id && /^\d+$/.test(String(member.id)) ? String(member.id) : ''
    if (!targetUserId && !memberId) {
      wx.showToast({ title: '暂不能发起聊天', icon: 'none' })
      return
    }
    if (this.data.chatStarting) return
    this.setData({ chatStarting: true })
    try {
      const conversation = await chatApi.getOrCreateConversation(targetUserId
        ? { targetUserId }
        : { targetMemberId: memberId })
      wx.navigateTo({ url: `/pages/matchmaker/chat?id=${conversation.id}` })
    } catch (err) {
      console.warn('start matchmaker chat failed', err)
    } finally {
      this.setData({ chatStarting: false })
    }
  },

  async prepareClaimInvite() {
    if (!this.data.isOwn || !this.data.member || this.data.claimInviteLoading) return
    if (this.data.claimInvite) return
    await this.requestClaimInvite()
  },

  async requestClaimInvite() {
    if (!this.data.member.phone) {
      this.setData({ claimPhoneFocus: true })
      wx.showToast({ title: '请先补录会员手机号', icon: 'none' })
      return
    }
    this.setData({ claimInviteLoading: true })
    try {
      const claimInvite: any = await memberApi.createIdentityClaimInvite(this.data.id)
      if (claimInvite.status === 'claimed') {
        wx.showToast({ title: '该会员已绑定微信', icon: 'none' })
        await this.load()
        return
      }
      this.setData({ claimInvite })
      wx.showToast({ title: '认领邀请已生成' })
    } catch (err) {
      console.warn('create member identity claim invite failed', err)
    } finally {
      this.setData({ claimInviteLoading: false })
    }
  },

  regenerateClaimInvite() {
    if (!this.data.member || this.data.claimInviteLoading) return
    wx.showModal({
      title: '重新生成邀请？',
      content: '重新生成后，之前发送的认领链接会立即失效。',
      confirmText: '重新生成',
      confirmColor: '#8f493f',
      success: res => {
        if (!res.confirm) return
        void this.requestClaimInvite()
      }
    })
  },

  onClaimPhoneInput(e: WechatMiniprogram.Input) {
    this.setData({ claimPhone: e.detail.value })
  },

  onClaimPhoneBlur() {
    this.setData({ claimPhoneFocus: false })
  },

  async saveClaimPhoneAndPrepare() {
    if (this.data.claimPhoneSaving) return
    const phone = String(this.data.claimPhone || '').replace(/\s+/g, '')
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入有效手机号', icon: 'none' })
      return
    }
    this.setData({ claimPhoneSaving: true })
    try {
      await memberApi.update(this.data.id, { phone })
      await this.load()
      await this.prepareClaimInvite()
    } catch (err) {
      console.warn('save member claim phone failed', err)
    } finally {
      this.setData({ claimPhoneSaving: false })
    }
  },

  onShareAppMessage(options: any) {
    const isClaimShare = options
      && options.from === 'button'
      && options.target
      && options.target.dataset
      && options.target.dataset.claim === 'member'
    if (isClaimShare && this.data.claimInvite && this.data.claimInvite.sharePath) {
      return {
        title: '主理人邀请你认领 HL 会员档案',
        path: this.data.claimInvite.sharePath,
        imageUrl: '/assets/members/lifestyle-gallery.png'
      }
    }
    return {
      title: 'HL 会员服务',
      path: '/pages/user/members',
      imageUrl: '/assets/members/lifestyle-gallery.png'
    }
  }
})
