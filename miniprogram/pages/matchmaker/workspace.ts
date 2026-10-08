import { dashboardController } from '../../controllers/matchmaker/dashboard'
import { membersController } from '../../controllers/matchmaker/members'
import { messagesController } from '../../controllers/matchmaker/messages'
import { salonController } from '../../controllers/matchmaker/salon'
import { mineController } from '../../controllers/matchmaker/mine'
import { matchmakerPageSessionScope, matchmakerPageSnapshotRevision } from '../../utils/matchmaker-page-cache'
import {
  MatchmakerControllerDefinition,
  MatchmakerControllerInstance,
  MatchmakerWorkspaceTab,
  MATCHMAKER_WORKSPACE_TABS,
  instantiateMatchmakerController,
  invokeMatchmakerController,
  isMatchmakerWorkspaceTab
} from '../../utils/matchmaker-workspace'

const controllers: Record<MatchmakerWorkspaceTab, MatchmakerControllerDefinition> = {
  dashboard: dashboardController,
  members: membersController,
  messages: messagesController,
  salon: salonController,
  mine: mineController
}

const titles: Record<MatchmakerWorkspaceTab, string> = {
  dashboard: '工作台', members: '会员管理', messages: '消息', salon: '活动管理', mine: '主理人中心'
}

type EventHost = {
  dispatchControllerEvent(tab: MatchmakerWorkspaceTab, method: string, event: WechatMiniprogram.BaseEvent): unknown
}

function eventHandlers() {
  const handlers: Record<string, (this: EventHost, event: WechatMiniprogram.BaseEvent) => unknown> = {}
  MATCHMAKER_WORKSPACE_TABS.forEach(tab => {
    Object.keys(controllers[tab]).forEach(method => {
      if (typeof controllers[tab][method] !== 'function' || method.startsWith('onLoad') || method === 'onShow' || method === 'onHide' || method === 'onUnload') return
      handlers[`workspace_${tab}_${method}`] = function(event) {
        return this.dispatchControllerEvent(tab, method, event)
      }
    })
  })
  return handlers
}

Page({
  ...eventHandlers(),
  _controllers: {} as Partial<Record<MatchmakerWorkspaceTab, MatchmakerControllerInstance>>,
  _workspaceScope: '',
  _workspaceSession: '',
  _workspaceRevision: 0,
  _workspaceUnloaded: false,
  _disposing: false,
  _viewGeneration: 0,
  _scrollPositions: {} as Partial<Record<MatchmakerWorkspaceTab, number>>,

  data: {
    activeTab: 'dashboard' as MatchmakerWorkspaceTab,
    view: {} as Record<string, unknown>
  },

  onLoad(query: Record<string, string | undefined>) {
    const tab = isMatchmakerWorkspaceTab(query.tab) ? query.tab : 'dashboard'
    this.setData({ activeTab: tab })
    this.synchronizeControllers()
    if (this._workspaceScope) this.ensureController(tab)
  },

  onShow() {
    this._workspaceUnloaded = false
    if (!this.synchronizeControllers()) return
    return this.showController(this.data.activeTab)
  },

  onReady() {
    wx.setNavigationBarTitle({ title: titles[this.data.activeTab] })
  },

  onHide() {
    const controller = this._controllers[this.data.activeTab]
    if (controller) invokeMatchmakerController(controller, 'onHide')
  },

  onUnload() {
    this._workspaceUnloaded = true
    this.disposeControllers()
  },

  onPullDownRefresh() {
    if (!this.synchronizeControllers()) {
      wx.stopPullDownRefresh()
      return
    }
    const controller = this.ensureController(this.data.activeTab)
    return Promise.resolve(invokeMatchmakerController(controller, 'onPullDownRefresh')).then(() => undefined).finally(() => wx.stopPullDownRefresh())
  },

  onPageScroll(event: WechatMiniprogram.Page.IPageScrollOption) {
    this._scrollPositions[this.data.activeTab] = event.scrollTop
  },

  onReachBottom() {
    if (this._workspaceUnloaded || !this.synchronizeControllers()) return
    const controller = this.ensureController(this.data.activeTab)
    return Promise.resolve(invokeMatchmakerController(controller, 'onReachBottom')).then(() => undefined)
  },

  onShareAppMessage(options: WechatMiniprogram.Page.IShareAppMessageOption) {
    if (!this.synchronizeControllers()) return { title: 'HL 婚恋服务', path: '/pages/index/index' }
    const controller = this.ensureController(this.data.activeTab)
    return invokeMatchmakerController(controller, 'onShareAppMessage', [options]) as WechatMiniprogram.Page.ICustomShareContent | undefined
      || { title: 'HL 婚恋服务', path: '/pages/index/index' }
  },

  disposeControllers(keep?: MatchmakerWorkspaceTab) {
    this._disposing = true
    this._viewGeneration += 1
    const old = this._controllers
    this._controllers = keep && old[keep] ? { [keep]: old[keep] } : {}
    MATCHMAKER_WORKSPACE_TABS.forEach(tab => {
      const controller = old[tab]
      if (controller && tab !== keep) invokeMatchmakerController(controller, 'onUnload')
    })
    this._disposing = false
  },

  synchronizeControllers(source?: MatchmakerWorkspaceTab) {
    const session = matchmakerPageSessionScope()
    const revision = matchmakerPageSnapshotRevision()
    const scope = session ? JSON.stringify([session, revision]) : ''
    if (session !== this._workspaceSession) {
      this.disposeControllers()
      this._workspaceScope = scope
      this._workspaceSession = session
      this._workspaceRevision = revision
      this._scrollPositions = {}
      this.setData({ view: {} })
    } else if (revision !== this._workspaceRevision) {
      const keep = source === this.data.activeTab ? source : undefined
      this.disposeControllers(keep)
      this._workspaceScope = scope
      this._workspaceRevision = revision
      if (!keep) {
        this._scrollPositions = {}
        this.setData({ view: {} })
        // A denied background read clears the visible panel without starting
        // another automatic request. Its next user visit revalidates normally.
        if (session && !this._workspaceUnloaded) {
          const controller = this.ensureController(this.data.activeTab)
          this.setData({ view: controller.data })
        }
      }
    }
    if (scope) return scope
    if (!this._workspaceUnloaded) wx.redirectTo({ url: '/pages/index/index' })
    return ''
  },

  ensureController(tab: MatchmakerWorkspaceTab) {
    const existing = this._controllers[tab]
    if (existing) return existing
    const controller = instantiateMatchmakerController(controllers[tab], tab, (instance, safePatch, callback) => {
      if (this._disposing || this._workspaceUnloaded || this._controllers[tab] !== instance) return
      this.synchronizeControllers(tab)
      if (this._controllers[tab] !== instance) return
      const session = this._workspaceSession
      const revision = this._workspaceRevision
      const guardedCallback = callback ? () => {
        if (!this._disposing && !this._workspaceUnloaded && this._controllers[tab] === instance
          && matchmakerPageSessionScope() === session && matchmakerPageSnapshotRevision() === revision) callback()
      } : undefined
      if (this.data.activeTab === tab && Object.keys(safePatch).length) {
        const viewPatch = Object.fromEntries(Object.entries(safePatch).map(([path, value]) => [`view.${path}`, value]))
        this.setData(viewPatch, guardedCallback)
      } else if (guardedCallback) guardedCallback()
    })
    this._controllers[tab] = controller
    invokeMatchmakerController(controller, 'onLoad', [{}])
    return controller
  },

  showController(tab: MatchmakerWorkspaceTab): Promise<void> {
    if (this._workspaceUnloaded || !this.synchronizeControllers()) return Promise.resolve()
    const controller = this.ensureController(tab)
    this.setData({ view: controller.data })
    return Promise.resolve(invokeMatchmakerController(controller, 'onShow')).then(() => undefined)
  },

  activateTab(tab: unknown): Promise<void> {
    if (!isMatchmakerWorkspaceTab(tab) || this._workspaceUnloaded || !this.synchronizeControllers()) return Promise.resolve()
    if (tab === this.data.activeTab && this._controllers[tab]) return Promise.resolve()
    const previous = this._controllers[this.data.activeTab]
    if (previous) invokeMatchmakerController(previous, 'onHide')
    const controller = this.ensureController(tab)
    const generation = ++this._viewGeneration
    this.setData({ activeTab: tab, view: controller.data }, () => {
      if (generation === this._viewGeneration && typeof wx.pageScrollTo === 'function') {
        wx.pageScrollTo({ scrollTop: this._scrollPositions[tab] || 0, duration: 0 })
      }
    })
    wx.setNavigationBarTitle({ title: titles[tab] })
    return Promise.resolve(invokeMatchmakerController(controller, 'onShow')).then(() => undefined)
  },

  onTabChange(event: WechatMiniprogram.CustomEvent<{ key?: string }>) {
    return this.activateTab(event.detail.key)
  },

  dispatchControllerEvent(tab: MatchmakerWorkspaceTab, method: string, event: WechatMiniprogram.BaseEvent): unknown {
    if (tab !== this.data.activeTab || this._workspaceUnloaded) return undefined
    const session = this._workspaceSession
    const revision = this._workspaceRevision
    if (!this.synchronizeControllers() || session !== this._workspaceSession || revision !== this._workspaceRevision) return undefined
    const controller = this.ensureController(tab)
    if (tab === 'dashboard' && (method === 'goMembers' || method === 'goSalon')) {
      if (!invokeMatchmakerController(controller, 'ensureCertified')) return undefined
      return this.activateTab(method === 'goMembers' ? 'members' : 'salon')
    }
    if (tab === 'messages' && method === 'goMembers') return this.activateTab('members')
    if (typeof controllers[tab][method] !== 'function') return undefined
    return invokeMatchmakerController(controller, method, [event])
  }
})
