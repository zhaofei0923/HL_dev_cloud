import { request } from './api'

export type LikedMeItem = {
  id: number | string
  userId?: number
  displayName?: string
  realName?: string
  nickname?: string
  avatarUrl?: string
  coverUrl?: string
  photos?: string[]
  metaText?: string
  hint?: string
  tags?: string[]
  highlightTags?: string[]
  likedAt?: string
  locked?: boolean
  blurred?: boolean
  canViewDetail?: boolean
  coverTone?: number
}

export type LikedMeResult = {
  total: number
  page: number
  pageSize: number
  list: LikedMeItem[]
  isPremiumMember: boolean
  unlockRequired: boolean
  unlockText?: string
  previewCount?: number
}

export type RelationshipKind = 'incoming' | 'mutual'

export type HiddenMember = { targetUserId: number; displayName: string; available: boolean }

export type InviteMemberOption = {
  id: number | string
  userId: number
  realName: string
  nickname: string
}

export type InviteMemberOptionsResult = {
  list: InviteMemberOption[]
  total: number
  page: number
  pageSize: number
}

export type RelationshipItem = LikedMeItem & {
  relationshipType?: RelationshipKind
  relationshipAt?: string
  canRespond?: boolean
  canChat?: boolean
}

export type RelationshipCounts = {
  incoming: number
  mutual: number
}

export type RelationshipResult = {
  type: RelationshipKind
  counts: RelationshipCounts
  total: number
  page: number
  pageSize: number
  list: RelationshipItem[]
  isPremiumMember: boolean
  unlockRequired: boolean
  unlockText?: string
  previewCount?: number
}

export type MembershipPlan = {
  planCode: string
  title: string
  description: string
  badge: string
  amountFen: number
  priceText: string
  durationDays: number
  active: boolean
  sortOrder: number
}

export type MembershipPaymentConfig = {
  available: boolean
  reason: string
  functionName: string
  createPath: string
}

export type MembershipOverview = {
  isPremiumMember: boolean
  phoneBound: boolean
  phoneMasked: string
  needsMatchmaker: boolean
  membership: null | {
    memberType: string
    serviceLevel: string
    expireAt: string | null
    lifetime: boolean
  }
  plans: MembershipPlan[]
  payment: MembershipPaymentConfig
}

export type MembershipPaymentOrder = {
  id: number
  outTradeNo: string
  userId: number
  planCode: string
  planTitle: string
  amountFen: number
  durationDays: number
  status: 'pending' | 'confirming' | 'paid' | 'closed' | 'failed' | 'refunded'
  transactionId?: string
  paidAt?: string | null
  createdAt: string
  updatedAt: string
}

export type MembershipOrderCheckout = {
  order: MembershipPaymentOrder
  payment: MembershipPaymentConfig
}

export type MemberCertificationKind = 'identity' | 'education' | 'vehicle' | 'property' | 'assets'
export type MemberCertificationStatus = 'unsubmitted' | 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired'
export type EducationCertificationMethod = 'chsi_code' | 'diploma_photo' | 'study_proof' | 'cscse_number'
export type VerifiedEducationLevel = 'bachelors' | 'master' | 'doctor'
export type FinancialAssetRange = 'under_500k' | '500k_2m' | '2m_5m' | '5m_10m' | 'over_10m'
export type CertificationMaterialMime = 'image/jpeg' | 'image/png' | 'application/pdf'

export type CertificationMaterial = {
  id: string
  kind: MemberCertificationKind
  mimeType: CertificationMaterialMime
  size: number
  createdAt: string
  expiresAt?: string
  clientRequestId?: string
}

export type CertificationEntry = {
  kind: MemberCertificationKind
  status: MemberCertificationStatus
  verified: boolean
  verifiedEducation?: '本科' | '硕士' | '博士'
  verifiedFinancialAssetRange?: FinancialAssetRange
  source?: string
  submittedAt?: string
  reviewedAt?: string
  expiresAt?: string
  feedback?: string
  application?: {
    requestId?: string
    status: MemberCertificationStatus
    source?: 'chsi' | 'cscse'
    educationLevel?: VerifiedEducationLevel
    institutionName?: string
    method?: EducationCertificationMethod
    materialIds?: string[]
    submittedAt?: string
  }
}

export type CertificationOverview = { entries: CertificationEntry[] }
export type CertificationApplicationInput = {
  kind: MemberCertificationKind
  consentConfirmed: true
  materialIds: string[]
  source?: 'chsi' | 'cscse'
  educationLevel?: VerifiedEducationLevel
  institutionName?: string
  method?: EducationCertificationMethod
  verificationCode?: string
  certificateNumber?: string
  declaredFinancialAssetRange?: FinancialAssetRange
}

export const memberApi = {
  certifications(showError = false) {
    return request<CertificationOverview>('/user/certifications', { showError })
  },
  applyCertification(data: CertificationApplicationInput, showError = false) {
    return request<CertificationOverview>('/user/certification-requests', { method: 'POST', data, showError })
  },
  stagingCertificationMaterials(kind: MemberCertificationKind, showError = false) {
    return request<{ materials: CertificationMaterial[] }>('/user/certification-materials', { data: { kind }, showError })
  },
  uploadCertificationMaterial(data: { kind: MemberCertificationKind; mimeType: CertificationMaterialMime; contentBase64: string; clientRequestId: string }, showError = false) {
    return request<{ material: CertificationMaterial }>('/user/certification-materials', { method: 'POST', data, showError })
  },
  removeCertificationMaterial(id: string, showError = false) {
    return request<{ removed: boolean }>(`/user/certification-materials/${encodeURIComponent(id)}`, { method: 'DELETE', showError })
  },
  certificationMaterial(id: string, showError = false) {
    return request<{ material: CertificationMaterial; contentBase64: string }>(`/user/certification-materials/${encodeURIComponent(id)}`, { showError })
  },
  list(data?: Record<string, any>) {
    return request('/member/list', { data })
  },
  inviteOptions(data?: Record<string, unknown>) {
    return request<InviteMemberOptionsResult>('/member/invite-options', { data })
  },
  resources(data?: Record<string, any>) {
    return request('/member/resources', { data })
  },
  async showcase(data?: Record<string, unknown>) {
    const result = await request<Record<string, unknown>>('/member/showcase', { data })
    if (data && data.category && data.category !== 'recommend' && result.category !== data.category) {
      throw new Error('该分类暂不可用，请稍后重试')
    }
    return result
  },
  showcaseDetail(id: number | string) {
    return request<Record<string, unknown> & { id: number | string }>(`/member/showcase/${encodeURIComponent(String(id))}`, { showError: false })
  },
  hidden(page = 1) {
    return request<{ list: HiddenMember[]; total: number; page: number; pageSize: number }>('/member/hidden', {
      data: { page, pageSize: 20 }, showError: false
    })
  },
  likedMe(data?: Record<string, unknown>) {
    return request<LikedMeResult>('/member/liked-me', { data })
  },
  relationships(data?: Record<string, unknown>) {
    return request<RelationshipResult>('/member/relationships', { data })
  },
  membershipOverview() {
    return request<MembershipOverview>('/member/membership-plans')
  },
  createMembershipOrder(planCode: string) {
    return request<MembershipOrderCheckout>('/member/payment-orders', {
      method: 'POST',
      data: { planCode }
    })
  },
  membershipOrder(outTradeNo: string) {
    return request<MembershipPaymentOrder>(`/member/payment-orders/${outTradeNo}`, {
      showError: false
    })
  },
  gifts(showError = true) {
    return request('/member/gifts', { showError })
  },
  interact(data: Record<string, any>, showError = true) {
    return request('/member/interactions', { method: 'POST', data, showError })
  },
  sendGift(data: Record<string, any>, showError = true) {
    return request('/member/gifts/send', { method: 'POST', data, showError })
  },
  resolveMatchmakerInvite(data: Record<string, any>) {
    return request('/member/matchmaker-invite/resolve', { data })
  },
  requestMatchmaker(data: Record<string, any>) {
    return request('/member/matchmaker-requests', { method: 'POST', data })
  },
  acceptMatchmakerInvite(data: Record<string, any>) {
    return request('/member/matchmaker-invite/accept', { method: 'POST', data })
  },
  referralCard(showError = false) {
    return request('/member/referral-card', { showError })
  },
  addManual(data: Record<string, any>) {
    return request('/member/manual', { method: 'POST', data })
  },
  createIdentityClaimInvite(id: number | string) {
    return request(`/member/${id}/identity-claim-invite`, { method: 'POST' })
  },
  detail(id: number | string) {
    return request(`/member/${id}`)
  },
  update(id: number | string, data: Record<string, any>) {
    return request(`/member/${id}`, { method: 'PUT', data })
  },
  remove(id: number | string) {
    return request(`/member/${id}`, { method: 'DELETE' })
  },
  recommend(data: Record<string, any>) {
    return request('/member/recommend', { method: 'POST', data })
  }
}
