export type ChosenImage = {
  fileID: string
  tempFilePath: string
  displayUrl: string
}

type ChooseImageOptions = {
  crop?: boolean
  cloudFolder?: 'profile' | 'member-private'
  privateOwnerKey?: string | number
}

type CloudFolder = NonNullable<ChooseImageOptions['cloudFolder']>

const CLOUD_FOLDER_PATHS: Record<CloudFolder, string> = {
  profile: 'profile',
  'member-private': 'member-private'
}

type CropResult = {
  tempFilePath: string
}

function extensionFromPath(path: string) {
  const cleanPath = path.split('?')[0] || ''
  const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/)
  return match ? match[1].toLowerCase() : 'jpg'
}

function cloudFolderPath(folder: ChooseImageOptions['cloudFolder']) {
  return folder === 'member-private'
    ? CLOUD_FOLDER_PATHS['member-private']
    : CLOUD_FOLDER_PATHS.profile
}

function privateOwnerPath(ownerKey: ChooseImageOptions['privateOwnerKey']) {
  const value = String(ownerKey === undefined || ownerKey === null ? '' : ownerKey).trim()
  if (!/^[1-9]\d*$/.test(value)) throw new Error('invalid private image owner')
  return value
}

function cloudPathFor(tempFilePath: string, options: ChooseImageOptions) {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.random().toString(36).slice(2, 10)
  const ext = extensionFromPath(tempFilePath)
  const folder = cloudFolderPath(options.cloudFolder)
  const ownerPath = options.cloudFolder === 'member-private'
    ? `${privateOwnerPath(options.privateOwnerKey)}/`
    : ''
  return `hl_uploads/${folder}/${ownerPath}${year}${month}${day}/${Date.now()}-${random}.${ext}`
}

function isCloudFileID(path: string) {
  return /^cloud:\/\//.test(String(path || ''))
}

async function uploadImage(tempFilePath: string, options: ChooseImageOptions) {
  if (!wx.cloud) throw new Error('cloud is not available')
  const result = await wx.cloud.uploadFile({
    cloudPath: cloudPathFor(tempFilePath, options),
    filePath: tempFilePath
  })
  if (!result.fileID) throw new Error('uploadFile returned empty fileID')
  return result.fileID
}

async function chooseImages(count: number, sizeType: Array<'original' | 'compressed'>) {
  return new Promise<string[]>((resolve, reject) => {
    wx.chooseImage({
      count,
      sizeType,
      sourceType: ['album'],
      success(res) {
        resolve((res.tempFilePaths || []).slice(0, count))
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

function cropImage(tempFilePath: string) {
  return new Promise<string>((resolve, reject) => {
    wx.navigateTo({
      url: '/pages/common/image-cropper',
      success(res) {
        const channel = res.eventChannel
        channel.once('crop:done', (result: CropResult) => {
          if (result && result.tempFilePath) {
            resolve(result.tempFilePath)
          } else {
            reject(new Error('crop failed'))
          }
        })
        channel.once('crop:cancel', () => reject(new Error('crop cancel')))
        channel.emit('crop:init', {
          sourcePath: tempFilePath
        })
      },
      fail: reject
    })
  })
}

async function cropImages(paths: string[], crop?: boolean) {
  if (!crop) return paths
  const croppedPaths: string[] = []
  for (let index = 0; index < paths.length; index += 1) {
    croppedPaths.push(await cropImage(paths[index]))
  }
  return croppedPaths
}

async function uploadOrSave(tempFilePath: string, options: ChooseImageOptions): Promise<ChosenImage> {
  const fileID = await uploadImage(tempFilePath, options)
  return {
    fileID,
    tempFilePath,
    displayUrl: tempFilePath
  }
}

export async function deleteCloudFiles(paths: string[]) {
  const fileIDs = Array.from(new Set(paths.map(path => String(path || '')).filter(isCloudFileID)))
  if (!fileIDs.length || !wx.cloud) return

  for (let index = 0; index < fileIDs.length; index += 50) {
    const result = await wx.cloud.deleteFile({ fileList: fileIDs.slice(index, index + 50) })
    const failures = (result.fileList || []).filter(item => Number(item.status) !== 0)
    if (failures.length) {
      throw new Error(failures.map(item => item.errMsg || `delete failed: ${item.fileID}`).join('; '))
    }
  }
}

export async function chooseLocalImages(count = 1, options: ChooseImageOptions = {}) {
  if (options.cloudFolder === 'member-private') privateOwnerPath(options.privateOwnerKey)
  const paths = await chooseImages(count, options.crop ? ['original'] : ['compressed'])
  const uploadPaths = await cropImages(paths, options.crop)
  if (!uploadPaths.length) return []

  wx.showLoading({ title: '上传中', mask: true })
  const uploaded: ChosenImage[] = []
  try {
    for (let index = 0; index < uploadPaths.length; index += 1) {
      uploaded.push(await uploadOrSave(uploadPaths[index], options))
    }
    return uploaded
  } catch (err) {
    try {
      await deleteCloudFiles(uploaded.map(item => item.fileID))
    } catch (cleanupErr) {
      console.warn('cleanup partial image uploads failed', cleanupErr)
    }
    throw err
  } finally {
    wx.hideLoading()
  }
}

function errorText(err: unknown) {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const value = err as { errMsg?: unknown; message?: unknown }
    return String(value.errMsg || value.message || '')
  }
  return String(err)
}

export function isImageChooseCancel(err: unknown) {
  return /cancel/i.test(errorText(err))
}

export async function resolveImageUrls(paths: string[]) {
  const safePaths = paths.filter(Boolean)
  const cloudPaths = safePaths.filter(isCloudFileID)
  if (!cloudPaths.length || !wx.cloud) return safePaths

  try {
    const result = await wx.cloud.getTempFileURL({ fileList: cloudPaths })
    const urlMap = (result.fileList || []).reduce<Record<string, string>>((map, item) => {
      if (item.fileID && item.tempFileURL && item.status === 0) map[item.fileID] = item.tempFileURL
      return map
    }, {})
    return safePaths.map(path => urlMap[path] || path)
  } catch (err) {
    return safePaths
  }
}
