import { CLOUD_ENV_ID, CLOUD_FUNCTION_NAME } from '../config/cloud'

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: Record<string, any>
  auth?: boolean
  token?: string
  showError?: boolean
  preserveSessionOnUnauthorized?: boolean
}

type ApiResponse<T> = {
  code: number
  message: string
  data: T
}

function isUnauthorized(code?: number) {
  return code === 401 || code === 40100 || code === 40102
}

function errorText(err: any) {
  if (!err) return ''
  return String(err.errMsg || err.message || err)
}

function cloudFailMessage(err: any) {
  const raw = errorText(err)
  if (/timeout/i.test(raw)) {
    return `云函数 ${CLOUD_FUNCTION_NAME} 调用超时，请确认已部署到 ${CLOUD_ENV_ID}`
  }
  if (/not found|function/i.test(raw)) {
    return `云函数 ${CLOUD_FUNCTION_NAME} 未部署，请先部署到 ${CLOUD_ENV_ID}`
  }
  return `无法连接云函数 ${CLOUD_FUNCTION_NAME}，请检查 ${CLOUD_ENV_ID}`
}

export function request<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method || 'GET'
  const app = getApp<IAppOption>()
  const env = app.globalData.env || CLOUD_ENV_ID
  const token = options.token !== undefined
    ? options.token
    : (options.auth === false ? '' : app.globalData.token || wx.getStorageSync('token'))

  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_FUNCTION_NAME,
      config: { env },
      slow: true,
      data: {
        path,
        method,
        data: options.data || {},
        token
      },
      success(res) {
        const body = res.result as ApiResponse<T> | undefined
        if (body && body.code === 0) {
          resolve(body.data)
          return
        }

        const code = body && body.code
        if (isUnauthorized(code) && !options.preserveSessionOnUnauthorized) {
          wx.removeStorageSync('token')
          wx.removeStorageSync('user')
          app.globalData.token = ''
          app.globalData.user = null
          wx.redirectTo({ url: '/pages/index/index' })
        }

        const message = body && body.message ? body.message : '请求失败'
        if (options.showError !== false) wx.showToast({ title: message, icon: 'none' })
        reject(new Error(message))
      },
      fail(err) {
        const message = cloudFailMessage(err)
        if (options.showError !== false) wx.showToast({ title: message, icon: 'none', duration: 3000 })
        reject(new Error(message))
      }
    })
  })
}

export function setSession(session: any) {
  const app = getApp<IAppOption>()
  app.globalData.token = session.token
  app.globalData.user = session.user
  wx.setStorageSync('token', session.token)
  wx.setStorageSync('user', session.user)
}

export function currentUser() {
  const app = getApp<IAppOption>()
  return app.globalData.user || wx.getStorageSync('user')
}
