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
  productType?: MembershipProductType
  serviceCount?: number
}

export type MembershipProductType = 'vip' | 'matchmaking' | 'matchmaker'
export type MembershipEntitlements = {
  chat: boolean
  exchangeWechat: boolean
  unlimitedSwipe: boolean
  advancedFilter: boolean
  onlineReminder: boolean
  exclusiveSupport: boolean
  memberBadge: boolean
  likedMe: boolean
  visitors: boolean
  invisibleVisit: boolean
  specialZones: boolean
}

export type VipMembership = { tier: 'vip'; expireAt: string | null; lifetime: boolean }
export type MatchmakingPackage = {
  id: string
  planTitle: string
  startAt?: string
  expireAt: string
  totalCount: number
  usedCount: number
  remainingCount: number
  status: 'active' | 'expired' | 'exhausted' | 'refunded'
}

export type MatchmakingReadiness = {
  ready: boolean
  profileComplete: boolean
  matchmakerConfirmed: boolean
  activeAssignment?: boolean
  matchmakerId: number | null
  reason: string
}

export type MatchmakingProgress = {
  status: 'not_purchased' | 'needs_profile' | 'awaiting_assignment' | 'awaiting_contact' | 'ready' | 'expired' | 'exhausted' | 'refunded'
  purchased: boolean
  profileComplete: boolean
  assigned: boolean
  matchmakerConfirmed: boolean
  matchmakerId: number | null
  matchmakerUserId: number | null
  matchmakerName: string
  requestedAt: string | null
  remainingCount: number
  earliestExpireAt: string | null
}

export type VipOverview = {
  membershipTier: 'free' | 'vip'
  isPremiumMember: boolean
  entitlements: Partial<MembershipEntitlements>
  vipMembership?: VipMembership | null
  expireAt?: string | null
  lifetime?: boolean
  invisible?: boolean
  privacy?: { invisible: boolean }
  onlineSubscriptions?: OnlineSubscription[]
  matchmakingPackages?: MatchmakingPackage[]
  matchmakingReadiness?: MatchmakingReadiness
  matchmakingProgress?: MatchmakingProgress
}

export type MemberVisitor = {
  id: string | number
  memberId?: string | number
  visitorUserId: number
  userId?: number
  displayName: string
  avatarUrl?: string
  visitedAt: string
}
export type MemberVisitorPage = { list: MemberVisitor[]; total: number; page?: number; pageSize?: number }
export type WechatExchange = {
  id: string
  requesterId: number
  recipientId: number
  targetUserId?: number
  otherUserId?: number
  displayName?: string
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'
  direction?: 'incoming' | 'outgoing'
  wechatId?: string
  otherWechatId?: string
  wechat?: { mine: string; peer: string }
  createdAt: string
  updatedAt?: string
}
export type OnlineSubscription = {
  id?: string
  targetUserId: number
  displayName?: string
  avatarUrl?: string
  active: boolean
  online?: boolean
  lastOnlineAt?: string
  lastNotifiedAt?: string
}
export type MatchmakingRequest = {
  id: string
  targetUserId: number
  memberUserId?: number
  displayName?: string
  matchmakerId?: number
  status: 'pending' | 'connected' | 'rejected' | 'cancelled'
  memberConsent: boolean
  targetConsent: boolean
  serviceConfirmed: boolean
  serviceConfirmedAt?: string
  note?: string
  createdAt: string
  canConfirm?: boolean
  selfConfirmed?: boolean
  otherConfirmed?: boolean
  updatedAt?: string
  connectedAt?: string
  conversationId?: number
}

export type MembershipPaymentConfig = {
  available: boolean
  testMode?: boolean
  reason: string
  provider?: 'virtual' | 'jsapi'
  functionName: string
  createPath: string
  queryPath?: string
}

export type VirtualPaymentParams = {
  mode: 'short_series_goods'
  signData: string
  paySig: string
  signature: string
}

export type VirtualPaymentCheckoutResult = {
  order: MembershipPaymentOrder
  paymentAttemptNo: string
  virtualPayment: VirtualPaymentParams
}

export type VirtualPaymentQueryResult = {
  order: MembershipPaymentOrder
  tradeState?: 'NOTPAY' | 'USERPAYING' | 'SUCCESS' | 'CLOSED' | 'PAYERROR'
  providerOrderAbsent?: true
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
  pendingOrder?: MembershipPaymentOrder | null
  pendingOrderPayment?: MembershipPaymentConfig | null
  membershipTier?: 'free' | 'vip'
  entitlements?: Partial<MembershipEntitlements>
  vipMembership?: VipMembership | null
  matchmakingPackages?: MatchmakingPackage[]
  matchmakingReadiness?: MatchmakingReadiness
  matchmakingProgress?: MatchmakingProgress
  matchmakingPayment?: MembershipPaymentConfig
}

export type MembershipPaymentOrder = {
  id: number
  outTradeNo: string
  userId: number
  planCode: string
  planTitle: string
  amountFen: number
  durationDays: number
  lifetime?: boolean
  status: 'pending' | 'confirming' | 'paid' | 'closed' | 'failed' | 'refunded'
  fulfillmentStatus?: '' | 'fulfilled' | 'requires_review'
  fulfillmentMessage?: string
  transactionId?: string
  paidAt?: string | null
  cancelledAt?: string | null
  createdAt: string
  updatedAt: string
  productType?: MembershipProductType
  serviceCount?: number
  paymentProvider?: 'virtual' | 'jsapi'
}

export type MembershipOrderCheckout = {
  order: MembershipPaymentOrder
  payment: MembershipPaymentConfig
  reused?: boolean
  recoveryRequired?: boolean
}

export type MemberOrder = {
  outTradeNo: string
  planCode: string
  planTitle: string
  amountFen: number
  durationDays: number
  lifetime?: boolean
  status: MembershipPaymentOrder['status']
  fulfillmentStatus: '' | 'fulfilled' | 'requires_review'
  fulfillmentMessage: string
  createdAt: string
  updatedAt: string
  paidAt: string | null
  productType: MembershipProductType
  serviceCount: number
  paymentProvider: 'virtual' | 'jsapi'
  transactionId?: string
  refundedAt?: string | null
  cancelledAt?: string | null
}

export type MemberOrderPage = {
  list: MemberOrder[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

export type MemberCertificationKind = 'identity' | 'education' | 'vehicle' | 'property' | 'assets'
export type MemberCertificationStatus = 'unsubmitted' | 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired'
export type EducationCertificationMethod = 'chsi_code' | 'diploma_photo' | 'study_proof' | 'cscse_number' | 'cscse_photo'
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
  likedMe(data?: Record<string, unknown>) {
    return request<LikedMeResult>('/member/liked-me', { data })
  },
  relationships(data?: Record<string, unknown>) {
    return request<RelationshipResult>('/member/relationships', { data })
  },
  membershipOverview() {
    return request<MembershipOverview>('/member/membership-plans')
  },
  orders(page = 1, pageSize = 20) {
    return request<MemberOrderPage>('/member/orders', {
      data: { page, pageSize }, showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
    })
  },
  orderDetail(outTradeNo: string) {
    return request<MemberOrder>(`/member/orders/${encodeURIComponent(outTradeNo)}`, {
      showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
    })
  },
  vipOverview() {
    return request<VipOverview>('/member/vip/overview', { showError: false })
  },
  privacy() {
    return request<{ invisible: boolean }>('/member/vip/privacy', { showError: false })
  },
  updatePrivacy(data: { invisible: boolean }) {
    return request<{ invisible: boolean }>('/member/vip/privacy', { method: 'POST', data })
  },
  visitors(data: { page?: number; pageSize?: number } = {}) {
    return request<MemberVisitorPage>('/member/vip/visitors', { data, showError: false })
  },
  recordVisit(targetUserId: number) {
    return request<{ recorded: boolean }>('/member/vip/visits', { method: 'POST', data: { targetUserId }, showError: false })
  },
  wechatExchanges() {
    return request<{ list: WechatExchange[] }>('/member/vip/wechat-exchanges', { showError: false })
  },
  requestWechatExchange(data: { targetUserId: number; wechatId: string }) {
    return request<WechatExchange>('/member/vip/wechat-exchanges', { method: 'POST', data })
  },
  respondWechatExchange(id: string, data: { accepted: boolean; wechatId?: string }) {
    return request<WechatExchange>(`/member/vip/wechat-exchanges/${encodeURIComponent(id)}/respond`, { method: 'POST', data })
  },
  wechatExchange(id: string) {
    return request<WechatExchange>(`/member/vip/wechat-exchanges/${encodeURIComponent(id)}`, { showError: false })
  },
  onlineSubscriptions() {
    return request<{ list: OnlineSubscription[] }>('/member/vip/online-subscriptions', { showError: false })
  },
  subscribeOnline(data: { targetUserId: number; active: boolean }) {
    return request<OnlineSubscription>('/member/vip/online-subscriptions', { method: 'POST', data })
  },
  updatePresence() {
    return request<{ online: boolean }>('/member/vip/presence', { method: 'POST', data: {}, showError: false })
  },
  matchmakingPackages() {
    return request<{ list: MatchmakingPackage[] }>('/member/matchmaking/packages', { showError: false })
  },
  matchmakingReadiness(memberUserId?: number) {
    return request<MatchmakingReadiness>('/member/matchmaking/readiness', { data: memberUserId ? { memberUserId } : {}, showError: false })
  },
  confirmMatchmakingReadiness(memberUserId: number, confirmed: boolean) {
    return request<MatchmakingReadiness>('/member/matchmaking/readiness', { method: 'POST', data: { memberUserId, confirmed } })
  },
  matchmakingRequests() {
    return request<{ list: MatchmakingRequest[] }>('/member/matchmaking/requests', { showError: false })
  },
  requestMatchmaking(data: { targetUserId: number; memberUserId?: number; note?: string }) {
    return request<MatchmakingRequest>('/member/matchmaking/requests', { method: 'POST', data })
  },
  respondMatchmaking(id: string, data: { accepted: boolean }) {
    return request<MatchmakingRequest>(`/member/matchmaking/requests/${encodeURIComponent(id)}/respond`, { method: 'POST', data })
  },
  approveMatchmaking(id: string) {
    return request<MatchmakingRequest>(`/member/matchmaking/requests/${encodeURIComponent(id)}/approve`, { method: 'POST', data: {} })
  },
  cancelMatchmaking(id: string) {
    return request<MatchmakingRequest>(`/member/matchmaking/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST', data: {} })
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
  cancelPaymentOrder(outTradeNo: string) {
    return request<MembershipPaymentOrder>(`/member/payment-orders/${encodeURIComponent(outTradeNo)}/cancel`, {
      method: 'POST', data: {}, showError: false, unauthorizedRedirect: '/pages/index/index?returnTo=orders'
    })
  },
  virtualPaymentCheckout(outTradeNo: string, loginCode: string) {
    return request<VirtualPaymentCheckoutResult>('/member/payment-virtual/checkout', {
      method: 'POST',
      data: { outTradeNo, loginCode }
    })
  },
  virtualPaymentQuery(outTradeNo: string) {
    return request<VirtualPaymentQueryResult>('/member/payment-virtual/query', {
      method: 'POST',
      data: { outTradeNo },
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
