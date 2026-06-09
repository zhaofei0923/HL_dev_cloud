import { CLOUD_ENV_ID } from './config/cloud'

App<IAppOption>({
  globalData: {
    env: CLOUD_ENV_ID,
    token: wx.getStorageSync('token') || '',
    user: wx.getStorageSync('user') || null
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true
    })

    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)
  }
})
