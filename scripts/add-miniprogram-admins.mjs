import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests } from './deploy-admin-entry-compatibility.mjs';
import { variables } from './configure-miniprogram-admin-entry.mjs';
import { probeToken } from './verify-native-admin-readonly.mjs';

const require = createRequire(import.meta.url);
const { configuredUserIds } = require('../cloudfunctions/hlApi/admin-entry-policy.js');
const { assertVirtualPayer } = require('../cloudfunctions/hlApi/virtual-payment-policy.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'output/admin-additions-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const TARGET = { envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai', functionName: 'hlApi' };
const KEY = 'MINIPROGRAM_ADMIN_USER_IDS';
const BASE_CODE = '24b108f4e9548d812eb95c4fcbd17da4bae044ebaad62a7c86640094d539a32b';
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const check = (ok, safeCode) => { if (!ok) throw Object.assign(new Error(safeCode), { safeCode }); };
const save = (name, report, exclusive = false) => writeFileSync(resolve(OUT, name), JSON.stringify(report, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
const load = name => JSON.parse(readFileSync(resolve(OUT, name), 'utf8'));
const protectedEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => key !== KEY));

export function requestedAccounts(input) {
  check(Array.isArray(input) && input.length > 0 && input.length <= 20, 'REQUEST_FORMAT');
  check(input.every(item => item && Object.keys(item).sort().join(',') === 'label,phone'
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 64
    && typeof item.phone === 'string' && /^1\d{10}$/.test(item.phone)), 'REQUEST_FORMAT');
  check(new Set(input.map(item => item.phone)).size === input.length, 'DUPLICATE_REQUEST_PHONE');
  return input;
}
export function uniqueRequestedAccount(rows, requested) {
  check(Array.isArray(rows) && rows.length < 10, 'ACCOUNT_READ_INCOMPLETE');
  const active = rows.filter(row => row.phone === requested.phone && Number(row.status) !== 0);
  check(active.length > 0, 'PHONE_ACCOUNT_NOT_FOUND');
  check(active.length === 1, 'PHONE_ACCOUNT_NOT_UNIQUE');
  const user = active[0];
  check(Number(user.status) === 1 && !user.mergedIntoUserId, 'ACCOUNT_NOT_ACTIVE');
  check(user.phoneSource === 'wechat', 'PHONE_BINDING_NOT_VERIFIED');
  check(Number.isSafeInteger(user.id) && user.id > 0 && !/^(?:manual_|mock_|seed[-_]|merged_|archived_)/i.test(user.openid || ''), 'ACCOUNT_NOT_WECHAT');
  try { assertVirtualPayer(user.openid); } catch { check(false, 'ACCOUNT_NOT_WECHAT'); }
  return user;
}
export function appendedEnvironment(env, ids) {
  const original = configuredUserIds(env[KEY]);
  check(original && ids.length > 0 && ids.every(id => Number.isSafeInteger(id) && id > 0), 'ADMIN_IDS_INVALID');
  const merged = [...new Set([...original, ...ids])];
  return { ...env, [KEY]: merged.join(',') };
}
function safeAccount(user, requested) {
  return { requestedLabel: requested.label, userId: user.id, nickname: String(user.nickname || ''),
    phoneMasked: requested.phone.slice(0, 3) + '****' + requested.phone.slice(-4),
    nicknameMatches: user.nickname === requested.label, phoneSource: user.phoneSource || 'unspecified', activeWechatAccount: true };
}
async function stdinAccounts() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString('utf8'); check(input.length <= 8192, 'INPUT_TOO_LARGE'); }
  try { return requestedAccounts(JSON.parse(input)); } catch (error) { check(false, error.safeCode || 'REQUEST_FORMAT'); }
}

async function main(mode) {
  check(['--inspect-stdin','--apply-stdin','--verify'].includes(mode), 'MODE_INVALID');
  mkdirSync(OUT, { recursive: true });
  const requested = mode === '--verify' ? null : await stdinAccounts();
  const mcp = new PaymentMcpClient(resolve(SDK, '..', 'cli.cjs'), { ...TARGET, cwd: ROOT });
  let stage = 'connect', writeRequested = false;
  try {
    await mcp.ready;
    const listed = await mcp.request('tools/list', {});
    check(['readNoSqlDatabaseContent','manageFunctions'].every(name => listed.tools.some(tool => tool.name === name)), 'MCP_SCHEMA_MISSING');
    const manager = await require(SDK).getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
    async function snapshot() {
      const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
      check(detail.Status === 'Active', 'FUNCTION_NOT_ACTIVE');
      const env = variables(detail), protectedValues = protectedDigests(detail);
      const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
      check(address.CodeSha256 === BASE_CODE, 'LIVE_CODE_CHANGED');
      return { detail, env, protected: protectedValues };
    }
    async function readUsers(query, fields = ['id','status','phone','phoneSource','nickname','openid','authVersion','mergedIntoUserId']) {
      const result = await mcp.call('readNoSqlDatabaseContent', { collectionName: 'hl_users', query,
        projection: Object.fromEntries(fields.map(key => [key, 1])), limit: 10 });
      check(result.success === true && Array.isArray(result.data) && result.data.length < 10, 'ACCOUNT_READ_INCOMPLETE');
      return result.data;
    }
    async function resolveRequested() {
      const resolutions = await Promise.all(requested.map(async request => {
        const rows = await readUsers({ phone: request.phone });
        try { return { user: uniqueRequestedAccount(rows, request) }; }
        catch (error) {
          const aliases = await readUsers({ nickname: request.label });
          const profiles = await mcp.call('readNoSqlDatabaseContent', { collectionName: 'hl_profiles', query: { 'basic.phone': request.phone },
            projection: { userId: 1 }, limit: 10 });
          check(profiles.success === true && Array.isArray(profiles.data) && profiles.data.length < 10, 'ACCOUNT_READ_INCOMPLETE');
          return { failure: { requestedLabel: request.label, phoneMasked: request.phone.slice(0, 3) + '****' + request.phone.slice(-4),
          code: error.safeCode || 'ACCOUNT_NOT_CONFIRMED', matches: rows.map(row => ({ userId: row.id, nickname: row.nickname || '', status: row.status,
            phoneSource: row.phoneSource || 'unspecified', merged: !!row.mergedIntoUserId })),
          nicknameMatches: aliases.map(row => ({ userId: row.id, nickname: row.nickname || '', status: row.status, phonePresent: !!row.phone })),
          profilePhoneMatches: profiles.data.map(row => ({ userId: row.userId })) } }; }
      }));
      const failures = resolutions.filter(row => row.failure).map(row => row.failure);
      if (failures.length) throw Object.assign(new Error('ACCOUNT_RESOLUTION_INCOMPLETE'), { safeCode: 'ACCOUNT_RESOLUTION_INCOMPLETE', accountFailures: failures });
      const users = resolutions.map(row => row.user);
      check(new Set(users.map(user => user.id)).size === users.length, 'DUPLICATE_TARGET_ACCOUNT');
      return users;
    }
    async function verifyAccess(env, ids) {
      const checks = [];
      for (const id of ids) {
        const rows = await readUsers({ id }, ['id','status','authVersion','mergedIntoUserId']);
        check(rows.length === 1 && Number(rows[0].status) === 1 && !rows[0].mergedIntoUserId, 'VERIFY_ACCOUNT_INVALID');
        const token = probeToken(env.JWT_SECRET, id, Number(rows[0].authVersion || 1));
        const entryResult = await manager.functions.invokeFunction(TARGET.functionName, { path: '/user/admin-entry', method: 'GET', token, data: {} });
        const entry = JSON.parse(entryResult.RetMsg);
        check(entry.code === 0 && entry.data?.allowed === true && entry.data.ready === true && entry.data.mode === 'native', 'ADMIN_ENTRY_NOT_ENABLED');
        const plansResult = await manager.functions.invokeFunction(TARGET.functionName, { path: '/user/admin/operations', method: 'POST', token,
          data: { action: 'plans.list', args: { page: 1, pageSize: 10 } } });
        const plans = JSON.parse(plansResult.RetMsg);
        check(plans.code === 0 && Array.isArray(plans.data?.list) && plans.data.list.length === 6, 'ADMIN_READ_NOT_ENABLED');
        checks.push({ userId: id, entryAllowed: true, managementReadAllowed: true });
      }
      return checks;
    }
    stage = 'read_current';
    const before = await snapshot();
    if (mode === '--verify') {
      const intent = load('intent.json');
      check(digest(before.env) === intent.expectedEnvironmentSha256 && before.protected.configurationSha256 === intent.configurationSha256, 'READBACK_MISMATCH');
      const access = await verifyAccess(before.env, intent.verifyIds);
      const report = { status: 'added_verified', verifiedAt: new Date().toISOString(), target: TARGET, accounts: intent.accounts,
        adminUserIds: [...configuredUserIds(before.env[KEY])], access, existingAdminsPreserved: true, otherEnvironmentPreserved: true,
        codeUnchanged: true, businessMutations: 0, paymentCalls: 0, realWechatLoginVerified: false, credentialsPersisted: false };
      save('verified.json', report); return report;
    }
    stage = 'resolve_accounts';
    const users = await resolveRequested(), ids = users.map(user => user.id);
    const expected = appendedEnvironment(before.env, ids), originalIds = [...configuredUserIds(before.env[KEY])];
    const accounts = users.map((user, index) => safeAccount(user, requested[index]));
    const identityDigest = digest(users), requestDigest = digest(requested);
    const report = { status: 'ready', checkedAt: new Date().toISOString(), target: TARGET, accounts, originalAdminIds: originalIds,
      resultingAdminIds: [...configuredUserIds(expected[KEY])], changedKeys: [KEY], environmentSha256: digest(before.env),
      expectedEnvironmentSha256: digest(expected), protectedEnvironmentSha256: digest(protectedEnv(before.env)),
      configurationSha256: before.protected.configurationSha256, identityDigest, requestDigest, codeSha256: BASE_CODE, cloudWrites: 0 };
    if (mode === '--inspect-stdin') { save('inspection.json', report); return report; }
    check(!existsSync(resolve(OUT, 'intent.json')), 'WRITE_ALREADY_REQUESTED_VERIFY_FIRST');
    const inspected = load('inspection.json');
    check(inspected.environmentSha256 === report.environmentSha256 && inspected.configurationSha256 === report.configurationSha256
      && inspected.identityDigest === identityDigest && inspected.requestDigest === requestDigest, 'INSPECTION_CHANGED');
    stage = 'final_preflight';
    check(digest(await resolveRequested()) === identityDigest, 'ACCOUNT_CHANGED');
    const fresh = await snapshot();
    check(digest(fresh.env) === digest(before.env) && fresh.detail.ModTime === before.detail.ModTime
      && fresh.protected.configurationSha256 === before.protected.configurationSha256, 'CONCURRENT_CONFIGURATION_CHANGE');
    const verifyIds = [...new Set([...ids, ...originalIds])];
    save('intent.json', { ...report, status: 'write_requested', verifyIds, requestedAt: new Date().toISOString() }, true);
    stage = 'update_environment'; writeRequested = true;
    await mcp.call('manageFunctions', { action: 'updateFunctionConfig', functionName: TARGET.functionName, envVariables: expected });
    stage = 'readback';
    let after;
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
      check(!/Failed|Error/i.test(detail.Status), 'CONFIGURATION_UPDATE_FAILED');
      if (detail.Status === 'Active' && digest(variables(detail)) === digest(expected)) { after = await snapshot(); break; }
      await new Promise(done => setTimeout(done, 1000));
    }
    check(after && digest(after.env) === digest(expected) && digest(protectedEnv(after.env)) === report.protectedEnvironmentSha256
      && after.protected.configurationSha256 === before.protected.configurationSha256, 'READBACK_MISMATCH');
    stage = 'verify_access';
    const access = await verifyAccess(after.env, verifyIds);
    const final = await snapshot();
    check(digest(final.env) === digest(expected) && final.protected.configurationSha256 === before.protected.configurationSha256, 'FINAL_STATE_CHANGED');
    const result = { status: 'added_verified', verifiedAt: new Date().toISOString(), target: TARGET, accounts,
      adminUserIds: [...configuredUserIds(final.env[KEY])], access, existingAdminsPreserved: true, otherEnvironmentPreserved: true,
      codeUnchanged: true, configurationWrites: 1, businessMutations: 0, paymentCalls: 0, realWechatLoginVerified: false, credentialsPersisted: false };
    save('verified.json', result); return result;
  } catch (error) {
    const result = { status: 'incomplete', stage, code: error.safeCode || 'ADMIN_ADDITION_FAILED', configurationUpdateRequested: writeRequested, automaticRetry: false };
    if (error.accountFailures) result.accountFailures = error.accountFailures;
    save('latest-safe-result.json', result); return result;
  } finally { mcp.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await main(process.argv.length === 3 ? process.argv[2] : ''); console.log(JSON.stringify(report)); if (report.status === 'incomplete') process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ status: 'incomplete', code: error.safeCode || 'ADMIN_ADDITION_FAILED' })); process.exitCode = 1; }
}
