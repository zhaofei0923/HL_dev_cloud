import { request } from './api'

export type MemberLocationState = { enabled: boolean; updatedAt: string | null }
export const memberLocationApi = {
  read() { return request<MemberLocationState>('/user/location', { showError: false }) },
  save(data: { enabled: false } | { enabled: true; latitude: number; longitude: number }) {
    return request<MemberLocationState>('/user/location', { method: 'PUT', data, showError: false })
  }
}
