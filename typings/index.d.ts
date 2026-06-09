/// <reference path="./types/index.d.ts" />

interface IAppOption {
  globalData: {
    env: string
    token?: string
    user?: any
    userInfo?: WechatMiniprogram.UserInfo
  }
  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback
}
