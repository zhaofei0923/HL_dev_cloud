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
