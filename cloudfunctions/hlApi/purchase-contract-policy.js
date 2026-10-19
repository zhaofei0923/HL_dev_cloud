'use strict';

// The server sets this only on newly created, canonical user-owned purchases.
// An absent marker retains the historical assignment-based payment contract.
const DIRECT_PURCHASE_CONTRACT = 'user_entitlement_v1';
function isDirectPurchaseOrder(order = {}) {
  return order.fulfillmentContract === DIRECT_PURCHASE_CONTRACT
    && ['vip', 'matchmaking', 'matchmaker'].includes(order.productType);
}
function assertPurchaseContract(order = {}) {
  if ((order.fulfillmentContract !== undefined || order.productType === 'matchmaker') && !isDirectPurchaseOrder(order)) {
    throw Object.assign(new Error('订单权益规则无效，请联系工作人员核查'), { status: 409, code: 40907 });
  }
  return isDirectPurchaseOrder(order);
}
module.exports = { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder, assertPurchaseContract };
