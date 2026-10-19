import type { MatchmakerActivationResult } from '../services/matchmaker'
import type { MembershipPaymentOrder } from '../services/member'
import { assertPaymentQueryResponse, virtualPaymentParamsFrom, type VirtualPaymentParams } from './payment-response'

export const MATCHMAKER_LIFETIME_PLAN_CODE = 'matchmaker_lifetime'
export const MATCHMAKER_LIFETIME_AMOUNT_FEN = 698000

export function assertMatchmakerActivationOrder(order: MembershipPaymentOrder, userId: number) {
  if (!order || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(order.outTradeNo)) throw new Error('主理人订单编号无效')
  assertPaymentQueryResponse({ order }, order.outTradeNo)
  if (Number(order.userId) !== userId || !Number.isSafeInteger(userId) || userId <= 0
    || order.productType !== 'matchmaker' || order.planCode !== MATCHMAKER_LIFETIME_PLAN_CODE
    || order.amountFen !== MATCHMAKER_LIFETIME_AMOUNT_FEN || order.durationDays !== 0
    || (order.serviceCount !== undefined && order.serviceCount !== 0)
    || order.paymentProvider !== 'virtual') throw new Error('主理人订单与当前账号或开通方案不一致，请查询订单')
}

export function assertMatchmakerActivationOverview(result: MatchmakerActivationResult) {
  const plan = result && result.plan
  if (!result || typeof result.active !== 'boolean' || typeof result.phoneBound !== 'boolean'
    || !plan || plan.planCode !== MATCHMAKER_LIFETIME_PLAN_CODE || plan.productType !== 'matchmaker'
    || plan.amountFen !== MATCHMAKER_LIFETIME_AMOUNT_FEN || plan.durationDays !== 0 || plan.lifetime !== true
    || !result.payment || typeof result.payment.available !== 'boolean') throw new Error('主理人开通方案暂时无法确认，请刷新重试')
  if (result.active && (!result.matchmaker || Number(result.matchmaker.certificationStatus) !== 2
    || Number(result.matchmaker.status) !== 1)) throw new Error('主理人权限尚未确认，请刷新重试')
}

function compareVersion(left: string, right: string) {
  const a = left.split('.'), b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (Number(a[index]) || 0) - (Number(b[index]) || 0)
    if (difference) return difference
  }
  return 0
}

export function matchmakerPaymentSupport() {
  type Device = { platform?: string; system?: string }
  type App = { SDKVersion?: string; version?: string }
  const api = wx as unknown as {
    getDeviceInfo?: () => Device
    getAppBaseInfo?: () => App
    getSystemInfoSync?: () => Device & App
  }
  let legacy: Device & App | undefined
  const oldInfo = () => legacy || (legacy = typeof api.getSystemInfoSync === 'function' ? api.getSystemInfoSync() || {} : {})
  const device = typeof api.getDeviceInfo === 'function' ? api.getDeviceInfo() || {} : oldInfo()
  const app = typeof api.getAppBaseInfo === 'function' ? api.getAppBaseInfo() || {} : oldInfo()
  const platform = String(device.platform || '').toLowerCase()
  if (platform === 'ios') {
    const system = /^iOS\s+(\d+(?:\.\d+)*)$/i.exec(String(device.system || oldInfo().system || ''))?.[1] || ''
    if (!system || compareVersion(system, '15') < 0) return { platform, reason: '苹果支付需要 iOS 15 及以上，请更新系统后重试。' }
    const version = String(app.version || oldInfo().version || '')
    if (!/^\d+(?:\.\d+)*$/.test(version) || compareVersion(version, '8.0.68') < 0) {
      return { platform, reason: '苹果支付需要微信 8.0.68 及以上，请更新微信后重试。' }
    }
  }
  const supported = compareVersion(String(app.SDKVersion || ''), '2.19.2') >= 0
    || (typeof wx.canIUse === 'function' && wx.canIUse('requestVirtualPayment'))
  return { platform, reason: supported ? '' : '当前微信版本不支持虚拟支付，请更新微信后重试。' }
}

export function matchmakerPaymentReason(reason: string) {
  if (reason === 'phone_required') return '请先授权微信手机号，再开通主理人。'
  if (['account_inactive', 'matchmaker_inactive', 'matchmaker_application_unavailable'].includes(reason)) return '当前账号暂无法开通，请联系平台。'
  if (reason === 'already_active' || reason === 'matchmaker_already_active') return '主理人权限已经开通，无需再次付款。'
  if (reason === 'pending_order_query_required') return '请先查询上一笔订单，确认结果前勿重复付款。'
  if (reason === 'retired_plan_query_required') return '请查询原订单或联系平台处理。'
  return '主理人支付暂不可用，请稍后重试或联系平台。'
}

export function requestMatchmakerPayment(params: VirtualPaymentParams, submittedAttempts: string[]) {
  return new Promise<void>((resolve, reject) => {
    const validated = virtualPaymentParamsFrom(params)
    const signed = JSON.parse(validated.signData) as { outTradeNo: string; env: number; goodsPrice: number }
    const support = matchmakerPaymentSupport()
    if (support.reason) throw new Error(support.reason)
    if (signed.goodsPrice !== MATCHMAKER_LIFETIME_AMOUNT_FEN) throw new Error('主理人支付金额与开通方案不一致')
    if (support.platform === 'ios' && signed.env !== 0) throw new Error('苹果支付暂不支持当前测试商品，请联系平台。')
    const payer = (wx as unknown as { requestVirtualPayment?: (options: Record<string, unknown>) => void }).requestVirtualPayment
    if (typeof payer !== 'function') throw new Error('当前微信版本不支持虚拟支付，请更新微信后重试。')
    if (submittedAttempts.includes(signed.outTradeNo)) throw new Error('付款尝试已经提交，请先查询订单。')
    submittedAttempts.push(signed.outTradeNo)
    payer({ ...validated, success: () => resolve(), fail: reject })
  })
}
