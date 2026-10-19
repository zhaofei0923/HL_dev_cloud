'use strict';

// Closed diagnostics only: SDK errors can contain signed requests and merchant keys.
const SAFE_CODES = Object.freeze({
  SIGN_ERROR: 'PAYMENT_AUTH_ERROR',
  NO_AUTH: 'PAYMENT_AUTH_ERROR',
  INVALID_REQUEST: 'PAYMENT_INVALID_REQUEST',
  PARAM_ERROR: 'PAYMENT_INVALID_REQUEST',
  FREQUENCY_LIMITED: 'PAYMENT_RATE_LIMITED',
  ETIMEDOUT: 'PAYMENT_TIMEOUT',
  ECONNABORTED: 'PAYMENT_TIMEOUT',
  ERR_NETWORK: 'PAYMENT_UPSTREAM_ERROR',
  ERR_BAD_RESPONSE: 'PAYMENT_UPSTREAM_ERROR',
  SYSTEM_ERROR: 'PAYMENT_UPSTREAM_ERROR'
});
const SAFE_STATUSES = new Set([400, 401, 403, 404, 409, 429, 500, 502, 503, 504]);

// Read data properties without invoking getters or converting arbitrary values.
function ownValue(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(object, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  } catch (_) {
    return undefined;
  }
}

function safePaymentError(error) {
  const originalCode = ownValue(error, 'code');
  const code = typeof originalCode === 'string' && Object.hasOwn(SAFE_CODES, originalCode)
    ? SAFE_CODES[originalCode] : 'PAYMENT_ERROR';
  const statuses = [ownValue(error, 'status'), ownValue(error, 'statusCode'), ownValue(ownValue(error, 'response'), 'status')];
  const status = statuses.find(value => typeof value === 'number' && SAFE_STATUSES.has(value)) || 500;
  return { code, status };
}

module.exports = { safePaymentError };
