import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { protectedDigests, assertProtectedUnchanged, normalizedUploadHeaders } from './deploy-admin-entry-compatibility.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
export const OUTPUT = join(ROOT, 'output/apple-iap-20261019');
const POLICY = 'virtual-payment-policy.js';
const LOCAL_POLICY = join(ROOT, 'cloudfunctions/hlApi', POLICY);
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const MCP_BIN = join(dirname(SDK), 'cli.cjs');
const BASELINE = '24b108f4e9548d812eb95c4fcbd17da4bae044ebaad62a7c86640094d539a32b';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const normalize = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
const save = (name, value) => writeFileSync(join(OUTPUT, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const ARTIFACTS = ['deploy-apple-iap.mjs', 'cloudbase-payment-mcp-client.mjs', 'prepare-admin-entry-rebuild.mjs',
  'deploy-admin-entry-compatibility.mjs', 'repair-admin-entry-compatibility.mjs'].map(name => join(ROOT, 'scripts', name));
let stage = 'arguments';

function artifact(name) {
  const path = join(OUTPUT, name);
  check(existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'ARTIFACT_MISSING_OR_UNSAFE');
  return readFileSync(path);
}
const json = name => JSON.parse(artifact(name).toString('utf8'));

export function patchPolicy(original) {
  const source = original.toString('utf8');
  check(Buffer.from(source).equals(original), 'POLICY_ENCODING_INVALID');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const before = "  if (Number(xpayOrder.order_type) !== 0) throw failure('微信交易类型与会员订单不匹配', 409, 40907);";
  const after = [
    '  // query_order: 0 is a regular payment; 7 is an Apple IAP payment.',
    '  // Refund orders (1/8) are never original-payment evidence. Apple supports',
    '  // production only and requires at least CNY 1 per payment.',
    '  const orderType = Number(xpayOrder.order_type);',
    "  if (orderType !== 0 && orderType !== 7) throw failure('微信交易类型与会员订单不匹配', 409, 40907);",
    '  if (orderType === 7 && (expectedEnv !== 0 || amountFen < 100)) {',
    "    throw failure('苹果支付订单环境或金额无效', 409, 40907);",
    '  }'
  ].join(newline);
  check(source.split(before).length === 2 && !source.includes('const orderType = Number(xpayOrder.order_type);'), 'POLICY_BASELINE_MISMATCH');
  const bytes = Buffer.from(source.replace(before, after));
  check(normalize(bytes) === normalize(readFileSync(LOCAL_POLICY)), 'UNRELATED_LOCAL_POLICY_CHANGE');
  new Script(bytes.toString('utf8'), { filename: POLICY });
  return bytes;
}

export function bundlePolicyEvidence(files) {
  const bundle = files.find(file => file.name === 'native-admin.bundle.js');
  const index = files.find(file => file.name === 'index.js');
  check(bundle && index && files.filter(file => file.name === POLICY).length === 1, 'PACKAGE_LAYOUT_MISMATCH');
  const needles = ['virtual-payment-policy', 'buildVirtualConfirmation', 'createVirtualPaymentClient', '微信交易类型与会员订单不匹配'];
  const found = needles.filter(value => bundle.bytes.includes(Buffer.from(value)));
  check(found.length === 0, 'POLICY_INLINED_IN_ADMIN_BUNDLE_REQUIRES_REVIEW');
  check(/require\(['"]\.\/virtual-payment-policy['"]\)/.test(index.bytes.toString('utf8')), 'INDEX_POLICY_REQUIRE_UNCONFIRMED');
  return { bundlePresent: true, bundleSha256: sha(bundle.bytes), policyMarkersFound: found,
    indexRequiresStandalonePolicy: true, standalonePolicyOnly: true };
}

function regression(bytes) {
  const module = { exports: {} };
  new Script(bytes.toString('utf8'), { filename: POLICY }).runInNewContext({ module, exports: module.exports,
    require: createRequire(LOCAL_POLICY), Buffer, URL }, { timeout: 2000 });
  const confirm = module.exports.buildVirtualConfirmation;
  check(typeof confirm === 'function', 'POLICY_EXPORT_MISSING');
  const local = { outTradeNo: 'APPLE_IAP_LOCAL_20261019', amountFen: 100, payerOpenid: 'local_fixture_openid' };
  const paid = { order_id: local.outTradeNo, env_type: 1, order_type: 7, order_fee: 100, paid_fee: 100,
    paid_time: Math.floor(Date.now() / 1000) - 5, wx_order_id: 'apple_fixture_order_20261019' };
  const identity = { merchantId: 'fixture_merchant', appId: 'wx0123456789abcdef', currency: 'CNY' };
  let cases = 0;
  for (const type of [0, 7]) { check(confirm(local, { ...paid, order_type: type }, 0, identity).tradeState === 'SUCCESS', 'PAYMENT_REGRESSION_FAILED'); cases++; }
  for (const [l, x, env] of [
    [local, { ...paid, order_type: 1 }, 0], [local, { ...paid, order_type: 8 }, 0],
    [local, { ...paid, env_type: 2 }, 1],
    [{ ...local, amountFen: 99 }, { ...paid, order_fee: 99, paid_fee: 99 }, 0],
    [local, { ...paid, paid_fee: 99 }, 0], [local, { ...paid, order_id: 'WRONG_ORDER_20261019' }, 0]
  ]) {
    let rejected = false;
    try { confirm(l, x, env, identity); } catch (error) { rejected = error.code === 40907; }
    check(rejected, 'PAYMENT_REJECTION_REGRESSION_FAILED'); cases++;
  }
  return { passed: true, cases, externalRequests: 0, productionPaymentCalls: 0 };
}

function signedUrl(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'SIGNED_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'SIGNED_URL_INVALID');
  return url;
}

async function manager() {
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  return getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
}

async function snapshot(client) {
  const before = await client.functions.getFunctionDetail(TARGET.functionName);
  const protectedState = protectedDigests(before);
  check(before.Status === 'Active' && before.InstallDependency === 'FALSE', 'FUNCTION_NOT_ACTIVE_OR_DEPENDENCIES_ENABLED');
  const address = await client.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(typeof address.CodeSha256 === 'string' && /^[a-f0-9]{64}$/.test(address.CodeSha256), 'CODE_SHA_UNCONFIRMED');
  const response = await fetch(signedUrl(address.Url), { redirect: 'error', signal: AbortSignal.timeout(45000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'CODE_DOWNLOAD_FAILED');
  const zip = Buffer.from(await response.arrayBuffer());
  check(sha(zip) === address.CodeSha256, 'REMOTE_CODE_AND_DOWNLOAD_HASH_DIFFER');
  const files = readZip(zip);
  const [after, next] = await Promise.all([client.functions.getFunctionDetail(TARGET.functionName), client.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  check(after.Status === 'Active' && before.ModTime === after.ModTime && next.CodeSha256 === address.CodeSha256
    && digest(protectedDigests(after)) === digest(protectedState), 'CONCURRENT_CLOUD_CHANGE');
  return { codeSha256: address.CodeSha256, zip, files, protectedDigests: protectedState, modifiedAt: after.ModTime };
}

function validateSchema(document) {
  const query = document.schemas.find(row => row.name === 'queryFunctions')?.inputSchema;
  const manage = document.schemas.find(row => row.name === 'manageFunctions')?.inputSchema;
  check(query?.properties?.action?.enum?.includes('getFunctionUploadUrl')
    && manage?.properties?.action?.enum?.includes('updateFunctionCode')
    && manage?.properties?.code?.properties?.cosBucketName
    && manage?.properties?.code?.properties?.cosObjectName
    && manage?.properties?.functionName, 'MCP_EXACT_PACKAGE_SCHEMA_UNAVAILABLE');
  return digest(document.schemas);
}

export function validateCandidate() {
  const manifest = json('manifest.json');
  check(digest(manifest.target) === digest(TARGET) && manifest.originalRemoteCodeSha256 === BASELINE
    && manifest.changedFiles.length === 1 && manifest.changedFiles[0] === POLICY, 'MANIFEST_SCOPE_MISMATCH');
  check(manifest.scriptInputs.every(row => sha(readFileSync(row.path)) === row.sha256), 'DEPLOY_SCRIPT_CHANGED_AFTER_PREPARATION');
  check(validateSchema(json('mcp-function-schemas.json')) === manifest.mcpSchemaSha256, 'MCP_SCHEMA_ARTIFACT_CHANGED');
  const rollback = artifact('hlApi.rollback.zip'), candidate = artifact('hlApi.apple-iap.zip');
  check(sha(rollback) === manifest.rollbackZipSha256 && sha(rollback) === BASELINE
    && sha(candidate) === manifest.candidateZipSha256, 'PACKAGE_HASH_MISMATCH');
  check(sha(readFileSync(LOCAL_POLICY)) === manifest.localPolicySha256, 'LOCAL_POLICY_CHANGED_AFTER_PREPARATION');
  const before = readZip(rollback), after = readZip(candidate), patched = patchPolicy(before.find(file => file.name === POLICY)?.bytes);
  const expected = before.map(file => ({ ...file, bytes: file.name === POLICY ? patched : file.bytes }));
  check(digest(inventory(before)) === digest(manifest.beforeInventory)
    && digest(inventory(after)) === digest(manifest.candidateInventory)
    && digest(inventory(expected)) === digest(inventory(after))
    && after.length === manifest.fileCount && manifest.unchangedFiles === before.length - 1, 'PACKAGE_FILE_SCOPE_MISMATCH');
  check(digest(bundlePolicyEvidence(before)) === digest(manifest.bundleEvidence), 'BUNDLE_EVIDENCE_CHANGED');
  regression(patched);
  return { manifest, rollback, candidate, after };
}

async function prepare() {
  stage = 'read-only-live-baseline';
  mkdirSync(OUTPUT, { recursive: true });
  check(!existsSync(join(OUTPUT, 'manifest.json')) && !existsSync(join(OUTPUT, 'hlApi.rollback.zip')), 'ALREADY_PREPARED_OR_PARTIAL_ARTIFACTS');
  const mcpSchemaSha256 = validateSchema(json('mcp-function-schemas.json'));
  const inspection = json('cloud-readonly-inspection.json');
  check(digest(inspection.target) === digest(TARGET) && inspection.codeSha256 === BASELINE, 'INITIAL_INSPECTION_BASELINE_MISMATCH');
  const live = await snapshot(await manager());
  check(live.codeSha256 === BASELINE, 'LIVE_BASELINE_CHANGED');
  assertProtectedUnchanged(inspection.protectedDigests, live.protectedDigests);
  const bundleEvidence = bundlePolicyEvidence(live.files);
  const policy = live.files.find(file => file.name === POLICY);
  const patched = patchPolicy(policy.bytes), policyRegression = regression(patched);
  const after = live.files.map(file => ({ ...file, bytes: file.name === POLICY ? patched : file.bytes }));
  const candidate = rootZip(after), beforeInventory = inventory(live.files), candidateInventory = inventory(after);
  check(digest(inventory(readZip(candidate))) === digest(candidateInventory), 'ZIP_ROUNDTRIP_FAILED');
  const changed = candidateInventory.filter(file => beforeInventory.find(prior => prior.name === file.name)?.sha256 !== file.sha256).map(file => file.name);
  check(changed.length === 1 && changed[0] === POLICY, 'PATCH_SCOPE_MISMATCH');
  const manifest = { preparedAt: new Date().toISOString(), target: TARGET, originalRemoteCodeSha256: live.codeSha256,
    rollbackZipSha256: sha(live.zip), candidateZipSha256: sha(candidate), baselineModifiedAt: live.modifiedAt,
    protectedDigests: live.protectedDigests, changedFiles: changed, fileCount: after.length, unchangedFiles: after.length - 1,
    addedFiles: 0, removedFiles: 0, beforeInventory, candidateInventory, bundleEvidence, policyRegression,
    originalPolicySha256: sha(policy.bytes), candidatePolicySha256: sha(patched), localPolicySha256: sha(readFileSync(LOCAL_POLICY)),
    localAndCandidateSourceEqualAfterNewlineNormalization: true, mcpSchemaSha256,
    scriptInputs: ARTIFACTS.map(path => ({ path, sha256: sha(readFileSync(path)) })),
    transport: 'official_mcp_two_stage_exact_zip', runtime: 'Nodejs16.13', functionType: 'Event',
    cloudCodeWrites: 0, cloudConfigurationWrites: 0, paymentCalls: 0, credentialsPersisted: false };
  writeFileSync(join(OUTPUT, 'hlApi.rollback.zip'), live.zip, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.apple-iap.zip'), candidate, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'virtual-payment-policy.before.js'), policy.bytes, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'virtual-payment-policy.candidate.js'), patched, { flag: 'wx' });
  save('manifest.json', manifest);
  save('rollback-plan.json', { target: TARGET, backup: join(OUTPUT, 'hlApi.rollback.zip'), backupSha256: manifest.rollbackZipSha256,
    candidateSha256: manifest.candidateZipSha256, commandsAfterExplicitRollbackAuthorization: [
      'node scripts/deploy-apple-iap.mjs inspect --restore-backup', 'node scripts/deploy-apple-iap.mjs deploy --restore-backup',
      'node scripts/deploy-apple-iap.mjs verify --restore-backup'
    ], protectedDigests: manifest.protectedDigests, configurationWrites: 0, permissionsWrites: 0 });
  validateCandidate();
  return { status: 'prepared_not_deployed', changedFiles: changed, filesVerified: after.length,
    candidateSha256: manifest.candidateZipSha256, bundlePolicyInlined: false, policyRegression, cloudWrites: 0 };
}

function assertBaseline(live, manifest, restore) {
  assertProtectedUnchanged(manifest.protectedDigests, live.protectedDigests);
  const expectedSha = restore ? manifest.candidateZipSha256 : manifest.originalRemoteCodeSha256;
  const expectedInventory = restore ? manifest.candidateInventory : manifest.beforeInventory;
  check(live.codeSha256 === expectedSha && digest(inventory(live.files)) === digest(expectedInventory), 'LIVE_BASELINE_CHANGED');
  if (!restore) check(live.modifiedAt === manifest.baselineModifiedAt, 'BASELINE_MODIFICATION_TIME_CHANGED');
}

async function verify(client, prepared, restore) {
  const { manifest } = prepared;
  const prefix = restore ? 'restore' : 'deployment';
  const intent = json(`${prefix}-intent.json`);
  const expectedSha = restore ? manifest.rollbackZipSha256 : manifest.candidateZipSha256;
  check(intent.targetSha256 === expectedSha && digest(intent.target) === digest(TARGET), 'DEPLOYMENT_INTENT_MISMATCH');
  const request = json(`${prefix}-code-update-request.json`);
  check(request.codeUpdateRequests === 1 && request.targetSha256 === expectedSha, 'CODE_UPDATE_REQUEST_EVIDENCE_MISSING');
  const live = await snapshot(client);
  assertProtectedUnchanged(manifest.protectedDigests, live.protectedDigests);
  check(live.codeSha256 === expectedSha
    && digest(inventory(live.files)) === digest(restore ? manifest.beforeInventory : manifest.candidateInventory), 'DEPLOYED_PACKAGE_MISMATCH');
  const downloaded = join(OUTPUT, `hlApi.${prefix}.downloaded.zip`);
  if (existsSync(downloaded)) check(sha(readFileSync(downloaded)) === expectedSha, 'EXISTING_VERIFICATION_BACKUP_MISMATCH');
  else writeFileSync(downloaded, live.zip, { flag: 'wx' });
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), target: TARGET, restoredBackup: restore,
    codeSha256: live.codeSha256, filesVerified: live.files.length, changedFiles: [POLICY], protectedOtherFiles: manifest.unchangedFiles,
    environmentUnchanged: true, configurationUnchanged: true, dependencyInstallation: 'FALSE',
    codeUpdateRequests: 1, environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0,
    transport: 'official_mcp_two_stage_exact_zip', fullFileContentsAndAttributesMatched: true };
  const reportName = `${prefix}-verification.json`;
  if (existsSync(join(OUTPUT, reportName))) {
    const previous = json(reportName);
    check(previous.status === 'verified' && previous.codeSha256 === expectedSha, 'EXISTING_VERIFICATION_REPORT_MISMATCH');
  } else save(reportName, report);
  return report;
}

function findSlot(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.uploadUrl === 'string') return value;
  for (const child of Object.values(value)) { const result = findSlot(child); if (result) return result; }
  return null;
}

async function operate(mode, restore) {
  stage = 'immutable-candidate-validation';
  const prepared = validateCandidate(), { manifest } = prepared, client = await manager();
  if (mode === 'verify') return verify(client, prepared, restore);
  const before = await snapshot(client);
  assertBaseline(before, manifest, restore);
  if (restore) check(json('deployment-intent.json').targetSha256 === manifest.candidateZipSha256, 'ORIGINAL_DEPLOYMENT_INTENT_REQUIRED');
  if (mode === 'inspect') return { status: 'preflight_passed_not_deployed', target: TARGET, restoreBackup: restore,
    baselineCodeSha256: before.codeSha256, targetSha256: restore ? manifest.rollbackZipSha256 : manifest.candidateZipSha256,
    protectedDigests: before.protectedDigests, filesVerified: before.files.length, cloudWrites: 0 };
  const prefix = restore ? 'restore' : 'deployment';
  check(!existsSync(join(OUTPUT, `${prefix}-intent.json`)), 'DEPLOY_ALREADY_REQUESTED_USE_VERIFY_DO_NOT_REPEAT');
  const bytes = restore ? prepared.rollback : prepared.candidate;
  const targetSha256 = sha(bytes);
  let mcp;
  try {
    stage = 'mcp-schema-read';
    mcp = new PaymentMcpClient(MCP_BIN, { envId: TARGET.envId, region: TARGET.region, cwd: ROOT, timeoutMs: 45000 });
    await mcp.ready;
    const list = await mcp.request('tools/list', {});
    const schemas = list.tools.filter(row => ['queryFunctions', 'manageFunctions'].includes(row.name)).map(row => ({ name: row.name, inputSchema: row.inputSchema }));
    check(validateSchema({ schemas }) === manifest.mcpSchemaSha256, 'LIVE_MCP_SCHEMA_CHANGED');
    save(`${prefix}-intent.json`, { target: TARGET, startedAt: new Date().toISOString(), restoreBackup: restore,
      baselineCodeSha256: before.codeSha256, targetSha256, changedFiles: [POLICY], protectedDigests: before.protectedDigests,
      transport: 'official_mcp_two_stage_exact_zip', environmentWrites: 0, permissionsWrites: 0 });
    stage = 'mcp-upload-authorization';
    const slot = findSlot(await mcp.call('queryFunctions', { action: 'getFunctionUploadUrl', functionName: TARGET.functionName }));
    check(slot && typeof slot.cosBucketName === 'string' && !!slot.cosBucketName && typeof slot.cosObjectName === 'string'
      && !!slot.cosObjectName && slot.cosBucketRegion === TARGET.region, 'MCP_UPLOAD_SLOT_INVALID');
    stage = 'exact-package-upload';
    const upload = await fetch(signedUrl(slot.uploadUrl), { method: 'PUT', headers: normalizedUploadHeaders(slot.uploadHeaders),
      body: bytes, redirect: 'error', signal: AbortSignal.timeout(45000) });
    check(upload.ok, 'CANDIDATE_UPLOAD_FAILED');
    stage = 'pre-update-baseline-recheck';
    const fresh = await snapshot(client);
    assertBaseline(fresh, manifest, restore);
    check(fresh.modifiedAt === before.modifiedAt, 'CONCURRENT_CLOUD_CHANGE');
    validateCandidate();
    save(`${prefix}-code-update-request.json`, { requestedAt: new Date().toISOString(), targetSha256,
      codeUpdateRequests: 1, environmentWrites: 0, permissionsWrites: 0, automaticRetry: false });
    stage = 'mcp-single-code-update';
    await mcp.call('manageFunctions', { action: 'updateFunctionCode', functionName: TARGET.functionName,
      code: { cosBucketName: slot.cosBucketName, cosObjectName: slot.cosObjectName, cosBucketRegion: slot.cosBucketRegion } });
    stage = 'wait-for-active-code';
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = await client.functions.getFunctionDetail(TARGET.functionName);
      check(!/Failed|Error/i.test(String(detail.Status)), 'DEPLOYMENT_FAILED_VERIFY_BEFORE_ANY_RECOVERY');
      assertProtectedUnchanged(manifest.protectedDigests, protectedDigests(detail));
      if (detail.Status === 'Active') {
        const address = await client.functions.getFunctionDownloadUrl(TARGET.functionName);
        if (address.CodeSha256 === targetSha256) { stage = 'verify-downloaded-package'; return verify(client, prepared, restore); }
      }
      await new Promise(done => setTimeout(done, 1500));
    }
    check(false, 'DEPLOYMENT_PENDING_USE_VERIFY_DO_NOT_REPEAT');
  } finally { mcp?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    const mode = process.argv[2], restore = process.argv[3] === '--restore-backup';
    check(['prepare', 'inspect', 'deploy', 'verify'].includes(mode)
      && (process.argv.length === 3 || process.argv.length === 4 && restore && mode !== 'prepare'), 'MODE_REQUIRED');
    console.log(JSON.stringify(await (mode === 'prepare' ? prepare() : operate(mode, restore))));
  } catch (error) {
    console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'APPLE_IAP_DEPLOYMENT_UNCONFIRMED',
      rawErrorWithheld: true, automaticRetry: false, environmentWrites: 0, permissionsWrites: 0, paymentCalls: 0 }));
    process.exitCode = 1;
  }
}
