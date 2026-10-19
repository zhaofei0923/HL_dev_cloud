'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const modulePromise = import('../scripts/validate-recovery-wechat-credentials.mjs');
const APP_SECRET = 'wechat-secret-fixture-0123456789';
const APP_KEY = 'sandbox-key-fixture-0123456789';
const OPENID = 'oPrivateFixturePayer00000001';
const TOKEN = 'private-access-token-fixture-000001';
const TRANSACTION = '420000PRIVATEfixturetransaction';
const RUN = 'week_20261013_mv68bzxs';
const DOC = `payment_probe_user_1_run_${RUN}`;
const ATTEMPT = 'HLA' + 'a'.repeat(24);
const credentials = { WX_APP_SECRET: APP_SECRET, VPAY_SANDBOX_APP_KEY: APP_KEY };
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const intent = { envId: 'cloud1-d2gza7q9c8d69c721', functionName: 'hlApi', userId: 1, runId: RUN,
    documentId: DOC, planCode: 'vip_week', amountFen: 6160, durationDays: 7, sandbox: true,
    createdAt: '2026-10-13T05:19:55.597Z', expiresAt: '2026-10-13T06:04:55.597Z' };
  const intentSha256 = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const state = { status: 'closed_verified', configurationVerified: true, otherEnvironmentValuesPreserved: true, intentSha256 };
  const order = { _id: DOC, userId: 1, outTradeNo: 'HLM202610131791870434924000', planCode: 'vip_week',
    productType: 'vip', membershipTier: 'vip', amountFen: 6160, durationDays: 7, status: 'paid', fulfillmentStatus: 'fulfilled',
    paymentProvider: 'virtual', merchantId: '1118515135', appId: 'wx7e5c0f4d07d2f0f8', currency: 'CNY', payerOpenid: OPENID,
    paymentTestPlanCode: 'vip_week', paymentTestRunId: RUN, virtualPaymentEnv: 1, virtualPaymentOfferId: '1450674507',
    virtualPaymentAttempts: [{ outTradeNo: ATTEMPT, env: 1, offerId: '1450674507', createdAt: '2026-10-13T05:20:59.000Z' }],
    virtualPaidAttemptNo: ATTEMPT, virtualDeliveryStatus: 'confirmed', virtualDeliveryOrderNo: ATTEMPT,
    transactionId: TRANSACTION, createdAt: '2026-10-13T05:20:30.000Z' };
  const mapping = { _id: `virtualPaymentAttempt_${ATTEMPT}`, orderDocumentId: DOC,
    businessOutTradeNo: order.outTradeNo, env: 1, offerId: '1450674507' };
  const provider = { order_id: ATTEMPT, env_type: 2, status: 4, order_type: 0, order_fee: 6160,
    paid_fee: 6160, paid_time: 1791868870, wxpay_order_id: TRANSACTION };
  const reads = [], requests = [];
  const result = { intent, state, intentSha256, order, mapping, provider, reads, requests };
  result.dependencies = {
    loadEvidence: async () => ({ intent, state, intentSha256 }),
    read: async args => {
      reads.push(args);
      assert.equal(args.limit, 2);
      assert.ok(Object.values(args.projection).every(value => value === 1));
      if (args.collectionName === 'hl_payment_orders') {
        assert.deepEqual(args.query, { _id: DOC, userId: 1 });
        return [clone(order)];
      }
      assert.equal(args.collectionName, 'hl_counters');
      assert.deepEqual(args.query, { _id: mapping._id });
      return [clone(mapping)];
    },
    request: async (url, options) => {
      const target = new URL(url), body = JSON.parse(options.body);
      requests.push({ path: target.pathname, method: options.method });
      assert.equal(options.method, 'POST');
      if (target.pathname === '/cgi-bin/stable_token') {
        assert.equal(body.secret, APP_SECRET);
        assert.equal(body.appid, 'wx7e5c0f4d07d2f0f8');
        assert.equal(body.force_refresh, false);
        return { status: 200, data: { access_token: TOKEN, expires_in: 7200 } };
      }
      assert.equal(target.pathname, '/xpay/query_order');
      assert.equal(target.searchParams.get('access_token'), TOKEN);
      assert.equal(target.searchParams.get('pay_sig'), crypto.createHmac('sha256', APP_KEY)
        .update('/xpay/query_order&' + options.body).digest('hex'));
      assert.deepEqual(body, { openid: OPENID, env: 1, order_id: ATTEMPT });
      return { status: 200, data: { errcode: 0, order: clone(provider) } };
    }
  };
  return result;
}

test('recovery checks both credentials through only token acquisition and the bound completed sandbox query', async () => {
  const { validateRecoveryWechatCredentials } = await modulePromise;
  const data = fixture(), before = clone({ order: data.order, mapping: data.mapping });
  const evidence = await validateRecoveryWechatCredentials(credentials, data.dependencies);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.amountFen, 6160);
  assert.equal(evidence.transactionMatched, true);
  assert.deepEqual(data.requests, [{ path: '/cgi-bin/stable_token', method: 'POST' }, { path: '/xpay/query_order', method: 'POST' }]);
  assert.equal(data.reads.length, 4);
  assert.deepEqual({ order: data.order, mapping: data.mapping }, before);
  const serialized = JSON.stringify(evidence);
  for (const privateValue of [APP_SECRET, APP_KEY, OPENID, TOKEN, TRANSACTION, ATTEMPT, data.order.outTradeNo, 'https://']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('closed evidence, duplicate database rows and cross-scope records fail before any provider request', async () => {
  const { validateRecoveryWechatCredentials } = await modulePromise;
  const changes = [
    data => { data.state.status = 'open_verified'; },
    data => { data.state.intentSha256 = '0'.repeat(64); },
    data => { data.order.virtualPaymentEnv = 0; },
    data => { data.order.userId = 2; },
    data => { data.order.amountFen = 1; },
    data => { data.order.transactionId = ''; },
    data => { data.mapping.businessOutTradeNo = 'another-order'; },
    data => { data.dependencies.read = async () => [clone(data.order), clone(data.order)]; }
  ];
  for (const change of changes) {
    const data = fixture(); change(data);
    await assert.rejects(validateRecoveryWechatCredentials(credentials, data.dependencies), error => /^RECOVERY_/.test(error.safeCode));
    assert.equal(data.requests.length, 0);
  }
});

test('provider must prove exact completed sandbox order, amount and transaction without accepting absent orders', async () => {
  const { validateRecoveryWechatCredentials } = await modulePromise;
  for (const patch of [{ status: 2 }, { status: 5 }, { order_id: 'HLA' + 'b'.repeat(24) }, { env_type: 1 },
    { order_type: 1 }, { order_fee: 1 }, { paid_fee: 1 }, { wxpay_order_id: 'another-transaction' }, { paid_time: 0 }]) {
    const data = fixture(); Object.assign(data.provider, patch);
    await assert.rejects(validateRecoveryWechatCredentials(credentials, data.dependencies), error => /^RECOVERY_/.test(error.safeCode));
  }
  const absent = fixture();
  absent.dependencies.request = async url => new URL(url).pathname === '/cgi-bin/stable_token'
    ? { status: 200, data: { access_token: TOKEN, expires_in: 7200 } } : { status: 200, data: { errcode: 90019 } };
  await assert.rejects(validateRecoveryWechatCredentials(credentials, absent.dependencies), error => error.safeCode === 'RECOVERY_PROVIDER_ORDER_NOT_COMPLETED');
});

test('a changed order or attempt mapping after query fails the read-only stable-snapshot check', async () => {
  const { validateRecoveryWechatCredentials } = await modulePromise;
  for (const target of ['order', 'mapping']) {
    const data = fixture(), transport = data.dependencies.request;
    data.dependencies.request = async (...args) => {
      const response = await transport(...args);
      if (new URL(args[0]).pathname === '/xpay/query_order') data[target].unexpectedChange = true;
      return response;
    };
    await assert.rejects(validateRecoveryWechatCredentials(credentials, data.dependencies), error => error.safeCode === 'RECOVERY_READONLY_SNAPSHOT_CHANGED');
  }
});

test('raw database and transport errors cannot expose secrets, tokens, URLs or provider payloads', async () => {
  const { validateRecoveryWechatCredentials } = await modulePromise;
  for (const dependency of ['read', 'request']) {
    const data = fixture();
    data.dependencies[dependency] = async () => { throw new Error(`https://api.weixin.qq.com/?secret=${APP_SECRET}&token=${TOKEN}&openid=${OPENID}`); };
    await assert.rejects(validateRecoveryWechatCredentials(credentials, data.dependencies), error => {
      assert.equal(error.message, error.safeCode);
      for (const value of [APP_SECRET, TOKEN, OPENID, 'https://']) assert.equal(String(error.stack).includes(value), false);
      return /^RECOVERY_/.test(error.safeCode);
    });
  }
});

test('the request allowlist rejects delivery, checkout, refund, alternate hosts, credentials and methods before IO', async () => {
  const { createRecoveryReadOnlyRequest } = await modulePromise;
  let calls = 0;
  const request = createRecoveryReadOnlyRequest(async () => { calls++; return {}; });
  for (const url of ['https://api.weixin.qq.com/xpay/notify_provide_goods', 'https://api.weixin.qq.com/xpay/create_order',
    'https://api.weixin.qq.com/xpay/refund_order', 'https://api.weixin.qq.com.evil.test/xpay/query_order',
    'http://api.weixin.qq.com/xpay/query_order', 'https://user:password@api.weixin.qq.com/xpay/query_order',
    'https://api.weixin.qq.com:444/xpay/query_order', 'https://api.weixin.qq.com/xpay/query_order#fragment']) {
    await assert.rejects(request(url, { method: 'POST', body: '{}' }), error => error.safeCode === 'RECOVERY_PROVIDER_MUTATION_FORBIDDEN');
  }
  await assert.rejects(request('https://api.weixin.qq.com/xpay/query_order', { method: 'GET', body: '{}' }));
  assert.equal(calls, 0);
});

test('official MCP adapter calls only the projected read tool and refuses unconfirmed or raw failure output', async () => {
  const { recoveryReadFromMcp } = await modulePromise;
  const args = { collectionName: 'hl_payment_orders', query: { _id: DOC }, projection: { status: 1 }, limit: 2 };
  const calls = [];
  const reader = recoveryReadFromMcp({ call: async (name, supplied) => {
    calls.push(name); assert.deepEqual(supplied, args); return { success: true, data: [{ status: 'paid' }] };
  } });
  assert.deepEqual(await reader(args), [{ status: 'paid' }]);
  assert.deepEqual(calls, ['readNoSqlDatabaseContent']);
  for (const result of [{ data: [] }, { success: true, data: [], collectionName: 'other' }]) {
    await assert.rejects(recoveryReadFromMcp({ call: async () => result })(args), error => error.safeCode === 'RECOVERY_DATABASE_READ_UNCONFIRMED');
  }
});
