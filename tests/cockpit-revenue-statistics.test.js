'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateRevenueStatistics: aggregate } = require('../cloudfunctions/hlApi/cockpit-revenue-statistics');
const NOW = '2026-10-14T04:00:00.000Z'; // Beijing noon.
const PAID = '2026-10-12T08:00:00.000Z';
const REFUNDED = '2026-10-14T01:00:00.000Z';
function order(number = 1, patch = {}) {
  const attempt = `HLAfixture_attempt_${number}`;
  return { _id: `payment_order_${number}`, id: number, outTradeNo: `HLMfixture_order_${number}`, userId: number,
    payerOpenid: `fixture_payer_${number}`, merchantId: 'merchant-fixture-001', appId: 'wx1234567890abcdef', currency: 'CNY',
    paymentProvider: 'virtual', virtualPaymentEnv: 0, virtualPaymentOfferId: '1234567890',
    virtualPaidAttemptNo: attempt,
    virtualPaymentAttempts: [{ outTradeNo: attempt, env: 0, offerId: '1234567890' }],
    status: 'paid', confirmationSource: 'wechat_push', transactionId: `fixture_transaction_${number}`,
    paidAt: PAID, amountFen: 6160, planCode: 'vip_week', planTitle: 'VIP周卡', productType: 'vip', durationDays: 7,
    fulfillmentStatus: 'fulfilled', ...patch };
}
function refunded(number = 1, patch = {}) {
  return order(number, { status: 'refunded', refundId: `fixture_refund_${number}`,
    refundAmountFen: 6160, refundedAt: REFUNDED, refundSource: 'virtual_order_query', ...patch });
}
const run = (orders, options = {}) => aggregate({ orders, now: NOW, days: 7, ...options });
function withDuplicate(patch = {}) {
  const row = order(1, { fulfillmentStatus: 'requires_review', reviewReason: 'duplicate_payment' });
  row.virtualPaymentAttempts.push({ outTradeNo: 'HLAfixture_duplicate', env: 0, offerId: '1234567890' });
  row.duplicateVirtualPayments = [{ paymentAttemptNo: 'HLAfixture_duplicate', transactionId: 'fixture_extra_transaction',
    amountFen: 6160, paidTime: Date.parse('2026-10-13T08:00:00Z') / 1000, ...patch }];
  return row;
}

test('complete empty snapshot is an actual zero with one bucket per Beijing day', () => {
  const result = run([]);
  assert.deepEqual([result.paidFen, result.refundFen, result.netFen, result.paidTransactions, result.refundTransactions], [0, 0, 0, 0, 0]);
  assert.equal(result.quality.complete, true);
  assert.deepEqual(result.trend.map(item => item.date), ['2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14']);
  assert.ok(result.trend.every(item => item.paidFen === 0 && item.refundFen === 0 && item.netFen === 0));
  assert.deepEqual(result.products, []);
});

test('requires_review does not erase a verified collection, and product prices use the order snapshot', () => {
  const result = run([order(1, { fulfillmentStatus: 'requires_review', amountFen: 12345, planTitle: '历史周卡' })]);
  assert.equal(result.paidFen, 12345);
  assert.equal(result.paidTransactions, 1);
  assert.equal(result.quality.fulfillmentReviewTransactions, 1);
  assert.deepEqual(result.products, [{ code:'vip_week', title:'历史周卡', productType:'vip', paidFen:12345, refundFen:0, netFen:12345 }]);
  assert.equal(result.quality.complete, true);
});

test('explicit sandbox/probe/test/demo and nonpaid states are excluded without excluding the real vip_week plan', () => {
  const result = run([order(1), order(2, { virtualPaymentEnv:1 }), order(3, { planCode:'hl_payment_probe' }),
    order(4, { paymentTestPlanCode:'vip_week' }), order(5, { paymentTestRunId:'accepted_test_run' }),
    order(6, { _id:'payment_probe_user_6_run_prior_archive' }), order(7, { isDemo:true }), order(8, { source:'demo' }),
    ...['pending','confirming','closed','failed'].map((status, index) => order(20 + index, {status}))]);
  assert.equal(result.paidFen, 6160);
  assert.equal(result.paidTransactions, 1);
  assert.equal(result.quality.excludedOrders, 11);
  assert.equal(result.quality.complete, true);
});

test('internal or missing confirmation evidence remains unknown, never a synthetic zero', () => {
  for (const confirmationSource of ['internal', '', null, undefined, 'client_success']) {
    const result = run([order(1, {confirmationSource})]);
    assert.equal(result.paidFen, null);
    assert.equal(result.netFen, null);
    assert.equal(result.paidTransactions, null);
    assert.equal(result.refundFen, 0);
    assert.equal(result.quality.knownTotals.paidFen, 0);
    assert.equal(result.quality.paidComplete, false);
    assert.ok(result.trend.every(item => item.paidFen === null));
  }
  assert.equal(run([order(1, {confirmationSource:'virtual_query'})]).paidFen, 6160);
});

test('legacy JSAPI records do not acquire trustworthy virtual evidence from a paid flag', () => {
  const result = run([order(1, { paymentProvider:'jsapi', confirmationSource:'internal' })]);
  assert.equal(result.paidFen, null);
  assert.equal(result.quality.excludedCounts.unverified_legacy_channel, 1);
});

test('only explicit numeric production env zero is accepted', () => {
  for (const virtualPaymentEnv of ['0', undefined, null, false, 2, -1]) {
    const result = run([order(1, {virtualPaymentEnv})]);
    assert.equal(result.paidFen, null);
    assert.equal(result.quality.paidComplete, false);
  }
});

test('missing merchant/app/currency/owner/transaction identity cannot silently count as real receipts', () => {
  for (const patch of [{merchantId:''},{appId:undefined},{currency:'USD'},{payerOpenid:''},{userId:0},
    {transactionId:''},{outTradeNo:''}]) {
    assert.equal(run([order(1, patch)]).paidFen, null);
  }
});

test('receipt amounts require positive safe integer fen, without coercion', () => {
  for (const amountFen of [0,-1,0.5,'6160',null,true,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1,1n,{}]) {
    assert.equal(run([order(1, {amountFen})]).paidFen, null);
  }
});

test('the explicit as-of instant accepts a server Date across isolated runtime contexts', () => {
  const vm=require('node:vm');
  const result=run([order()],{now:vm.runInNewContext('new Date("2026-10-14T04:00:00.000Z")')});
  assert.equal(result.paidFen,6160);
  assert.equal(result.quality.window.to,NOW);
});

test('invalid, missing and unzoned payment times remain unverified', () => {
  for (const paidAt of [null,'','2026-10-12','2026-10-12T08:00:00','2026-02-30T08:00:00Z','2026-10-12T25:00:00Z','2026-10-12T08:00:00+24:00']) {
    assert.equal(run([order(1, {paidAt})]).paidFen, null);
  }
});

test('the rolling interval uses Beijing midnight and an inclusive as-of cutoff', () => {
  const result = run([
    order(1, {paidAt:'2026-10-07T15:59:59.999Z'}), // before Beijing Oct 8.
    order(2, {paidAt:'2026-10-07T16:00:00.000Z'}),
    order(3, {paidAt:'2026-10-14T12:00:00+08:00'}),
    order(4, {paidAt:'2026-10-14T04:00:00.001Z'})
  ]);
  assert.equal(result.paidFen, 12320);
  assert.equal(result.trend[0].paidFen, 6160);
  assert.equal(result.trend[6].paidFen, 6160);
  assert.equal(result.quality.window.from, '2026-10-07T16:00:00.000Z');
  assert.equal(result.quality.complete, true);
  for (const days of [7,30,90]) assert.equal(run([], {days}).trend.length, days);
});

test('a full verified refund preserves original payment and uses its local processing date', () => {
  const result = run([refunded()]);
  assert.deepEqual([result.paidFen,result.refundFen,result.netFen,result.paidTransactions,result.refundTransactions], [6160,6160,0,1,1]);
  assert.equal(result.trend.find(item => item.date === '2026-10-12').paidFen, 6160);
  assert.equal(result.trend.find(item => item.date === '2026-10-14').refundFen, 6160);
  assert.equal(result.products[0].refundFen, 6160);
  assert.equal(result.quality.refundTimeBasis, 'local_refundedAt');
  assert.ok(result.quality.limitations.some(item => item.includes('并非微信实际')));
});

test('a current refund for an earlier payment produces negative net collections', () => {
  const result = run([refunded(1, {paidAt:'2026-09-01T08:00:00Z'})]);
  assert.deepEqual([result.paidFen,result.refundFen,result.netFen], [0,6160,-6160]);
  assert.equal(result.products[0].netFen, -6160);
});

test('partial or unsupported/missing refund proof withholds refund totals while retaining verified paid totals', () => {
  for (const patch of [{refundAmountFen:100},{refundAmountFen:'6160'},{refundId:''},{refundedAt:null},
    {refundSource:'internal'},{refundSource:'verified_provider'},{refundedAt:'2026-10-11T08:00:00Z'}]) {
    const result = run([refunded(1, patch)]);
    assert.equal(result.paidFen, 6160);
    assert.equal(result.refundFen, null);
    assert.equal(result.netFen, null);
    assert.equal(result.quality.refundComplete, false);
  }
});

test('a refunded order without a verified original cannot substantiate either side', () => {
  const result = run([refunded(1, {confirmationSource:'internal'})]);
  assert.equal(result.paidFen, null);
  assert.equal(result.refundFen, null);
});

test('consistent snapshots deduplicate both transaction and full refund by their provider-scoped identifiers', () => {
  const a = refunded(), b = structuredClone(a); b._id='another_document_copy';
  const result = run([a,b]);
  assert.equal(result.paidFen, 6160);
  assert.equal(result.refundFen, 6160);
  assert.equal(result.quality.deduplicatedPayments, 1);
  assert.equal(result.quality.deduplicatedRefunds, 1);
  assert.equal(result.quality.complete, true);
});

test('transaction ids on different merchant/AppID namespaces do not collide', () => {
  const result = run([order(1), order(2, {transactionId:'fixture_transaction_1', appId:'wxabcdef1234567890'}),
    order(3, {transactionId:'fixture_transaction_1',merchantId:'different-merchant'})]);
  assert.equal(result.paidFen, 18480);
  assert.equal(result.paidTransactions, 3);
});

test('same transaction with conflicting price, business ownership, payer, time or product is excluded in both input orders', () => {
  for (const patch of [{amountFen:100},{outTradeNo:'HLManother_business'}, {userId:99},{payerOpenid:'different_payer'},
    {paidAt:'2026-10-13T08:00:00Z'},{planCode:'vip_month'},{amountFen:'6160'}]) {
    const first = order(), second = {...first,...patch};
    for (const input of [[first,second],[second,first]]) {
      const result = run(input);
      assert.equal(result.paidFen, null);
      assert.equal(result.quality.knownTotals.paidFen, 0);
      assert.ok(result.quality.excludedCounts.transaction_identity_or_amount_conflict >= 1);
    }
  }
});

test('one business order cannot silently switch merchant/AppID identity between snapshots', () => {
  const result = run([order(),order(1,{appId:'wxabcdef1234567890', transactionId:'another_transaction'})]);
  assert.equal(result.paidFen, null);
  assert.equal(result.quality.knownTotals.paidFen, 0);
});

test('different transaction ids do not legitimize conflicting original prices for one business order', () => {
  const result = run([order(),order(1,{transactionId:'another_transaction',amountFen:9900})]);
  assert.equal(result.paidFen,null);
  assert.equal(result.quality.knownTotals.paidFen,0);
});

test('recorded extra verified virtual transactions are additional money, not an extra entitlement or a business-order count', () => {
  const row=withDuplicate(); row.duplicateVirtualPayments.push(structuredClone(row.duplicateVirtualPayments[0]));
  const result = run([row]);
  assert.equal(result.paidFen, 12320);
  assert.equal(result.paidTransactions, 2);
  assert.equal(result.quality.additionalVirtualTransactions, 1);
  assert.equal(result.quality.fulfillmentReviewTransactions, 2);
  assert.equal(result.quality.deduplicatedPayments, 1);
  assert.equal(result.trend.find(item => item.date==='2026-10-13').paidFen, 6160);
});

test('attempt env/offer/pointer conflicts fail closed, including mixed production and sandbox attempts', () => {
  for (const patch of [{env:1},{env:'0'},{offerId:'different-offer'}]) {
    const row=withDuplicate(); Object.assign(row.virtualPaymentAttempts[1],patch);
    const result=run([row]); assert.equal(result.paidFen,null);
    assert.equal(result.quality.knownTotals.paidFen,0);
    assert.equal(result.quality.excludedCounts.payment_attempt_identity_conflict,1);
  }
  assert.equal(run([order(1,{virtualPaidAttemptNo:'HLAunknown_pointer'})]).paidFen,null);
});

test('extra payment amount/time/identity/attempt evidence cannot be forged or inherited when absent', () => {
  for (const patch of [{amountFen:1},{amountFen:'6160'},{paidTime:null},{paymentAttemptNo:'unknown_attempt'},
    {merchantId:'other-merchant'},{appId:'other-app'},{env:1},{virtualPaymentEnv:1},{offerId:'other-offer'},
    {virtualPaymentOfferId:'other-offer'},{confirmationSource:'internal'}]) {
    const result = run([withDuplicate(patch)]);
    assert.equal(result.paidFen,null);
    assert.equal(result.quality.knownTotals.paidFen,6160);
    assert.equal(result.quality.additionalVirtualTransactions,0);
  }
});

test('a historical unverified parent does not hide a current extra payment behind the original old paid date', () => {
  const row = withDuplicate(); row.paidAt='2026-09-01T08:00:00Z'; row.confirmationSource='internal';
  const result = run([row]);
  assert.equal(result.paidFen,null);
  assert.equal(result.quality.knownTotals.paidFen,0);
  assert.equal(result.quality.excludedCounts.unverified_duplicate_parent,1);
});

test('an original transaction after the cutoff does not hide an earlier verified extra transaction', () => {
  const row=withDuplicate(); row.paidAt='2026-10-14T04:00:00.001Z';
  const result=run([row]);
  assert.equal(result.paidFen,6160);
  assert.equal(result.paidTransactions,1);
  assert.equal(result.quality.additionalVirtualTransactions,1);
});

test('an extra transaction id owned by another business order conflicts rather than silently deduplicating it', () => {
  const result = run([withDuplicate(), order(2,{transactionId:'fixture_extra_transaction',paidAt:'2026-10-13T08:00:00Z'})]);
  assert.equal(result.paidFen,null);
  assert.equal(result.quality.knownTotals.paidFen,6160);
});

test('one provider cashier number cannot substantiate two different payment transactions', () => {
  const primaryConflict=withDuplicate({paymentAttemptNo:'HLAfixture_attempt_1'});
  const first=run([primaryConflict]);
  assert.equal(first.paidFen,null); assert.equal(first.quality.knownTotals.paidFen,0);
  const extraConflict=withDuplicate(); extraConflict.duplicateVirtualPayments.push({
    ...extraConflict.duplicateVirtualPayments[0],transactionId:'second_conflicting_extra_transaction'});
  const second=run([extraConflict]);
  assert.equal(second.paidFen,null); assert.equal(second.quality.knownTotals.paidFen,6160);
});

test('duplicate-payment aftersales are not invented as verified single full refunds', () => {
  const row=withDuplicate(); Object.assign(row,refunded(),{virtualPaymentAttempts:row.virtualPaymentAttempts,
    duplicateVirtualPayments:row.duplicateVirtualPayments,reviewReason:'duplicate_payment'});
  const result=run([row]);
  assert.equal(result.paidFen,12320);
  assert.equal(result.refundFen,null);
});

test('the same refund identifier cannot be allocated to two original transactions', () => {
  const result=run([refunded(1),refunded(2,{refundId:'fixture_refund_1'})]);
  assert.equal(result.paidFen,12320);
  assert.equal(result.refundFen,null);
  assert.equal(result.quality.knownTotals.refundFen,0);
});

test('two distinct purported full refunds for one transaction require review', () => {
  const result=run([refunded(1),refunded(1,{refundId:'fixture_second_refund'})]);
  assert.equal(result.paidFen,6160);
  assert.equal(result.refundFen,null);
});

test('missing historical product type remains legacy and missing classification is explicit without erasing real cash', () => {
  const legacy=run([order(1,{productType:undefined,planCode:'retired_30d',planTitle:'已停售月卡',amountFen:9900})]);
  assert.equal(legacy.products[0].productType,'legacy'); assert.equal(legacy.paidFen,9900);
  const missing=run([order(1,{planCode:'',planTitle:''})]);
  assert.equal(missing.paidFen,6160); assert.equal(missing.products[0].code,'unknown');
  assert.equal(missing.quality.productsComplete,false); assert.equal(missing.quality.complete,false);
});

test('aggregate arithmetic never rounds an unsafe integer total', () => {
  const result=run([order(1,{amountFen:Number.MAX_SAFE_INTEGER}),order(2,{amountFen:1})]);
  assert.equal(result.paidFen,null); assert.equal(result.netFen,null);
  assert.equal(result.quality.knownTotals.paidFen,null);
  assert.equal(result.quality.excludedCounts.paid_safe_integer_overflow,1);
});

test('invalid options cannot turn missing input or an unsupported window into an empty successful response', () => {
  for (const args of [{},{orders:null,now:NOW},{orders:[],now:'2026-10-14'},{orders:[],now:'2026-02-30T00:00:00Z'},
    {orders:[],now:NOW,days:14},{orders:[],now:NOW,days:'30'}]) {
    assert.throws(()=>aggregate(args),error=>error.status===400&&error.code===40001);
  }
});

test('projection is immutable and diagnostics expose only bounded hashed audit references', () => {
  const input=[order(1),order(2,{confirmationSource:'internal'})];const before=structuredClone(input);
  const result=run(input); assert.deepEqual(input,before);
  const json=JSON.stringify(result);
  for (const privateValue of ['fixture_payer_2','fixture_transaction_2','HLMfixture_order_2','merchant-fixture-001']) assert.ok(!json.includes(privateValue));
  assert.match(result.quality.issues[0].recordRef,/^[a-f0-9]{16}$/);
  const noisy=run(Array.from({length:150},(_,index)=>order(index+1,{confirmationSource:'internal'})));
  assert.equal(noisy.quality.issues.length,100);assert.equal(noisy.quality.issuesTruncated,50);
});
