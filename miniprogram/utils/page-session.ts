import { showcaseSessionScope } from './showcase-cache'

// Retained pages use a credential fingerprint, never credentials in cache keys.
export function pageSessionScope() {
  const app = getApp<IAppOption>()
  return showcaseSessionScope(
    app.globalData.token || wx.getStorageSync('token'),
    app.globalData.user || wx.getStorageSync('user'),
    app.globalData.env
  )
}
