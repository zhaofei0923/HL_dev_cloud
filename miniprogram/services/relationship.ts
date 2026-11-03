import { request } from './api'

export type RelationshipStatus = 'single' | 'coupled'
export interface CoupleInvitation {
  id: number
  peerId: number | null
  peerName: string
  direction: 'incoming' | 'outgoing'
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  createdAt: string
}
export interface RelationshipOverview {
  relationshipStatus: RelationshipStatus
  displayEnabled: boolean
  incomingInvitations: CoupleInvitation[]
  outgoingInvitations: CoupleInvitation[]
  candidates: Array<{ userId: number; displayName: string }>
}

export const relationshipApi = {
  overview() {
    return request<RelationshipOverview>('/member/relationship-status', { showError: false })
  },
  setStatus(status: RelationshipStatus) {
    return request('/member/relationship-status', { method: 'POST', data: { status }, showError: false })
  },
  invite(targetUserId: number) {
    return request('/member/relationship-invitations', { method: 'POST', data: { targetUserId }, showError: false })
  },
  respond(id: number, accept: boolean) {
    return request(`/member/relationship-invitations/${id}/respond`, { method: 'POST', data: { accept }, showError: false })
  },
  unmatch(targetUserId: number, reason: string) {
    return request('/member/unmatch', { method: 'POST', data: { targetUserId, reason }, showError: false })
  }
}
