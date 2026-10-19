'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js');
const requireFromApi = createRequire(apiPath);
const merchant = require('../cloudfunctions/hlApi/payment-merchant-config.json');
const identity = { merchantId: merchant.merchantId, appId: merchant.appId, currency: merchant.currency };
const ORDER_NO = 'HLM202610110000000001';
const ATTEMPT_NO = 'HLAfixtureattempt000000001';
const OPENID = 'fixture-virtual-payer-1';
const TRANSACTION_ID = 'fixture-virtual-transaction-001';
const ENV = { NODE_ENV: 'test', SEED_DATA: 'false', DEMO_MEMBERS: 'false',
  VPAY_OFFER_ID: '1450674507', VPAY_ENV: '0', VPAY_APP_KEY: 'fixture-vpay-app-key-0123456789',
  VPAY_SANDBOX_APP_KEY: 'fixture-sandbox-app-key-0123456789', WX_APP_SECRET: 'fixture-app-secret-0123456789',
  PAYMENT_CALLBACK_TOKEN: 'fixture-callback-token-01234567890123456789', PAYMENT_INTEGRATION_READY: 'true' };

function paidOrder(patch = {}) {
  return { order_id: ATTEMPT_NO, status: 2, order_type: 0, order_fee: 9900, paid_fee: 9900,
    env_type: 1, paid_time: Math.floor(Date.now() / 1000), wxpay_order_id: TRANSACTION_ID, ...patch };
}

function pushEvent(patch = {}) {
  return { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: OPENID,
    OutTradeNo: ATTEMPT_NO, Env: 0, GoodsInfo: { ProductId: 'paid_30d', Quantity: 1, ActualPrice: 9900 }, ...patch };
}

function runtime(options = {}) {
  const rows = {
    hl_users: [{ _id: 'user-1', id: 1, status: 1, authVersion: 1, openid: OPENID, phone: 'fixture-phone' }],
    hl_members: [{ _id: 'member-11', id: 11, userId: 1, matchmakerId: options.reassigned ? 22 : 21,
      status: 1, memberType: 'free', expireAt: null }],
    hl_payment_orders: [{ _id: 'order-1', id: 1, outTradeNo: ORDER_NO, userId: 1, memberRecordId: 11,
      memberMatchmakerId: 21, payerOpenid: OPENID, planCode: 'paid_30d', planTitle: '月度会员',
      amountFen: 9900, durationDays: 30, status: 'confirming', transactionId: '', ...identity,
      paymentProvider: 'virtual', virtualPaymentEnv: 0, virtualPaymentOfferId: ENV.VPAY_OFFER_ID,
      virtualProviderOrderNo: ATTEMPT_NO,
      virtualPaymentAttempts: [{ outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }],
      ...(options.orderPatch || {}) }]
  };
  rows.hl_counters = rows.hl_payment_orders[0].virtualPaymentAttempts.map(attempt => ({
    _id: `virtualPaymentAttempt_${attempt.outTradeNo}`, key: `virtualPaymentAttempt_${attempt.outTradeNo}`,
    orderDocumentId: rows.hl_payment_orders[0]._id, businessOutTradeNo: ORDER_NO, env: attempt.env, offerId: attempt.offerId
  }));
  const writes = [], queries = [], deliveries = [], logs = [];
  let transactionTail = Promise.resolve();
  const env = { ...ENV, ...(options.env || {}) };
  function collection(name) {
    let query = {}, offset = 0, size = 100;
    const ref = {
      where(value) { query = value; return ref; },
      skip(value) { offset = value; return ref; },
      limit(value) { size = value; return ref; },
      async get() { return { data: structuredClone((rows[name] || []).filter(row =>
        Object.entries(query).every(([key, value]) => row[key] === value)).slice(offset, offset + size)) }; },
      doc(id) {
        const current = () => (rows[name] || []).find(row => row._id === id);
        return {
          async get() {
            const row = current();
            if (!row) throw Object.assign(new Error('document does not exist'), { errCode: 'DOCUMENT_NOT_EXIST' });
            return { data: structuredClone(row) };
          },
          async set({ data }) {
            if (Object.hasOwn(data, '_id')) {
              throw Object.assign(new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值'),
                { errCode: -501007, errMsg: 'document.set:fail -501007 invalid parameters. 不能更新_id的值' });
            }
            const list = rows[name] ||= [];
            const index = list.findIndex(row => row._id === id);
            const saved = { ...structuredClone(data), _id: id };
            if (index < 0) list.push(saved); else list[index] = saved;
            writes.push({ name, id, data: structuredClone(data) });
          },
          async update({ data }) {
            if (options.failDeliveryWrite && data.virtualDeliveryStatus === 'confirmed') {
              throw new Error('fixture delivery-status write failure');
            }
            Object.assign(current(), structuredClone(data));
            writes.push({ name, id, data: structuredClone(data) });
          }
        };
      }
    };
    return ref;
  }
  const db = { collection, command: { inc: value => ({ kind: 'inc', value }) }, async createCollection() {},
    runTransaction(callback) {
      const run = transactionTail.then(async () => {
        const saved = structuredClone(rows), count = writes.length;
        try { return await callback({ collection: name => ({ doc: id => collection(name).doc(id) }) }); }
        catch (error) { for (const key of Object.keys(rows)) delete rows[key]; Object.assign(rows, saved); writes.splice(count); throw error; }
      });
      transactionTail = run.catch(() => {});
      return run;
    } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(apiPath, 'utf8') + '\nexports.__test = { tokenService, membership };', {
    module, exports: module.exports, process: { env }, Buffer, setTimeout, clearTimeout,
    console: { log(value) { logs.push(value); }, warn() {}, error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID }) };
      if (name === './auth-policy') {
        const actual = requireFromApi(name);
        return { ...actual, createTokenService: () => actual.createTokenService({ secret: 'fixture-token-secret-01234567890123456789' }) };
      }
      if (name === './virtual-payment-policy') {
        return { ...requireFromApi(name), createVirtualPaymentClient: () => ({
          accessToken: async () => 'fixture-access-token-0123456789',
          queryOrder: async request => { queries.push({ ...request, appSecret: undefined, appKey: undefined });
            return typeof options.query === 'function' ? options.query(request) : options.xpay === undefined ? paidOrder() : structuredClone(options.xpay); },
          notifyProvideGoods: async request => {
            deliveries.push({ ...request, appSecret: undefined, appKey: undefined });
            if (options.notify) await options.notify(request, deliveries.length);
          }
        }) };
      }
      return requireFromApi(name);
    }
  }, { filename: apiPath });
  return { rows, writes, queries, deliveries, logs, env, options,
    push: (event, context) => module.exports.main(event || pushEvent(), context),
    close: data => module.exports.__test.membership.closePayment({ ...identity, callbackToken: ENV.PAYMENT_CALLBACK_TOKEN, paymentProvider: 'virtual',
      outTradeNo: ORDER_NO, payerOpenid: OPENID, amountFen: 9900, tradeState: 'CLOSED', ...data }),
    query: () => module.exports.__test.membership.virtualQuery(1, { outTradeNo: ORDER_NO }) };
}

test('delivery pushes never acknowledge absent, unpaid or invalid provider results as fulfilled', async () => {
  for (const xpay of [null, { status: 1 }, paidOrder({ paid_fee: 1 })]) {
    const r = runtime({ xpay });
    assert.notEqual((await r.push()).ErrCode, 0);
    assert.equal(r.rows.hl_members[0].memberType, 'free');
    assert.equal(r.deliveries.length, 0);
  }
});

test('delivery pushes never acknowledge payments requiring membership review', async () => {
  const r = runtime({ reassigned: true });
  assert.notEqual((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'requires_review');
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  assert.equal(r.deliveries.length, 0);
  assert.notEqual((await r.push()).ErrCode, 0, 'paid review orders do not use the old success shortcut');
});

test('delivery pushes with unknown orders, mismatched goods or missing configuration fail closed', async () => {
  for (const [options, event] of [
    [{}, pushEvent({ OutTradeNo: 'HLM202610119999999999' })],
    [{}, pushEvent({ OpenId: 'fixture-other-payer' })],
    [{}, pushEvent({ GoodsInfo: { ProductId: 'other_plan', Quantity: 1 } })],
    [{ env: { VPAY_APP_KEY: '' } }, pushEvent()]
  ]) {
    const r = runtime(options);
    assert.notEqual((await r.push(event)).ErrCode, 0);
    assert.equal(r.rows.hl_members[0].memberType, 'free');
    assert.equal(r.deliveries.length, 0);
  }
});

test('query fulfillment confirms provider delivery and duplicate queries never extend membership twice', async () => {
  const r = runtime();
  const first = await r.query();
  assert.equal(first.tradeState, 'SUCCESS');
  assert.equal(first.order.fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'confirmed');
  assert.equal(r.deliveries[0].outTradeNo, ATTEMPT_NO);
  assert.equal(r.deliveries[0].env, 0);
  assert.equal(r.rows.hl_payment_orders[0].confirmationSource, 'virtual_query');
  const expiry = r.rows.hl_members[0].expireAt;
  await r.query();
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
  assert.equal(r.deliveries.length, 1);
});

function pushOnlyRuntime(options = {}) {
  return runtime({ ...options, env: { VPAY_ENV: '1', PAYMENT_INTEGRATION_READY: 'false',
    PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: '1', PAYMENT_TEST_RUN_ID: 'push_20261011_2127',
    PAYMENT_TEST_PUSH_ONLY: 'true', PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    ...(options.env || {}) },
    orderPatch: { _id: 'payment_probe_user_1_run_push_20261011_2127', planCode: 'hl_payment_probe',
      planTitle: '微信支付测试', amountFen: 1, durationDays: 1, virtualPaymentEnv: 1,
      virtualPaymentAttempts: [{ outTradeNo: ATTEMPT_NO, env: 1, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }],
      ...(options.orderPatch || {}) },
    xpay: paidOrder({ env_type: 2, order_fee: 1, paid_fee: 1, ...(options.xpay || {}) }) });
}

function sandboxPush(patch = {}) {
  return pushEvent({ Env: 1, GoodsInfo: { ProductId: 'hl_payment_probe', Quantity: 1, ActualPrice: 1 }, ...patch });
}

test('push-only local polling cannot query WeChat or fulfill; real handler context records the first successful push once', async () => {
  const r = pushOnlyRuntime();
  const before = structuredClone(r.rows);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal((await r.query()).tradeState, 'NOTPAY');
  }
  assert.equal(r.queries.length, 0); assert.equal(r.deliveries.length, 0); assert.equal(r.writes.length, 0);
  assert.deepEqual(r.rows, before);
  assert.equal((await r.push(sandboxPush({ request_id: 'forged-payload-request', RequestId: 'also-forged',
    confirmationSource: 'virtual_query', data: { request_id: 'forged-data-request' } }),
  { request_id: 'fixture-platform-request-001' })).ErrCode, 0);
  const order = r.rows.hl_payment_orders[0];
  assert.equal(order.confirmationSource, 'wechat_push');
  assert.equal(order.confirmationRequestId, 'fixture-platform-request-001');
  assert.ok(order.virtualPushHandledAt);
  assert.equal(order.virtualPushRequestId, 'fixture-platform-request-001');
  assert.equal(order.virtualPushOrderNo, ATTEMPT_NO);
  assert.equal(order.virtualDeliveryStatus, 'confirmed');
  const receipt = structuredClone(order), expiry = r.rows.hl_members[0].expireAt, writes = r.writes.length;
  const queries = r.queries.length, deliveries = r.deliveries.length;
  assert.equal((await r.query()).tradeState, 'SUCCESS');
  assert.equal(r.queries.length, queries); assert.equal(r.deliveries.length, deliveries); assert.equal(r.writes.length, writes);
  assert.equal((await r.push(sandboxPush(), { request_id: 'fixture-platform-retry-002' })).ErrCode, 0);
  assert.deepEqual(order, receipt); assert.equal(r.rows.hl_members[0].expireAt, expiry);
  assert.equal(r.deliveries.length, 1); assert.equal(r.writes.length, writes);
  const safeLog = JSON.parse(r.logs[0]);
  assert.deepEqual(Object.keys(safeLog).sort(), ['ACK', 'attempt', 'env', 'event', 'orderId', 'requestId']);
  assert.equal(safeLog.requestId, 'fixture-platform-request-001');
  assert.equal(safeLog.ACK, 0);
  assert.ok(!JSON.stringify(r.logs).includes(OPENID));
  assert.ok(!JSON.stringify(r.logs).includes(TRANSACTION_ID));
});

test('push payloads cannot supply platform request identifiers or replace a prior query confirmation origin', async () => {
  const r = runtime();
  await r.query();
  assert.equal((await r.push(pushEvent({ request_id: 'forged-payload-request', data: { request_id: 'forged-data-request' } }))).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].confirmationSource, 'virtual_query');
  assert.equal(r.rows.hl_payment_orders[0].confirmationRequestId, '');
  assert.equal(r.rows.hl_payment_orders[0].virtualPushRequestId, '');
  assert.equal((await r.push(pushEvent(), { request_id: 'invalid context / request' })).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].virtualPushRequestId, '');
});

test('failed first-push delivery preserves the original confirmation request while a retry records its own successful receipt', async () => {
  const r = pushOnlyRuntime({ notify: async (_request, count) => {
    if (count === 1) throw new Error('fixture first delivery failure');
  } });
  assert.equal((await r.push(sandboxPush(), { request_id: 'fixture-confirming-platform-request' })).ErrCode, -1);
  const order = r.rows.hl_payment_orders[0];
  assert.equal(order.confirmationSource, 'wechat_push');
  assert.equal(order.confirmationRequestId, 'fixture-confirming-platform-request');
  assert.equal(order.virtualPushHandledAt, undefined);
  const expiry = r.rows.hl_members[0].expireAt;
  assert.equal((await r.push(sandboxPush(), { request_id: 'fixture-delivered-platform-retry' })).ErrCode, 0);
  assert.equal(order.confirmationRequestId, 'fixture-confirming-platform-request');
  assert.equal(order.virtualPushRequestId, 'fixture-delivered-platform-retry');
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
  assert.equal(JSON.parse(r.logs[0]).requestId, 'fixture-confirming-platform-request');
  assert.equal(JSON.parse(r.logs[0]).ACK, -1);
  assert.equal(JSON.parse(r.logs[1]).requestId, 'fixture-delivered-platform-retry');
  assert.equal(JSON.parse(r.logs[1]).ACK, 0);
});

test('disabling or expiring isolation restores query compensation and leaves other orders unchanged', async () => {
  for (const patch of [{ PAYMENT_TEST_PUSH_ONLY: 'false' }, { PAYMENT_TEST_RUN_ID: undefined },
    { PAYMENT_TEST_RUN_ID: 'other_run' }, { PAYMENT_TEST_ENABLED: 'false' },
    { PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }]) {
    const r = pushOnlyRuntime({ env: patch });
    assert.equal((await r.query()).tradeState, 'SUCCESS');
    assert.equal(r.rows.hl_payment_orders[0].confirmationSource, 'virtual_query');
    assert.equal(r.queries.length, 1); assert.equal(r.deliveries.length, 1);
  }
  const ordinary = runtime({ env: { PAYMENT_TEST_PUSH_ONLY: 'true' } });
  assert.equal((await ordinary.query()).tradeState, 'SUCCESS');
  assert.equal(ordinary.rows.hl_payment_orders[0].confirmationSource, 'virtual_query');
  const delayed = pushOnlyRuntime({ env: { PAYMENT_TEST_ENABLED: 'false',
    PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await delayed.push(sandboxPush(), { request_id: 'fixture-late-platform-request' })).ErrCode, 0);
  assert.equal(delayed.rows.hl_payment_orders[0].confirmationSource, 'wechat_push');
});

test('provider delivery failures persist as pending and are retried without issuing duplicate rights', async () => {
  const r = runtime({ notify: async (_request, number) => { if (number === 1) throw new Error('fixture provider outage'); } });
  await assert.rejects(r.query, /发货确认/);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'fulfilled');
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'pending');
  const expiry = r.rows.hl_members[0].expireAt;
  const result = await r.query();
  assert.equal(result.tradeState, 'SUCCESS');
  assert.equal(r.deliveries.length, 2);
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'confirmed');
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
});

test('reconcile passes the key selected for the same verified production or sandbox attempt', async () => {
  for (const environment of [0, 1]) {
    const r = runtime({ env: { VPAY_ENV: String(environment) },
      orderPatch: { virtualPaymentEnv: environment, virtualPaymentAttempts: [{ outTradeNo: ATTEMPT_NO,
        env: environment, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }] },
      xpay: paidOrder({ env_type: environment === 1 ? 2 : 1 }),
      notify: async request => {
        assert.equal(request.env, environment);
        assert.equal(request.outTradeNo, ATTEMPT_NO);
        assert.equal(request.appKey, environment === 1 ? ENV.VPAY_SANDBOX_APP_KEY : ENV.VPAY_APP_KEY);
      } });
    await r.query();
    assert.equal(r.deliveries.length, 1);
    const expiry = r.rows.hl_members[0].expireAt;
    await r.query();
    assert.equal(r.deliveries.length, 1);
    assert.equal(r.rows.hl_members[0].expireAt, expiry);
  }
});

test('a failed confirmation-record write retries platform confirmation without repeating membership fulfillment', async () => {
  const options = { failDeliveryWrite: true };
  const r = runtime(options);
  await assert.rejects(r.query, /发货确认/);
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'pending');
  const expiry = r.rows.hl_members[0].expireAt;
  options.failDeliveryWrite = false;
  await r.query();
  assert.equal(r.deliveries.length, 2);
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'confirmed');
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
});

test('verified already-delivered provider state records confirmation without another delivery API call', async () => {
  const r = runtime({ xpay: paidOrder({ status: 4 }) });
  assert.equal((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'confirmed');
  assert.equal(r.deliveries.length, 0);
});

test('refund provider state does not acknowledge a delivery push even when local rights were fulfilled earlier', async () => {
  const r = runtime({ xpay: paidOrder({ status: 8 }), orderPatch: {
    status: 'paid', transactionId: TRANSACTION_ID, fulfillmentStatus: 'fulfilled' } });
  assert.notEqual((await r.push()).ErrCode, 0);
  assert.equal(r.deliveries.length, 0);
});

test('successfully fulfilled delivery pushes acknowledge success only after provider confirmation', async () => {
  const r = runtime();
  assert.equal((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'fulfilled');
  assert.equal(r.deliveries.length, 1);
  const expiry = r.rows.hl_members[0].expireAt;
  assert.equal((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
});

test('historical payment attempts fulfill the business order when the newest attempt is absent', async () => {
  const latest = 'HLV202610110000000002';
  const r = runtime({ orderPatch: { virtualProviderOrderNo: latest,
    virtualPaymentAttempts: [
      { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() },
      { outTradeNo: latest, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }
    ] }, query: async request => request.outTradeNo === ATTEMPT_NO ? paidOrder() : null });
  const result = await r.query();
  assert.equal(result.order.outTradeNo, ORDER_NO);
  assert.equal(result.order.fulfillmentStatus, 'fulfilled');
  assert.equal(r.deliveries[0].outTradeNo, ATTEMPT_NO);
  assert.equal(r.queries.length, 2);
});

test('a closed older attempt cannot close a business order with an unpaid or absent newer attempt', async () => {
  const latest = 'HLV202610110000000002';
  for (const newer of [null, paidOrder({ order_id: latest, status: 1 })]) {
    const r = runtime({ orderPatch: { virtualProviderOrderNo: latest,
      virtualPaymentAttempts: [
        { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() },
        { outTradeNo: latest, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }
      ] }, query: async request => request.outTradeNo === ATTEMPT_NO ? paidOrder({ status: 6 }) : newer });
    if (newer) assert.equal((await r.query()).tradeState, 'NOTPAY');
    else assert.equal((await r.query()).providerOrderAbsent, true);
    assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
  }
});

test('an attempt appended during a CLOSED query prevents stale closure and its later payment still fulfills', async () => {
  const newerNo = 'HLAfixtureattempt000000002';
  let appended = false;
  let newerPaid = false;
  let r;
  r = runtime({ query: async request => {
    if (!appended) {
      appended = true;
      r.rows.hl_payment_orders[0].virtualPaymentAttempts.push({ outTradeNo: newerNo, env: 0,
        offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() });
      r.rows.hl_counters.push({ _id: `virtualPaymentAttempt_${newerNo}`, orderDocumentId: 'order-1',
        businessOutTradeNo: ORDER_NO, env: 0, offerId: ENV.VPAY_OFFER_ID });
    }
    return request.outTradeNo === ATTEMPT_NO ? paidOrder({ status: 6 })
      : newerPaid ? paidOrder({ order_id: newerNo }) : paidOrder({ order_id: newerNo, status: 1 });
  } });
  r.rows.hl_counters.push({ _id: 'paymentPendingUser_1', key: 'paymentPendingUser_1',
    userId: 1, orderDocumentId: 'order-1' });
  await assert.rejects(r.query, error => error.code === 40905 && /支付尝试已变化/.test(error.message));
  assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
  assert.equal(r.rows.hl_payment_orders[0].virtualPaymentAttempts.length, 2);
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, 'order-1');
  assert.equal(r.rows.hl_members[0].memberType, 'free');
  newerPaid = true;
  assert.equal((await r.query()).tradeState, 'SUCCESS');
  assert.equal(r.rows.hl_payment_orders[0].virtualPaidAttemptNo, newerNo);
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'fulfilled');
  assert.equal(r.deliveries[0].outTradeNo, newerNo);
});

test('virtual close requires the exact observed attempt snapshot and never releases the slot on rejection', async () => {
  const r = runtime();
  r.rows.hl_counters.push({ _id: 'paymentPendingUser_1', key: 'paymentPendingUser_1',
    userId: 1, orderDocumentId: 'order-1' });
  for (const data of [{}, { observedVirtualPaymentAttempts: [] }]) {
    await assert.rejects(() => r.close(data), error => error.code === 40905);
    assert.equal(r.rows.hl_payment_orders[0].status, 'confirming');
    assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, 'order-1');
    assert.equal(r.writes.length, 0);
  }
  await r.close({ observedVirtualPaymentAttempts: structuredClone(r.rows.hl_payment_orders[0].virtualPaymentAttempts) });
  assert.equal(r.rows.hl_payment_orders[0].status, 'closed');
  assert.equal(r.rows.hl_counters.find(row => row._id === 'paymentPendingUser_1').orderDocumentId, '');
});

test('a push for an unpaid or absent attempt cannot borrow another attempt payment and shipment proof', async () => {
  const paidAttemptNo = 'HLAfixtureattempt000000002';
  for (const other of [null, paidOrder({ status: 1 })]) {
    const r = runtime({ orderPatch: { virtualPaymentAttempts: [
      { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() },
      { outTradeNo: paidAttemptNo, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }
    ] }, query: async request => request.outTradeNo === ATTEMPT_NO ? other : paidOrder({ order_id: paidAttemptNo }) });
    assert.notEqual((await r.push()).ErrCode, 0);
    assert.equal(r.rows.hl_payment_orders[0].virtualPaidAttemptNo, paidAttemptNo);
    assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryOrderNo, paidAttemptNo);
    assert.equal(r.rows.hl_payment_orders[0].virtualDeliveryStatus, 'confirmed');
    assert.equal(r.deliveries[0].outTradeNo, paidAttemptNo);
    const expiry = r.rows.hl_members[0].expireAt;
    assert.equal((await r.push(pushEvent({ OutTradeNo: paidAttemptNo }))).ErrCode, 0);
    assert.equal(r.rows.hl_members[0].expireAt, expiry);
    assert.equal(r.deliveries.length, 1);
  }
});

test('multiple real payments issue rights once and persist duplicates for review without acknowledging shipment', async () => {
  const duplicateNo = 'HLV202610110000000002';
  const r = runtime({ orderPatch: { virtualProviderOrderNo: duplicateNo,
    virtualPaymentAttempts: [
      { outTradeNo: ATTEMPT_NO, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() },
      { outTradeNo: duplicateNo, env: 0, offerId: ENV.VPAY_OFFER_ID, createdAt: new Date().toISOString() }
    ] }, query: async request => paidOrder({ order_id: request.outTradeNo,
      wxpay_order_id: request.outTradeNo === ATTEMPT_NO ? TRANSACTION_ID : 'fixture-duplicate-transaction-002' }) });
  assert.notEqual((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_payment_orders[0].status, 'paid');
  assert.equal(r.rows.hl_payment_orders[0].paymentReviewRequired, true);
  assert.equal(r.rows.hl_payment_orders[0].fulfillmentStatus, 'requires_review');
  assert.equal(r.rows.hl_payment_orders[0].reviewReason, 'duplicate_payment');
  assert.equal(r.rows.hl_payment_orders[0].duplicateVirtualPayments.length, 1);
  assert.equal(r.rows.hl_payment_orders[0].duplicateVirtualPayments[0].paymentAttemptNo, duplicateNo);
  assert.equal(r.deliveries.length, 0);
  const expiry = r.rows.hl_members[0].expireAt;
  assert.notEqual((await r.push()).ErrCode, 0);
  assert.equal(r.rows.hl_members[0].expireAt, expiry);
  assert.equal(r.rows.hl_payment_orders[0].duplicateVirtualPayments.length, 1);
});
