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

export const memberApi = {
  list(data?: Record<string, any>) {
    return request('/member/list', { data })
  },
  resources(data?: Record<string, any>) {
    return request('/member/resources', { data })
  },
  showcase(data?: Record<string, any>) {
    return request('/member/showcase', { data })
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
  gifts() {
    return request('/member/gifts')
  },
  interact(data: Record<string, any>) {
    return request('/member/interactions', { method: 'POST', data })
  },
  sendGift(data: Record<string, any>) {
    return request('/member/gifts/send', { method: 'POST', data })
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
