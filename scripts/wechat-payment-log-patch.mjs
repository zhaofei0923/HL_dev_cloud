import { patchPaymentProtocolSource, protocolMarker } from './wechat-payment-protocol-patch.mjs';

const marker = '// HL: closed payment error diagnostics';

const serviceErrors = [
  "console.error('[PayService] unifiedOrder error:', err);",
  "console.error('[PayService] 异步处理支付回调业务失败:', err);",
  "console.error('[PayService] 异步处理退款回调业务失败:', err);",
  "console.error('[PayService] refund error:', err);",
  "console.error('[PayService] transfer error:', err);",
  "console.error('[PayService] 异步处理转账回调业务失败:', err);"
];
const controllerErrors = [
  'unifiedOrder', 'unifiedOrderH5', 'unifiedOrderNative',
  'queryOrderByOutTradeNo', 'queryOrderByTransactionId', 'closeOrder',
  'refund', 'queryRefund', 'transfer', 'queryTransferBill', 'queryTransferBillByNo'
].map(name => `console.error('[Controller] ${name} error:', err);`);
controllerErrors.push('console.error(`[Controller] ${triggerName} error:`, err);');

const rules = {
  'services/payService.js': {
    anchor: "const OrderService = require('./orderService');",
    dependency: "const { safePaymentError } = require('./hl-payment-safe-log');",
    replacements: [
      ...serviceErrors.map(before => ({ before, after: before.replace(', err);', ', safePaymentError(err));') })),
      {
        before: 'console.error(`[PayService] ${payType} 下单失败: status=${result?.status}, code=${result?.data?.code}, message=${result?.data?.message}`);',
        after: "console.error('[PayService] 下单失败:', safePaymentError({ status: result?.status, code: result?.data?.code }));"
      },
      ...['退款', '转账'].map(action => ({
        before: `console.error('[PayService] ${action}失败: status=%s, code=%s, message=%s', result?.status, result?.data?.code, result?.data?.message);`,
        after: `console.error('[PayService] ${action}失败:', safePaymentError({ status: result?.status, code: result?.data?.code }));`
      }))
    ]
  },
  'controllers/payController.js': {
    anchor: "const config = require('../config/config');",
    dependency: "const { safePaymentError } = require('../services/hl-payment-safe-log');",
    replacements: controllerErrors.map(before => ({ before, after: before.replace(', err);', ', safePaymentError(err));') }))
  },
  'services/strategies/sdkStrategy.js': {
    anchor: "const { verifyMode: defaultVerifyMode } = require('../../config/config');",
    dependency: "const { safePaymentError } = require('../hl-payment-safe-log');",
    replacements: [
      {
        before: "console.error('[SdkStrategy] 验签异常:', err.message);",
        after: "console.error('[SdkStrategy] 验签异常:', safePaymentError(err));"
      },
      {
        before: "console.error('[SdkStrategy] 下载平台证书失败（这通常是根因）:',\n                            dlErr.code || 'NO_CODE', '-', dlErr.message || dlErr);",
        after: "console.error('[SdkStrategy] 下载平台证书失败（这通常是根因）:', safePaymentError(dlErr));"
      }
    ]
  }
};

function occurrences(source, text) { return source.split(text).length - 1; }

/** Pure, fail-closed patch of the three inspected generated template files. */
export function patchPaymentLogSource(filename, source) {
  const rule = rules[filename];
  if (!Object.hasOwn(rules, filename) || typeof source !== 'string') throw new Error('不支持的支付日志模板文件');
  // Templates use either LF or CRLF. Normalize for matching; retain their newline style.
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let output = source.replace(/\r\n/g, '\n');
  if (occurrences(output, rule.anchor) !== 1) throw new Error(`支付日志模板锚点不匹配：${filename}`);
  const installed = output.includes(marker);
  const declaration = `${marker}\n${rule.dependency}`;
  if (installed) {
    if (occurrences(output, declaration) !== 1) throw new Error(`支付日志脱敏标记不匹配：${filename}`);
  } else {
    if (output.includes('safePaymentError')) throw new Error(`支付日志模板存在未知脱敏实现：${filename}`);
    output = output.replace(rule.anchor, `${rule.anchor}\n${declaration}`);
  }
  // The verified protocol replaces the original callback and its diagnostics.
  // Validate the whole installed patch before accepting those removed logs.
  const verifiedProtocol = filename === 'services/strategies/sdkStrategy.js' && output.includes(protocolMarker);
  if (verifiedProtocol) patchPaymentProtocolSource(output);
  for (const { before, after } of rule.replacements) {
    const beforeCount = occurrences(output, before);
    const afterCount = occurrences(output, after);
    // The preparation script intentionally removes this catch when it awaits fulfillment.
    const removedPaymentCatch = filename === 'services/payService.js'
      && before === serviceErrors[1]
      && output.includes('// HL: await business fulfillment before acknowledging the callback')
      && !beforeCount && !afterCount;
    const removedVerificationLog = verifiedProtocol && !beforeCount && !afterCount;
    if (removedPaymentCatch || removedVerificationLog) continue;
    if (beforeCount === 1 && afterCount === 0 && !installed) output = output.replace(before, after);
    else if (beforeCount === 0 && afterCount === 1 && installed) continue;
    else throw new Error(`支付日志模板与已核验版本不匹配：${filename}`);
  }
  return newline === '\n' ? output : output.replace(/\n/g, '\r\n');
}
