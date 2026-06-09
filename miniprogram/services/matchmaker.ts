import { request } from './api'

export const matchmakerApi = {
  apply() {
    return request('/matchmaker/apply', { method: 'POST' })
  },
  dashboard(showError = true) {
    return request('/matchmaker/dashboard', { showError })
  },
  memberRequests(data?: Record<string, any>) {
    return request('/matchmaker/member-requests', { data })
  },
  approveMemberRequest(id: number | string) {
    return request(`/matchmaker/member-requests/${id}/approve`, { method: 'POST' })
  },
  rejectMemberRequest(id: number | string, remark = '') {
    return request(`/matchmaker/member-requests/${id}/reject`, { method: 'POST', data: { remark } })
  }
}
