export const SHOWCASE_CACHE_TTL_MS = 45 * 1000

export type ShowcaseQuery = {
  page: number
  pageSize: number
  keyword: string
  city: string
  gender: string
}

export type FavoriteQuota = {
  dateKey: string
  limit: number
  used: number
  remaining: number
}

export type PublicShowcaseMember = Record<string, unknown> & {
  id: number | string
  userId?: number
  viewerState?: { isFavorite: boolean; isHidden: boolean }
}

export type ShowcaseResult = {
  list: PublicShowcaseMember[]
  total: number
  page: number
  pageSize: number
  favoriteQuota: FavoriteQuota | null
}

export type ShowcaseSnapshot = {
  result: ShowcaseResult
  loadedAt: number
  selectedMemberId: string
  currentIndex: number
  revision: number
}

type PendingRead = {
  promise: Promise<ShowcaseSnapshot>
  consumers: Array<() => boolean>
}

const PUBLIC_FIELDS = [
  'id', 'userId', 'source', 'sortId', 'status', 'createdAt', 'updatedAt',
  'realName', 'nickname', 'gender', 'age', 'height', 'education', 'occupation',
  'incomeRange', 'city', 'province', 'nativePlace', 'maritalStatus', 'houseStatus',
  'carStatus', 'selfIntro', 'partnerRequirement', 'photos', 'avatarUrl', 'coverUrl',
  'isVerified', 'memberType', 'identityStatus', 'identityStatusText',
  'profileCompletion', 'displayStatus', 'lastRecommendStatus'
]

const snapshots = new Map<string, ShowcaseSnapshot>()
const pendingReads = new Map<string, PendingRead>()
let activeScope = ''
let revision = 0

export class ShowcaseRequestDiscarded extends Error {
  constructor() {
    super('Showcase request is no longer current')
    this.name = 'ShowcaseRequestDiscarded'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// A session identifier is retained in memory; credentials never enter a cache entry or key.
export function showcaseSessionScope(token: unknown, user: unknown, env: unknown) {
  if (typeof token !== 'string' || !token) return ''
  const account = record(user)
  const userId = String(account && (account.id || account.userId) || '')
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < token.length; index += 1) {
    first = Math.imul(first ^ token.charCodeAt(index), 16777619) >>> 0
    second = (Math.imul(second, 33) ^ token.charCodeAt(index)) >>> 0
  }
  return JSON.stringify([String(env || ''), userId, first, second, token.length])
}

export function showcaseQueryKey(query: ShowcaseQuery) {
  return JSON.stringify([query.page, query.pageSize, query.keyword, query.city, query.gender])
}

function synchronizeScope(scope: string) {
  if (activeScope === scope) return
  activeScope = scope
  revision += 1
  snapshots.clear()
  pendingReads.clear()
}

export function normalizeFavoriteQuota(value: unknown): FavoriteQuota | null {
  const row = record(value)
  if (!row) return null
  const limit = Number(row.limit)
  const used = Number(row.used)
  const remaining = Number(row.remaining)
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || !Number.isFinite(remaining)) return null
  return {
    dateKey: String(row.dateKey || ''),
    limit,
    used: Math.max(used, 0),
    remaining: Math.max(remaining, 0)
  }
}

function normalizePublicMember(value: unknown): PublicShowcaseMember | null {
  const source = record(value)
  if (!source || (typeof source.id !== 'string' && typeof source.id !== 'number')) return null
  const row: PublicShowcaseMember = { id: source.id }
  PUBLIC_FIELDS.forEach(field => {
    if (source[field] !== undefined) row[field] = source[field]
  })
  const state = record(source.viewerState)
  row.viewerState = {
    isFavorite: !!(state && state.isFavorite),
    isHidden: !!(state && state.isHidden)
  }
  return row
}

function normalizeResult(value: unknown, query: ShowcaseQuery): ShowcaseResult {
  const body = record(value)
  if (!body || !Array.isArray(body.list)) throw new Error('公开会员资料格式无效')
  const list = body.list
    .map(normalizePublicMember)
    .filter((row): row is PublicShowcaseMember => !!row && !row.viewerState?.isHidden)
  const total = Number(body.total)
  return {
    list,
    total: Number.isFinite(total) && total >= 0 ? total : list.length,
    page: query.page,
    pageSize: query.pageSize,
    favoriteQuota: normalizeFavoriteQuota(body.favoriteQuota)
  }
}

export function readShowcaseCache(scope: string, query: ShowcaseQuery) {
  synchronizeScope(scope)
  if (!scope) return null
  const snapshot = snapshots.get(showcaseQueryKey(query))
  if (!snapshot || Date.now() - snapshot.loadedAt >= SHOWCASE_CACHE_TTL_MS) return null
  return snapshot
}

export async function requestShowcase(
  scope: string,
  query: ShowcaseQuery,
  fetcher: () => Promise<unknown>,
  force = false,
  isCurrent: () => boolean = () => true
): Promise<ShowcaseSnapshot> {
  synchronizeScope(scope)
  if (!scope || !isCurrent()) throw new ShowcaseRequestDiscarded()
  if (!force) {
    const snapshot = readShowcaseCache(scope, query)
    if (snapshot) return snapshot
  }
  const key = showcaseQueryKey(query)
  if (force) pendingReads.delete(key)
  let pending = pendingReads.get(key)
  if (!pending) {
    const requestRevision = revision
    const consumers = [isCurrent]
    const previous = snapshots.get(key)
    const promise: Promise<ShowcaseSnapshot> = Promise.resolve().then(fetcher).then(value => {
      if (activeScope !== scope || requestRevision !== revision || pendingReads.get(key)?.promise !== promise
        || !consumers.some(current => current())) {
        throw new ShowcaseRequestDiscarded()
      }
      const snapshot: ShowcaseSnapshot = {
        result: normalizeResult(value, query),
        loadedAt: Date.now(),
        selectedMemberId: previous ? previous.selectedMemberId : '',
        currentIndex: previous ? previous.currentIndex : 0,
        revision: requestRevision
      }
      snapshots.set(key, snapshot)
      return snapshot
    })
    pending = { promise, consumers }
    pendingReads.set(key, pending)
    const currentPending = pending
    promise.then(
      () => { if (pendingReads.get(key) === currentPending) pendingReads.delete(key) },
      () => {
        if (pendingReads.get(key) === currentPending) {
          pendingReads.delete(key)
          snapshots.delete(key)
        }
      }
    )
  } else {
    pending.consumers.push(isCurrent)
  }
  const snapshot = await pending.promise
  if (!isCurrent()) throw new ShowcaseRequestDiscarded()
  return snapshot
}

export function rememberShowcaseSelection(scope: string, query: ShowcaseQuery, memberId: unknown, index: number) {
  if (!scope || activeScope !== scope) return
  const snapshot = snapshots.get(showcaseQueryKey(query))
  if (!snapshot) return
  snapshot.selectedMemberId = typeof memberId === 'string' || typeof memberId === 'number' ? String(memberId) : ''
  snapshot.currentIndex = index
}

export function mergeShowcasePage(scope: string, query: ShowcaseQuery, incoming: ShowcaseSnapshot) {
  if (!scope || activeScope !== scope || incoming.revision !== revision) return null
  const snapshot = snapshots.get(showcaseQueryKey(query))
  if (!snapshot || snapshot.revision !== revision) return null
  const seen = new Set(snapshot.result.list.map(row => String(row.id)))
  const appended = incoming.result.list.filter(row => {
    const id = String(row.id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  snapshot.result = {
    ...snapshot.result,
    list: [...snapshot.result.list, ...appended],
    page: Math.max(snapshot.result.page, incoming.result.page),
    total: incoming.result.total,
    favoriteQuota: incoming.result.favoriteQuota || snapshot.result.favoriteQuota
  }
  return snapshot
}

export function applyShowcaseInteraction(
  scope: string,
  query: ShowcaseQuery,
  targetUserId: number,
  action: 'favorite' | 'hide',
  favoriteQuota: FavoriteQuota | null = null,
  active = true
) {
  if (!scope || activeScope !== scope) return
  revision += 1
  pendingReads.clear()
  const key = showcaseQueryKey(query)
  const snapshot = snapshots.get(key)
  snapshots.clear()
  if (!snapshot) return
  snapshot.revision = revision
  const matchesTarget = (row: PublicShowcaseMember) => Number(row.userId) === targetUserId
  const removed = action === 'hide' ? snapshot.result.list.filter(matchesTarget).length : 0
  snapshot.result = {
    ...snapshot.result,
    list: action === 'hide'
      ? snapshot.result.list.filter(row => !matchesTarget(row))
      : snapshot.result.list.map(row => matchesTarget(row) ? {
        ...row,
        viewerState: { isFavorite: active, isHidden: false }
      } : row),
    total: Math.max(snapshot.result.total - removed, 0),
    favoriteQuota: favoriteQuota || snapshot.result.favoriteQuota
  }
  // Keep the original read timestamp: mutations do not extend public-profile freshness.
  snapshots.set(key, snapshot)
}
