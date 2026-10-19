import { request } from './api'

export type AdminEntry = {
  allowed: boolean
  ready: boolean
  mode?: 'native'
}

export async function readAdminEntry(): Promise<AdminEntry> {
  const response = await request<unknown>('/user/admin-entry', { showError: false })
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { allowed: false, ready: false }
  const entry = response as Record<string, unknown>
  if (entry.allowed !== true) return { allowed: false, ready: false }
  if (entry.ready !== true || entry.mode !== 'native') return { allowed: true, ready: false }
  return { allowed: true, ready: true, mode: 'native' }
}
