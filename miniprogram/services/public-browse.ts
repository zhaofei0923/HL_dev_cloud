import { request } from './api'

export interface PublicSalonSummary {
  id: number | string
  title: string
  description?: string
  location?: string
  eventDate?: string
  price?: number
  status?: string
}

export interface PublicServicePlan {
  planCode: string
  name: string
  priceFen: number
  durationDays: number
  serviceTimes: number
  productType: string
}

export const publicBrowseApi = {
  salons() {
    return request<{ list: PublicSalonSummary[] }>('/public/salon/events', {
      auth: false, showError: false, preserveSessionOnUnauthorized: true,
      data: { page: 1, pageSize: 3, period: 'upcoming' }
    })
  },
  plans() {
    return request<{ plans: PublicServicePlan[] }>('/public/service-plans', {
      auth: false, showError: false, preserveSessionOnUnauthorized: true
    })
  }
}
