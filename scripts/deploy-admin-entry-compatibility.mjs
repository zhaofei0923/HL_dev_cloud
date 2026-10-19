import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { TARGET, OUTPUT, readZip, inventory, patchCompatibility } from './prepare-admin-entry-rebuild.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const RESULT_DIR = dirname(OUTPUT);
let executionStage = 'arguments';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { safeCode: code }); };
const save = (name, value, exclusive = false) => writeFileSync(join(RESULT_DIR, name), JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
function artifact(name) {
  const file = join(OUTPUT, name);
  check(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'ARTIFACT_MISSING_OR_UNSAFE');
  return readFileSync(file);
}
export function validateCandidate(manifest, rollback, candidate) {
  check(digest(manifest.target) === digest(TARGET) && manifest.sourceFileCount === 4046
    && manifest.unchangedFiles === 4044 && manifest.addedFiles === 0 && manifest.removedFiles === 0,
  'MANIFEST_SCOPE_MISMATCH');
  check(sha(rollback) === manifest.rollbackZipSha256 && sha(candidate) === manifest.candidateZipSha256, 'ARTIFACT_HASH_MISMATCH');
  const originalFiles = readZip(rollback), files = readZip(candidate);
  check(digest(inventory(originalFiles)) === digest(manifest.beforeInventory)
    && digest(inventory(files)) === digest(manifest.candidateInventory)
    && digest(inventory(patchCompatibility(originalFiles))) === digest(inventory(files)), 'IMMUTABLE_PATCH_MISMATCH');
  const index = files.find(file => file.name === 'index.js').bytes.toString('utf8');
  const policy = files.find(file => file.name === 'certification-material-policy.js').bytes.toString('utf8');
  check(index.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY')
    && policy.includes('secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret)'), 'COMPATIBILITY_SOURCE_MISSING');
  return files;
}
function validatedArtifacts() {
  const manifest = JSON.parse(artifact('manifest.json').toString('utf8'));
  const rollback = artifact('hlApi.rollback.zip'), candidate = artifact('hlApi.candidate.zip');
  return { manifest, candidate, files: validateCandidate(manifest, rollback, candidate) };
}
export function protectedDigests(detail) {
  check(detail?.FunctionName === TARGET.functionName && detail.Namespace === TARGET.envId && detail.Type === 'Event'
    && detail.Runtime === 'Nodejs16.13' && detail.Handler === 'index.main'
    && ['TRUE', 'FALSE'].includes(detail.InstallDependency), 'FUNCTION_TARGET_MISMATCH');
  const entries = detail.Environment?.Variables;
  check(Array.isArray(entries) && entries.every(row => typeof row.Key === 'string' && typeof row.Value === 'string')
    && new Set(entries.map(row => row.Key)).size === entries.length, 'ENVIRONMENT_UNCONFIRMED');
  // Values remain inside this process. They are hashed, never copied into any
  // update request, stdout, error message, or persistent configuration backup.
  const environmentSha256 = digest(Object.fromEntries(entries.map(row => [row.Key, row.Value])));
  const omitted = new Set(['Environment', 'InstallDependency', 'CodeInfo', 'CodeSha256', 'CodeSize', 'CodeResult',
    'CodeError', 'ErrNo', 'Status', 'StatusDesc', 'StatusReasons', 'ModTime', 'AddTime', 'LastModifiedTime', 'RequestId']);
  const configurationSha256 = digest(Object.fromEntries(Object.entries(detail).filter(([key]) => !omitted.has(key))));
  return { environmentSha256, configurationSha256, installDependency: detail.InstallDependency };
}
export function assertProtectedUnchanged(before, after) {
  check(before.environmentSha256 === after.environmentSha256 && before.configurationSha256 === after.configurationSha256,
    'PROTECTED_CONFIGURATION_CHANGED');
  check(after.installDependency === 'FALSE', 'DEPENDENCY_INSTALL_NOT_DISABLED');
}
function signedUrl(value) {
  let url;
  try { url = new URL(value); } catch { check(false, 'SIGNED_URL_INVALID'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname), 'SIGNED_URL_INVALID');
  return url;
}
async function download(manager) {
  const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  check(typeof address.CodeSha256 === 'string' && !!address.CodeSha256, 'CODE_SHA_UNCONFIRMED');
  const response = await fetch(signedUrl(address.Url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
  check(response.ok && Number(response.headers.get('content-length')) <= 60 * 1024 * 1024, 'CODE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  return { files: readZip(bytes), codeSha256: address.CodeSha256, zipSha256: sha(bytes) };
}
async function snapshot(manager) {
  const before = await manager.functions.getFunctionDetail(TARGET.functionName);
  const beforeDigests = protectedDigests(before);
  check(before.Status === 'Active', 'FUNCTION_NOT_ACTIVE');
  const code = await download(manager);
  const [after, address] = await Promise.all([manager.functions.getFunctionDetail(TARGET.functionName),
    manager.functions.getFunctionDownloadUrl(TARGET.functionName)]);
  const afterDigests = protectedDigests(after);
  check(after.Status === 'Active' && before.ModTime === after.ModTime && address.CodeSha256 === code.codeSha256
    && digest(beforeDigests) === digest(afterDigests), 'CLOUD_CHANGED_DURING_READ');
  return { detail: after, digests: afterDigests, code };
}
function slotFrom(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.uploadUrl === 'string') return value;
  for (const child of Object.values(value)) { const result = slotFrom(child); if (result) return result; }
  return null;
}
export function codeUpdateArguments(slot) {
  check(slot && typeof slot.cosBucketName === 'string' && !!slot.cosBucketName
    && typeof slot.cosObjectName === 'string' && !!slot.cosObjectName && slot.cosBucketRegion === TARGET.region, 'UPLOAD_SLOT_INVALID');
  return { func: { name: TARGET.functionName, handler: 'index.main', installDependency: false },
    code: { CosBucketName: slot.cosBucketName, CosBucketRegion: slot.cosBucketRegion, CosObjectName: slot.cosObjectName }, deployMode: 'cos' };
}
export function normalizedUploadHeaders(value) {
  if (value === undefined || value === null) return {};
  const entries = Array.isArray(value) ? value.map(item => {
    if (Array.isArray(item) && item.length === 2) return item;
    check(item && typeof item === 'object', 'UPLOAD_HEADERS_INVALID');
    return [item.Key ?? item.key ?? item.name, item.Value ?? item.value];
  }) : Object.entries(value);
  const result = {}, names = new Set();
  for (const [key, content] of entries) {
    check(typeof key === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
      && typeof content === 'string' && !/[\r\n]/.test(content) && !names.has(key.toLowerCase()), 'UPLOAD_HEADERS_INVALID');
    names.add(key.toLowerCase()); result[key] = content;
  }
  return result;
}
async function verify(manager, manifest, baseline) {
  const current = await snapshot(manager);
  assertProtectedUnchanged(baseline, current.digests);
  check(current.code.files.length === 4046 && digest(inventory(current.code.files)) === digest(manifest.candidateInventory), 'DEPLOYED_FILES_MISMATCH');
  const index = current.code.files.find(file => file.name === 'index.js').bytes.toString('utf8');
  const policy = current.code.files.find(file => file.name === 'certification-material-policy.js').bytes.toString('utf8');
  const legacyGetter = index.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY');
  const legacyPolicy = policy.includes('secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret)');
  check(legacyGetter && legacyPolicy, 'COMPATIBILITY_SOURCE_MISSING');
  const report = { status: 'verified', verifiedAt: new Date().toISOString(), envId: TARGET.envId, functionName: TARGET.functionName,
    legacyGetter, legacyPolicy, modifiedAt: current.detail.ModTime, functionStatus: current.detail.Status,
    deployedCodeSha256: current.code.codeSha256, filesVerified: 4046, fileContentsAndAttributesMatched: true,
    environmentUnchanged: true, otherConfigurationUnchanged: true,
    dependencyInstallation: { before: baseline.installDependency, after: current.digests.installDependency, installRequested: false },
    configurationUpdateRequested: false, environmentWriteRequested: false, businessCalls: 0, healthCallPerformed: false };
  save('compatibility-deployment.json', report);
  return report;
}
export async function main(mode) {
  executionStage = 'candidate-validation';
  check(['inspect', 'deploy', 'verify'].includes(mode), 'MODE_REQUIRED');
  const { manifest, candidate } = validatedArtifacts();
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  if (mode === 'verify') {
    const intent = JSON.parse(readFileSync(join(RESULT_DIR, 'compatibility-deployment-intent.json'), 'utf8'));
    check(intent.envId === TARGET.envId && intent.functionName === TARGET.functionName
      && intent.candidateZipSha256 === manifest.candidateZipSha256, 'DEPLOYMENT_INTENT_MISMATCH');
    return verify(manager, manifest, intent.protectedDigests);
  }
  executionStage = 'preflight-snapshot';
  const before = await snapshot(manager);
  check(before.code.codeSha256 === manifest.originalRemoteCodeSha256
    && digest(inventory(before.code.files)) === digest(manifest.beforeInventory), 'CLOUD_CODE_DIFFERS_FROM_MANIFEST');
  const baseline = before.digests;
  if (mode === 'inspect') return { status: 'preflight_verified_not_deployed', envId: TARGET.envId, functionName: TARGET.functionName,
    codeMatchesManifest: true, candidateZipSha256: manifest.candidateZipSha256, dependencyFlagBefore: baseline.installDependency,
    dependencyFlagPlanned: 'FALSE', environmentWrites: 0, codeWrites: 0 };
  const statePath = join(RESULT_DIR, 'compatibility-deployment-state.json');
  check(!existsSync(statePath), 'DEPLOYMENT_ALREADY_REQUESTED_VERIFY_BEFORE_RETRY');
  let client;
  try {
    executionStage = 'mcp-connect';
    client = new PaymentMcpClient(resolve(dirname(SDK), 'cli.cjs'), { envId: TARGET.envId, region: TARGET.region, cwd: ROOT, timeoutMs: 120000 });
    await client.ready;
    executionStage = 'mcp-upload-slot';
    const slot = slotFrom(await client.call('queryFunctions', { action: 'getFunctionUploadUrl', functionName: TARGET.functionName }));
    const request = codeUpdateArguments(slot);
    executionStage = 'cos-upload';
    const upload = await fetch(signedUrl(slot.uploadUrl), { method: 'PUT', body: candidate, headers: normalizedUploadHeaders(slot.uploadHeaders),
      redirect: 'error', signal: AbortSignal.timeout(60000) });
    check(upload.ok, 'UPLOAD_FAILED');
    executionStage = 'pre-update-snapshot';
    const fresh = await snapshot(manager);
    check(digest(fresh.digests) === digest(baseline) && fresh.code.codeSha256 === before.code.codeSha256
      && fresh.detail.ModTime === before.detail.ModTime && digest(inventory(fresh.code.files)) === digest(manifest.beforeInventory), 'CONCURRENT_CLOUD_CHANGE');
    validatedArtifacts();
    executionStage = 'write-intent';
    save('compatibility-deployment-intent.json', { envId: TARGET.envId, functionName: TARGET.functionName,
      candidateZipSha256: manifest.candidateZipSha256, originalCodeSha256: manifest.originalRemoteCodeSha256,
      protectedDigests: baseline, startedAt: new Date().toISOString(), dependencyFlagPlanned: 'FALSE' }, true);
    save('compatibility-deployment-state.json', { status: 'request_pending', codeUpdateRequests: 1,
      environmentWriteRequested: false, dependencyInstallationRequested: false }, true);
    // The official SDK maps this to TCB UpdateFunctionCode with fixed EnvId and
    // Namespace. No environment/configuration update API is called. FALSE is an
    // explicit, audited exception to preserve the uploaded dependency contents.
    executionStage = 'update-code-request';
    const result = await manager.functions.updateFunctionCode(request);
    check(!result.SCFErrorCode, 'CODE_UPDATE_REJECTED');
    save('compatibility-deployment-state.json', { status: 'request_returned', codeUpdateRequests: 1,
      environmentWriteRequested: false, dependencyInstallationRequested: false });
    for (let attempt = 0; attempt < 30; attempt++) {
      executionStage = 'wait-active';
      const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
      check(!/Failed|Error/i.test(String(detail.Status)), 'FUNCTION_DEPLOYMENT_FAILED');
      if (detail.Status === 'Active') {
        const address = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
        if (address.CodeSha256 !== manifest.originalRemoteCodeSha256) {
          executionStage = 'verify-download';
          const report = await verify(manager, manifest, baseline);
          save('compatibility-deployment-state.json', { status: 'verified', codeUpdateRequests: 1, verifiedAt: report.verifiedAt });
          return report;
        }
      }
      await new Promise(done => setTimeout(done, 2000));
    }
    check(false, 'DEPLOYMENT_PENDING_VERIFY_BEFORE_RETRY');
  } finally { client?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 3, 'MODE_REQUIRED'); console.log(JSON.stringify(await main(process.argv[2]))); }
  catch (error) { console.error(JSON.stringify({ status: 'incomplete', stage: executionStage, code: error.safeCode || 'COMPATIBILITY_DEPLOYMENT_UNCONFIRMED',
    environmentWriteRequested: false, automaticRetry: false, secretsPrinted: false })); process.exitCode = 1; }
}
