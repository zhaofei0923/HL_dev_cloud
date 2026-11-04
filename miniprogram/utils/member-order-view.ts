import type { MemberOrder, MembershipPaymentOrder } from '../services/member'

const STATUSES = ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']
const FULFILLMENT_STATUSES = ['', 'fulfilled', 'requires_review']

export function validMemberOrderNumber(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(value)
}

export function memberOrderAuthError(error: unknown) {
  const code = Number(error && typeof error === 'object' ? (error as { code?: unknown }).code : 0)
  return code === 401 || code === 40100 || code === 40102
}

export function canCancelMemberOrder(order: Pick<MembershipPaymentOrder, 'status' | 'cancelledAt' | 'fulfillmentStatus'>) {
  return !order.cancelledAt && order.fulfillmentStatus !== 'requires_review' && order.fulfillmentStatus !== 'fulfilled'
    && ['pending', 'confirming', 'closed', 'failed'].includes(order.status)
}

export function memberOrderCancellationError(error: unknown) {
  if (memberOrderAuthError(error)) return '登录状态已失效，请重新登录后查看订单。'
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message || '') : ''
  return /[\u4e00-\u9fff]/.test(message) ? message.slice(0, 200) : '取消订单暂未完成，请刷新订单状态后重试。'
}

function timeText(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间待确认'
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function memberOrderView(order: MemberOrder) {
  if (!order || !validMemberOrderNumber(order.outTradeNo) || !STATUSES.includes(order.status)
    || !FULFILLMENT_STATUSES.includes(order.fulfillmentStatus)
    || !Number.isSafeInteger(order.amountFen) || order.amountFen <= 0
    || !Number.isSafeInteger(order.durationDays)
    || (order.productType === 'matchmaker' ? order.durationDays !== 0 : order.durationDays <= 0)
    || !['vip', 'matchmaking', 'matchmaker'].includes(order.productType)
    || !['virtual', 'jsapi'].includes(order.paymentProvider)
    || !Number.isSafeInteger(order.serviceCount) || order.serviceCount < 0
    || (order.productType === 'matchmaking' && order.serviceCount < 1)) {
    throw new Error('订单记录不完整，请刷新后重试')
  }
  let statusText = '', statusTone = 'muted', resultText = ''
  if (order.status === 'paid') {
    if (order.fulfillmentStatus === 'requires_review') {
      statusText = '待核查'; statusTone = 'attention'
      resultText = order.fulfillmentMessage || '付款已确认，权益仍待工作人员核查。'
    } else if (order.fulfillmentStatus === 'fulfilled') {
      statusText = '已支付'; statusTone = 'success'
      resultText = order.productType === 'matchmaker' ? '主理人权限已确认开通，长期有效。'
        : order.productType === 'matchmaking' ? '牵线服务权益已确认到账。' : 'VIP权益已确认开通。'
    } else {
      statusText = '权益确认中'; statusTone = 'attention'
      resultText = '付款已确认，权益结果尚待核实，请稍后刷新。'
    }
  } else if (order.status === 'pending') {
    statusText = '待支付'; resultText = '订单尚未确认付款。'
  } else if (order.status === 'confirming') {
    statusText = '确认中'; statusTone = 'attention'; resultText = '付款结果正在核对，请勿重复付款。'
  } else if (order.status === 'closed') {
    statusText = order.cancelledAt ? '已取消' : '已关闭'
    resultText = order.cancelledAt ? '订单已取消。' : '订单已关闭。'
  } else if (order.status === 'failed') {
    statusText = '支付未成功'; statusTone = 'attention'; resultText = '此订单未确认付款成功。'
  } else {
    statusText = '已退款'; resultText = '订单已退款，权益以当前服务记录为准。'
  }
  return {
    outTradeNo: order.outTradeNo, planTitle: order.planTitle || '会员服务', status: order.status,
    productType: order.productType, amountText: `¥${(order.amountFen / 100).toFixed(2)}`,
    statusText, statusTone, resultText,
    canCancel: canCancelMemberOrder(order),
    isCancelled: order.status === 'closed' && !!order.cancelledAt,
    cancelledAt: order.cancelledAt || null, cancelledText: timeText(order.cancelledAt),
    termText: order.productType === 'matchmaker' ? '主理人开通 · 长期有效' : order.productType === 'matchmaking'
      ? `${order.durationDays}天服务期 · ${order.serviceCount}次牵线` : `${order.durationDays}天VIP权益`,
    createdText: timeText(order.createdAt), paidText: timeText(order.paidAt), refundedText: timeText(order.refundedAt),
    paymentText: order.paymentProvider === 'virtual' ? '小程序虚拟支付' : '微信支付'
  }
}

export type MemberOrderView = ReturnType<typeof memberOrderView>

// A cancellation reply is authoritative for these fields only. Keep the last
// validated order snapshot until the stricter order-detail DTO is refreshed.
export function cancelledMemberOrderView(previous: MemberOrderView, response: MembershipPaymentOrder): MemberOrderView {
  if (!response || response.outTradeNo !== previous.outTradeNo || response.status !== 'closed'
    || typeof response.cancelledAt !== 'string' || !Number.isFinite(new Date(response.cancelledAt).getTime())) {
    throw new Error('取消结果暂未确认，请刷新订单状态后重试。')
  }
  return { ...previous, status: 'closed', statusText: '已取消', statusTone: 'muted', resultText: '订单已取消。',
    cancelledAt: response.cancelledAt, cancelledText: timeText(response.cancelledAt), isCancelled: true, canCancel: false }
}
