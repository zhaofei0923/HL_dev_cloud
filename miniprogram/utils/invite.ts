export function normalizeInviteCode(value: any) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase()
}

function queryValue(raw: string, key: string) {
  const match = raw.match(new RegExp(`[?&#]${key}=([^&#]+)`, 'i'))
  return match ? decodeURIComponent(match[1] || '') : ''
}

export function extractInviteCode(input: any) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  const direct = normalizeInviteCode(raw)
  if (/^(HL[A-Z0-9]{4,}|MM\d+|MBR\d+|\d+)$/i.test(direct)) return direct

  const fromCode = queryValue(raw, 'code') || queryValue(raw, 'inviteCode') || queryValue(raw, 'matchmakerNo')
  if (fromCode) return normalizeInviteCode(fromCode)

  const scene = queryValue(raw, 'scene')
  if (scene && scene !== raw) {
    return extractInviteCode(scene)
  }

  const codeLike = raw.match(/\b(HL[A-Z0-9]{4,}|MM\d{2,}|MBR\d+)\b/i)
  return codeLike ? normalizeInviteCode(codeLike[1]) : ''
}

type InvitePathOptions = {
  eventId?: string | number
  autoRegister?: boolean
}

export function invitePath(code: string, source = 'share', options: InvitePathOptions = {}) {
  const query = [
    `code=${encodeURIComponent(normalizeInviteCode(code))}`,
    `source=${encodeURIComponent(source)}`
  ]
  if (options.eventId !== undefined && options.eventId !== '') {
    query.push(`eventId=${encodeURIComponent(String(options.eventId))}`)
  }
  if (options.autoRegister) {
    query.push('autoRegister=1')
  }
  return `/pages/user/matchmaker-invite?${query.join('&')}`
}
