import { createHash } from 'node:crypto';

export const protocolMarker = '// HL: verify exact WeChat Pay response bytes before parsing';
const dependency = "const { installVerifiedWechatPayTransport } = require('../hl-payment-response-verifier');";
const configAnchor = "const { verifyMode: defaultVerifyMode } = require('../../config/config');";
const constructorAnchor = "            console.log('[SdkStrategy] 验证模式: PUBLICKEY（固定公钥）');\n        }\n    }";
const constructorReplacement = "            console.log('[SdkStrategy] 验证模式: PUBLICKEY（固定公钥）');\n        }\n        this.paymentVerifier = installVerifiedWechatPayTransport({\n            sdk: this.wxPay, payConfig: this.payConfig, verifyMode: this.verifyMode,\n        });\n    }";
const verifiedCallback = `    async verifySign(callbackParams) {
        // The gateway path already verifies and decrypts. This is the direct
        // callback fallback: require the original body and all signature headers.
        try {
            this.paymentVerifier({
                rawBody: callbackParams.rawBody,
                headers: {
                    'wechatpay-serial': callbackParams.serial,
                    'wechatpay-timestamp': callbackParams.timestamp,
                    'wechatpay-nonce': callbackParams.nonce,
                    'wechatpay-signature': callbackParams.signature,
                },
            });
            return true;
        } catch (_) {
            return false;
        }
    }
`;
const callbackPattern = /    async verifySign\(callbackParams\) \{[\s\S]*?(?=\n    \/\*\*\n     \* 解密回调数据)/;
// Exact inspected Integration Center template, after the independent log patch.
// Refuse unknown vendor changes rather than editing similar-looking callbacks.
const inspectedCallbackHash = 'f2aa34c6a0d6a5c9630dd9decbdef338dc252fc5d5a779f2636d53e1a8c7a79b';
const logDeclaration = "// HL: closed payment error diagnostics\nconst { safePaymentError } = require('../hl-payment-safe-log');";
function count(source, token) { return source.split(token).length - 1; }

/** Pure, precise patch; retain outgoing SDK signing and the gateway callback. */
export function patchPaymentProtocolSource(source) {
  if (typeof source !== 'string') throw new Error('支付协议模板不是文本');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let output = source.replace(/\r\n/g, '\n');
  const callbackMatches = output.match(new RegExp(callbackPattern.source, 'g')) || [];
  if (count(output, configAnchor) !== 1 || count(output, logDeclaration) !== 1
    || callbackMatches.length !== 1 || count(output, "require('wechatpay-node-v3')") !== 1) {
    throw new Error('支付协议模板锚点与已核验版本不匹配');
  }
  const declaration = `${protocolMarker}\n${dependency}`;
  if (output.includes(protocolMarker)) {
    if (count(output, declaration) !== 1 || count(output, constructorReplacement) !== 1
      || callbackMatches[0] !== verifiedCallback || count(output, 'this.paymentVerifier(') !== 1
      || count(output, 'installVerifiedWechatPayTransport({') !== 1) {
      throw new Error('支付协议验签补丁存在未知修改');
    }
  } else {
    if (output.includes('paymentVerifier') || output.includes('installVerifiedWechatPayTransport')
      || count(output, constructorAnchor) !== 1
      || createHash('sha256').update(callbackMatches[0]).digest('hex') !== inspectedCallbackHash) {
      throw new Error('支付协议模板与已核验版本不匹配，请先检查实际源码');
    }
    output = output.replace(configAnchor, `${configAnchor}\n${declaration}`)
      .replace(constructorAnchor, constructorReplacement)
      .replace(callbackPattern, verifiedCallback);
  }
  return newline === '\n' ? output : output.replace(/\n/g, '\r\n');
}
