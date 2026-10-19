import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const REGION = 'ap-shanghai';
const NAME = 'hlApi';
const KEY = 'MINIPROGRAM_ADMIN_USER_IDS';
const MCP = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/cli.cjs';
const SDK = resolve(dirname(MCP), 'index.cjs');
const OUTPUT = resolve(ROOT, 'output/admin-entry-20261015');
const fields = names => Object.fromEntries(names.map(name => [name, 1]));
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function check(value, code) { if (!value) throw Object.assign(new Error(code), { safeCode: code }); }

export function uniqueWechatAccount(users) {
  const eligible = users.filter(user => Number.isSafeInteger(user.id) && user.id > 0 && Number(user.status) === 1
    && !user.mergedIntoUserId && typeof user.openid === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(user.openid));
  const deduped = new Map(eligible.map(user => [user.id, user]));
  check(eligible.length === deduped.size && deduped.size === 1, 'ACCOUNT_NOT_UNIQUE');
  return [...deduped.values()][0];
}

export function bindingEnvironment(current, userId) {
  assertUsableEnvironment(current);
  check(Number.isSafeInteger(userId) && userId > 0, 'INVALID_USER_ID');
  check(!Object.hasOwn(current, KEY) || current[KEY] === '' || current[KEY] === String(userId), 'EXISTING_BINDING_REQUIRES_REVIEW');
  return { ...current, [KEY]: String(userId) };
}

export function assertUsableEnvironment(current) {
  check(current && typeof current === 'object' && !Array.isArray(current)
    && Object.entries(current).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && typeof value === 'string'), 'ENVIRONMENT_SHAPE');
  // A redacted read is never a source for a complete environment replacement.
  // Check every value before binding conflicts or any other write decisions.
  const masked = /\[\s*(?:redacted|masked|hidden)\s*\]|<\s*(?:redacted|masked|hidden)\s*>|\*{2,}|[\u2022\u25cf]{2,}|\b(?:redacted|masked)\b/i;
  check(!Object.values(current).some(value => masked.test(value)), 'MASKED_ENVIRONMENT');
  check(typeof current.JWT_SECRET === 'string' && current.JWT_SECRET.length >= 32
    && current.JWT_SECRET.trim().length > 0, 'JWT_SECRET_INVALID');
  check(typeof current.ADMIN_CODE === 'string' && current.ADMIN_CODE.trim().length > 0
    && current.ADMIN_CODE.trim().toUpperCase() !== 'HLADMIN', 'ADMIN_CODE_INVALID');
  return current;
}
export function variables(detail) {
  const rows = detail?.Environment?.Variables;
  check(Array.isArray(rows) && rows.every(row => row && typeof row.Key === 'string' && typeof row.Value === 'string')
    && new Set(rows.map(row => row.Key)).size === rows.length, 'ENVIRONMENT_SHAPE');
  return assertUsableEnvironment(Object.fromEntries(rows.map(row => [row.Key, row.Value])));
}

export function directEnvironmentAccess(manager) {
  check(typeof manager?.functions?.getFunctionDetail === 'function'
    && typeof manager?.functions?.updateFunctionConfig === 'function', 'DIRECT_SDK_UNAVAILABLE');
  return {
    async getDetail() {
      const detail = await manager.functions.getFunctionDetail(NAME);
      check(detail && detail.FunctionName === NAME && detail.Namespace === ENV_ID
        && detail.Type === 'Event', 'FUNCTION_TARGET_MISMATCH');
      variables(detail);
      return detail;
    },
    async updateEnvironment(expected) {
      assertUsableEnvironment(expected);
      return manager.functions.updateFunctionConfig({ name: NAME, envVariables: { ...expected } });
    }
  };
}

async function main() {
  const [mode, nickname] = process.argv.slice(2);
  check(['inspect', 'bind'].includes(mode) && typeof nickname === 'string' && nickname.length > 0 && nickname.length <= 40, 'ARGUMENTS');
  let client;
  let stage = 'connect';
  const report = { envId: ENV_ID, region: REGION, functionName: NAME, mode, startedAt: new Date().toISOString() };
  try {
    client = new PaymentMcpClient(MCP, { envId: ENV_ID, region: REGION, cwd: ROOT });
    await client.ready;
    const listing = await client.request('tools/list', {});
    const readSchema = listing.tools?.find(tool => tool.name === 'readNoSqlDatabaseContent')?.inputSchema;
    check(readSchema, 'OFFICIAL_CONTRACT_MISMATCH');
    // MCP is restricted to account projections. Environment values are read and
    // written through the official manager SDK inside this process only.
    const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
    const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: ENV_ID, region: REGION, site: 'domestic' },
      authStrategy: 'fail_fast' });
    const environment = directEnvironmentAccess(manager);
    const read = async (collectionName, query, projection) => {
      const result = await client.call('readNoSqlDatabaseContent', { collectionName, query, projection, limit: 10 });
      check(Array.isArray(result.data) && result.data.length < 10, 'ACCOUNT_QUERY_INCOMPLETE');
      return result.data;
    };
    const userProjection = fields(['id', 'nickname', 'status', 'openid', 'mergedIntoUserId', 'authVersion']);
    stage = 'resolve-account';
    const users = await read('hl_users', { nickname }, userProjection);
    const profiles = await read('hl_profiles', { realName: nickname }, fields(['userId', 'realName']));
    const byId = new Map(users.map(user => [user.id, user]));
    for (const profile of profiles) {
      check(Number.isSafeInteger(profile.userId) && profile.userId > 0, 'PROFILE_USER_ID_INVALID');
      if (byId.has(profile.userId)) continue;
      const matches = await read('hl_users', { id: profile.userId }, userProjection);
      check(matches.length <= 1, 'DUPLICATE_USER_ID');
      if (matches[0]) byId.set(matches[0].id, matches[0]);
    }
    const user = uniqueWechatAccount([...byId.values()]);
    report.account = { requestedName: nickname, userId: user.id, activeWechatAccounts: 1,
      nameMatches: users.length, profileMatches: profiles.length };
    const getDetail = async () => {
      const value = await environment.getDetail();
      check(value && value.Status === 'Active', 'FUNCTION_NOT_ACTIVE');
      return value;
    };
    stage = 'inspect-configuration';
    const before = await getDetail();
    const current = variables(before);
    const expected = bindingEnvironment(current, user.id);
    const protectedVariables = vars => Object.fromEntries(Object.entries(vars).filter(([key]) => key !== KEY));
    report.before = { modifiedAt: before.ModTime, codeSha256: before.CodeSha256,
      alreadyBound: current[KEY] === String(user.id), targetUrlConfigured: !!current.WEDA_ADMIN_URL,
      protectedEnvironmentSha256: hash(protectedVariables(current)) };
    report.changedKeys = current[KEY] === String(user.id) ? [] : [KEY];
    report.configurationMutationPerformed = false;
    await mkdir(OUTPUT, { recursive: true });
    if (mode === 'bind' && report.changedKeys.length) {
      stage = 'preflight';
      const freshUsers = await read('hl_users', { id: user.id }, userProjection);
      const freshUser = uniqueWechatAccount(freshUsers);
      check(freshUser.openid === user.openid && Number(freshUser.authVersion || 1) === Number(user.authVersion || 1), 'ACCOUNT_CHANGED');
      const fresh = await getDetail();
      check(hash(variables(fresh)) === hash(current) && fresh.CodeSha256 === before.CodeSha256 && fresh.ModTime === before.ModTime, 'CONCURRENT_CONFIGURATION_CHANGE');
      await writeFile(resolve(OUTPUT, 'account-binding-intent.json'), JSON.stringify(report, null, 2) + '\n');
      stage = 'bind';
      await environment.updateEnvironment(expected);
      report.configurationMutationPerformed = true;
    }
    if (mode === 'bind') {
      stage = 'verify';
      let after;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = await environment.getDetail();
        check(candidate, 'FUNCTION_DETAIL_MISSING');
        if (candidate.Status === 'Active') { after = candidate; break; }
        await new Promise(done => setTimeout(done, 1500));
      }
      check(after && hash(variables(after)) === hash(expected)
        && hash(protectedVariables(variables(after))) === report.before.protectedEnvironmentSha256
        && after.CodeSha256 === before.CodeSha256, 'BINDING_READBACK_MISMATCH');
      report.verified = { userId: user.id, status: after.Status, fullEnvironmentReadback: true,
        otherEnvironmentPreserved: true, codeUpdateRequested: false,
        codeDigestVerified: typeof before.CodeSha256 === 'string' && after.CodeSha256 === before.CodeSha256 };
    }
    report.status = mode === 'inspect' ? 'account_resolved_not_bound' : 'account_bound_verified';
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(OUTPUT, mode === 'inspect' ? 'account-inspection.json' : 'account-binding.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'OFFICIAL_OPERATION_FAILED' }));
    process.exitCode = 1;
  } finally { client?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('INVALID_ARGUMENTS'); process.exitCode = 1; });
}
