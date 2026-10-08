import { request } from './api'

export interface SalonRegistrationRequirements {
  complete: boolean
  missingFields: string[]
}

export interface SalonEvent {
  id: number | string
  title?: string
  description?: string
  location?: string
  eventDate?: string
  status?: string
  statusText?: string
  maxParticipants?: number
  currentParticipants?: number
  price?: number
  isRegistered?: boolean
  isOrganizer?: boolean
  registrationStatus?: string
  isFull?: boolean
  isExpired?: boolean
  canRegister?: boolean
  registrationBlockedReason?: string
  registrationRequirements?: SalonRegistrationRequirements
}

export interface SalonParticipant {
  id?: number | string
  userId: number
  displayName: string
  avatarUrl: string
  canViewProfile: boolean
  isSelf?: boolean
}

export interface SalonParticipantPage {
  list: SalonParticipant[]
  total: number
  page: number
  pageSize: number
  canViewProfiles?: boolean
  visibilityNote?: string
}

export interface SalonParticipantProfile {
  id: number | string
  userId: number
  realName?: string
  nickname?: string
  avatarUrl?: string
  gender?: number
  age?: number
  height?: number
  city?: string
  nativePlace?: string
  education?: string
  occupation?: string
  incomeRange?: string
  maritalStatus?: string
  houseStatus?: string
  carStatus?: string
  selfIntro?: string
  partnerRequirement?: string
  photos?: string[]
}

function activitySessionReturn(id: number | string) {
  return `/pages/index/index?register=1&eventId=${encodeURIComponent(String(id))}`
}

export const salonApi = {
  list(data?: Record<string, any>) {
    return request('/salon/events', { data })
  },
  detail(id: number | string) {
    return request<SalonEvent>(`/salon/events/${id}`, { unauthorizedRedirect: activitySessionReturn(id) })
  },
  shareCard(id: number | string, showError = false) {
    return request(`/salon/events/${id}/share-card`, { showError, unauthorizedRedirect: activitySessionReturn(id) })
  },
  register(id: number | string) {
    return request(`/salon/events/${id}/register`, { method: 'POST', data: { participantProfileVisible: true }, unauthorizedRedirect: activitySessionReturn(id) })
  },
  participants(id: number | string, page = 1) {
    return request<SalonParticipantPage>(`/salon/events/${id}/participants`, { data: { page, pageSize: 20 }, unauthorizedRedirect: activitySessionReturn(id) })
  },
  participantProfile(id: number | string, userId: number | string) {
    return request<SalonParticipantProfile>(`/salon/events/${id}/participants/${userId}`, { unauthorizedRedirect: activitySessionReturn(id) })
  },
  cancelRegistration(id: number | string) {
    return request(`/salon/events/${id}/register`, { method: 'DELETE', unauthorizedRedirect: activitySessionReturn(id) })
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
