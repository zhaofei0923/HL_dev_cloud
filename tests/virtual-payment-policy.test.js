'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildVirtualCloseProof,
  buildVirtualConfirmation,
  buildVirtualRefundProof,
  buildVirtualSignData,
  clientPaymentSignatures,
  createVirtualPaymentClient,
  mapVirtualOrderState,
  serverPaySig,
  validateGoodsDeliverPush,
  virtualPaymentConfig
} = require('../cloudfunctions/hlApi/virtual-payment-policy');
const { paymentProviderConfig } = require('../cloudfunctions/hlApi/membership-payment-policy');

const APP_KEY = 'sandbox-appkey-fixture-0123456789';
const SESSION_KEY = 'sessionKeyFixture+/=_0123456789';
const OFFER_ID = '1450674507';
const ORDER_NO = 'HLM202610110000000001';
const OPENID = 'oFixturePayer0001';
const IDENTITY = { merchantId: '1118515135', appId: 'wx7e5c0f4d07d2f0f8', currency: 'CNY' };

const ENV = {
  VPAY_OFFER_ID: OFFER_ID,
  VPAY_ENV: '0',
  VPAY_APP_KEY: APP_KEY,
  VPAY_SANDBOX_APP_KEY: 'sandbox-other-key-fixture-000000',
  WX_APP_SECRET: 'app-secret-fixture-0123456789012',
  PAYMENT_CALLBACK_TOKEN: 'callback-token-fixture-0123456789012345'
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('virtual payment config requires every credential', () => {
  assert.equal(virtualPaymentConfig(ENV).configured, true);
  assert.equal(virtualPaymentConfig(ENV).env, 0);
  assert.equal(virtualPaymentConfig({ ...ENV, VPAY_OFFER_ID: '' }).configured, false);
  assert.equal(virtualPaymentConfig({ ...ENV, VPAY_APP_KEY: 'short' }).configured, false);
  assert.equal(virtualPaymentConfig({ ...ENV, WX_APP_SECRET: '' }).configured, false);
  assert.equal(virtualPaymentConfig({ ...ENV, PAYMENT_CALLBACK_TOKEN: 'short' }).configured, false);
});

test('sandbox environment selects the sandbox app key', () => {
  const config = virtualPaymentConfig({ ...ENV, VPAY_ENV: '1' });
  assert.equal(config.configured, true);
  assert.equal(config.env, 1);
  assert.equal(config.appKey, ENV.VPAY_SANDBOX_APP_KEY);
  assert.equal(virtualPaymentConfig({ ...ENV, VPAY_ENV: '1', VPAY_SANDBOX_APP_KEY: '' }).configured, false);
  assert.equal(virtualPaymentConfig({ ...ENV, VPAY_ENV: '1', VPAY_APP_KEY: '' }).configured, true);
});

test('virtual payment config refuses missing or invalid environments rather than choosing production', () => {
  for (const invalidEnv of [undefined, null, '', '2', 'sandbox', 'production', false]) {
    const config = virtualPaymentConfig({ ...ENV, VPAY_ENV: invalidEnv });
    assert.equal(config.configured, false);
    assert.equal(config.env, null);
    assert.equal(config.appKey, '');
  }
});

test('membership provider stays virtual and never exposes secrets or legacy payment routes', () => {
  const provider = paymentProviderConfig({ ...ENV, PAYMENT_INTEGRATION_READY: 'true' });
  assert.equal(provider.provider, 'virtual');
  assert.equal(provider.available, true);
  assert.equal(provider.functionName, '');
  const serialized = JSON.stringify(provider);
  assert.equal(serialized.includes(APP_KEY), false);
  assert.equal(serialized.includes(ENV.WX_APP_SECRET), false);
  assert.equal(serialized.includes(ENV.PAYMENT_CALLBACK_TOKEN), false);

  const notReady = paymentProviderConfig(ENV);
  assert.equal(notReady.provider, 'virtual');
  assert.equal(notReady.available, false);
  assert.equal(notReady.reason, 'merchant_not_configured');

  const legacy = paymentProviderConfig({
    PAYMENT_INTEGRATION_READY: 'true',
    PAYMENT_FUNCTION_NAME: 'paymentFn',
    PAYMENT_CREATE_PATH: '/hl-membership/create',
    PAYMENT_QUERY_PATH: '/hl-membership/query',
    PAYMENT_CALLBACK_TOKEN: ENV.PAYMENT_CALLBACK_TOKEN
  });
  assert.equal(legacy.provider, 'virtual');
  assert.equal(legacy.available, false);
  assert.equal(legacy.reason, 'integration_incomplete');
  assert.equal(legacy.functionName, '');
  assert.equal(legacy.createPath, '');
  assert.equal(legacy.queryPath, '');
});

// ---------------------------------------------------------------------------
// signData & signatures (golden vectors from the official HMAC-SHA256 spec)
// ---------------------------------------------------------------------------

test('signData uses the official field set and order', () => {
  const signData = buildVirtualSignData({
    offerId: OFFER_ID, env: 0, productId: 'vip_year', goodsPrice: 188000,
    outTradeNo: ORDER_NO, attach: 'vip_year'
  });
  assert.equal(signData, '{"offerId":"1450674507","buyQuantity":1,"env":0,"currencyType":"CNY",'
    + '"productId":"vip_year","goodsPrice":188000,"outTradeNo":"HLM202610110000000001","attach":"vip_year"}');
});

test('signData rejects untrusted shapes', () => {
  const base = { offerId: OFFER_ID, env: 0, productId: 'vip_year', goodsPrice: 188000, outTradeNo: ORDER_NO, attach: 'vip_year' };
  assert.throws(() => buildVirtualSignData({ ...base, offerId: 'abc' }));
  assert.throws(() => buildVirtualSignData({ ...base, env: 2 }));
  assert.throws(() => buildVirtualSignData({ ...base, productId: 'VIP Year' }));
  assert.throws(() => buildVirtualSignData({ ...base, goodsPrice: 0 }));
  assert.throws(() => buildVirtualSignData({ ...base, goodsPrice: 1.5 }));
  assert.throws(() => buildVirtualSignData({ ...base, outTradeNo: 'short' }));
  assert.throws(() => buildVirtualSignData({ ...base, outTradeNo: '_LEADING_UNDERSCORE_IS_BANNED' }));
  assert.throws(() => buildVirtualSignData({ ...base, attach: '' }));
});

test('client payment signatures match golden HMAC vectors', () => {
  const signData = buildVirtualSignData({
    offerId: OFFER_ID, env: 0, productId: 'vip_year', goodsPrice: 188000,
    outTradeNo: ORDER_NO, attach: 'vip_year'
  });
  const { paySig, signature } = clientPaymentSignatures({ signData, sessionKey: SESSION_KEY, appKey: APP_KEY });
  assert.equal(paySig, '9f8dffb60d0070bd62562165c5528c317f33c2ef8622ef87ab038c2bdea7e1a2');
  assert.equal(signature, 'e080d923f6084fd33f93601e6486903e66a4b2a5f54972ac25e81c89b6203fa8');
});

test('server pay_sig signs the exact outbound body', () => {
  const body = `{"openid":"${OPENID}","env":0,"order_id":"${ORDER_NO}"}`;
  assert.equal(serverPaySig('/xpay/query_order', body, APP_KEY),
    'a5eefea607a802d8ed1afef913ad2ff781e1a6a8ccef40bc42dbd58df36a1559');
});

// ---------------------------------------------------------------------------
// xpay order state mapping
// ---------------------------------------------------------------------------

test('xpay order status maps to local trade semantics', () => {
  assert.equal(mapVirtualOrderState({ status: 1 }), 'NOTPAY');
  assert.equal(mapVirtualOrderState({ status: 2 }), 'SUCCESS');
  assert.equal(mapVirtualOrderState({ status: 3 }), 'SUCCESS');
  assert.equal(mapVirtualOrderState({ status: 4 }), 'SUCCESS');
  assert.equal(mapVirtualOrderState({ status: 6 }), 'CLOSED');
  assert.equal(mapVirtualOrderState({ status: 5 }), 'REFUNDED');
  assert.equal(mapVirtualOrderState({ status: 8 }), 'REFUNDED');
  assert.equal(mapVirtualOrderState({ status: 0 }), 'OTHER');
  assert.equal(mapVirtualOrderState({ status: 7 }), 'OTHER');
  assert.equal(mapVirtualOrderState({}), 'OTHER');
});

// ---------------------------------------------------------------------------
// Confirmation evidence
// ---------------------------------------------------------------------------

function xpayPaidOrder(overrides = {}) {
  return {
    order_id: ORDER_NO,
    status: 2,
    order_type: 0,
    order_fee: 188000,
    paid_fee: 188000,
    paid_time: 1791712797,
    env_type: 1,
    wxpay_order_id: '4200001234202610111234567890',
    wx_order_id: 'midas_internal_order_0001',
    ...overrides
  };
}

function localOrder(overrides = {}) {
  return { outTradeNo: ORDER_NO, amountFen: 188000, payerOpenid: OPENID, userId: 7, status: 'confirming', ...overrides };
}

test('paid xpay order builds a strict confirmation', () => {
  const confirmation = buildVirtualConfirmation(localOrder(), xpayPaidOrder(), 0, IDENTITY);
  assert.equal(confirmation.outTradeNo, ORDER_NO);
  assert.equal(confirmation.amountFen, 188000);
  assert.equal(confirmation.payerOpenid, OPENID);
  assert.equal(confirmation.tradeState, 'SUCCESS');
  assert.equal(confirmation.transactionId, '4200001234202610111234567890');
  assert.equal(confirmation.merchantId, IDENTITY.merchantId);
  assert.equal(new Date(confirmation.successTime).getTime(), 1791712797 * 1000);
});

test('confirmation rejects any mismatch of order, amount, env or credentials', () => {
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_id: 'HLM202610119999999999' }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_fee: 1 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ paid_fee: 187999 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_type: 1 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ env_type: 2 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder(), 1, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ paid_time: 0 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ paid_time: Math.floor(Date.now() / 1000) + 3600 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ wxpay_order_id: '', channel_order_id: '', wx_order_id: '' }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder({ amountFen: 188000 }), xpayPaidOrder(), 0, { ...IDENTITY, currency: '' }));
});

test('Apple payment confirmations use the original production payment and available provider transaction ID', () => {
  for (const transaction of [
    { wxpay_order_id: '', channel_order_id: 'apple-channel-order-0001', wx_order_id: 'midas_internal_order_0001' },
    { wxpay_order_id: '', channel_order_id: '', wx_order_id: 'apple_internal_order_0001' }
  ]) {
    const confirmation = buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_type: 7, ...transaction }), 0, IDENTITY);
    assert.equal(confirmation.amountFen, 188000);
    assert.equal(confirmation.transactionId, transaction.channel_order_id || transaction.wx_order_id);
    assert.equal(confirmation.payerOpenid, OPENID);
  }
  assert.equal(buildVirtualConfirmation(localOrder({ amountFen: 100 }),
    xpayPaidOrder({ order_type: 7, order_fee: 100, paid_fee: 100 }), 0, IDENTITY).amountFen, 100);
});

test('Apple payment confirmation rejects sandbox, under-CNY-1 payments, refund orders and mismatched evidence', () => {
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_type: 7, env_type: 2 }), 1, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder({ amountFen: 99 }),
    xpayPaidOrder({ order_type: 7, order_fee: 99, paid_fee: 99 }), 0, IDENTITY));
  for (const patch of [
    { order_type: 8 }, { order_type: 1 }, { order_type: 2 }, { order_type: undefined },
    { order_id: 'HLM202610119999999999' }, { order_fee: 1 }, { paid_fee: 1 }, { env_type: 2 },
    { paid_time: 0 }, { wxpay_order_id: '', channel_order_id: '', wx_order_id: '' }
  ]) {
    assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_type: 7, ...patch }), 0, IDENTITY));
  }
  assert.throws(() => buildVirtualConfirmation(localOrder({ payerOpenid: 'mock_payer' }),
    xpayPaidOrder({ order_type: 7 }), 0, IDENTITY));
  assert.throws(() => buildVirtualConfirmation(localOrder(), xpayPaidOrder({ order_type: 7 }), 0, { ...IDENTITY, currency: '' }));
});

test('Apple full refunds require a matching original Apple payment with complete zero remaining-fee evidence', () => {
  for (const status of [5, 8]) {
    const order = xpayPaidOrder({ order_type: 7, status, left_fee: 0,
      wxpay_order_id: '', channel_order_id: 'apple-original-payment-0001' });
    const proof = buildVirtualRefundProof(localOrder(), order, 0, IDENTITY);
    assert.equal(proof.tradeState, 'REFUND');
    assert.equal(proof.transactionId, 'apple-original-payment-0001');
    assert.equal(proof.providerVerified, true);
    assert.equal(proof.refundAmountFen, 188000);
    for (const patch of [{ order_type: 8 }, { order_type: 1 }, { left_fee: 1 }, { left_fee: undefined },
      { left_fee: '0' }, { order_fee: 1 }, { paid_fee: 1 }, { env_type: 2 }]) {
      assert.throws(() => buildVirtualRefundProof(localOrder(), { ...order, ...patch }, 0, IDENTITY));
    }
  }
});

test('close proof derives only from the trusted local snapshot', () => {
  const proof = buildVirtualCloseProof(localOrder(), IDENTITY);
  assert.deepEqual(proof, {
    outTradeNo: ORDER_NO,
    merchantId: IDENTITY.merchantId,
    appId: IDENTITY.appId,
    currency: 'CNY',
    amountFen: 188000,
    payerOpenid: OPENID,
    tradeState: 'CLOSED'
  });
  assert.throws(() => buildVirtualCloseProof(localOrder({ payerOpenid: 'mock_payer' }), IDENTITY));
});

// ---------------------------------------------------------------------------
// Goods delivery push validation
// ---------------------------------------------------------------------------

function deliverPush(overrides = {}) {
  return {
    ToUserName: 'gh_fixture',
    FromUserName: 'oWxaFixtureOfficial',
    MsgType: 'event',
    Event: 'xpay_goods_deliver_notify',
    OpenId: OPENID,
    OutTradeNo: ORDER_NO,
    Env: 0,
    WeChatPayInfo: { MchOrderNo: 'midas_order_0001', TransactionId: '4200001234202610111234567890', PaidTime: 1796000000 },
    GoodsInfo: { ProductId: 'vip_year', Quantity: 1, OrigPrice: 188000, ActualPrice: 188000, Attach: 'vip_year' },
    ...overrides
  };
}

test('deliver push validates fields and environment', () => {
  const push = validateGoodsDeliverPush(deliverPush(), 0);
  assert.equal(push.outTradeNo, ORDER_NO);
  assert.equal(push.openid, OPENID);
  assert.equal(push.productId, 'vip_year');
  assert.equal(push.quantity, 1);
  assert.equal(push.actualPrice, 188000);

  assert.throws(() => validateGoodsDeliverPush(deliverPush({ Env: 1 }), 0));
  assert.throws(() => validateGoodsDeliverPush(deliverPush({ Event: 'xpay_refund_notify' }), 0));
  assert.throws(() => validateGoodsDeliverPush(deliverPush({ OutTradeNo: 'bad' }), 0));
  assert.throws(() => validateGoodsDeliverPush(deliverPush({ OpenId: 'seed-payer' }), 0));
  assert.throws(() => validateGoodsDeliverPush(deliverPush({ GoodsInfo: { ProductId: 'BAD ID', Quantity: 1 } }), 0));
  assert.throws(() => validateGoodsDeliverPush(deliverPush({ GoodsInfo: { ProductId: 'vip_year', Quantity: 0 } }), 0));
});

test('Apple delivery push can omit WeChatPayInfo while retaining validated order and goods locators', () => {
  const push = validateGoodsDeliverPush(deliverPush({ WeChatPayInfo: undefined }), 0);
  assert.equal(push.outTradeNo, ORDER_NO);
  assert.equal(push.openid, OPENID);
  assert.equal(push.productId, 'vip_year');
  assert.equal(push.quantity, 1);
  assert.equal(push.transactionId, '');
  assert.equal(push.wxOrderId, '');
  assert.equal(push.paidTime, 0);
});

// ---------------------------------------------------------------------------
// WeChat API client (transport injected)
// ---------------------------------------------------------------------------

test('query order sends the exact signed body and maps not-found to null', async () => {
  const calls = [];
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('stable_token')) {
        return { status: 200, data: { access_token: 'fixture_access_token_0000000000000001', expires_in: 7200 } };
      }
      const body = `{"openid":"${OPENID}","env":0,"order_id":"${ORDER_NO}"}`;
      assert.equal(options.body, body);
      assert.ok(url.startsWith('https://api.weixin.qq.com/xpay/query_order?'));
      assert.ok(url.includes('access_token=fixture_access_token_0000000000000001'));
      assert.ok(url.includes('pay_sig=a5eefea607a802d8ed1afef913ad2ff781e1a6a8ccef40bc42dbd58df36a1559'));
      return { status: 200, data: { errcode: 90019, errmsg: 'out_trade_no 未找到' } };
    }
  });
  const result = await client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO });
  assert.equal(result, null);
  assert.equal(calls.length, 2);
});

test('query order returns the order object and caches the access token', async () => {
  let tokenCalls = 0;
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async url => {
      if (url.includes('stable_token')) {
        tokenCalls += 1;
        return { status: 200, data: { access_token: 'fixture_access_token_0000000000000002', expires_in: 7200 } };
      }
      return { status: 200, data: { errcode: 0, errmsg: 'ok', order: xpayPaidOrder() } };
    }
  });
  const first = await client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO });
  const second = await client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO });
  assert.equal(first.order_id, ORDER_NO);
  assert.equal(second.order_id, ORDER_NO);
  assert.equal(tokenCalls, 1);
});

test('query order retries once with a fresh token on credential errors', async () => {
  let tokenCalls = 0;
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async (url, options = {}) => {
      if (url.includes('stable_token')) {
        tokenCalls += 1;
        const body = JSON.parse(options.body);
        return { status: 200, data: { access_token: `fixture_access_token_retry_0000000000${tokenCalls}`, expires_in: 7200, requested: body.force_refresh } };
      }
      if (tokenCalls === 1) return { status: 200, data: { errcode: 40001, errmsg: 'invalid credential' } };
      return { status: 200, data: { errcode: 0, errmsg: 'ok', order: xpayPaidOrder() } };
    }
  });
  const result = await client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO });
  assert.equal(result.order_id, ORDER_NO);
  assert.equal(tokenCalls, 2);
});

test('query order refuses provider failures instead of fabricating state', async () => {
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async url => {
      if (url.includes('stable_token')) {
        return { status: 200, data: { access_token: 'fixture_access_token_0000000000000003', expires_in: 7200 } };
      }
      return { status: 200, data: { errcode: -1, errmsg: 'system busy' } };
    }
  });
  await assert.rejects(
    () => client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO }),
    /微信订单查询失败/
  );
});

test('query order never treats unrelated not-found errors as order absence', async () => {
  for (const data of [
    { errcode: 99999, errmsg: 'application not found' },
    { errcode: -1, errmsg: '配置不存在' },
    { errcode: 40001, errmsg: 'access_token not found' },
    { errmsg: 'order not found' },
    { errcode: '90019', errmsg: 'order not found' }
  ]) {
    let queries = 0;
    const client = createVirtualPaymentClient({
      appId: IDENTITY.appId,
      request: async url => {
        if (url.includes('stable_token')) return { status: 200,
          data: { access_token: 'fixture_access_token_query_error_0001', expires_in: 7200 } };
        queries += 1;
        return { status: 200, data };
      }
    });
    await assert.rejects(
      () => client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO }),
      error => error.status === 503 && error.code === 50301
    );
    assert.equal(queries, data.errcode === 40001 ? 2 : 1);
  }
});

test('query order refuses success envelopes without an order object', async () => {
  for (const order of [undefined, null, [], '', false, 0]) {
    const client = createVirtualPaymentClient({
      appId: IDENTITY.appId,
      request: async url => ({ status: 200, data: url.includes('stable_token')
        ? { access_token: 'fixture_access_token_query_shape_0001', expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok', ...(order === undefined ? {} : { order }) } })
    });
    await assert.rejects(
      () => client.queryOrder({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, openid: OPENID, env: 0, outTradeNo: ORDER_NO }),
      error => error.status === 503 && error.code === 50301 && /结果不完整/.test(error.message)
    );
  }
});

test('code2session returns verified credentials and rejects mismatches', async () => {
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async url => {
      assert.ok(url.includes('js_code=loginCodeFixture001'));
      return { status: 200, data: { openid: OPENID, session_key: SESSION_KEY } };
    }
  });
  const login = await client.code2session(ENV.WX_APP_SECRET, 'loginCodeFixture001');
  assert.equal(login.openid, OPENID);
  assert.equal(login.sessionKey, SESSION_KEY);

  const failing = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async () => ({ status: 200, data: { errcode: 40029, errmsg: 'invalid code' } })
  });
  await assert.rejects(() => failing.code2session(ENV.WX_APP_SECRET, 'loginCodeFixture001'));
});

test('delivery confirmation signs the actual provider order body with the sandbox key and reuses the token', async () => {
  let tokenCalls = 0;
  let deliveryCalls = 0;
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async (url, options = {}) => {
      if (url.includes('stable_token')) {
        tokenCalls += 1;
        return { status: 200, data: { access_token: 'fixture_delivery_token_0000000000001', expires_in: 7200 } };
      }
      deliveryCalls += 1;
      const target = new URL(url);
      assert.equal(target.origin + target.pathname, 'https://api.weixin.qq.com/xpay/notify_provide_goods');
      assert.equal(target.searchParams.get('access_token'), 'fixture_delivery_token_0000000000001');
      assert.equal(target.searchParams.get('pay_sig'), crypto.createHmac('sha256', ENV.VPAY_SANDBOX_APP_KEY)
        .update(`/xpay/notify_provide_goods&${options.body}`).digest('hex'));
      assert.notEqual(target.searchParams.get('pay_sig'), crypto.createHmac('sha256', ENV.VPAY_APP_KEY)
        .update(`/xpay/notify_provide_goods&${options.body}`).digest('hex'));
      assert.equal(options.method, 'POST');
      assert.equal(options.body, JSON.stringify({ order_id: ORDER_NO, env: 1 }));
      return { status: 200, data: { errcode: 0, errmsg: 'ok' } };
    }
  });
  await client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, appKey: ENV.VPAY_SANDBOX_APP_KEY, env: 1, outTradeNo: ORDER_NO });
  await client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, appKey: ENV.VPAY_SANDBOX_APP_KEY, env: 1, outTradeNo: ORDER_NO });
  assert.equal(tokenCalls, 1);
  assert.equal(deliveryCalls, 2);
});

test('delivery confirmation accepts documented empty responses and rejects malformed or failing responses', async () => {
  for (const response of [
    { status: 200, data: null, emptyBody: true },
    { status: 200, data: null, emptyBody: false },
    { status: 200, data: {} },
    { status: 200, data: { errcode: -1 } },
    { status: 503, data: { errcode: 0 } }
  ]) {
    const client = createVirtualPaymentClient({
      appId: IDENTITY.appId,
      request: async url => url.includes('stable_token')
        ? { status: 200, data: { access_token: 'fixture_delivery_token_0000000000002', expires_in: 7200 } }
        : response
    });
    const notify = () => client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, env: 0, outTradeNo: ORDER_NO });
    if (response.emptyBody === true) await notify();
    else await assert.rejects(notify, /微信发货确认失败/);
  }
});

test('delivery confirmation refreshes expired credentials once and remains retryable after failure', async () => {
  let tokenCalls = 0;
  let deliveryCalls = 0;
  const client = createVirtualPaymentClient({
    appId: IDENTITY.appId,
    request: async (url, options = {}) => {
      if (url.includes('stable_token')) {
        tokenCalls += 1;
        assert.equal(JSON.parse(options.body).force_refresh, tokenCalls > 1);
        return { status: 200, data: { access_token: `fixture_delivery_refresh_00000000000${tokenCalls}`, expires_in: 7200 } };
      }
      deliveryCalls += 1;
      assert.equal(options.body, JSON.stringify({ order_id: ORDER_NO, env: 0 }));
      const target = new URL(url);
      assert.equal(target.searchParams.get('pay_sig'), crypto.createHmac('sha256', APP_KEY)
        .update(`/xpay/notify_provide_goods&${options.body}`).digest('hex'));
      assert.equal(target.searchParams.get('access_token'), `fixture_delivery_refresh_00000000000${tokenCalls}`);
      return { status: 200, data: { errcode: deliveryCalls <= 2 ? 42001 : 0 } };
    }
  });
  const notify = () => client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, appKey: APP_KEY, env: 0, outTradeNo: ORDER_NO });
  await assert.rejects(notify, /微信发货确认失败/);
  assert.equal(tokenCalls, 2);
  assert.equal(deliveryCalls, 2);
  await notify();
  assert.equal(deliveryCalls, 3);
});

test('delivery confirmation rejects invalid order numbers and environments before transport', async () => {
  const client = createVirtualPaymentClient({ appId: IDENTITY.appId,
    request: async () => { throw new Error('unexpected transport'); } });
  await assert.rejects(() => client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, env: 0, outTradeNo: 'bad' }), /订单号无效/);
  await assert.rejects(() => client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, env: 2, outTradeNo: ORDER_NO }), /环境配置无效/);
  for (const appKey of [undefined, '', 'short']) {
    await assert.rejects(() => client.notifyProvideGoods({ appSecret: ENV.WX_APP_SECRET, appKey, env: 1, outTradeNo: ORDER_NO }), /签名材料无效/);
  }
});
