'use strict';

// Product terms stay independent of merchant credentials and payment clients.
// Read-only administration and role services can validate this contract safely.
const MATCHMAKER_LIFETIME_PLAN = Object.freeze({
  planCode: 'matchmaker_lifetime', title: '主理人永久开通', productType: 'matchmaker',
  amountFen: 698000, durationDays: 0, lifetime: true, serviceCount: 0,
  active: true, description: '一次付费开通主理人工作台，无使用期限', badge: '永久', sortOrder: 0
});

function assertMatchmakerLifetimeProduct(row = {}) {
  if (row.productType !== MATCHMAKER_LIFETIME_PLAN.productType
    || row.planCode !== MATCHMAKER_LIFETIME_PLAN.planCode
    || row.amountFen !== MATCHMAKER_LIFETIME_PLAN.amountFen
    || row.durationDays !== 0 || row.lifetime !== true || row.serviceCount !== 0) {
    const error = new Error('主理人开通商品规则无效');
    error.code = 40001;
    throw error;
  }
  return true;
}

module.exports = { MATCHMAKER_LIFETIME_PLAN, assertMatchmakerLifetimeProduct };
