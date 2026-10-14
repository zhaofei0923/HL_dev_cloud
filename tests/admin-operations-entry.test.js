'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const file = path.resolve(__dirname, '../cloudfunctions/hlAdminOperations/index.js');
const localRequire = createRequire(file);
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const READS = { 'matchmakers.list': 'listMatchmakers', 'matchmakers.detail': 'detailMatchmaker',
  'certifications.list': 'listCertifications', 'certifications.detail': 'detailCertification',
  'salons.list': 'listSalons', 'salons.detail': 'detailSalon', 'plans.list': 'listPlans', 'plans.detail': 'detailPlan',
  'orders.list': 'listOrders', 'orders.detail': 'detailOrder' };
const WRITES = ['matchmakers.review', 'certifications.review', 'salons.review', 'salons.cancel', 'plans.update'];
const MATERIALS = ['certifications.evidence', 'certifications.material'];

function runtime(options = {}) {
  const calls = { parse: [], authorize: [], database: [], services: [], warnings: [], materialOptions: [] };
  // Opaque sentinels test delegation to the SDK and authorizer. They deliberately
  // make no claim to reproduce a real SCF/TCB caller context or credentials.
  const providerContext = Object.freeze({ fixture: 'opaque-provider-context' });
  const parsedContext = Object.freeze({ fixture: 'opaque-sdk-parse-result' });
  const state = { permitted: true, parseFailure: false, failure: null };
  let scanCount = 0;
  const db = options.realReads ? { collection() {
    return { orderBy() { return this; }, field() { return this; }, skip() { return this; }, limit() { return this; },
      async get() { scanCount++; return { data: [] }; } };
  } } : Object.freeze({ fixture: 'database' });
  const exported = { exports: {} };
  let sequence = 0;
  const serviceCall = async (kind, action, args, actor) => {
    calls.services.push({ kind, action, args, actor });
    if (state.failure) throw state.failure;
    return { kind, action, accepted: true };
  };
  const readService = Object.fromEntries(Object.values(READS).map(method => [method, args => serviceCall('read', method, args)]));
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports: exported.exports, module: exported, Object,
    process: { env: { MEMBER_CERTIFICATION_ENCRYPTION_KEY: 'fixture-domain-key', MEMBER_CERTIFICATION_JWT_DERIVED_KEY: 'fixture-derived-key',
      JWT_SECRET: 'fixture-signing-key-must-not-be-passed', ADMIN_CODE: 'fixture-shared-code-must-not-be-passed' } },
    console: { warn(...values) { calls.warnings.push(values); } },
    require(name) {
      if (name === 'node:crypto') return { randomUUID: () => `server-generated-${String(++sequence).padStart(4, '0')}` };
      if (name === '@cloudbase/node-sdk') return {
        init(config) {
          assert.equal(config.env, ENV_ID);
          return { database(config) { calls.database.push(config); assert.equal(config.throwOnCode, true); return db; },
            downloadFile: async () => { throw new Error('storage must be delegated, not reached in this entry test'); } };
        },
        parseContext(context) {
          calls.parse.push(context);
          if (state.parseFailure || context !== providerContext) throw new Error('fixture provider parse denial');
          return parsedContext;
        }
      };
      if (name === 'tencentcloud-sdk-nodejs-tcb') return { tcb: { v20180608: { Client: class {
        constructor() { throw new Error('entry tests must not create a live management client'); }
      } } } };
      if (name === '../hlAdminCockpit/auth') return { ENV_ID, async authorize(parsed, describeUsers) {
        calls.authorize.push(parsed); assert.equal(parsed, parsedContext); assert.equal(typeof describeUsers, 'function');
        if (!state.permitted) throw Object.assign(new Error('fixture administrator revoked'), { code: 40350 });
        return { uid: 'provider-authorized-admin' };
      } };
      if (name === './read-service') return options.realReads ? localRequire(name)
        : { createReadService({ db: supplied }) { assert.equal(supplied, db); return readService; } };
      if (name === './mutation-service') return { createMutationService({ db: supplied }) { assert.equal(supplied, db);
        return { execute: (action, args, actor) => serviceCall('mutation', action, args, actor) }; } };
      if (name === './material-service') return { createMaterialService(options) {
        assert.equal(options.db, db); calls.materialOptions.push(options);
        return { evidence: (args, actor) => serviceCall('material', 'evidence', args, actor),
          material: (args, actor) => serviceCall('material', 'material', args, actor) };
      } };
      return localRequire(name);
    }
  }, { filename: file });
  return { ...exported.exports, calls, state, providerContext, get scanCount() { return scanCount; } };
}

test('entry refuses caller-supplied identity when the real provider parsing boundary denies it', async () => {
  const rt = runtime();
  const result = await rt.main({ action: 'plans.update', args: { planCode: 'vip_week', active: true }, requestId: 'client-operation-01',
    uid: 'provider-authorized-admin', role: 'administrator', token: 'forged', context: rt.providerContext }, {});
  assert.equal(result.code, 40150); assert.equal(rt.calls.authorize.length, 0);
  assert.equal(rt.calls.database.length, 0); assert.equal(rt.calls.services.length, 0);
});
test('authorization is refreshed on every invocation and a revoked administrator cannot reach business services', async () => {
  const rt = runtime();
  assert.equal((await rt.main({ action: 'plans.list' }, rt.providerContext)).code, 0);
  rt.state.permitted = false;
  assert.equal((await rt.main({ action: 'plans.list' }, rt.providerContext)).code, 40350);
  assert.equal(rt.calls.authorize.length, 2); assert.equal(rt.calls.services.length, 1); assert.equal(rt.calls.database.length, 1);
});
test('whitelist contains only the documented reads, five writes and explicit material reads', async () => {
  const rt = runtime();
  assert.deepEqual(Array.from(rt.ACTIONS), [...Object.keys(READS), ...WRITES, ...MATERIALS]);
  for (const [action, method] of Object.entries(READS)) {
    const args = { fixture: action };
    const result = await rt.main({ action, args }, rt.providerContext);
    assert.equal(result.code, 0); assert.equal(rt.calls.services.at(-1).kind, 'read');
    assert.equal(rt.calls.services.at(-1).action, method); assert.equal(rt.calls.services.at(-1).args, args);
  }
});
for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'orders.refund', 'orders.fulfill', 'functions.invoke', '/admin/login', 'plans.delete']) {
  test(`entry denies non-whitelisted action ${action} before creating database or services`, async () => {
    const rt = runtime(); const result = await rt.main({ action, args: {} }, rt.providerContext);
    assert.equal(result.code, 40360); assert.equal(rt.calls.database.length, 0); assert.equal(rt.calls.services.length, 0);
  });
}
test('top-level actor, role, code and arbitrary routing fields are ignored and cannot affect an authorized operation', async () => {
  for (const field of ['uid', 'role', 'code', 'token', 'path', 'method', 'functionName', 'context', 'serverRequestId']) {
    const rt = runtime();
    const result = await rt.main({ action: 'plans.update', args: {}, requestId: 'client-operation-01', [field]: 'forged' }, rt.providerContext);
    assert.equal(result.code, 0); assert.equal(rt.calls.services.length, 1);
    assert.equal(rt.calls.services[0].action, 'plans.update');
    assert.equal(rt.calls.services[0].actor.uid, 'provider-authorized-admin');
    assert.ok(!JSON.stringify({ result, calls: rt.calls.services, warnings: rt.calls.warnings }).includes('forged'));
  }
});
test('write dispatcher supplies only the authorizer uid and separates stable client operation id from server request id', async () => {
  const rt = runtime(); const args = { planCode: 'vip_week', active: false, expectedVersion: 'fixture-service-validates-version' };
  for (const action of WRITES) {
    const result = await rt.main({ action, args, requestId: 'stable-client-operation-01' }, rt.providerContext);
    assert.equal(result.code, 0);
    const call = rt.calls.services.at(-1);
    assert.equal(call.kind, 'mutation'); assert.equal(call.action, action); assert.equal(call.args, args);
    assert.equal(call.actor.uid, 'provider-authorized-admin'); assert.equal(call.actor.requestId, 'stable-client-operation-01');
    assert.equal(call.actor.serverRequestId, result.requestId); assert.notEqual(call.actor.requestId, result.requestId);
  }
  assert.equal(new Set(rt.calls.services.map(call => call.actor.serverRequestId)).size, WRITES.length);
});
test('a retry preserves its client operation id and receives a fresh independent server tracing id', async () => {
  const rt = runtime(); const event = { action: 'matchmakers.review', args: { id: 1 }, requestId: 'stable-client-operation-01' };
  const first = await rt.main(event, rt.providerContext), second = await rt.main(event, rt.providerContext);
  assert.equal(rt.calls.services[0].actor.requestId, rt.calls.services[1].actor.requestId);
  assert.notEqual(first.requestId, second.requestId);
});
test('missing or invalid client operation ids fail before mutation execution', async () => {
  for (const requestId of [undefined, null, '', 1, {}, 'unsafe/id', 'x'.repeat(81)]) {
    const rt = runtime(); const result = await rt.main({ action: 'plans.update', args: {}, requestId }, rt.providerContext);
    assert.equal(result.code, 42260); assert.equal(rt.calls.services.length, 0);
  }
});
test('materials use explicit actions and receive only domain decryption keys, never a JWT signing secret or shared admin code', async () => {
  const rt = runtime();
  for (const action of MATERIALS) {
    const args = { userId: 2, kind: 'identity', applicationId: 'fixture-application', expectedVersion: 'fixture-service-validates-version' };
    const result = await rt.main({ action, args }, rt.providerContext);
    assert.equal(result.code, 0); const call = rt.calls.services.at(-1);
    assert.equal(call.kind, 'material'); assert.equal(call.actor.uid, 'provider-authorized-admin');
    assert.equal(call.actor.serverRequestId, result.requestId); assert.equal(call.actor.requestId, undefined);
    const options = rt.calls.materialOptions.at(-1);
    assert.deepEqual(Object.keys(options.secrets).sort(), ['encryptionKey', 'jwtDerivedKey']);
    assert.equal(options.secrets.jwtSecret, undefined); assert.equal(options.secrets.adminCode, undefined);
    assert.equal(JSON.stringify(result).includes('fixture-domain-key'), false);
  }
});
test('unknown internal exceptions return a generic message and log only a code plus server tracking id', async () => {
  const rt = runtime();
  const privateMessage = 'private-material-cloud-url-and-key-that-must-not-leak';
  rt.state.failure = Object.assign(new Error(privateMessage), { requestId: privateMessage, uid: privateMessage });
  const result = await rt.main({ action: 'certifications.material', args: {} }, rt.providerContext);
  assert.equal(result.code, 50360); assert.equal(result.data, undefined);
  assert.equal(JSON.stringify(result).includes(privateMessage), false); assert.equal(JSON.stringify(rt.calls.warnings).includes(privateMessage), false);
  assert.equal(rt.calls.warnings.length, 1);
  assert.deepEqual(Object.keys(rt.calls.warnings[0][1]).sort(), ['code', 'requestId']);
});
test('non-plain request envelopes and accessor properties cannot execute a service', async () => {
  for (const event of [null, [], Object.create({ action: 'plans.list' }), Object.defineProperty({}, 'action', { get() { throw new Error('accessor must not run'); }, enumerable: true })]) {
    const rt = runtime(); const result = await rt.main(event, rt.providerContext);
    assert.equal(result.code, 42260); assert.equal(rt.calls.services.length, 0);
  }
});

// basic-api.callFunction in the official Weda SDK injects six top-level fields;
// the official renderer's beforeCallFunction hook adds accessToken for configured
// login. Values below are isolated fixtures, not real cloud identity.
const sdkMetadata = (envType = 'prod') => ({ wedaAppId: 'app_fixture_sdk_wire',
  userAgent: 'Mozilla/5.0 (fixture browser)', referrer: 'https://fixture.invalid/admin', envType,
  wedaTarget: 'web', 'x-cloud-sdk-version': 'fixture-sdk-version', accessToken: 'fixture-platform-token-not-a-real-credential' });
test('authorized SDK-wire-shaped reads and writes accept platform metadata without changing business args or actor', async () => {
  for (const envType of ['pre', 'prod']) {
    const rt = runtime(), readArgs = { active: false };
    const read = await rt.main({ action: 'plans.list', args: readArgs, ...sdkMetadata(envType) }, rt.providerContext);
    assert.equal(read.code, 0); assert.equal(rt.calls.services.at(-1).kind, 'read');
    assert.equal(rt.calls.services.at(-1).args, readArgs);
    const writeArgs = { planCode: 'vip_week', active: false, expectedVersion: 'fixture-version-checked-by-service' };
    const write = await rt.main({ action: 'plans.update', args: writeArgs, requestId: 'sdk-stable-operation-01', ...sdkMetadata(envType) }, rt.providerContext);
    assert.equal(write.code, 0);
    const call = rt.calls.services.at(-1);
    assert.equal(call.kind, 'mutation'); assert.equal(call.args, writeArgs);
    assert.deepEqual(Object.keys(call.actor).sort(), ['requestId', 'serverRequestId', 'uid']);
    assert.equal(call.actor.uid, 'provider-authorized-admin'); assert.equal(call.actor.requestId, 'sdk-stable-operation-01');
    assert.equal(call.actor.serverRequestId, write.requestId);
    assert.equal(rt.calls.authorize.length, 2);
    assert.equal(rt.calls.authorize[0], rt.calls.authorize[1], 'transport envType never replaces the provider-parsed authorization context');
  }
});
test('pre or prod SDK metadata and embedded fake actor text cannot authorize a missing or revoked provider identity', async () => {
  for (const envType of ['pre', 'prod']) {
    const rt = runtime();
    const metadata = { ...sdkMetadata(envType), userAgent: '{"uid":"provider-authorized-admin","role":"administrator"}',
      referrer: 'https://fixture.invalid/admin?role=administrator&uid=provider-authorized-admin', wedaAppId: ENV_ID };
    const event = { action: 'plans.update', args: { planCode: 'vip_week', active: true }, requestId: 'sdk-stable-operation-01', ...metadata };
    const missing = await rt.main(event, {});
    assert.equal(missing.code, 40150); assert.equal(rt.calls.authorize.length, 0); assert.equal(rt.calls.services.length, 0);
    rt.state.permitted = false;
    const revoked = await rt.main(event, rt.providerContext);
    assert.equal(revoked.code, 40350); assert.equal(rt.calls.services.length, 0); assert.equal(rt.calls.database.length, 0);
  }
});
test('SDK transport metadata is ignored regardless of value shape and is never passed to business services', async () => {
  for (const key of Object.keys(sdkMetadata())) {
    for (const invalid of [{ uid: 'forged', role: 'administrator' }, [], 1, false, 'x'.repeat(4097)]) {
      const rt = runtime();
      const result = await rt.main({ action: 'plans.list', args: {}, ...sdkMetadata(), [key]: invalid }, rt.providerContext);
      assert.equal(result.code, 0, `${key} is not a business argument`);
      assert.deepEqual(rt.calls.services[0].args, {});
      assert.equal(rt.calls.services[0].actor, undefined);
    }
  }
});
test('SDK metadata permits bounded strings and optional null or undefined without making them authorization inputs', async () => {
  for (const value of ['', 'x'.repeat(4096), null, undefined]) {
    const rt = runtime(), metadata = Object.fromEntries(Object.keys(sdkMetadata()).map(key => [key, value]));
    const result = await rt.main({ action: 'plans.list', ...metadata }, rt.providerContext);
    assert.equal(result.code, 0); assert.equal(rt.calls.authorize.length, 1); assert.equal(rt.calls.services.length, 1);
    assert.deepEqual(Object.keys(rt.calls.services[0].args), []);
  }
});

test('renderer accessToken is ignored for every read and never reaches a service, result or diagnostic', async () => {
  const token = 'fixture-renderer-token-containing-private-text';
  for (const action of Object.keys(READS)) {
    const rt = runtime(), args = { fixture: 'business-service-validates-its-own-fields' };
    const result = await rt.main({ action, args, ...sdkMetadata(), accessToken: token }, rt.providerContext);
    assert.equal(result.code, 0, action);
    assert.equal(rt.calls.parse[0], rt.providerContext);
    assert.equal(rt.calls.authorize.length, 1);
    assert.equal(rt.calls.services[0].args, args);
    assert.equal(rt.calls.services[0].actor, undefined);
    assert.ok(!JSON.stringify({ result, services: rt.calls.services, warnings: rt.calls.warnings }).includes(token));
  }
  const rt = runtime();
  rt.state.failure = Object.assign(new Error('fixture service error'), { code: 42260 });
  const failed = await rt.main({ action: 'plans.list', accessToken: token }, rt.providerContext);
  assert.equal(failed.code, 42260);
  assert.ok(!JSON.stringify({ failed, warnings: rt.calls.warnings }).includes(token));
  assert.deepEqual(Object.keys(rt.calls.warnings[0][1]).sort(), ['code', 'requestId']);
});

test('renderer accessToken does not replace provider login or an active server administrator role', async () => {
  const rt = runtime();
  const request = { action: 'plans.list', args: { page: 1, pageSize: 10 },
    accessToken: 'fixture-token-claiming-administrator' };
  assert.equal((await rt.main(request, {})).code, 40150);
  rt.state.permitted = false;
  assert.equal((await rt.main(request, rt.providerContext)).code, 40350);
  assert.equal(rt.calls.database.length, 0);
  assert.equal(rt.calls.services.length, 0);
});

test('authorized validation failures return safe diagnostic categories without exposing caller data', async () => {
  const rt = runtime();
  const event = Object.defineProperty({ userInfo: { token: 'private-canary' } }, 'action', { get() { throw new Error('private-canary'); } });
  const result = await rt.main(event, rt.providerContext);
  assert.equal(result.code, 42260);
  assert.equal(result.diagnosticCode, 'ENVELOPE_ACCESSOR');
  assert.equal(rt.calls.database.length, 0);
  assert.equal((await rt.main({ action: 'plans.list', accessToken: 'private-canary'.repeat(1000) }, rt.providerContext)).code, 0);
  assert.ok(!JSON.stringify({ result, warnings: rt.calls.warnings }).includes('private-canary'));
  rt.state.failure = Object.assign(new Error('分页参数无效'), { code: 42260 });
  assert.equal((await rt.main({ action: 'plans.list', args: {} }, rt.providerContext)).diagnosticCode, 'ARGS_PAGE');
});

test('unauthorized requests never receive validation diagnostics or reach business services', async () => {
  const rt = runtime();
  const event = { action: 'plans.list', userInfo: { token: 'private-canary' } };
  assert.equal((await rt.main(event, {})).diagnosticCode, undefined);
  rt.state.permitted = false;
  assert.equal((await rt.main(event, rt.providerContext)).diagnosticCode, undefined);
  assert.equal(rt.calls.database.length, 0);
});

test('all real list services ignore unknown outer fields while inner business fields remain strictly validated', async () => {
  for (const page of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
    const rt = runtime({ realReads: true });
    const args = { page: 1, pageSize: 10 };
    const baseline = await rt.main({ action: page + '.list', args }, rt.providerContext);
    assert.equal(baseline.code, 0);
    let getterCalls = 0;
    const request = { action: page + '.list', args, ...sdkMetadata(), accessToken: { canary: 'private-transport-token' },
      userInfo: { uid: 'forged' }, requestContext: { role: 'forged' }, amountFen: 1,
      ['private-canary-field']: 'private-canary-value', [Symbol('private-canary')]: true };
    Object.defineProperty(request, 'unknownPlatformField', { get() { getterCalls++; throw new Error('must not read metadata'); } });
    Object.defineProperty(request, '__proto__', { value: 'private-canary-prototype' });
    const result = await rt.main(request, rt.providerContext);
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, baseline.data);
    assert.equal(getterCalls, 0);
    assert.ok(!JSON.stringify({ result, warnings: rt.calls.warnings }).includes('private-canary'));
    if (page === 'plans') assert.equal(result.data.total, 6);
    const scans = rt.scanCount;
    const invalid = await rt.main({ ...request, args: { ...args, extraBusinessField: true } }, rt.providerContext);
    assert.equal(invalid.code, 42260);
    assert.equal(invalid.diagnosticCode, 'ARGS_FIELDS');
    assert.equal(rt.scanCount, scans, 'invalid business arguments are rejected before data reads');
  }
});
