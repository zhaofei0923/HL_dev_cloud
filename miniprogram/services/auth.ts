import { request, setSession } from './api'

export function loginByWechat(role: 'user' | 'matchmaker') {
  return new Promise<any>((resolve, reject) => {
    wx.login({
      success: async loginRes => {
        try {
          if (!loginRes.code) throw new Error('微信登录未返回有效 code')
          const session = await request('/auth/wx-login', {
            method: 'POST',
            auth: false,
            data: {
              code: loginRes.code,
              role,
              nickname: role === 'matchmaker' ? '主理人' : '新用户'
            }
          })
          setSession(session)
          resolve(session)
        } catch (err) {
          reject(err)
        }
      },
      fail: reject
    })
  })
}

export async function bindWechatPhone(code: string) {
  if (!code) throw new Error('手机号授权 code 不能为空')
  const user = await request<any>('/auth/wechat-phone', {
    method: 'POST',
    data: { code }
  })
  const app = getApp<IAppOption>()
  app.globalData.user = user
  wx.setStorageSync('user', user)
  return user
}
