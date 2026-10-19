import { createRequire } from 'node:module';
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { validateRecoveryWechatCredentials } from './validate-recovery-wechat-credentials.mjs';
const require = createRequire(import.meta.url);
const ROOT = 'D:/HL_dev_cloud';
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const OUTPUT = `${ROOT}/output/admin-entry-20261015`;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const masked = value => typeof value !== 'string' || !value || /REDACTED|MASKED|^\*+$/i.test(value);
const vars = detail => Object.fromEntries((detail.Environment?.Variables || []).map(row => [row.Key, row.Value]));
let stage = 'input';
let readClient;
let configurationWriteRequested = false;
try {
  let inputChunks = [], inputLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputLength += bytes.length; check(inputLength <= 16384, 'INPUT_TOO_LARGE'); inputChunks.push(bytes);
  }
  let inputBytes = Buffer.concat(inputChunks), text, legacyEncoding = false;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(inputBytes); }
  catch { text = new TextDecoder('gb18030', { fatal: true }).decode(inputBytes); legacyEncoding = true; }
  const input = JSON.parse(text); text = ''; inputChunks = []; inputBytes.fill(0); inputBytes = undefined;
  check(input && Object.keys(input).sort().join(',') === 'ADMIN_CODE,JWT_SECRET,VPAY_SANDBOX_APP_KEY,WX_APP_SECRET', 'INPUT_KEYS');
  // The already-open Windows form uses the console's GB2312 stdin encoding.
  // Its dedicated Chinese markers and ASCII platform keys identify this one
  // compatibility path. Future forms explicitly send UTF-8 and ASCII markers.
  if (legacyEncoding) check(input.JWT_SECRET === '自动生成' && input.ADMIN_CODE === '自动生成'
    && /^[\x21-\x7e]{16,128}$/.test(input.WX_APP_SECRET) && /^[\x21-\x7e]{16,128}$/.test(input.VPAY_SANDBOX_APP_KEY), 'INPUT_ENCODING_INVALID');
  // The user explicitly selects replacement mode in the dedicated two-field form.
  // The two WeChat credentials remain original values and stay in this process.
  const rebuildMarkers = new Set(['自动生成', '__GENERATE_LOGIN_CREDENTIALS__']);
  const rebuild = rebuildMarkers.has(input.JWT_SECRET) && input.JWT_SECRET === input.ADMIN_CODE;
  check(rebuild || !rebuildMarkers.has(input.JWT_SECRET) && !rebuildMarkers.has(input.ADMIN_CODE), 'REBUILD_SELECTION_INCOMPLETE');
  if (rebuild) {
    input.JWT_SECRET = randomBytes(48).toString('base64url');
    input.ADMIN_CODE = randomBytes(32).toString('base64url');
  }
  check(Object.values(input).every(value => !masked(value) && !/[\r\n\x00]/.test(value)), 'INPUT_INVALID');
  check(Buffer.byteLength(input.JWT_SECRET) >= 32 && input.JWT_SECRET.trim() === input.JWT_SECRET, 'JWT_FORMAT');
  check(input.ADMIN_CODE.trim() && input.ADMIN_CODE.trim().toUpperCase() !== 'HLADMIN', 'ADMIN_CODE_FORMAT');
  check(input.WX_APP_SECRET.length >= 16 && input.WX_APP_SECRET.length <= 128
    && input.VPAY_SANDBOX_APP_KEY.length >= 16 && input.VPAY_SANDBOX_APP_KEY.length <= 128, 'PLATFORM_KEY_FORMAT');
  const known = JSON.parse(await readFile(`${OUTPUT}/recovery-known-config.json`, 'utf8'));
  const { getCloudBaseManager } = require('C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs');
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: ENV_ID, region: 'ap-shanghai', site: 'domestic' }, authStrategy: 'fail_fast' });
  stage = 'verify_certification_key';
  const operations = vars(await manager.functions.getFunctionDetail('hlAdminOperations'));
  const proof = operations.MEMBER_CERTIFICATION_JWT_DERIVED_KEY;
  check(typeof proof === 'string' && /^hex:[a-f0-9]{64}$/i.test(proof), 'JWT_PROOF_UNAVAILABLE');
  const expectedKey = Buffer.from(proof.slice(4), 'hex');
  if (!rebuild) {
    const suppliedKey = createHmac('sha256', Buffer.from(input.JWT_SECRET)).update('hl.member-certification.encryption.jwt-derived.v1', 'utf8').digest();
    check(timingSafeEqual(expectedKey, suppliedKey), 'JWT_ORIGINAL_MISMATCH');
  }
  const callbackVars = vars(await manager.functions.getFunctionDetail(known.callbackSourceFunction));
  const callback = callbackVars.PAYMENT_CALLBACK_TOKEN;
  check(!masked(callback), 'CALLBACK_SOURCE_UNAVAILABLE');
  stage = 'verify_full_original_configuration';
  const base = { ...known.values, PAYMENT_CALLBACK_TOKEN: callback, ...input };
  delete base.NODE_ENV;
  let recovered;
  let codeProof;
  if (rebuild) {
    stage = 'verify_rebuild_code';
    codeProof = JSON.parse(await readFile(`${OUTPUT}/compatibility-deployment.json`, 'utf8'));
    check(codeProof.status === 'verified' && codeProof.envId === ENV_ID && codeProof.functionName === 'hlApi'
      && codeProof.legacyGetter === true && codeProof.legacyPolicy === true && typeof codeProof.modifiedAt === 'string', 'REBUILD_CODE_NOT_READY');
    recovered = { ...base, NODE_ENV: 'production' };
    check(Object.keys(recovered).length === 20 && Object.keys(known.values).length === 14, 'REBUILD_CONFIG_SHAPE');
  } else {
    const candidates = ['production', 'development', 'test'].map(value => ({ ...base, NODE_ENV: value }))
      .filter(value => Object.keys(value).length === 20 && digest(value) === known.expectedClosedEnvironmentSha256);
    check(candidates.length === 1, 'ORIGINAL_CONFIGURATION_HASH_MISMATCH');
    recovered = candidates[0];
  }
  check(Object.values(recovered).every(value => !masked(value)), 'REDACTED_CONFIG_REJECTED');
  check(recovered.PAYMENT_TEST_ENABLED === 'false' && recovered.PAYMENT_INTEGRATION_READY === 'false'
    && recovered.MATCHMAKING_PAYMENT_READY === 'false' && recovered.VPAY_ENV === '1', 'PAYMENT_BOUNDARY_MISMATCH');
  let wechatVerification;
  if (rebuild) {
    stage = 'verify_wechat_credentials_readonly';
    readClient = new PaymentMcpClient('C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/cli.cjs',
      { envId: ENV_ID, region: 'ap-shanghai', cwd: ROOT });
    wechatVerification = await validateRecoveryWechatCredentials({ WX_APP_SECRET: input.WX_APP_SECRET,
      VPAY_SANDBOX_APP_KEY: input.VPAY_SANDBOX_APP_KEY }, {
      read: async ({ collectionName, query, projection, limit }) => {
        const result = await readClient.call('readNoSqlDatabaseContent', { collectionName, query, projection, limit });
        check(result?.success === true && Array.isArray(result.data) && result.data.length < limit
          && (!result.collectionName || result.collectionName === collectionName), 'READONLY_DATABASE_UNCONFIRMED');
        return result.data;
      }
    });
    check(wechatVerification.verified === true, 'WECHAT_CREDENTIALS_UNVERIFIED');
    readClient.close(); readClient = undefined;
  }
  const before = await manager.functions.getFunctionDetail('hlApi');
  check(before.FunctionName === 'hlApi' && before.Namespace === ENV_ID && before.Type === 'Event'
    && before.Status === 'Active', 'RECOVERY_TARGET_UNCONFIRMED');
  const current = vars(before);
  check(Object.keys(current).length === 21 && current.MINIPROGRAM_ADMIN_USER_IDS === '1', 'CONCURRENT_CONFIG_CHANGE');
  if (rebuild) check(before.ModTime === codeProof.modifiedAt, 'REBUILD_CODE_CHANGED');
  const expected = { ...recovered, MINIPROGRAM_ADMIN_USER_IDS: '1',
    ...(rebuild ? { MEMBER_CERTIFICATION_JWT_DERIVED_KEY: proof } : {}) };
  const beforeDigest = digest(current);
  stage = 'restore';
  let mutation = false;
  if (beforeDigest !== digest(expected)) {
    check(Object.entries(current).filter(([key]) => key !== 'MINIPROGRAM_ADMIN_USER_IDS').every(([,value]) => masked(value)), 'CONCURRENT_CONFIG_CHANGE');
    const fresh = await manager.functions.getFunctionDetail('hlApi');
    check(digest(vars(fresh)) === beforeDigest && fresh.ModTime === before.ModTime, 'CONCURRENT_CONFIG_CHANGE');
    configurationWriteRequested = true;
    await manager.functions.updateFunctionConfig({ name: 'hlApi', envVariables: expected });
    mutation = true;
  }
  stage = 'verify_readback';
  let restored;
  for (let attempt = 0; attempt < 24; attempt++) {
    const detail = await manager.functions.getFunctionDetail('hlApi');
    if (detail.Status === 'Active' && digest(vars(detail)) === digest(expected)) { restored = detail; break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  check(restored, 'RESTORATION_READBACK_PENDING');
  stage = 'health';
  const invocation = await manager.functions.invokeFunction('hlApi', { path: '/health', method: 'GET', data: {} });
  const body = JSON.parse(invocation.RetMsg);
  check(body.code === 0 && body.data?.status === 'ok', 'HEALTH_NOT_VERIFIED');
  const report = { status: 'restored_verified', recoveryMode: rebuild ? 'replacement_login_credentials_preserved_certification_key' : 'original_configuration',
    verifiedAt: new Date().toISOString(), envId: ENV_ID,
    functionName: 'hlApi', historicalVariableCount: 20, configurationVariableCount: Object.keys(expected).length,
    restoredOriginalVariables: rebuild ? undefined : 20, rotatedLoginCredentialCount: rebuild ? 2 : 0,
    originalConfigurationSha256: rebuild ? undefined : digest(recovered), configurationSha256: digest(expected),
    matchesHistoricalClosedConfiguration: !rebuild, originalJwtProofVerified: !rebuild, administratorEntryUserId: 1,
    oldCertificationKeyPreserved: rebuild, previousLoginSessionsInvalidated: rebuild,
    wechatCredentialsVerifiedByReadonlyQuery: rebuild ? true : undefined,
    configurationMutationPerformed: mutation, functionStatus: restored.Status, healthPassed: true,
    codeUpdateRequested: false, businessRecordsChanged: false, paymentTestEnabled: false, formalPaymentsEnabled: false,
    secretsWrittenToFiles: false };
  await writeFile(`${OUTPUT}/configuration-recovery.json`, JSON.stringify(report, null, 2) + '\n');
  for (const key of Object.keys(input)) input[key] = '';
  console.log(JSON.stringify({ status: report.status, healthPassed: true, replacementMode: rebuild }));
} catch (error) {
  const report = { status: 'recovery_incomplete', stage, code: error.safeCode || 'OFFICIAL_OPERATION_FAILED',
    configurationWriteRequested, automaticRetry: false, checkedAt: new Date().toISOString() };
  await writeFile(`${OUTPUT}/configuration-recovery-latest.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); process.exitCode = 1;
} finally {
  readClient?.close();
}
