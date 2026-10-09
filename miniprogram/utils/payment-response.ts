export type PaymentParams = {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

export function paymentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Legacy integrations omit transport metadata or wrap parameters in payment.
// Validate every envelope before unwrapping SDK and business responses.
function paymentPayloadFrom(result: unknown): Record<string, unknown> {
  let current = result
  for (let depth = 0; depth < 8; depth += 1) {
    if (!paymentRecord(current)) throw new Error('支付服务返回格式无效')
    if (Object.prototype.hasOwnProperty.call(current, 'statusCode') && current.statusCode !== 200) {
      throw new Error('支付服务请求未成功，请稍后重试')
    }
    if (Object.prototype.hasOwnProperty.call(current, 'status') && current.status !== 200) {
      throw new Error('支付服务未确认请求成功')
    }
    if (Object.prototype.hasOwnProperty.call(current, 'code') && current.code !== 0) {
      throw new Error('支付服务返回业务错误，请稍后重试')
    }
    if ('data' in current) current = current.data
    else if ('payment' in current) current = current.payment
    else return current
  }
  throw new Error('支付服务返回格式无效')
}

export function paymentParamsFrom(result: unknown): PaymentParams {
  const params = paymentPayloadFrom(result)
  if (typeof params.timeStamp !== 'string' || !/^\d{1,16}$/.test(params.timeStamp)
    || typeof params.nonceStr !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.nonceStr)
    || typeof params.package !== 'string' || !/^prepay_id=[A-Za-z0-9_-]{1,128}$/.test(params.package)
    || typeof params.paySign !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(params.paySign) || params.paySign.length > 4096
    || (params.signType !== undefined && params.signType !== 'RSA')) {
    throw new Error('支付函数未返回有效的微信支付参数')
  }
  return { timeStamp: params.timeStamp, nonceStr: params.nonceStr, package: params.package,
    signType: 'RSA', paySign: params.paySign }
}

export function assertPaymentQueryResponse(result: unknown, outTradeNo: string): void {
  const payload = paymentPayloadFrom(result)
  const order = payload.order
  if (!paymentRecord(order) || order.outTradeNo !== outTradeNo
    || (Object.prototype.hasOwnProperty.call(order, 'code') && order.code !== 0)
    || typeof order.status !== 'string' || !['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'].includes(order.status)) {
    throw new Error('支付查询未返回当前订单的有效结果')
  }
}
