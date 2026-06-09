import { currentUser } from '../../services/api'
import { matchmakerApi } from '../../services/matchmaker'

function defaultDashboard() {
  return {
    matchmaker: {
      memberCount: 0,
      certificationStatus: 0,
      certificationRemark: '',
      level: 1
    },
    operations: {
      salonCount: 0,
      resourceCount: 0,
      registrationCount: 0,
      recentRecommendationCount: 0,
      todoCounts: {
        incompleteMembers: 0,
        pendingRecommendations: 0,
        upcomingSalons: 0,
        salonRegistrations: 0
      }
    },
    resourceCount: 0,
    recentRecommendationCount: 0,
    registrationCount: 0,
    todoCounts: {
      incompleteMembers: 0,
      pendingRecommendations: 0,
      upcomingSalons: 0,
      salonRegistrations: 0
    }
  }
}

function certificationView(matchmaker: any) {
  const status = Number((matchmaker && matchmaker.certificationStatus) || 0)
  const remark = (matchmaker && matchmaker.certificationRemark) || ''
  if (status === 2) {
    return {
      canOperate: true,
      statusText: '已认证',
      statusTagClass: 'gold',
      statusNote: '红娘权限已开通，可使用会员经营、资源池互推和沙龙发起。'
    }
  }
  if (status === 1) {
    return {
      canOperate: false,
      statusText: '已拒绝',
      statusTagClass: 'rose',
      statusNote: remark || '本次申请暂未通过，请完善资料后重新提交。'
    }
  }
  return {
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '红娘申请已提交，后台审批通过后将开放会员经营、资源池和沙龙发起权限。'
  }
}

Page({
  data: {
    user: null as any,
    dashboard: defaultDashboard() as any,
    loading: false,
    canOperate: false,
    statusText: '待审批',
    statusTagClass: '',
    statusNote: '申请已提交，后台审核通过后将开放会员经营、资源池和沙龙发起权限。'
  },

  async onShow() {
    await this.loadDashboard()
  },

  async loadDashboard() {
    this.setData({ loading: true })
    try {
      let dashboard: any
      try {
        dashboard = await matchmakerApi.dashboard(false)
      } catch (err) {
        await matchmakerApi.apply()
        dashboard = await matchmakerApi.dashboard()
      }
      const view = certificationView(dashboard.matchmaker)
      this.setData({
        user: currentUser() || {},
        dashboard,
        canOperate: view.canOperate,
        statusText: view.statusText,
        statusTagClass: view.statusTagClass,
        statusNote: view.statusNote
      })
    } catch (err) {
      console.warn('load matchmaker dashboard failed', err)
      this.setData({
        user: currentUser() || {},
        dashboard: defaultDashboard(),
        canOperate: false,
        statusText: '云服务未连接',
        statusTagClass: 'rose',
        statusNote: '请确认 hlApi 云函数已部署后重试。'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  ensureCertified() {
    if (this.data.canOperate) return true
    wx.showToast({ title: '红娘认证通过后可使用', icon: 'none' })
    return false
  },

  async applyAgain() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      await matchmakerApi.apply()
      wx.showToast({ title: '已重新提交' })
      await this.loadDashboard()
    } catch (err) {
      console.warn('apply matchmaker failed', err)
    } finally {
      this.setData({ loading: false })
    }
  },

  goMembers() {
    if (!this.ensureCertified()) return
    wx.navigateTo({ url: '/pages/matchmaker/members' })
  },

  goResources() {
    if (!this.ensureCertified()) return
    wx.navigateTo({ url: '/pages/matchmaker/resources' })
  },

  goSalon() {
    if (!this.ensureCertified()) return
    wx.navigateTo({ url: '/pages/matchmaker/salon' })
  },

  goUserProfile() {
    wx.redirectTo({ url: '/pages/user/profile' })
  },

  logout() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
    wx.redirectTo({ url: '/pages/index/index' })
  }
})
