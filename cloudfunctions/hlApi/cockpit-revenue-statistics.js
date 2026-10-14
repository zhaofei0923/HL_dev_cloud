'use strict';

// Pure projection of trusted, complete server-side hl_payment_orders snapshots.
// This does not verify client-supplied orders, query providers, or authorize any action.
const { createHash } = require('node:crypto');
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SOURCES = new Set(['wechat_push', 'virtual_query']);
const NON_PAID = new Set(['pending', 'confirming', 'closed', 'failed']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const transaction = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
const positive = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ref = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const signature = values => JSON.stringify(values.map(value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : `invalid-number:${String(value)}`;
  return `invalid-type:${typeof value}`;
}));

// Date.parse alone silently normalizes invalid calendar dates and assumes the host
// timezone for unzoned strings. Persisted payment times must identify an instant.
function instant(value) {
  if (value !== null && typeof value === 'object') {
    try { return instant(Date.prototype.getTime.call(value)); } catch { return null; }
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  if (+year < 1970 || +month < 1 || +month > 12 || +day < 1
    || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
    || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 14 || +zone.slice(4) > 59
    || (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0))) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

function isTest(order) {
  return order.planCode === 'hl_payment_probe'
    || /^payment_probe_user_/i.test(String(order._id || ''))
    || ['paymentTestPlanCode', 'paymentTestRunId'].some(key => order[key] !== undefined && order[key] !== null && order[key] !== '')
    || ['isTest', 'isDemo', 'testMode'].some(key => order[key] === true || order[key] === 1 || order[key] === 'true')
    || ['source', 'dataSource', 'origin'].some(key => ['test', 'demo', 'seed', 'sandbox', 'probe', 'mock'].includes(order[key]));
}

function productSnapshot(order) {
  const code = typeof order.planCode === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(order.planCode) ? order.planCode : 'unknown';
  const title = typeof order.planTitle === 'string' && order.planTitle.trim() && order.planTitle.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(order.planTitle) ? order.planTitle : '未记录套餐名称';
  const productType = order.productType === undefined || order.productType === '' ? 'legacy'
    : ['vip', 'matchmaking'].includes(order.productType) ? order.productType : 'unknown';
  return { code, title, productType, incomplete: code === 'unknown' || title === '未记录套餐名称' || productType === 'unknown' };
}

function aggregateRevenueStatistics({ orders, now, days = 30 } = {}) {
  const end = instant(now);
  if (!Array.isArray(orders) || ![7, 30, 90].includes(days) || end === null) {
    const error = new TypeError('收款统计需完整订单数组、明确截至时间及7/30/90天范围');
    error.code = 40001; error.status = 400; throw error;
  }
  const start = Math.floor((end + OFFSET) / DAY) * DAY - OFFSET - (days - 1) * DAY;
  const date = time => new Date(time + OFFSET).toISOString().slice(0, 10);
  const inWindow = time => time !== null && time >= start && time <= end;
  const relevant = time => time === null || inWindow(time);
  const quality = { complete: true, paidComplete: true, refundComplete: true, productsComplete: true,
    inputRecords: orders.length, excludedOrders: 0, excludedCounts: {}, issues: [], issuesTruncated: 0,
    deduplicatedPayments: 0, deduplicatedRefunds: 0, fulfillmentReviewTransactions: 0, additionalVirtualTransactions: 0,
    timezone: 'Asia/Shanghai', refundTimeBasis: 'local_refundedAt', scope: 'supplied_complete_order_snapshot',
    window: { days, from: new Date(start).toISOString(), to: new Date(end).toISOString(), fromDate: date(start), toDate: date(end) },
    limitations: ['退款归期使用本地refundedAt，并非微信实际退款完成日', '只支持已核验全额退款；不支持部分、多次或重复付款售后结案统计',
      '旧JSAPI/internal确认记录缺少独立可信证据时列为待核验', '净收款不代表会计收入、手续费后金额或结算到账'] };
  const count = code => { quality.excludedCounts[code] = (quality.excludedCounts[code] || 0) + 1; };
  function issue(code, order, scope = 'none', time = null) {
    count(code);
    if (relevant(time)) {
      if (scope === 'paid') quality.paidComplete = false;
      if (scope === 'refund') quality.refundComplete = false;
      if (scope === 'product') quality.productsComplete = false;
    }
    if (quality.issues.length < 100) quality.issues.push({ code, scope,
      recordRef: ref(record(order) ? order.outTradeNo || order._id || 'missing_order_identity' : 'invalid_order') });
    else quality.issuesTruncated++;
  }
  const payments = [], refunds = [], paymentClaims = new Map(), refundClaims = new Map(), businessClaims = new Map(), cashierClaims = new Map();
  const blockedKeys = new Set();
  const claim = (map, key, fingerprint) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(fingerprint);
  };
  function namespace(order) {
    if (!['virtual', 'jsapi'].includes(order.paymentProvider) || !identifier(order.merchantId)
      || !identifier(order.appId) || order.currency !== 'CNY') return null;
    return signature([order.paymentProvider, order.merchantId, order.appId,
      order.paymentProvider === 'virtual' ? order.virtualPaymentEnv : 'production']);
  }
  function paymentClaim(order, ns, tx, amount, time, cashier, product) {
    if (!ns || !transaction(tx)) return null;
    const key = signature([ns, tx]);
    // Include owner and original product snapshot: an identical transaction must
    // never be allocated to a second business order/user or a different price.
    const fingerprint = signature([order.outTradeNo, order.userId, order.payerOpenid,
      amount, time, cashier, product.code, product.title, product.productType,
      order.durationDays, order.serviceCount, order.virtualPaymentOfferId]);
    claim(paymentClaims, key, fingerprint);
    if (identifier(cashier)) claim(cashierClaims, signature([ns, cashier]), key);
    return key;
  }
  function unresolvedExtras(order) {
    if (order.duplicateVirtualPayments === undefined) return;
    if (!Array.isArray(order.duplicateVirtualPayments)) { issue('unverified_duplicate_parent', order, 'paid'); return; }
    for (const extra of order.duplicateVirtualPayments) {
      const time = record(extra) && positive(extra.paidTime) && Number.isSafeInteger(extra.paidTime * 1000)
        ? instant(extra.paidTime * 1000) : null;
      issue('unverified_duplicate_parent', order, 'paid', time);
    }
  }
  for (const order of orders) {
    if (!record(order)) { quality.excludedOrders++; issue('invalid_order', order, 'paid'); continue; }
    if (isTest(order)) { quality.excludedOrders++; count('test_or_probe'); continue; }
    if (order.paymentProvider === 'virtual' && order.virtualPaymentEnv === 1) {
      quality.excludedOrders++; count('sandbox'); continue;
    }
    if (NON_PAID.has(order.status)) { quality.excludedOrders++; count('non_paid_status'); continue; }
    const paidTime = instant(order.paidAt), refundTime = instant(order.refundedAt);
    if (!['paid', 'refunded'].includes(order.status)) {
      quality.excludedOrders++; issue('unknown_payment_status', order, 'paid', paidTime); unresolvedExtras(order); continue;
    }
    const product = productSnapshot(order), ns = namespace(order);
    const key = paymentClaim(order, ns, order.transactionId, order.amountFen, paidTime, order.virtualPaidAttemptNo || '', product);
    const reject = code => {
      quality.excludedOrders++; issue(code, order, 'paid', paidTime);
      unresolvedExtras(order);
      if (order.status === 'refunded') issue('unverified_original_payment_for_refund', order, 'refund', refundTime);
    };
    if (!ns || !identifier(order.outTradeNo) || !positive(order.userId) || !identifier(order.payerOpenid)) {
      reject('missing_payment_identity'); continue;
    }
    claim(businessClaims, order.outTradeNo, signature([ns, order.userId, order.payerOpenid, order.virtualPaymentOfferId,
      order.amountFen, product.code, product.title, product.productType, order.durationDays, order.serviceCount]));
    if (order.paymentProvider !== 'virtual') { reject('unverified_legacy_channel'); continue; }
    if (order.virtualPaymentEnv !== 0) { reject('unknown_virtual_environment'); continue; }
    if (!SOURCES.has(order.confirmationSource)) { reject('unverified_confirmation_source'); continue; }
    const attempts = order.virtualPaymentAttempts === undefined ? [] : order.virtualPaymentAttempts;
    const attemptMap = new Map();
    let attemptConflict = !Array.isArray(attempts);
    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      if (!record(attempt) || !identifier(attempt.outTradeNo) || attempt.env !== 0
        || !identifier(attempt.offerId) || attempt.offerId !== order.virtualPaymentOfferId || attemptMap.has(attempt.outTradeNo)) {
        attemptConflict = true; break;
      }
      attemptMap.set(attempt.outTradeNo, attempt);
    }
    if (attemptConflict || (order.virtualPaidAttemptNo && !attemptMap.has(order.virtualPaidAttemptNo))) {
      if (key) blockedKeys.add(key);
      reject('payment_attempt_identity_conflict'); continue;
    }
    if (!key || !positive(order.amountFen)) { reject('invalid_payment_amount_or_transaction'); continue; }
    if (paidTime === null) { reject('missing_or_invalid_paid_time'); continue; }
    if (paidTime > end) count('payment_after_cutoff');
    const base = { order, key, ns, product, time: paidTime, amount: order.amountFen, extra: false };
    payments.push(base);
    const duplicateRows = order.duplicateVirtualPayments === undefined ? [] : order.duplicateVirtualPayments;
    if (!Array.isArray(duplicateRows)) issue('invalid_duplicate_payments', order, 'paid');
    for (const duplicate of Array.isArray(duplicateRows) ? duplicateRows : []) {
      const time = record(duplicate) && positive(duplicate.paidTime) && Number.isSafeInteger(duplicate.paidTime * 1000)
        ? instant(duplicate.paidTime * 1000) : null;
      const extraKey = record(duplicate) ? paymentClaim(order, ns, duplicate.transactionId,
        duplicate.amountFen, time, duplicate.paymentAttemptNo || '', product) : null;
      if (!record(duplicate) || !extraKey || !positive(duplicate.amountFen) || duplicate.amountFen !== order.amountFen
        || !attemptMap.has(duplicate.paymentAttemptNo) || time === null
        || ['merchantId', 'appId', 'paymentProvider'].some(field => duplicate[field] !== undefined && duplicate[field] !== order[field])
        || (duplicate.env !== undefined && duplicate.env !== 0)
        || (duplicate.virtualPaymentEnv !== undefined && duplicate.virtualPaymentEnv !== 0)
        || (duplicate.offerId !== undefined && duplicate.offerId !== order.virtualPaymentOfferId)
        || (duplicate.virtualPaymentOfferId !== undefined && duplicate.virtualPaymentOfferId !== order.virtualPaymentOfferId)
        || (duplicate.confirmationSource !== undefined && !SOURCES.has(duplicate.confirmationSource))) {
        issue('unverified_duplicate_payment', order, 'paid', time); continue;
      }
      if (time > end) { count('payment_after_cutoff'); continue; }
      payments.push({ ...base, key: extraKey, amount: duplicate.amountFen, time, extra: true });
    }
    if (order.status === 'refunded') {
      const refundKey = identifier(order.refundId) && order.refundId.length >= 8 && order.refundId.length <= 96
        ? signature([ns, order.refundId]) : null;
      if (refundKey) claim(refundClaims, refundKey, signature([key, order.refundAmountFen, refundTime]));
      if (!refundKey || !positive(order.refundAmountFen) || order.refundAmountFen !== order.amountFen
        || refundTime === null || refundTime < paidTime || order.refundSource !== 'virtual_order_query'
        || !Array.isArray(duplicateRows) || duplicateRows.length || order.reviewReason === 'duplicate_payment') {
        issue('unverified_full_refund', order, 'refund', refundTime); continue;
      }
      if (refundTime > end) { count('refund_after_cutoff'); continue; }
      refunds.push({ ...base, refundKey, time: refundTime, amount: order.refundAmountFen });
    } else if (order.refundId || order.refundAmountFen || order.refundedAt) {
      issue('refund_status_conflict', order, 'refund', refundTime);
    }
  }
  const conflictedBusinesses = new Set([...businessClaims].filter(([, values]) => values.size > 1).map(([key]) => key));
  for (const keys of cashierClaims.values()) if (keys.size > 1) for (const key of keys) blockedKeys.add(key);
  const verifiedPayments = new Map();
  for (const payment of payments) {
    if (blockedKeys.has(payment.key) || paymentClaims.get(payment.key).size > 1 || conflictedBusinesses.has(payment.order.outTradeNo)) {
      issue('transaction_identity_or_amount_conflict', payment.order, 'paid', payment.time); continue;
    }
    if (verifiedPayments.has(payment.key)) { quality.deduplicatedPayments++; continue; }
    verifiedPayments.set(payment.key, payment);
  }
  const refundIdsByTransaction = new Map();
  for (const refund of refunds) claim(refundIdsByTransaction, refund.key, refund.refundKey);
  const verifiedRefunds = new Map();
  for (const refund of refunds) {
    if (!verifiedPayments.has(refund.key) || refundClaims.get(refund.refundKey).size > 1
      || refundIdsByTransaction.get(refund.key).size > 1) {
      issue('refund_transaction_conflict', refund.order, 'refund', refund.time); continue;
    }
    if (verifiedRefunds.has(refund.refundKey)) { quality.deduplicatedRefunds++; continue; }
    verifiedRefunds.set(refund.refundKey, refund);
  }
  const buckets = Array.from({ length: days }, (_, index) => ({ date: date(start + index * DAY), paid: 0n, refund: 0n }));
  const productBuckets = new Map();
  let paid = 0n, refund = 0n, paidTransactions = 0, refundTransactions = 0;
  function add(item, kind) {
    if (!inWindow(item.time)) return;
    if (item.product.incomplete) issue('missing_product_snapshot', item.order, 'product', item.time);
    const productKey = JSON.stringify([item.product.code, item.product.title, item.product.productType]);
    if (!productBuckets.has(productKey)) productBuckets.set(productKey, { ...item.product, paid: 0n, refund: 0n });
    const amount = BigInt(item.amount);
    productBuckets.get(productKey)[kind] += amount;
    buckets[Math.floor((item.time - start) / DAY)][kind] += amount;
    if (kind === 'paid') {
      paid += amount; paidTransactions++;
      if (item.extra) quality.additionalVirtualTransactions++;
      if (item.order.fulfillmentStatus === 'requires_review') quality.fulfillmentReviewTransactions++;
    } else { refund += amount; refundTransactions++; }
  }
  for (const payment of verifiedPayments.values()) add(payment, 'paid');
  for (const payment of verifiedRefunds.values()) add(payment, 'refund');
  if (paid > MAX) issue('paid_safe_integer_overflow', null, 'paid');
  if (refund > MAX) issue('refund_safe_integer_overflow', null, 'refund');
  const safe = value => value <= MAX && value >= -MAX ? Number(value) : null;
  quality.knownTotals = { paidFen: safe(paid), refundFen: safe(refund), netFen: safe(paid - refund), paidTransactions, refundTransactions };
  quality.complete = quality.paidComplete && quality.refundComplete && quality.productsComplete;
  quality.issues.sort((a, b) => a.code.localeCompare(b.code) || a.recordRef.localeCompare(b.recordRef) || a.scope.localeCompare(b.scope));
  const amounts = item => ({ paidFen: quality.paidComplete ? safe(item.paid) : null,
    refundFen: quality.refundComplete ? safe(item.refund) : null,
    netFen: quality.paidComplete && quality.refundComplete ? safe(item.paid - item.refund) : null });
  return { ...amounts({ paid, refund }), paidTransactions: quality.paidComplete ? paidTransactions : null,
    refundTransactions: quality.refundComplete ? refundTransactions : null,
    trend: buckets.map(item => ({ date: item.date, ...amounts(item) })),
    products: [...productBuckets.values()].sort((a, b) => a.code.localeCompare(b.code) || a.title.localeCompare(b.title)
      || a.productType.localeCompare(b.productType)).map(item => ({ code: item.code, title: item.title, productType: item.productType, ...amounts(item) })), quality };
}

module.exports = { aggregateRevenueStatistics };
