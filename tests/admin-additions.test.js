const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = import('../scripts/add-miniprogram-admins.mjs');
const request = Object.freeze({ label: 'fixture-wechat-handle', phone: '13800000001' });
const account = overrides => ({ id: 201, phone: request.phone, phoneSource: 'wechat', status: 1,
  openid: 'fixtureWechatOpenid_000000001', nickname: 'A different display name', authVersion: 1, ...overrides });
const rejectsSafely = operation => assert.throws(operation, error => typeof error.safeCode === 'string'
  && /^[A-Z][A-Z0-9_]+$/.test(error.safeCode));

test('admin requests accept exact labels and phones and reject malformed input', async () => {
  const { requestedAccounts } = await helpers;
  const input = [request, { label: 'second-handle', phone: '13800000002' }];
  assert.deepEqual(requestedAccounts(input), input);
  for (const invalid of [null, {}, [], Array.from({ length: 21 }, () => request),
    [null], [{ phone: request.phone }], [{ ...request, label: '' }], [{ ...request, label: 'x'.repeat(65) }],
    [{ ...request, phone: 13800000001 }], [{ ...request, phone: '+8613800000001' }],
    [{ ...request, phone: '1380000000' }], [{ ...request, extra: true }]]) {
    assert.throws(() => requestedAccounts(invalid), { safeCode: 'REQUEST_FORMAT' });
  }
});

test('admin requests reject the same phone even when its labels differ', async () => {
  const { requestedAccounts } = await helpers;
  assert.throws(() => requestedAccounts([request, { ...request, label: 'another-handle' }]),
    { safeCode: 'DUPLICATE_REQUEST_PHONE' });
});

test('appending admins preserves all existing admins and every other environment value', async () => {
  const { appendedEnvironment } = await helpers;
  const env = Object.freeze({ MINIPROGRAM_ADMIN_USER_IDS: '1, 9,1', JWT_SECRET: 'fixture-jwt',
    ADMIN_CODE: 'fixture-admin-code', VPAY_APP_KEY: 'fixture-production-key',
    VPAY_SANDBOX_APP_KEY: 'fixture-sandbox-key', VPAY_ENV: '0', PAYMENT_INTEGRATION_READY: 'true',
    MATCHMAKING_PAYMENT_READY: 'true', PAYMENT_TEST_ENABLED: 'false', WX_APP_SECRET: 'fixture-wx-secret',
    FUTURE_CONFIGURATION: 'keep exactly: space, unicode 配置, and newline\n', EMPTY_OPTION: '' });
  const ids = Object.freeze([201, 202, 9, 201]);
  const result = appendedEnvironment(env, ids);
  assert.deepEqual(result, { ...env, MINIPROGRAM_ADMIN_USER_IDS: '1,9,201,202' });
  assert.equal(env.MINIPROGRAM_ADMIN_USER_IDS, '1, 9,1');
  assert.notEqual(result, env);
});

test('appending admins rejects malformed existing lists or invalid target IDs', async () => {
  const { appendedEnvironment } = await helpers;
  for (const previous of [undefined, '', '1,', '1,0', '1,abc', '1,9007199254740992']) {
    assert.throws(() => appendedEnvironment({ MINIPROGRAM_ADMIN_USER_IDS: previous }, [201]),
      { safeCode: 'ADMIN_IDS_INVALID' });
  }
  for (const ids of [[], [0], [-1], ['201'], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => appendedEnvironment({ MINIPROGRAM_ADMIN_USER_IDS: '1' }, ids),
      { safeCode: 'ADMIN_IDS_INVALID' });
  }
});

test('account resolution uses verified phone identity without requiring a nickname match', async () => {
  const { uniqueRequestedAccount } = await helpers;
  const user = Object.freeze(account());
  const rows = Object.freeze([user, Object.freeze(account({ id: 202, phone: '13800000002' }))]);
  assert.equal(uniqueRequestedAccount(rows, request), user);
  assert.equal(user.nickname, 'A different display name');
});

test('account resolution rejects missing, duplicate, disabled, merged or invalid-ID targets', async () => {
  const { uniqueRequestedAccount } = await helpers;
  for (const rows of [[], [account({ phone: '13800000002' })], [account(), account({ id: 202 })],
    [account({ status: 0 })], [account({ status: 2 })], [account({ mergedIntoUserId: 999 })],
    [account({ id: 0 })], [account({ id: '201' })]]) {
    rejectsSafely(() => uniqueRequestedAccount(rows, request));
  }
  for (const rows of [null, Array.from({ length: 10 }, () => account())]) {
    assert.throws(() => uniqueRequestedAccount(rows, request), { safeCode: 'ACCOUNT_READ_INCOMPLETE' });
  }
});

test('phone uniqueness is checked before excluding other non-disabled ineligible accounts', async () => {
  const { uniqueRequestedAccount } = await helpers;
  for (const duplicate of [account({ id: 202, status: 2 }), account({ id: 202, mergedIntoUserId: 999 }),
    account({ id: 202, openid: 'mock_000000000000000000000000' }),
    account({ id: 202, phoneSource: 'manual' })]) {
    assert.throws(() => uniqueRequestedAccount([account(), duplicate], request),
      { safeCode: 'PHONE_ACCOUNT_NOT_UNIQUE' });
  }
  const user = account();
  assert.equal(uniqueRequestedAccount([user, account({ id: 202, status: 0 })], request), user);
});

test('manual, missing or historical claim phone metadata cannot prove current phone ownership', async () => {
  const { uniqueRequestedAccount } = await helpers;
  for (const phoneSource of ['manual', '', undefined]) {
    rejectsSafely(() => uniqueRequestedAccount([account({ phoneSource })], request));
    rejectsSafely(() => uniqueRequestedAccount([account({ phoneSource, identitySource: 'manual_claimed',
      identityStatus: 'claimed' })], request));
  }
});

test('account resolution rejects placeholder, archived and malformed OpenIDs', async () => {
  const { uniqueRequestedAccount } = await helpers;
  for (const openid of ['manual_12345678901234567890', 'mock_123456789012345678901234',
    'seed-matchmaker-1234567890', 'merged_12345678901234567890', 'archived_12345678901234567890',
    'MOCK_123456789012345678901234', '', null, 'has spaces in openid', '非法标识']) {
    assert.throws(() => uniqueRequestedAccount([account({ openid })], request),
      { safeCode: 'ACCOUNT_NOT_WECHAT' });
  }
});
