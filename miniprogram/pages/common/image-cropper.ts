type RatioOption = {
  key: string
  label: string
  help: string
  width: number
  height: number
}

type CropInitPayload = {
  sourcePath: string
  ratioKey?: string
}

type CropRect = {
  x: number
  y: number
  width: number
  height: number
}

type ImageFrame = CropRect

type Point = {
  x: number
  y: number
}

type ImageSize = {
  width: number
  height: number
}

type CropperState = {
  sourcePath: string
  ratio: RatioOption
  ratios: RatioOption[]
  canvasWidth: number
  canvasHeight: number
  cropRect: CropRect
  imageFrame: ImageFrame
  imageSize: ImageSize
  lastTouches: Point[]
  channel: WechatMiniprogram.EventChannel | null
  completed: boolean
}

const CANVAS_ID = 'cropCanvas'
const EXPORT_LONG_EDGE = 1200

const PHOTO_RATIOS: RatioOption[] = [
  { key: '1:1', label: '1:1 方图', help: '方图适合头像式生活照，列表和详情都会居中展示。', width: 1, height: 1 },
  { key: '3:2', label: '3:2 横图', help: '3:2 横图推荐用于生活照和封面，展示裁切最稳。', width: 3, height: 2 },
  { key: '4:5', label: '4:5 竖图', help: '4:5 竖图适合半身照，能保留更多人物主体。', width: 4, height: 5 }
]

function defaultState(): CropperState {
  return {
    sourcePath: '',
    ratio: PHOTO_RATIOS[1],
    ratios: PHOTO_RATIOS,
    canvasWidth: 320,
    canvasHeight: 430,
    cropRect: { x: 32, y: 90, width: 256, height: 170 },
    imageFrame: { x: 32, y: 90, width: 256, height: 170 },
    imageSize: { width: 1, height: 1 },
    lastTouches: [],
    channel: null,
    completed: false
  }
}

let cropState = defaultState()

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function ratioByKey(ratios: RatioOption[], key?: string) {
  return ratios.find(item => item.key === key) || ratios[0]
}

function layoutForRatio(ratio: RatioOption) {
  const system = wx.getSystemInfoSync()
  const canvasWidth = Math.max(300, Math.floor(system.windowWidth - 28))
  const maxCanvasHeight = Math.max(360, Math.floor(system.windowHeight * 0.58))
  const canvasHeight = Math.min(520, maxCanvasHeight)
  const margin = Math.max(24, Math.floor(canvasWidth * 0.08))
  let cropWidth = canvasWidth - margin * 2
  let cropHeight = cropWidth * ratio.height / ratio.width
  const maxCropHeight = canvasHeight - margin * 2

  if (cropHeight > maxCropHeight) {
    cropHeight = maxCropHeight
    cropWidth = cropHeight * ratio.width / ratio.height
  }

  return {
    canvasWidth,
    canvasHeight,
    cropRect: {
      x: Math.round((canvasWidth - cropWidth) / 2),
      y: Math.round((canvasHeight - cropHeight) / 2),
      width: Math.round(cropWidth),
      height: Math.round(cropHeight)
    }
  }
}

function touchPoints(touches: WechatMiniprogram.TouchCanvasDetail[]) {
  return touches.map(touch => ({ x: touch.x, y: touch.y }))
}

function distance(a: Point, b: Point) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function midpoint(a: Point, b: Point) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  }
}

function minScaleForCurrentCrop() {
  const crop = cropState.cropRect
  const image = cropState.imageSize
  return Math.max(crop.width / image.width, crop.height / image.height)
}

function clampFrame(frame: ImageFrame) {
  const crop = cropState.cropRect
  const image = cropState.imageSize
  const minScale = minScaleForCurrentCrop()
  const maxScale = minScale * 5
  const scale = clamp(frame.width / image.width, minScale, maxScale)
  const width = image.width * scale
  const height = image.height * scale
  let x = frame.x
  let y = frame.y

  if (x > crop.x) x = crop.x
  if (y > crop.y) y = crop.y
  if (x + width < crop.x + crop.width) x = crop.x + crop.width - width
  if (y + height < crop.y + crop.height) y = crop.y + crop.height - height

  return { x, y, width, height }
}

function resetImageFrame() {
  const crop = cropState.cropRect
  const image = cropState.imageSize
  const scale = minScaleForCurrentCrop()
  const width = image.width * scale
  const height = image.height * scale
  cropState.imageFrame = clampFrame({
    x: crop.x + (crop.width - width) / 2,
    y: crop.y + (crop.height - height) / 2,
    width,
    height
  })
}

function exportSizeForRatio(ratio: RatioOption) {
  if (ratio.width >= ratio.height) {
    return {
      width: EXPORT_LONG_EDGE,
      height: Math.round(EXPORT_LONG_EDGE * ratio.height / ratio.width)
    }
  }

  return {
    width: Math.round(EXPORT_LONG_EDGE * ratio.width / ratio.height),
    height: EXPORT_LONG_EDGE
  }
}

Page({
  data: {
    title: '裁剪照片',
    ratios: PHOTO_RATIOS,
    ratioKey: '3:2',
    ratioHelp: PHOTO_RATIOS[1].help,
    canvasWidth: 320,
    canvasHeight: 430,
    ready: false,
    saving: false
  },

  onLoad() {
    cropState = defaultState()
    cropState.channel = this.getOpenerEventChannel()
    cropState.channel.on('crop:init', (payload: CropInitPayload) => {
      void this.initCrop(payload)
    })
  },

  onUnload() {
    if (!cropState.completed && cropState.channel) {
      cropState.channel.emit('crop:cancel')
    }
  },

  async initCrop(payload: CropInitPayload) {
    const ratios = PHOTO_RATIOS
    const ratio = ratioByKey(ratios, payload.ratioKey || '3:2')
    const layout = layoutForRatio(ratio)

    cropState = {
      ...defaultState(),
      sourcePath: payload.sourcePath,
      ratio,
      ratios,
      canvasWidth: layout.canvasWidth,
      canvasHeight: layout.canvasHeight,
      cropRect: layout.cropRect,
      channel: cropState.channel
    }

    this.setData({
      title: '裁剪照片墙图片',
      ratios,
      ratioKey: ratio.key,
      ratioHelp: ratio.help,
      canvasWidth: layout.canvasWidth,
      canvasHeight: layout.canvasHeight,
      ready: false,
      saving: false
    })

    try {
      const imageInfo = await this.getImageInfo(payload.sourcePath)
      cropState.imageSize = {
        width: imageInfo.width,
        height: imageInfo.height
      }
      resetImageFrame()
      this.setData({ ready: true })
      this.drawCanvas(true)
    } catch (err) {
      wx.showToast({ title: '图片读取失败，请重试', icon: 'none' })
      this.cancelCrop()
    }
  },

  getImageInfo(src: string) {
    return new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => {
      wx.getImageInfo({
        src,
        success: resolve,
        fail: reject
      })
    })
  },

  drawCanvas(showMask: boolean, callback?: () => void) {
    const ctx = wx.createCanvasContext(CANVAS_ID, this)
    const frame = cropState.imageFrame
    const crop = cropState.cropRect
    const canvasWidth = cropState.canvasWidth
    const canvasHeight = cropState.canvasHeight

    ctx.setFillStyle('#151210')
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    ctx.drawImage(cropState.sourcePath, frame.x, frame.y, frame.width, frame.height)

    if (showMask) {
      ctx.setFillStyle('rgba(0, 0, 0, 0.56)')
      ctx.fillRect(0, 0, canvasWidth, crop.y)
      ctx.fillRect(0, crop.y, crop.x, crop.height)
      ctx.fillRect(crop.x + crop.width, crop.y, canvasWidth - crop.x - crop.width, crop.height)
      ctx.fillRect(0, crop.y + crop.height, canvasWidth, canvasHeight - crop.y - crop.height)
      ctx.setStrokeStyle('#fff8ed')
      ctx.setLineWidth(2)
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height)
      ctx.setStrokeStyle('rgba(255, 248, 237, 0.46)')
      ctx.setLineWidth(1)
      ctx.beginPath()
      ctx.moveTo(crop.x + crop.width / 3, crop.y)
      ctx.lineTo(crop.x + crop.width / 3, crop.y + crop.height)
      ctx.moveTo(crop.x + crop.width * 2 / 3, crop.y)
      ctx.lineTo(crop.x + crop.width * 2 / 3, crop.y + crop.height)
      ctx.moveTo(crop.x, crop.y + crop.height / 3)
      ctx.lineTo(crop.x + crop.width, crop.y + crop.height / 3)
      ctx.moveTo(crop.x, crop.y + crop.height * 2 / 3)
      ctx.lineTo(crop.x + crop.width, crop.y + crop.height * 2 / 3)
      ctx.stroke()
    }

    ctx.draw(false, callback)
  },

  selectRatio(e: WechatMiniprogram.TouchEvent) {
    if (this.data.saving) return
    const key = String(e.currentTarget.dataset.key || '')
    const ratio = ratioByKey(cropState.ratios, key)
    const layout = layoutForRatio(ratio)
    cropState.ratio = ratio
    cropState.canvasWidth = layout.canvasWidth
    cropState.canvasHeight = layout.canvasHeight
    cropState.cropRect = layout.cropRect
    resetImageFrame()
    this.setData({
      ratioKey: ratio.key,
      ratioHelp: ratio.help,
      canvasWidth: layout.canvasWidth,
      canvasHeight: layout.canvasHeight
    }, () => this.drawCanvas(true))
  },

  onTouchStart(e: WechatMiniprogram.TouchCanvas) {
    cropState.lastTouches = touchPoints(e.touches)
  },

  onTouchMove(e: WechatMiniprogram.TouchCanvas) {
    if (!this.data.ready || this.data.saving) return
    const touches = touchPoints(e.touches)
    if (!touches.length) return

    if (touches.length === 1 && cropState.lastTouches.length === 1) {
      const dx = touches[0].x - cropState.lastTouches[0].x
      const dy = touches[0].y - cropState.lastTouches[0].y
      cropState.imageFrame = clampFrame({
        ...cropState.imageFrame,
        x: cropState.imageFrame.x + dx,
        y: cropState.imageFrame.y + dy
      })
      this.drawCanvas(true)
    }

    if (touches.length >= 2 && cropState.lastTouches.length >= 2) {
      const oldDistance = distance(cropState.lastTouches[0], cropState.lastTouches[1])
      const newDistance = distance(touches[0], touches[1])
      if (oldDistance > 0) {
        const center = midpoint(touches[0], touches[1])
        const frame = cropState.imageFrame
        const nextScale = clamp(newDistance / oldDistance, 0.82, 1.18)
        const nextWidth = frame.width * nextScale
        const nextHeight = frame.height * nextScale
        const offsetX = center.x - frame.x
        const offsetY = center.y - frame.y
        cropState.imageFrame = clampFrame({
          x: center.x - offsetX * nextScale,
          y: center.y - offsetY * nextScale,
          width: nextWidth,
          height: nextHeight
        })
        this.drawCanvas(true)
      }
    }

    cropState.lastTouches = touches
  },

  onTouchEnd(e: WechatMiniprogram.TouchCanvas) {
    cropState.lastTouches = touchPoints(e.touches)
  },

  cancelCrop() {
    cropState.completed = true
    if (cropState.channel) cropState.channel.emit('crop:cancel')
    wx.navigateBack()
  },

  confirmCrop() {
    if (!this.data.ready || this.data.saving) return
    this.setData({ saving: true })
    const crop = cropState.cropRect
    const exportSize = exportSizeForRatio(cropState.ratio)

    this.drawCanvas(false, () => {
      wx.canvasToTempFilePath({
        canvasId: CANVAS_ID,
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        destWidth: exportSize.width,
        destHeight: exportSize.height,
        fileType: 'jpg',
        quality: 0.92,
        success: res => {
          cropState.completed = true
          if (cropState.channel) {
            cropState.channel.emit('crop:done', {
              tempFilePath: res.tempFilePath,
              ratioKey: cropState.ratio.key
            })
          }
          wx.navigateBack()
        },
        fail: err => {
          console.warn('crop image failed', err)
          wx.showToast({ title: '裁剪失败，请重试', icon: 'none' })
          this.setData({ saving: false })
          this.drawCanvas(true)
        }
      }, this)
    })
  }
})
