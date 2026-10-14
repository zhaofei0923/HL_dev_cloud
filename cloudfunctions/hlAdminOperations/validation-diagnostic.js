'use strict';

const MESSAGES = Object.freeze({
  '管理参数无效': 'ARGS_FIELDS', '记录编号无效': 'ARGS_ID', '分页参数无效': 'ARGS_PAGE',
  '搜索词须为80字以内文本': 'ARGS_KEYWORD', '套餐启停筛选须为布尔值': 'ARGS_ACTIVE',
  '筛选条件无效': 'ARGS_FILTER', '记录标识无效': 'ARGS_IDENTIFIER'
});

// Return only server-defined categories. Never copy request values, arbitrary
// property names, error text or credentials into a diagnostic response.
function validationDiagnostic(stage, failure) {
  try {
    if (stage === 'envelope') {
      return ['ENVELOPE_SHAPE', 'ENVELOPE_ACCESSOR'].includes(failure?.diagnosticCode)
        ? failure.diagnosticCode : 'ENVELOPE_FORMAT';
    }
    if (stage === 'business') return Object.hasOwn(MESSAGES, failure?.message) ? MESSAGES[failure.message] : 'BUSINESS_VALIDATION';
  } catch { /* Diagnostics must never affect validation or authorization. */ }
  return 'VALIDATION_UNCLASSIFIED';
}

module.exports = { validationDiagnostic };
