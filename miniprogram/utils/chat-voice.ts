import { ChatMessage } from '../services/chat'

export type VoiceRecordResult = {
  tempFilePath: string
  durationSeconds: number
  fileSize: number
  format: 'mp3'
}

type ActiveRecord = {
  cancelled: boolean
  stopped: boolean
  promise: Promise<VoiceRecordResult>
  resolve: (value: VoiceRecordResult) => void
  reject: (reason?: unknown) => void
}

const RECORD_OPTIONS: WechatMiniprogram.RecorderManagerStartOption = {
  duration: 60000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'mp3'
}

let recorderManager: WechatMiniprogram.RecorderManager | null = null
let recorderBound = false
let activeRecord: ActiveRecord | null = null

function errorText(err: unknown) {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const value = err as { errMsg?: unknown; message?: unknown }
    return String(value.errMsg || value.message || '')
  }
  return String(err)
}

function getSetting() {
  return new Promise<WechatMiniprogram.GetSettingSuccessCallbackResult>((resolve, reject) => {
    wx.getSetting({ success: resolve, fail: reject })
  })
}

function authorizeRecord() {
  return new Promise<void>((resolve, reject) => {
    wx.authorize({
      scope: 'scope.record',
      success: () => resolve(),
      fail: reject
    })
  })
}

export async function ensureRecordPermission() {
  const setting = await getSetting()
  const authorized = setting.authSetting['scope.record']
  if (authorized) return
  if (authorized === false) {
    wx.showToast({ title: '请在设置中允许麦克风权限', icon: 'none' })
    throw new Error('record permission denied')
  }
  await authorizeRecord()
}

function rejectActiveRecord(err: unknown) {
  if (!activeRecord) return
  const reject = activeRecord.reject
  activeRecord = null
  reject(err)
}

function bindRecorder(manager: WechatMiniprogram.RecorderManager) {
  if (recorderBound) return
  recorderBound = true
  manager.onStop(result => {
    if (!activeRecord) return
    const record = activeRecord
    record.stopped = true
    if (record.cancelled) {
      record.reject(new Error('record cancelled'))
      return
    }
    const durationSeconds = Math.ceil(Number(result.duration || 0) / 1000)
    if (!result.tempFilePath || durationSeconds < 1) {
      record.reject(new Error('record too short'))
      return
    }
    record.resolve({
      tempFilePath: result.tempFilePath,
      durationSeconds: Math.min(durationSeconds, 60),
      fileSize: Number(result.fileSize || 0),
      format: 'mp3'
    })
  })
  manager.onError(err => {
    rejectActiveRecord(new Error(errorText(err) || 'record failed'))
  })
  manager.onInterruptionBegin(() => {
    rejectActiveRecord(new Error('record interrupted'))
  })
}

function recorder() {
  if (!recorderManager) {
    recorderManager = wx.getRecorderManager()
    bindRecorder(recorderManager)
  }
  return recorderManager
}

export async function startChatVoiceRecording() {
  if (activeRecord) throw new Error('recording')
  await ensureRecordPermission()
  const manager = recorder()
  let resolveRecord: (value: VoiceRecordResult) => void = () => undefined
  let rejectRecord: (reason?: unknown) => void = () => undefined
  const promise = new Promise<VoiceRecordResult>((resolve, reject) => {
    resolveRecord = resolve
    rejectRecord = reject
  })
  activeRecord = {
    cancelled: false,
    stopped: false,
    promise,
    resolve: resolveRecord,
    reject: rejectRecord
  }
  try {
    manager.start(RECORD_OPTIONS)
  } catch (err) {
    rejectActiveRecord(err)
    throw err
  }
}

export function stopChatVoiceRecording() {
  const record = activeRecord
  if (!record) return Promise.reject(new Error('not recording'))
  if (!record.stopped) recorder().stop()
  return record.promise.finally(() => {
    if (activeRecord === record) activeRecord = null
  })
}

export function cancelChatVoiceRecording() {
  const record = activeRecord
  if (!record) return
  record.cancelled = true
  record.promise.catch(() => undefined)
  record.reject(new Error('record cancelled'))
  if (!record.stopped) recorder().stop()
  activeRecord = null
}

function extensionFromPath(path: string) {
  const cleanPath = String(path || '').split('?')[0] || ''
  const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/)
  return match ? match[1].toLowerCase() : 'mp3'
}

function chatVoiceCloudPath(tempFilePath: string) {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.random().toString(36).slice(2, 10)
  const ext = extensionFromPath(tempFilePath)
  return `hl_uploads/chat_voice/${year}${month}${day}/${Date.now()}-${random}.${ext}`
}

export async function uploadChatVoice(tempFilePath: string) {
  if (!wx.cloud) throw new Error('cloud is not available')
  const result = await wx.cloud.uploadFile({
    cloudPath: chatVoiceCloudPath(tempFilePath),
    filePath: tempFilePath
  })
  if (!result.fileID) throw new Error('uploadFile returned empty fileID')
  return result.fileID
}

function isCloudFileID(path: string) {
  return /^cloud:\/\//.test(String(path || ''))
}

export function voiceDurationText(value: number | string | undefined) {
  const seconds = Math.max(Math.round(Number(value || 0)), 1)
  return `${seconds}秒`
}

export async function resolveChatVoiceUrls<T extends ChatMessage>(messages: T[]) {
  const fileIDs = messages
    .filter(item => item.contentType === 'voice' && item.voiceFileID && isCloudFileID(item.voiceFileID))
    .map(item => String(item.voiceFileID))
  const uniqueFileIDs = Array.from(new Set(fileIDs))
  if (!uniqueFileIDs.length || !wx.cloud) {
    return messages.map(item => ({
      ...item,
      voiceUrl: item.voiceUrl || item.voiceFileID || '',
      voiceDurationText: voiceDurationText(item.voiceDuration)
    }))
  }

  const urlMap: Record<string, string> = {}
  for (let index = 0; index < uniqueFileIDs.length; index += 50) {
    const fileList = uniqueFileIDs.slice(index, index + 50)
    const result = await wx.cloud.getTempFileURL({ fileList })
    ;(result.fileList || []).forEach(item => {
      if (item.fileID && item.tempFileURL && item.status === 0) urlMap[item.fileID] = item.tempFileURL
    })
  }

  return messages.map(item => ({
    ...item,
    voiceUrl: item.voiceFileID ? urlMap[item.voiceFileID] || item.voiceFileID : '',
    voiceDurationText: voiceDurationText(item.voiceDuration)
  }))
}
