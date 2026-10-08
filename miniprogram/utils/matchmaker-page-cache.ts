import { currentUser } from '../services/api'
import { pageSessionScope } from './page-session'

export const MATCHMAKER_PAGE_TTL_MS = 30 * 1000

type PageSnapshot<T> = { data: T; loadedAt: number }
type PendingRead = {
  promise: Promise<PageSnapshot<unknown>>
  consumers: Array<() => boolean>
}

const snapshots = new Map<string, PageSnapshot<unknown>>()
const pendingReads = new Map<string, PendingRead>()
let activeScope = ''
let revision = 0

// Only renderable, session-scoped data belongs in these in-memory snapshots.
const sensitiveFields = new Set([
  'privatearchive', 'privatephotos', 'assetverification', 'personalprofile',
  'businessregistration', 'riskassessment', 'lifephotos', 'authversion',
  'idcard', 'idcardfront', 'idcardback', 'idcardnumber', 'identitynumber',
  'identitymaterials', 'verificationmaterials', 'verificationfiles',
  'educationcertificate', 'vehiclecertificate', 'propertycertificate',
  'assetcertificate', 'phone', 'mobile', 'remark'
])

function cloneForSnapshot<T>(value: T): T {
  const encoded = JSON.stringify(value, (key, item: unknown) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    if (sensitiveFields.has(normalized) || /token|credential|password|secret|openid|authorization|jwt/i.test(key)) return undefined
    return item
  })
  return JSON.parse(encoded) as T
}

export function sanitizeMatchmakerPageData<T>(value: T): T {
  return cloneForSnapshot(value)
}

export function matchmakerPageSessionScope() {
  const session = pageSessionScope()
  const user = currentUser() as { currentRole?: string; role?: string } | undefined
  const scope = session ? JSON.stringify([session, 'matchmaker', (user && (user.currentRole || user.role)) || '']) : ''
  if (scope !== activeScope) {
    activeScope = scope
    revision += 1
    snapshots.clear()
    pendingReads.clear()
  }
  return scope
}

export function readMatchmakerPageSnapshot<T>(route: string): PageSnapshot<T> | null {
  if (!matchmakerPageSessionScope()) return null
  const cached = snapshots.get(route)
  return cached ? cloneForSnapshot(cached) as PageSnapshot<T> : null
}

export function writeMatchmakerPageSnapshot<T>(route: string, data: T, loadedAt = Date.now()) {
  if (!matchmakerPageSessionScope() || !Number.isFinite(loadedAt)) return
  snapshots.set(route, cloneForSnapshot({ data, loadedAt }))
}

export function invalidateMatchmakerPageSnapshots() {
  matchmakerPageSessionScope()
  revision += 1
  snapshots.clear()
  pendingReads.clear()
}

export function matchmakerPageSnapshotRevision() {
  matchmakerPageSessionScope()
  return revision
}

export class MatchmakerPageRequestDiscarded extends Error {
  constructor() {
    super('matchmaker page request superseded')
    this.name = 'MatchmakerPageRequestDiscarded'
  }
}

// Dashboard and mine share one read. Force refresh supersedes only this route.
export function requestMatchmakerPageSnapshot<T>(
  route: string,
  fetcher: () => Promise<T>,
  force = false,
  isCurrent: () => boolean = () => true
): Promise<PageSnapshot<T>> {
  const scope = matchmakerPageSessionScope()
  if (!scope || !isCurrent()) return Promise.reject(new MatchmakerPageRequestDiscarded())
  const cached = snapshots.get(route)
  if (!force && cached && Date.now() - cached.loadedAt < MATCHMAKER_PAGE_TTL_MS) {
    return Promise.resolve(cloneForSnapshot(cached) as PageSnapshot<T>)
  }
  const existing = pendingReads.get(route)
  if (!force && existing) {
    existing.consumers.push(isCurrent)
    return existing.promise.then(snapshot => cloneForSnapshot(snapshot) as PageSnapshot<T>)
  }

  const startedRevision = revision
  const read: PendingRead = { promise: Promise.resolve({ data: undefined, loadedAt: 0 }), consumers: [isCurrent] }
  const promise = Promise.resolve().then(fetcher).then(data => {
    if (matchmakerPageSessionScope() !== scope || revision !== startedRevision
      || pendingReads.get(route) !== read || !read.consumers.some(consumer => consumer())) {
      throw new MatchmakerPageRequestDiscarded()
    }
    const snapshot = cloneForSnapshot({ data, loadedAt: Date.now() })
    snapshots.set(route, snapshot)
    return cloneForSnapshot(snapshot)
  }).catch((err: unknown) => {
    if (matchmakerPageSessionScope() === scope && revision === startedRevision && pendingReads.get(route) === read) {
      const previous = snapshots.get(route)
      if (previous) snapshots.set(route, { ...previous, loadedAt: Date.now() - MATCHMAKER_PAGE_TTL_MS })
    }
    throw err
  }).finally(() => {
    if (pendingReads.get(route) === read) pendingReads.delete(route)
  })
  read.promise = promise
  pendingReads.set(route, read)
  return promise
}
