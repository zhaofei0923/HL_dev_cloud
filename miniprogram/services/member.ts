import { request } from './api'

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
