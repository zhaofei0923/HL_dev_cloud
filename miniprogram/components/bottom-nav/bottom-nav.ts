type NavRole = 'user' | 'matchmaker'

type NavItem = {
  key: string
  label: string
  path: string
  icon: string
}

const USER_TABS: NavItem[] = [
  { key: 'members', label: '推荐', path: '/pages/user/members', icon: 'members' },
  { key: 'salon', label: '活动', path: '/pages/user/salon', icon: 'salon' },
  { key: 'messages', label: '消息', path: '/pages/user/messages', icon: 'messages' },
  { key: 'mine', label: '我的', path: '/pages/user/profile', icon: 'mine' }
]

const MATCHMAKER_TABS: NavItem[] = [
  { key: 'dashboard', label: '工作台', path: '/pages/matchmaker/dashboard', icon: 'dashboard' },
  { key: 'members', label: '会员', path: '/pages/matchmaker/members', icon: 'members' },
  { key: 'messages', label: '消息', path: '/pages/matchmaker/messages', icon: 'messages' },
  { key: 'salon', label: '沙龙', path: '/pages/matchmaker/salon', icon: 'salon' },
  { key: 'mine', label: '我的', path: '/pages/matchmaker/mine', icon: 'mine' }
]

function tabsForRole(role: NavRole) {
  return role === 'matchmaker' ? MATCHMAKER_TABS : USER_TABS
}

Component({
  properties: {
    role: {
      type: String,
      value: 'user',
      observer() {
        this.updateTabs()
      }
    },
    active: {
      type: String,
      value: ''
    },
    embedded: {
      type: Boolean,
      value: false
    }
  },

  data: {
    tabs: USER_TABS,
    navigating: false
  },

  lifetimes: {
    attached() {
      this.updateTabs()
    }
  },

  methods: {
    updateTabs() {
      this.setData({
        tabs: tabsForRole(this.data.role as NavRole)
      })
    },

    switchTab(e: WechatMiniprogram.TouchEvent) {
      const key = String(e.currentTarget.dataset.key || '')
      const path = String(e.currentTarget.dataset.path || '')
      if (!key || !path || key === this.data.active || this.data.navigating) return
      if (!this.data.tabs.some(tab => tab.key === key && tab.path === path)) return

      if (this.data.role === 'matchmaker' && this.data.embedded) {
        this.triggerEvent('change', { key })
        return
      }

      this.setData({ navigating: true })
      const options = {
        url: path,
        fail: () => wx.showToast({ title: '页面暂未打开，请重试', icon: 'none' as const }),
        complete: () => this.setData({ navigating: false })
      }
      if (this.data.role === 'matchmaker') {
        wx.redirectTo(options)
      } else {
        wx.switchTab(options)
      }
    }
  }
})
