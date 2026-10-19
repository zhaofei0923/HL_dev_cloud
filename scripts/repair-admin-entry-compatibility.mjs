import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, OUTPUT, readZip, inventory } from './prepare-admin-entry-rebuild.mjs';
import { validateCandidate, protectedDigests, assertProtectedUnchanged } from './deploy-admin-entry-compatibility.mjs';

const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const RESULT_DIR = dirname(OUTPUT);
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const save = (name, value, exclusive = false) => writeFileSync(join(RESULT_DIR, name), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
const json = file => JSON.parse(readFileSync(file, 'utf8'));
let stage = 'arguments';

export function allowedRepairStatus(detail) {
  if (detail.Status === 'Active') return true;
  const reasons = detail.StatusReasons;
  return detail.Status === 'UpdateFailed' && Array.isArray(reasons) && reasons.length > 0
    && reasons.every(reason => reason.ErrorCode === 'InvalidParameterValue.CodeConfig'
      && /format codeCosInfo failed.*get baseCodeCosInfo tmp token failed.*assume role failed/i.test(String(reason.ErrorMessage || '')));
}
export function tempCosUploadPlan(config, response) {
  check(config.env === TARGET.envId && config.namespace === TARGET.envId && /^\d+$/.test(String(config.appId)), 'TEMP_COS_TARGET_MISMATCH');
  check(typeof response.Date === 'string' && /^\d{4}-?\d{2}-?\d{2}$/.test(response.Date)
    && typeof response.Sign === 'string' && response.Sign.length > 16 && !/[\r\n]/.test(response.Sign), 'TEMP_COS_AUTH_UNCONFIRMED');
  const key = `/${response.Date}/${config.appId}/${TARGET.envId}/${TARGET.functionName}.zip`;
  return { url: `https://shtempcos-1253665819.cos.ap-shanghai.myqcloud.com${key}`,
    key, headers: { Authorization: response.Sign, 'Content-Type': 'application/zip' } };
}
export function repairCodeArguments(key) {
  check(typeof key === 'string' && /^\/\d{4}-?\d{2}-?\d{2}\/\d+\/cloud1-d2gza7q9c8d69c721\/hlApi\.zip$/.test(key), 'TEMP_COS_KEY_INVALID');
  return { func: { name: TARGET.functionName, handler: 'index.main', installDependency: false },
    code: { CosBucketRegion: TARGET.region, TempCosObjectName: key }, deployMode: 'cos' };
}
async function downloaded(manager) {
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  const url = new URL(address.Url);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'DOWNLOAD_TARGET_INVALID');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'DOWNLOAD_FAILED');
  return { codeSha256: address.CodeSha256, files: readZip(Buffer.from(await response.arrayBuffer())) };
}
async function originalSnapshot(manager, manifest, baseline) {
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(allowedRepairStatus(before), 'REPAIR_STATUS_NOT_ALLOWED');
  check(hash(protectedDigests(before)) === hash(baseline), 'ORIGINAL_CONFIGURATION_CHANGED');
  const code = await downloaded(manager);
  const after = await manager.functions.getFunctionDetail(TARGET.functionName);
  check(allowedRepairStatus(after) && before.ModTime === after.ModTime
    && hash(protectedDigests(after)) === hash(baseline), 'CONCURRENT_CONFIGURATION_CHANGE');
  check(code.codeSha256 === manifest.originalRemoteCodeSha256
    && hash(inventory(code.files)) === hash(manifest.beforeInventory), 'ORIGINAL_CODE_CHANGED');
  return after;
}
export async function main(mode) {
  check(['inspect', 'deploy'].includes(mode), 'MODE_REQUIRED');
  stage = 'immutable-candidate';
  const manifest = json(join(OUTPUT, 'manifest.json'));
  const candidate = readFileSync(join(OUTPUT, 'hlApi.candidate.zip'));
  validateCandidate(manifest, readFileSync(join(OUTPUT, 'hlApi.rollback.zip')), candidate);
  const previous = json(join(RESULT_DIR, 'compatibility-deployment-intent.json'));
  check(previous.envId === TARGET.envId && previous.functionName === TARGET.functionName
    && previous.candidateZipSha256 === manifest.candidateZipSha256
    && previous.originalCodeSha256 === manifest.originalRemoteCodeSha256, 'ORIGINAL_INTENT_MISMATCH');
  const baseline = previous.protectedDigests;
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  stage = 'verify-original-cloud';
  const before = await originalSnapshot(manager, manifest, baseline);
  if (mode === 'inspect') return { status: 'repair_preflight_verified_not_deployed', envId: TARGET.envId,
    functionName: TARGET.functionName, originalCodeAndConfigurationMatched: true, currentStatus: before.Status, cloudWrites: 0 };
  check(!existsSync(join(RESULT_DIR, 'compatibility-repair-state.json'))
    && !existsSync(join(RESULT_DIR, 'compatibility-repair-intent.json')), 'REPAIR_ALREADY_STARTED');
  save('compatibility-repair-intent.json', { envId: TARGET.envId, functionName: TARGET.functionName,
    candidateZipSha256: manifest.candidateZipSha256, originalCodeSha256: manifest.originalRemoteCodeSha256,
    protectedDigests: baseline, transport: 'official_sdk_temp_cos', originalAttemptPreserved: true, startedAt: new Date().toISOString() }, true);
  save('compatibility-repair-state.json', { status: 'preparing_upload', codeUpdateRequests: 0,
    environmentWrites: 0, originalAttemptPreserved: true }, true);
  stage = 'temp-cos-authorization';
  const config = manager.functions.getFunctionConfig();
  check(config.env === TARGET.envId && config.namespace === TARGET.envId && /^\d+$/.test(String(config.appId)), 'TEMP_COS_TARGET_MISMATCH');
  const authorization = await manager.functions.scfService.request('GetTempCosInfo', {
    ObjectPath: `${config.appId}/${config.env}/${TARGET.functionName}.zip`
  });
  const upload = tempCosUploadPlan(config, authorization);
  stage = 'temp-cos-upload';
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: candidate,
    redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok, 'TEMP_COS_UPLOAD_FAILED');
  stage = 'pre-update-recheck';
  await originalSnapshot(manager, manifest, baseline);
  validateCandidate(manifest, readFileSync(join(OUTPUT, 'hlApi.rollback.zip')), readFileSync(join(OUTPUT, 'hlApi.candidate.zip')));
  stage = 'repair-code-request';
  save('compatibility-repair-state.json', { status: 'request_pending', codeUpdateRequests: 1,
    environmentWrites: 0, originalAttemptPreserved: true });
  // This is the SDK's native TempCos code contract. Sign is used only in the
  // upload Authorization header; neither Sign nor the temporary key is saved.
  const result = await manager.functions.updateFunctionCode(repairCodeArguments(upload.key));
  check(!result.SCFErrorCode, 'REPAIR_REQUEST_REJECTED');
  save('compatibility-repair-state.json', { status: 'request_returned', codeUpdateRequests: 1,
    environmentWrites: 0, originalAttemptPreserved: true });
  stage = 'wait-repair-active';
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await manager.functions.getFunctionDetail(TARGET.functionName);
    if (current.Status === 'Active') {
      stage = 'verify-repair-files';
      const code = await downloaded(manager);
      if (code.codeSha256 === manifest.originalRemoteCodeSha256) {
        stage = 'wait-repair-active';
        await new Promise(done => setTimeout(done, 2000));
        continue;
      }
      assertProtectedUnchanged(baseline, protectedDigests(current));
      check(code.files.length === 4046 && hash(inventory(code.files)) === hash(manifest.candidateInventory), 'REPAIR_FILES_MISMATCH');
      const after = await manager.functions.getFunctionDetail(TARGET.functionName);
      check(after.Status === 'Active' && after.ModTime === current.ModTime, 'CONCURRENT_REPAIR_CHANGE');
      assertProtectedUnchanged(baseline, protectedDigests(after));
      const index = code.files.find(file => file.name === 'index.js').bytes.toString('utf8');
      const policy = code.files.find(file => file.name === 'certification-material-policy.js').bytes.toString('utf8');
      const legacyGetter = index.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY');
      const legacyPolicy = policy.includes('secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret)');
      check(legacyGetter && legacyPolicy, 'REPAIR_COMPATIBILITY_SOURCE_MISSING');
      const report = { status: 'verified', verifiedAt: new Date().toISOString(), envId: TARGET.envId, functionName: TARGET.functionName,
        legacyGetter, legacyPolicy, modifiedAt: after.ModTime, functionStatus: after.Status, transport: 'official_sdk_temp_cos',
        deployedCodeSha256: code.codeSha256, filesVerified: 4046, fileContentsAndAttributesMatched: true,
        environmentUnchanged: true, otherConfigurationUnchanged: true,
        dependencyInstallation: { before: baseline.installDependency, after: after.InstallDependency, installRequested: false },
        originalAttemptPreserved: true, repairCodeUpdateRequests: 1, configurationUpdateRequested: false,
        environmentWriteRequested: false, businessCalls: 0, healthCallPerformed: false };
      save('compatibility-deployment.json', report);
      save('compatibility-repair-state.json', { status: 'verified', codeUpdateRequests: 1, verifiedAt: report.verifiedAt,
        environmentWrites: 0, originalAttemptPreserved: true });
      return report;
    }
    const previousFailureStillVisible = current.Status === 'UpdateFailed' && current.ModTime === before.ModTime && allowedRepairStatus(current);
    check(previousFailureStillVisible || current.Status !== 'UpdateFailed' && !/CreateFailed|Error/i.test(String(current.Status)), 'REPAIR_DEPLOYMENT_FAILED');
    await new Promise(done => setTimeout(done, 2000));
  }
  check(false, 'REPAIR_PENDING_NO_AUTOMATIC_RETRY');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 3, 'MODE_REQUIRED'); console.log(JSON.stringify(await main(process.argv[2]))); }
  catch (error) { console.error(JSON.stringify({ status: 'incomplete', stage, code: error.safeCode || 'REPAIR_OPERATION_UNCONFIRMED',
    environmentWriteRequested: false, automaticRetry: false, secretsPrinted: false })); process.exitCode = 1; }
}
