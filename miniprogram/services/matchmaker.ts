import { request } from './api'
import type { MembershipOrderCheckout, MembershipPaymentConfig, MembershipPaymentOrder, MembershipPlan } from './member'

export type MatchmakerActivationSource = '' | 'manual' | 'paid'

export type MatchmakerAccount = {
  id: number | string
  userId?: number
  certificationStatus: number
  certificationRemark?: string
  status?: number
  activationSource?: MatchmakerActivationSource
  lifetime?: boolean
}

export type MatchmakerStatusResult = {
  matchmaker: MatchmakerAccount | null
}

export type MatchmakerActivationResult = {
  matchmaker: MatchmakerAccount | null
  active: boolean
  activationSource: MatchmakerActivationSource
  lifetime: boolean
  plan: MembershipPlan & { lifetime: boolean }
  payment: MembershipPaymentConfig
  pendingOrder?: MembershipPaymentOrder | null
  pendingOrderPayment?: MembershipPaymentConfig | null
  phoneBound: boolean
}

export const matchmakerApi = {
  activation(showError = false) {
    return request<MatchmakerActivationResult>('/matchmaker/activation', { showError })
  },
  createActivationOrder() {
    return request<MembershipOrderCheckout>('/matchmaker/activation/orders', { method: 'POST', data: {} })
  },
  apply() {
    return request('/matchmaker/apply', { method: 'POST' })
  },
  dashboard(showError = true) {
    return request('/matchmaker/dashboard', { showError })
  },
  status(showError = true) {
    return request<MatchmakerStatusResult>('/matchmaker/status', { showError })
  },
  inviteCard(showError = true) {
    return request('/matchmaker/invite-card', { showError })
  },
  resetInviteCode() {
    return request('/matchmaker/invite-code/reset', { method: 'POST' })
  },
  memberRequests(data?: Record<string, any>, showError = true) {
    return request('/matchmaker/member-requests', { data, showError })
  },
  approveMemberRequest(id: number | string) {
    return request(`/matchmaker/member-requests/${id}/approve`, { method: 'POST' })
  },
  rejectMemberRequest(id: number | string, remark = '') {
    return request(`/matchmaker/member-requests/${id}/reject`, { method: 'POST', data: { remark } })
  }
}
