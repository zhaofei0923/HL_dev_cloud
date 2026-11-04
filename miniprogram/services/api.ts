import { CLOUD_ENV_ID, CLOUD_FUNCTION_NAME } from '../config/cloud'

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: Record<string, any>
  auth?: boolean
  token?: string
  showError?: boolean
  preserveSessionOnUnauthorized?: boolean
  unauthorizedRedirect?: string
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

export function apiErrorMessage(err: any) {
  return errorText(err)
}

export function isSessionRecoverableError(err: any) {
  const code = Number(err && err.code)
  const raw = errorText(err)
  return isUnauthorized(code) || /invalid token|unauthorized|user not found/i.test(raw)
}

function cloudFailure(err: unknown) {
  const details = err && typeof err === 'object' ? err as Record<string, unknown> : {}
  const raw = errorText(err)
  // Keep only bounded SDK codes in the UI; raw messages can contain request
  // contents, credentials or infrastructure details and stay on the Error.
  const safeCode = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 && Math.abs(value) <= 999999999
    ? String(value) : typeof value === 'string' && /^(?:-?\d{1,9}|[A-Z][A-Z0-9_]{2,63})$/.test(value) && value !== '0' ? value : ''
  const semantic = raw.match(/\b(?:FUNCTIONS?_[A-Z_]+|EXCEED_[A-Z_]+|INVALID_ENV(?:_SOURCE|_STATUS)?|PERMISSION_DENIED|ACCESS_DENIED|SERVER_TIMEOUT)\b/)
  const numeric = raw.match(/\berrCode\s*[:=]\s*(-?\d{1,9})\b/i)
    || raw.match(/\b(?:cloud\.)?callFunction:fail\s+(-?\d{1,9})\b/i)
  const code = safeCode(details.errCode) || safeCode(details.code) || (numeric ? numeric[1] : '') || (semantic ? safeCode(semantic[0]) : '')
  const reason = `${safeCode(details.code)} ${safeCode(details.errCode)} ${raw}`
  let message = '请求未完成，请重试'
  if (/timeout|timed\s*out|TIME_LIMIT_EXCEEDED/i.test(reason)) {
    message = '请求超时，请稍后重试'
  } else if (/EXCEED_(?:MAX_PAYLOAD_SIZE|REQUEST_SIZE(?:_LIMIT)?|UPLOAD_MAXFILESIZE)|payload too large|request entity too large/i.test(reason)) {
    message = '提交内容过大，请缩小文件后重试'
  } else if (/FUNCTIONS?_NOT_FOUND|\bfunction\s+(?:[\w.-]{1,64}\s+)?(?:not found|does not exist)\b|云函数不存在/i.test(reason)) {
    message = '服务暂不可用，请稍后重试'
  } else if (/PERMISSION_DENIED|ACCESS_DENIED|EXCEED_AUTHORITY|permission denied|access denied/i.test(reason)) {
    message = '当前服务暂不可访问，请重新进入小程序后重试'
  } else if (/INVALID_ENV(?:_SOURCE|_STATUS)?\b/i.test(reason)) {
    message = '服务配置异常，请联系工作人员'
  } else if (/network|request:fail|SSL|TLS|socket|ECONN|ENOTFOUND|disconnected/i.test(reason)) {
    message = '网络连接失败，请切换网络后重试'
  }
  return { code, message: code ? `${message}（错误码 ${code}）` : message }
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
        const currentToken = app.globalData.token || wx.getStorageSync('token')
        const currentEnv = app.globalData.env || CLOUD_ENV_ID
        // A late response from a previous account must not clear the new session.
        if (isUnauthorized(code) && !options.preserveSessionOnUnauthorized
          && token === currentToken && env === currentEnv) {
          wx.removeStorageSync('token')
          wx.removeStorageSync('user')
          app.globalData.token = ''
          app.globalData.user = null
          wx.redirectTo({ url: options.unauthorizedRedirect || '/pages/index/index' })
        }

        const message = body && body.message ? body.message : '请求失败'
        if (options.showError !== false) wx.showToast({ title: message, icon: 'none' })
        const apiError = new Error(message) as any
        apiError.code = code
        apiError.response = body
        apiError.path = path
        reject(apiError)
      },
      fail(err) {
        const { code, message } = cloudFailure(err)
        if (options.showError !== false) wx.showToast({ title: message, icon: 'none', duration: 3000 })
        const apiError = new Error(message) as Error & { raw: unknown; path: string; transportCode: string }
        apiError.raw = err
        apiError.path = path
        apiError.transportCode = code
        reject(apiError)
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
