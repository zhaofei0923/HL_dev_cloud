import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { TARGET, OUTPUT as COMPATIBILITY_OUTPUT, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'output/admin-entry-20261015/admin-entry-deployment');
const POLICY_SHA256 = 'bfe3e6f8fb9e5456f864fd0721e9b43285ee516b5a1537ab458e57b3886a25d0';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
function check(value, safeCode) { if (!value) throw Object.assign(new Error(safeCode), { safeCode }); }

const REQUIRE_ANCHOR = "const crypto = require('node:crypto');";
const REQUIRE_BLOCK = "const { miniprogramAdminEntry } = require('./admin-entry-policy');";
const ROUTE_ANCHOR = '    const session = await requireUser(apiToken);';
const ROUTE_BLOCK = [
  "    if (method === 'GET' && path === '/user/admin-entry') {",
  '      const user = await getById(C.users, session.userId);',
  '      return ok(miniprogramAdminEntry(user, session, process.env));',
  '    }'
].join('\n');
const CATCH_ANCHOR = "    const failedPath = String(event.path || '/');";
const CATCH_BLOCK = [
  "    if (failedPath === '/user/admin-entry') {",
  '      const safeError = err?.status === 401 && err?.code === 40100',
  "        ? createHttpError('登录状态已失效，请重新登录', 401, 40100)",
  '        : err?.status === 404 && err?.code === 40400',
  "          ? createHttpError('not found', 404, 40400)",
  "          : createHttpError('管理入口暂不可用，请稍后重试', 503, 50340);",
  "      console.error('admin entry request failed', safeError.code);",
  '      return fail(safeError);',
  '    }'
].join('\n');

function utf8(bytes) {
  check(Buffer.isBuffer(bytes), 'SOURCE_BYTES_REQUIRED');
  const source = bytes.toString('utf8');
  check(Buffer.from(source).equals(bytes), 'SOURCE_ENCODING_INVALID');
  return source;
}
function once(source, anchor, replacement) {
  check(source.split(anchor).length === 2, 'PATCH_ANCHOR_MISMATCH');
  return source.replace(anchor, replacement);
}
export function checkedLocalPatch(indexBytes, policyBytes) {
  const source = utf8(indexBytes).replace(/\r\n/g, '\n');
  utf8(policyBytes);
  check(sha(policyBytes) === POLICY_SHA256, 'LOCAL_POLICY_DRIFT');
  for (const [anchor, block] of [[REQUIRE_ANCHOR, REQUIRE_BLOCK], [ROUTE_ANCHOR, ROUTE_BLOCK], [CATCH_ANCHOR, CATCH_BLOCK]]) {
    check(source.split(anchor + '\n' + block).length === 2 && source.split(block).length === 2,
      'LOCAL_TESTED_BLOCK_DRIFT');
  }
  try { new Script(policyBytes.toString('utf8')); } catch { check(false, 'POLICY_SYNTAX_INVALID'); }
  return { policyBytes: Buffer.from(policyBytes), localIndexSha256: sha(indexBytes),
    policySha256: POLICY_SHA256, blockSha256: { require: sha(REQUIRE_BLOCK), route: sha(ROUTE_BLOCK), catch: sha(CATCH_BLOCK) } };
}

export function patchAdminEntry(input, patch) {
  const files = input.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  check(files.filter(file => file.name === 'index.js').length === 1
    && !files.some(file => file.name.toLowerCase() === 'admin-entry-policy.js'), 'PATCH_ALREADY_PRESENT_OR_INVALID');
  check(patch && sha(patch.policyBytes) === POLICY_SHA256, 'LOCAL_POLICY_DRIFT');
  const entry = files.find(file => file.name === 'index.js'), original = utf8(entry.bytes);
  check(!original.includes("require('./admin-entry-policy')") && !original.includes("'/user/admin-entry'"), 'PATCH_ALREADY_PRESENT_OR_INVALID');
  check(original.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY'), 'COMPATIBILITY_BASE_REQUIRED');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let changed = original;
  for (const [anchor, block] of [[REQUIRE_ANCHOR, REQUIRE_BLOCK], [ROUTE_ANCHOR, ROUTE_BLOCK], [CATCH_ANCHOR, CATCH_BLOCK]]) {
    changed = once(changed, anchor, anchor + newline + block.replace(/\n/g, newline));
  }
  try { new Script(changed); } catch { check(false, 'PATCH_SYNTAX_INVALID'); }
  entry.bytes = Buffer.from(changed);
  // Copy the already tested policy exactly; never reconstruct it from cloud config.
  files.push({ name: 'admin-entry-policy.js', bytes: Buffer.from(patch.policyBytes), externalAttributes: 0, madeBy: 20 });
  return files;
}

export function validateBaseline(manifest, baseline) {
  check(digest(manifest.target) === digest(TARGET) && manifest.sourceFileCount === 4046
    && manifest.unchangedFiles === 4044 && manifest.addedFiles === 0 && manifest.removedFiles === 0,
    'COMPATIBILITY_MANIFEST_SCOPE_MISMATCH');
  check(sha(baseline) === manifest.candidateZipSha256, 'COMPATIBILITY_ARTIFACT_HASH_MISMATCH');
  const files = readZip(baseline);
  check(files.length === 4046 && digest(inventory(files)) === digest(manifest.candidateInventory), 'COMPATIBILITY_INVENTORY_MISMATCH');
  const policy = files.find(file => file.name === 'certification-material-policy.js');
  check(policy && utf8(policy.bytes).includes('secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret)'),
    'COMPATIBILITY_BASE_REQUIRED');
  return files;
}

export function prepare() {
  check(!existsSync(OUTPUT), 'OUTPUT_ALREADY_EXISTS');
  const baselinePath = join(COMPATIBILITY_OUTPUT, 'hlApi.candidate.zip');
  const manifest = JSON.parse(readFileSync(join(COMPATIBILITY_OUTPUT, 'manifest.json'), 'utf8'));
  const baseline = readFileSync(baselinePath), files = validateBaseline(manifest, baseline);
  const patch = checkedLocalPatch(readFileSync(join(ROOT, 'cloudfunctions/hlApi/index.js')),
    readFileSync(join(ROOT, 'cloudfunctions/hlApi/admin-entry-policy.js')));
  const result = patchAdminEntry(files, patch), candidate = rootZip(result);
  const beforeInventory = inventory(files), candidateInventory = inventory(result);
  check(digest(inventory(readZip(candidate))) === digest(candidateInventory), 'ZIP_ROUNDTRIP_MISMATCH');
  const beforeByName = new Map(beforeInventory.map(file => [file.name, file]));
  const added = candidateInventory.filter(file => !beforeByName.has(file.name)).map(file => file.name);
  const changed = candidateInventory.filter(file => beforeByName.has(file.name)
    && digest(beforeByName.get(file.name)) !== digest(file)).map(file => file.name);
  const afterNames = new Set(candidateInventory.map(file => file.name));
  check(JSON.stringify(added) === JSON.stringify(['admin-entry-policy.js'])
    && JSON.stringify(changed) === JSON.stringify(['index.js']) && beforeInventory.every(file => afterNames.has(file.name)), 'PATCH_SCOPE_MISMATCH');
  mkdirSync(join(OUTPUT, 'hlApi'), { recursive: true });
  for (const file of result.filter(file => !file.name.includes('/'))) writeFileSync(join(OUTPUT, 'hlApi', file.name), file.bytes, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.admin-entry.candidate.zip'), candidate, { flag: 'wx' });
  const report = { preparedAt: new Date().toISOString(), target: TARGET, preparationOnly: true,
    compatibilityBaseline: baselinePath, compatibilityBaselineZipSha256: sha(baseline),
    compatibilityManifestSha256: sha(readFileSync(join(COMPATIBILITY_OUTPUT, 'manifest.json'))),
    candidateZipSha256: sha(candidate), sourceFileCount: files.length, candidateFileCount: result.length,
    changedFiles: changed, addedFiles: added, removedFiles: 0, unchangedFiles: files.length - changed.length,
    dependencyFilesPreserved: files.filter(file => file.name.startsWith('node_modules/')).length,
    allOtherBusinessAndDependencyBytesPreserved: true, explicitLegacyKeyCompatibilityPreserved: true,
    localIndexSha256: patch.localIndexSha256, policySha256: patch.policySha256, blockSha256: patch.blockSha256,
    beforeInventory, candidateInventory, requiresLiveCompatibilityBaselineCheckBeforeDeployment: true,
    requiresConfigurationRecoveryBeforeDeployment: true, cloudCodeWrites: 0, configurationWrites: 0, businessCalls: 0,
    scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(OUTPUT, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { prepared: true, output: OUTPUT, candidateFileCount: result.length, changedFiles: changed, addedFiles: added,
    unchangedFiles: report.unchangedFiles, cloudCodeWrites: 0, configurationWrites: 0, businessCalls: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 2, 'NO_DEPLOY_MODE_SUPPORTED');
    console.log(JSON.stringify(prepare()));
  } catch (error) {
    console.error(JSON.stringify({ prepared: false, diagnostic: error.safeCode || 'LOCAL_PREPARATION_FAILED',
      cloudCodeWrites: 0, configurationWrites: 0, businessCalls: 0, secretsPrinted: false }));
    process.exitCode = 1;
  }
}
