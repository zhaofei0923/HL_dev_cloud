import { request, setSession } from './api'

export function loginByWechat(role: 'user' | 'matchmaker') {
  return new Promise<any>((resolve, reject) => {
    wx.login({
      success: async loginRes => {
        try {
          const session = await request('/auth/wx-login', {
            method: 'POST',
            auth: false,
            data: {
              code: loginRes.code || `${role}-${Date.now()}`,
              role,
              nickname: role === 'matchmaker' ? '红娘顾问' : '新用户'
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
