import { request } from './api'

export const matchmakerApi = {
  apply() {
    return request('/matchmaker/apply', { method: 'POST' })
  },
  dashboard(showError = true) {
    return request('/matchmaker/dashboard', { showError })
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
