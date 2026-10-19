'use strict';

const CODES = new Set(['ORDER_NOT_EXIST', 'PARAM_ERROR', 'INVALID_REQUEST', 'MCH_NOT_EXISTS',
  'SIGN_ERROR', 'RULE_LIMIT', 'TRADE_ERROR', 'FREQUENCY_LIMITED', 'SYSTEM_ERROR']);

// Only the verified transport can establish provider evidence. The older SDK
// discarded response headers; its error envelope alone is not authentication.
// Never expose raw requests, messages, signatures or unknown provider values.
function merchantQueryDiagnostic(result) {
  let parsed;
  if (typeof result?.error === 'string' && result.error.length <= 32768) {
    try { parsed = JSON.parse(result.error); } catch (_) {}
  }
  const candidates = [result?.code, result?.data?.code, parsed?.code].filter(value => value !== undefined);
  const agreed = candidates.length > 0 && candidates.every(value => value === candidates[0]);
  const verified = result?.verified === true;
  const code = verified && agreed && CODES.has(candidates[0]) ? candidates[0] : 'PAYMENT_PREFLIGHT_FAILED';
  const status = Number.isInteger(result?.status) && result.status >= 400 && result.status <= 599 ? result.status : 0;
  return { authenticated: verified && status === 404 && code === 'ORDER_NOT_EXIST', status, code };
}

module.exports = { merchantQueryDiagnostic };
