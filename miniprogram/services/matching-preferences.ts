import { request } from './api'

export type MatchingPreferences = {
  ageMin: number | null
  ageMax: number | null
  heightMin: number | null
  occupations: string[]
  education: string
  city: string
  marriageTimeline: string
  hasChildren: string
  wantsChildren: string
  weightMin: number | null
  weightMax: number | null
  zodiac: string
  constellation: string
  smoking: string
  drinking: string
  pets: string
  maritalStatus: string
}

export const matchingPreferencesApi = {
  get() {
    return request<{ preferences: MatchingPreferences }>('/user/matching-preferences', { showError: false })
  },
  save(preferences: MatchingPreferences) {
    return request<{ preferences: MatchingPreferences }>('/user/matching-preferences', {
      method: 'PUT', data: { preferences }, showError: false
    })
  }
}
