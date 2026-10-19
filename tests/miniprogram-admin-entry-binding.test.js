const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = import('../scripts/configure-miniprogram-admin-entry.mjs');

const usableEnvironment = () => ({ JWT_SECRET: 'isolated-fixture-jwt-secret-32-characters', ADMIN_CODE: 'fixture-private-admin-code',
  PRIVATE_FIXTURE: 'opaque', WEDA_ADMIN_URL: '', PAYMENT_INTEGRATION_READY: 'false' });
const detailFor = env => ({ FunctionName: 'hlApi', Namespace: 'cloud1-d2gza7q9c8d69c721', Type: 'Event', Status: 'Active',
  Environment: { Variables: Object.entries(env).map(([Key, Value]) => ({ Key, Value })) } });

test('entry binding resolves one active WeChat account and rejects duplicate or ineligible accounts', async () => {
  const { uniqueWechatAccount } = await policy;
  const user = { id: 17, status: 1, openid: 'isolated_wechat_account_17' };
  assert.equal(uniqueWechatAccount([user]), user);
  for (const users of [[], [user, { ...user }], [user, { ...user, id: 18 }], [{ ...user, status: 0 }],
    [{ ...user, openid: '' }], [{ ...user, mergedIntoUserId: 18 }], [{ ...user, id: '17' }]]) {
    assert.throws(() => uniqueWechatAccount(users), /ACCOUNT_NOT_UNIQUE/);
  }
});

test('entry binding changes only the authorized ID configuration and refuses unrelated existing authorizations', async () => {
  const { bindingEnvironment } = await policy;
  const before = usableEnvironment();
  assert.deepEqual(bindingEnvironment(before, 17), { ...before, MINIPROGRAM_ADMIN_USER_IDS: '17' });
  assert.equal(Object.hasOwn(before, 'MINIPROGRAM_ADMIN_USER_IDS'), false);
  assert.deepEqual(bindingEnvironment({ ...before, MINIPROGRAM_ADMIN_USER_IDS: '17' }, 17), { ...before, MINIPROGRAM_ADMIN_USER_IDS: '17' });
  assert.throws(() => bindingEnvironment({ ...before, MINIPROGRAM_ADMIN_USER_IDS: '18' }, 17), /EXISTING_BINDING/);
  for (const userId of [0, -1, '17', NaN, 1.5]) assert.throws(() => bindingEnvironment(before, userId), /INVALID_USER_ID/);
});

test('masked values anywhere in the environment block the binding before existing-binding decisions', async () => {
  const { bindingEnvironment, assertUsableEnvironment, variables } = await policy;
  for (const masked of ['[REDACTED]', '[redacted]', '[ MASKED ]', '<redacted>', '<MASKED>', '***', '********', '**',
    '••••', '●●●', 'redacted', 'masked', 'prefix-[REDACTED]-suffix', 'secret***tail']) {
    for (const key of ['JWT_SECRET', 'ADMIN_CODE', 'MINIPROGRAM_ADMIN_USER_IDS', 'UNRELATED_PRIVATE_KEY']) {
      const current = { ...usableEnvironment(), [key]: masked };
      assert.throws(() => assertUsableEnvironment(current), /MASKED_ENVIRONMENT/);
      assert.throws(() => bindingEnvironment(current, 17), /MASKED_ENVIRONMENT/);
      assert.throws(() => variables(detailFor(current)), /MASKED_ENVIRONMENT/);
    }
  }
});

test('weak JWT, empty or default administrator code cannot be rewritten by the binding helper', async () => {
  const { bindingEnvironment } = await policy;
  for (const value of [undefined, '', 'short', 'x'.repeat(31), ' '.repeat(32)]) {
    const current = usableEnvironment();
    if (value === undefined) delete current.JWT_SECRET;
    else current.JWT_SECRET = value;
    assert.throws(() => bindingEnvironment(current, 17), /JWT_SECRET_INVALID/);
  }
  for (const value of [undefined, '', '   ', 'HLADMIN', ' hladmin ']) {
    const current = usableEnvironment();
    if (value === undefined) delete current.ADMIN_CODE;
    else current.ADMIN_CODE = value;
    assert.throws(() => bindingEnvironment(current, 17), /ADMIN_CODE_INVALID/);
  }
});

test('environment parser rejects duplicate, missing or non-string values', async () => {
  const { variables } = await policy;
  const valid = detailFor(usableEnvironment());
  assert.deepEqual(variables(valid), usableEnvironment());
  for (const malformed of [{}, { Environment: { Variables: null } },
    { Environment: { Variables: [...valid.Environment.Variables, valid.Environment.Variables[0]] } },
    { Environment: { Variables: [{ Key: 'JWT_SECRET', Value: 123 }] } },
    { Environment: { Variables: [null] } }]) assert.throws(() => variables(malformed), /ENVIRONMENT_SHAPE/);
});

test('environment reads and writes use only the direct official manager API with a fixed function target', async () => {
  const { directEnvironmentAccess, bindingEnvironment } = await policy;
  const calls = [], current = usableEnvironment();
  const manager = { functions: {
    async getFunctionDetail(name) { calls.push({ method: 'getFunctionDetail', name }); return detailFor(current); },
    async updateFunctionConfig(config) { calls.push({ method: 'updateFunctionConfig', config }); return { RequestId: 'fixture' }; }
  } };
  const access = directEnvironmentAccess(manager);
  const detail = await access.getDetail();
  const expected = bindingEnvironment(Object.fromEntries(detail.Environment.Variables.map(row => [row.Key, row.Value])), 17);
  await access.updateEnvironment(expected);
  assert.deepEqual(calls, [{ method: 'getFunctionDetail', name: 'hlApi' },
    { method: 'updateFunctionConfig', config: { name: 'hlApi', envVariables: expected } }]);
  assert.notEqual(calls[1].config.envVariables, expected);
  assert.equal(Object.hasOwn(current, 'MINIPROGRAM_ADMIN_USER_IDS'), false);
});

test('direct API adapter refuses masked reads or writes before any update call', async () => {
  const { directEnvironmentAccess } = await policy;
  let writes = 0;
  const manager = { functions: {
    async getFunctionDetail() { return detailFor({ ...usableEnvironment(), PRIVATE_TOKEN: '[REDACTED]' }); },
    async updateFunctionConfig() { writes += 1; }
  } };
  const access = directEnvironmentAccess(manager);
  await assert.rejects(access.getDetail(), /MASKED_ENVIRONMENT/);
  for (const value of ['[REDACTED]', '***', '<masked>']) {
    await assert.rejects(access.updateEnvironment({ ...usableEnvironment(), PRIVATE_TOKEN: value }), /MASKED_ENVIRONMENT/);
  }
  await assert.rejects(access.updateEnvironment({ ...usableEnvironment(), JWT_SECRET: 'short' }), /JWT_SECRET_INVALID/);
  assert.equal(writes, 0);
});

test('direct API reads reject a different function or environment without attempting updates', async () => {
  const { directEnvironmentAccess } = await policy;
  let writes = 0;
  for (const patch of [{ FunctionName: 'other' }, { Namespace: 'other' }, { Type: 'HTTP' }]) {
    const access = directEnvironmentAccess({ functions: {
      async getFunctionDetail() { return { ...detailFor(usableEnvironment()), ...patch }; },
      async updateFunctionConfig() { writes += 1; }
    } });
    await assert.rejects(access.getDetail(), /FUNCTION_TARGET_MISMATCH/);
  }
  assert.equal(writes, 0);
});

test('configuration helper never sends environment reads or writes through MCP', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'configure-miniprogram-admin-entry.mjs'), 'utf8');
  const toolCalls = [...source.matchAll(/client\.call\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(toolCalls, ['readNoSqlDatabaseContent']);
  assert.doesNotMatch(source, /revealEnvValues|client\.call\('(?:queryFunctions|manageFunctions)'/);
});
