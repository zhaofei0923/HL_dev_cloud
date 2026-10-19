const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const input = () => ({ JWT_SECRET: 'isolated-fixture-original-jwt-at-least-32-characters', ADMIN_CODE: 'isolated-admin-original',
  WX_APP_SECRET: 'isolated-original-wechat-secret', VPAY_SANDBOX_APP_KEY: 'isolated-original-sandbox-key' });
const callback = 'isolated-original-callback-token';
async function run(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/recover-admin-entry-env.mjs'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('const require = createRequire(import.meta.url);', 'const require = __require;');
  const original = input();
  const values = { MATCHMAKING_PAYMENT_READY: 'false', PAYMENT_CREATE_PATH: '/hl-membership/create',
    PAYMENT_FUNCTION_NAME: 'isolated-payment', PAYMENT_INTEGRATION_READY: 'false', PAYMENT_QUERY_PATH: '/hl-membership/query',
    PAYMENT_TEST_ENABLED: 'false', PAYMENT_TEST_EXPIRES_AT: '2026-10-13T00:00:00Z', PAYMENT_TEST_PLAN_CODE: 'vip_week',
    PAYMENT_TEST_PUSH_ONLY: 'false', PAYMENT_TEST_RUN_ID: 'isolated-run', PAYMENT_TEST_USER_ID: '1',
    VIP_MEMBERSHIP_CATALOG_READY: 'true', VPAY_ENV: '1', VPAY_OFFER_ID: '1234567890' };
  const recovered = { ...values, PAYMENT_CALLBACK_TOKEN: callback, ...original, NODE_ENV: 'production' };
  const current = { ...Object.fromEntries(Object.keys(recovered).map(key => [key, '[REDACTED]'])), MINIPROGRAM_ADMIN_USER_IDS: '1' };
  const known = { values, callbackSourceFunction: 'isolated-payment', expectedClosedEnvironmentSha256: digest(recovered) };
  if (options.wrongHash) known.expectedClosedEnvironmentSha256 = '0'.repeat(64);
  let actual = { ...current }, writes = 0, healthCalls = 0, wechatChecks = 0, readClientClosed = 0;
  const messages = [], files = [];
  const details = () => ({ FunctionName: 'hlApi', Namespace: options.wrongTarget ? 'other-environment' : 'cloud1-d2gza7q9c8d69c721',
    Type: 'Event', Status: 'Active', ModTime: 'fixed-before',
    Environment: { Variables: Object.entries(actual).map(([Key, Value]) => ({ Key, Value })) } });
  const manager = { functions: {
    async getFunctionDetail(name) {
      if (name === 'hlAdminOperations') return { Environment: { Variables: [{ Key: 'MEMBER_CERTIFICATION_JWT_DERIVED_KEY',
        Value: 'hex:' + crypto.createHmac('sha256', original.JWT_SECRET).update('hl.member-certification.encryption.jwt-derived.v1').digest('hex') }] } };
      if (name === 'isolated-payment') return { Environment: { Variables: [{ Key: 'PAYMENT_CALLBACK_TOKEN', Value: callback }] } };
      assert.equal(name, 'hlApi');
      return details();
    },
    async updateFunctionConfig(config) {
      writes++;
      assert.equal(config.name, 'hlApi');
      assert.deepEqual(Object.keys(config).sort(), ['envVariables', 'name']);
      actual = options.readbackFailure ? { ...current } : JSON.parse(JSON.stringify(config.envVariables));
    },
    async invokeFunction(name, data) {
      healthCalls++;
      assert.equal(name, 'hlApi'); assert.equal(data.path, '/health');
      return { RetMsg: JSON.stringify({ code: 0, data: { status: 'ok' } }) };
    }
  } };
  const supplied = { ...original, ...options.input };
  let payload = JSON.stringify(supplied);
  if (options.legacyFormEncoding) {
    const parts = payload.split('自动生成'), marker = Buffer.from([0xd7, 0xd4, 0xb6, 0xaf, 0xc9, 0xfa, 0xb3, 0xc9]);
    assert.equal(parts.length, 3);
    payload = Buffer.concat([Buffer.from(parts[0]), marker, Buffer.from(parts[1]), marker, Buffer.from(parts[2])]);
  }
  const processMock = { stdin: (async function* () { yield payload; })(), exitCode: 0 };
  await vm.runInNewContext(`(async () => {${source}\n})()`, {
    __require: () => ({ getCloudBaseManager: async () => manager }),
    PaymentMcpClient: class {
      async call(name, args) {
        assert.equal(name, 'readNoSqlDatabaseContent');
        assert.equal(args.collectionName, 'hl_users');
        return options.databaseUnconfirmed ? { success: false } : { success: true, data: [] };
      }
      close() { readClientClosed++; }
    },
    validateRecoveryWechatCredentials: async (secrets, { read }) => {
      wechatChecks++;
      assert.equal(Object.keys(secrets).sort().join(','), 'VPAY_SANDBOX_APP_KEY,WX_APP_SECRET');
      assert.equal(secrets.WX_APP_SECRET, supplied.WX_APP_SECRET);
      assert.equal(secrets.VPAY_SANDBOX_APP_KEY, supplied.VPAY_SANDBOX_APP_KEY);
      await read({ collectionName: 'hl_users', query: { id: 1 }, projection: { id: 1 }, limit: 2 });
      if (options.wechatRejected) throw Object.assign(new Error('WECHAT_CREDENTIALS_UNVERIFIED'), { safeCode: 'WECHAT_CREDENTIALS_UNVERIFIED' });
      return { verified: true };
    },
    createHash: crypto.createHash, createHmac: crypto.createHmac, timingSafeEqual: crypto.timingSafeEqual, randomBytes: crypto.randomBytes,
    Buffer, TextDecoder, process: processMock, console: { log: value => messages.push(value) },
    readFile: async file => JSON.stringify(String(file).endsWith('compatibility-deployment.json')
      ? { status: options.codeNotReady ? 'pending' : 'verified', envId: 'cloud1-d2gza7q9c8d69c721', functionName: 'hlApi',
        legacyGetter: true, legacyPolicy: true, modifiedAt: options.codeChanged ? 'other-version' : 'fixed-before' } : known),
    writeFile: async (file, text) => files.push({ file, text }),
    setTimeout: callback => { callback(); return 0; }
  });
  const output = messages.join('\n') + files.map(file => file.text).join('\n');
  for (const value of [...Object.values(original), callback, actual.JWT_SECRET, actual.ADMIN_CODE]) {
    if (value === '[REDACTED]') continue;
    assert.equal(output.includes(value), false, 'no secret may be logged or persisted');
  }
  return { actual, recovered, writes, healthCalls, wechatChecks, readClientClosed, files, messages, exitCode: processMock.exitCode };
}

test('recovery restores exactly the historical twenty variables plus the authorized entrance ID', async () => {
  const r = await run();
  assert.equal(r.writes, 1); assert.equal(r.healthCalls, 1); assert.equal(r.exitCode, 0);
  assert.deepEqual(r.actual, { ...r.recovered, MINIPROGRAM_ADMIN_USER_IDS: '1' });
  assert.ok(r.files.some(file => JSON.parse(file.text).status === 'restored_verified'));
});
test('recovery rejects a replacement JWT before any cloud mutation', async () => {
  const r = await run({ input: { JWT_SECRET: 'different-jwt-secret-with-at-least-32-characters' } });
  assert.equal(r.writes, 0); assert.match(r.messages[0], /JWT_ORIGINAL_MISMATCH/);
});
test('recovery rejects incorrect original secrets through the complete historical digest', async () => {
  const r = await run({ input: { ADMIN_CODE: 'different-admin-original' } });
  assert.equal(r.writes, 0); assert.match(r.messages[0], /ORIGINAL_CONFIGURATION_HASH_MISMATCH/);
});
test('recovery refuses masked input and mismatched historical configuration', async () => {
  for (const options of [{ input: { WX_APP_SECRET: '[REDACTED]' } }, { wrongHash: true }]) {
    const r = await run(options); assert.equal(r.writes, 0); assert.equal(r.healthCalls, 0);
  }
});
test('recovery never repeats a write when readback has not converged', async () => {
  const r = await run({ readbackFailure: true });
  assert.equal(r.writes, 1); assert.equal(r.healthCalls, 0);
  assert.match(r.messages[0], /RESTORATION_READBACK_PENDING/);
  assert.equal(JSON.parse(r.messages[0]).configurationWriteRequested, true);
});

test('replacement mode generates new login credentials while preserving the original certificate key and payment gates', async () => {
  const r = await run({ input: { JWT_SECRET: '自动生成', ADMIN_CODE: '自动生成' } });
  assert.equal(r.writes, 1); assert.equal(r.healthCalls, 1); assert.equal(r.exitCode, 0);
  assert.notEqual(r.actual.JWT_SECRET, input().JWT_SECRET);
  assert.ok(r.actual.JWT_SECRET.length >= 32);
  assert.notEqual(r.actual.ADMIN_CODE, input().ADMIN_CODE);
  assert.equal(r.actual.MEMBER_CERTIFICATION_JWT_DERIVED_KEY,
    'hex:' + crypto.createHmac('sha256', input().JWT_SECRET).update('hl.member-certification.encryption.jwt-derived.v1').digest('hex'));
  assert.equal(r.actual.PAYMENT_TEST_ENABLED, 'false');
  assert.equal(r.actual.PAYMENT_INTEGRATION_READY, 'false');
  assert.equal(r.actual.MATCHMAKING_PAYMENT_READY, 'false');
  assert.equal(r.wechatChecks, 1);
  assert.equal(r.readClientClosed, 1);
  assert.equal(Object.keys(r.actual).length, 22);
  const evidence = JSON.parse(r.files.find(file => file.file.endsWith('configuration-recovery.json')).text);
  assert.equal(evidence.matchesHistoricalClosedConfiguration, false);
  assert.equal(evidence.oldCertificationKeyPreserved, true);
  assert.equal(evidence.previousLoginSessionsInvalidated, true);
  assert.equal(evidence.wechatCredentialsVerifiedByReadonlyQuery, true);
});

test('replacement rejects failed WeChat credential or unconfirmed database checks before any write', async () => {
  for (const option of [{ wechatRejected: true }, { databaseUnconfirmed: true }]) {
    const r = await run({ ...option, input: { JWT_SECRET: '自动生成', ADMIN_CODE: '自动生成' } });
    assert.equal(r.writes, 0); assert.equal(r.healthCalls, 0);
    assert.equal(r.wechatChecks, 1); assert.equal(r.readClientClosed, 1);
    assert.equal(r.exitCode, 1);
    assert.equal(JSON.parse(r.messages[0]).configurationWriteRequested, false);
  }
});

test('replacement refuses missing compatibility deployment or a changed cloud version before writing', async () => {
  for (const option of [{ codeNotReady: true }, { codeChanged: true }]) {
    const r = await run({ ...option, input: { JWT_SECRET: '自动生成', ADMIN_CODE: '自动生成' } });
    assert.equal(r.writes, 0); assert.equal(r.healthCalls, 0);
  }
});

test('replacement must be explicitly selected for both login fields', async () => {
  const r = await run({ input: { JWT_SECRET: '自动生成' } });
  assert.equal(r.writes, 0); assert.match(r.messages[0], /REBUILD_SELECTION_INCOMPLETE/);
});

test('recovery refuses a different cloud environment before configuration mutation', async () => {
  const r = await run({ wrongTarget: true });
  assert.equal(r.writes, 0); assert.equal(r.healthCalls, 0);
  assert.match(r.messages[0], /RECOVERY_TARGET_UNCONFIRMED/);
});

test('the already-open Windows GB2312 form can retry without reentering either platform credential', async () => {
  const r = await run({ legacyFormEncoding: true, input: { JWT_SECRET: '自动生成', ADMIN_CODE: '自动生成' } });
  assert.equal(r.writes, 1); assert.equal(r.healthCalls, 1); assert.equal(r.exitCode, 0);
  assert.equal(r.actual.WX_APP_SECRET, input().WX_APP_SECRET);
  assert.equal(r.actual.VPAY_SANDBOX_APP_KEY, input().VPAY_SANDBOX_APP_KEY);
});

test('future UTF8 forms use an ASCII marker for generating login credentials', async () => {
  const marker = '__GENERATE_LOGIN_CREDENTIALS__';
  const r = await run({ input: { JWT_SECRET: marker, ADMIN_CODE: marker } });
  assert.equal(r.writes, 1); assert.equal(r.healthCalls, 1);
});
