import { userTabKeyForRoute, type UserTabKey } from '../utils/user-navigation'

Component({
  data: {
    active: 'members' as UserTabKey
  },

  lifetimes: {
    attached() {
      this.syncActiveTab()
    }
  },

  pageLifetimes: {
    show() {
      this.syncActiveTab()
    }
  },

  methods: {
    syncActiveTab() {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1]
      const active = page ? userTabKeyForRoute(page.route) : null
      if (active && active !== this.data.active) this.setData({ active })
    }
  }
})
