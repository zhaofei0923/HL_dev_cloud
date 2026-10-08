import { sanitizeMatchmakerPageData } from './matchmaker-page-cache'

// Keep the same contextual `this` inference as the native Page constructor.
export function defineMatchmakerController<
  TData extends WechatMiniprogram.Page.DataOption,
  TCustom extends WechatMiniprogram.Page.CustomOption
>(definition: WechatMiniprogram.Page.Options<TData, TCustom> & { data: TData }) {
  return definition
}

export type MatchmakerWorkspaceTab = 'dashboard' | 'members' | 'messages' | 'salon' | 'mine'
export type MatchmakerControllerDefinition = Record<string, unknown> & { data: Record<string, unknown> }
export type MatchmakerControllerInstance = Record<string, unknown> & {
  data: Record<string, unknown>
  route: string
  is: string
  options: Record<string, string | undefined>
  setData(patch: Record<string, unknown>, callback?: () => void): void
}

export const MATCHMAKER_WORKSPACE_TABS: MatchmakerWorkspaceTab[] = ['dashboard', 'members', 'messages', 'salon', 'mine']

export function isMatchmakerWorkspaceTab(value: unknown): value is MatchmakerWorkspaceTab {
  return typeof value === 'string' && MATCHMAKER_WORKSPACE_TABS.some(tab => tab === value)
}

function cloneInitial<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

function applyDataPath(data: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let target: Record<string, unknown> | unknown[] = data
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    const record = target as Record<string, unknown>
    if (record[part] === null || typeof record[part] !== 'object') {
      record[part] = /^\d+$/.test(parts[index + 1]) ? [] : {}
    }
    target = record[part] as Record<string, unknown> | unknown[]
  }
  ;(target as Record<string, unknown>)[parts[parts.length - 1]] = value
}

function safeDataPaths(patch: Record<string, unknown>) {
  const safePatch = sanitizeMatchmakerPageData(patch)
  const result: Record<string, unknown> = {}
  Object.keys(safePatch).forEach(path => {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    if (!parts.length || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) return
    const allowed = sanitizeMatchmakerPageData(Object.fromEntries(parts.map(part => [part, true])))
    if (parts.every(part => Object.prototype.hasOwnProperty.call(allowed, part))) result[path] = safePatch[path]
  })
  return result
}

// Each retained panel owns its state and methods; only the host owns rendering.
export function instantiateMatchmakerController(
  definition: MatchmakerControllerDefinition,
  tab: MatchmakerWorkspaceTab,
  onDataChange: (instance: MatchmakerControllerInstance, safePatch: Record<string, unknown>, callback?: () => void) => void
): MatchmakerControllerInstance {
  const instance = {} as MatchmakerControllerInstance
  Object.keys(definition).forEach(key => {
    instance[key] = typeof definition[key] === 'function' ? definition[key] : cloneInitial(definition[key])
  })
  instance.route = `pages/matchmaker/${tab}`
  instance.is = instance.route
  instance.options = {}
  instance.data = sanitizeMatchmakerPageData(instance.data)
  instance.setData = (patch, callback) => {
    const safePatch = safeDataPaths(patch)
    Object.keys(safePatch).forEach(path => applyDataPath(instance.data, path, safePatch[path]))
    onDataChange(instance, safePatch, callback)
  }
  return instance
}

export function invokeMatchmakerController(instance: MatchmakerControllerInstance, method: string, args: unknown[] = []): unknown {
  const handler = instance[method]
  return typeof handler === 'function' ? handler.apply(instance, args) : undefined
}
