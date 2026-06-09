import { request } from './api'

export const salonApi = {
  list(data?: Record<string, any>) {
    return request('/salon/events', { data })
  },
  detail(id: number | string) {
    return request(`/salon/events/${id}`)
  },
  register(id: number | string) {
    return request(`/salon/events/${id}/register`, { method: 'POST' })
  },
  cancelRegistration(id: number | string) {
    return request(`/salon/events/${id}/register`, { method: 'DELETE' })
  },
  myRegistrations(data?: Record<string, any>) {
    return request('/salon/my-registrations', { data })
  },
  myEvents(data?: Record<string, any>) {
    return request('/salon/my-events', { data })
  },
  create(data: Record<string, any>) {
    return request('/salon/events', { method: 'POST', data })
  },
  update(id: number | string, data: Record<string, any>) {
    return request(`/salon/events/${id}`, { method: 'PUT', data })
  },
  cancelEvent(id: number | string) {
    return request(`/salon/events/${id}/cancel`, { method: 'PUT' })
  },
  invite(id: number | string, userIds: number[], all = false) {
    return request(`/salon/events/${id}/invite`, { method: 'POST', data: { userIds, all } })
  }
}
