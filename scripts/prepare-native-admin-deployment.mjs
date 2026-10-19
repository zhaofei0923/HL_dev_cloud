import { createRequire, isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { TARGET, readZip, rootZip, inventory } from './prepare-admin-entry-rebuild.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = join(ROOT, 'output/native-admin-20261015/backend-candidate-v3');
export const RUNTIME = 'Nodejs16.13';
export const BUILD_TARGET = 'node16.13';
export const BASELINE_SHA256 = '73e5e3a4f7a36841047a1985f7d31a89d86634fcc68a8c09a39f6674cc33df42';
export const SDK_VERSION = '3.18.3';
const BASELINE_DIR = join(ROOT, 'output/admin-entry-20261015/admin-entry-deployment');
const TOOLING = join(ROOT, 'output/admin-operations-20261014/build-tooling');
const SDK_ROOT = 'C:/Users/12157/AppData/Local/Temp/hl-cockpit-sdk-20261014/node_modules/@cloudbase/node-sdk';
const SDK_ENTRY = join(SDK_ROOT, 'dist/index.js');
const QA = join(ROOT, 'output/native-admin-20261015/runtime-qa');
const NODE16 = join(QA, 'node-v16.13.0-win-x64/node.exe');
const NODE16_SHA256 = '7fca04f83b0e2169e41b2e1845e8da0f07d66cf9c3a1b4150767bf3ffddccf62';
const sha = value => createHash('sha256').update(value).digest('hex');
function check(ok, safeCode) { if (!ok) throw Object.assign(new Error(safeCode), { safeCode }); }
function utf8(bytes) {
  check(Buffer.isBuffer(bytes), 'SOURCE_BYTES_REQUIRED');
  const text = bytes.toString('utf8'); check(Buffer.from(text).equals(bytes), 'SOURCE_ENCODING_INVALID'); return text;
}
const ENTRY_ROUTE = [
  "    if (method === 'GET' && path === '/user/admin-entry') {",
  '      const user = await getById(C.users, session.userId);',
  '      return ok(miniprogramAdminEntry(user, session, process.env));', '    }'
].join('\n');
const CATCH_ANCHOR = "    const failedPath = String(event.path || '/');";
export const BOOTSTRAP_ORIGINAL = '    await ensureCollectionsForPath(path);\n    await ensureSeed();';
export const BOOTSTRAP_GUARD = [
  "    if (path !== '/user/admin-entry' && path !== '/user/admin/operations') {",
  '      await ensureCollectionsForPath(path);', '      await ensureSeed();', '    }'
].join('\n');
export const NATIVE_ROUTE = [
  "    if (method === 'POST' && path === '/user/admin/operations') {",
  '      const user = await getById(C.users, session.userId);',
  "      const { authorizeNativeAdmin, executeNativeAdmin } = require('./native-admin.bundle');",
  '      const actor = authorizeNativeAdmin(user, session, process.env);',
  '      const result = await executeNativeAdmin(data, actor);',
  "      return { code: 0, message: 'success', data: result.data, requestId: result.requestId };", '    }'
].join('\n');
export const NATIVE_CATCH = [
  "    if (failedPath === '/user/admin/operations') {",
  '      const requestedCode = Number(err?.code);',
  '      const nativeCode = [40100, 40360, 40361, 42250, 42260, 40940, 40960, 40400, 40460, 50340, 50350, 50351, 50360].includes(requestedCode)',
  '        ? requestedCode : 50360;',
  "      const message = nativeCode === 40100 ? '登录状态已失效，请重新登录'",
  "        : [40360, 40361].includes(nativeCode) ? '当前账号没有管理权限'",
  "          : [42250, 42260].includes(nativeCode) ? '填写内容或操作参数无效，请检查后重试'",
  "            : [40940, 40960].includes(nativeCode) ? '记录已变化，请刷新详情后重新确认'",
  "              : [40400, 40460].includes(nativeCode) ? '记录不存在或操作未开放'",
  "                : '管理操作暂时无法完成，请稍后重试';",
  '      const requestId = crypto.randomUUID();',
  "      console.warn('native_admin_request_failed', { code: nativeCode, requestId });",
  '      return { code: nativeCode, message, requestId };', '    }'
].join('\n');

function once(source, anchor, replacement) {
  check(source.split(anchor).length === 2, 'PATCH_ANCHOR_MISMATCH'); return source.replace(anchor, replacement);
}
export function checkedNativePatch(localIndexBytes, policyBytes) {
  const local = utf8(localIndexBytes).replace(/\r\n/g, '\n'), policy = utf8(policyBytes);
  check(local.split(ENTRY_ROUTE + '\n' + NATIVE_ROUTE).length === 2
    && local.split(CATCH_ANCHOR + '\n' + NATIVE_CATCH).length === 2
    && local.split(NATIVE_ROUTE).length === 2 && local.split(NATIVE_CATCH).length === 2, 'LOCAL_NATIVE_BLOCK_DRIFT');
  check(local.split(BOOTSTRAP_GUARD).length === 2, 'LOCAL_BOOTSTRAP_GUARD_DRIFT');
  check(!policy.includes('WEDA_ADMIN_URL') && policy.includes("return { allowed: true, ready: true, mode: 'native' };")
    && policy.includes('MINIPROGRAM_ADMIN_USER_IDS'), 'LOCAL_NATIVE_POLICY_INVALID');
  try { new Script(policy); } catch { check(false, 'LOCAL_NATIVE_POLICY_SYNTAX_INVALID'); }
  return { route: NATIVE_ROUTE, catch: NATIVE_CATCH, bootstrapGuard: BOOTSTRAP_GUARD, policyBytes: Buffer.from(policyBytes),
    localIndexSha256: sha(localIndexBytes), policySha256: sha(policyBytes), routeSha256: sha(NATIVE_ROUTE), catchSha256: sha(NATIVE_CATCH),
    bootstrapGuardSha256: sha(BOOTSTRAP_GUARD) };
}
export function patchNativeAdmin(input, patch, bundleBytes) {
  check(patch?.route === NATIVE_ROUTE && patch?.catch === NATIVE_CATCH && patch?.bootstrapGuard === BOOTSTRAP_GUARD
    && Buffer.isBuffer(patch.policyBytes) && sha(patch.policyBytes) === patch.policySha256, 'PATCH_CONTRACT_INVALID');
  check(Buffer.isBuffer(bundleBytes) && bundleBytes.length > 0, 'BUNDLE_BYTES_REQUIRED');
  const files = input.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  check(files.filter(file => file.name === 'index.js').length === 1
    && files.filter(file => file.name === 'admin-entry-policy.js').length === 1
    && !files.some(file => file.name.toLowerCase() === 'native-admin.bundle.js'), 'PATCH_ALREADY_PRESENT_OR_INVALID');
  const entry = files.find(file => file.name === 'index.js'), original = utf8(entry.bytes);
  check(!original.includes('/user/admin/operations') && !original.includes('native-admin.bundle'), 'PATCH_ALREADY_PRESENT_OR_INVALID');
  check(original.includes('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY'), 'COMPATIBILITY_BASE_REQUIRED');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text => text.replace(/\n/g, newline);
  let changed = once(original, normalized(ENTRY_ROUTE), normalized(ENTRY_ROUTE + '\n' + patch.route));
  changed = once(changed, CATCH_ANCHOR, CATCH_ANCHOR + newline + normalized(patch.catch));
  changed = once(changed, normalized(BOOTSTRAP_ORIGINAL), normalized(patch.bootstrapGuard));
  try { new Script(changed); new Script(utf8(bundleBytes)); } catch { check(false, 'CANDIDATE_SYNTAX_INVALID'); }
  entry.bytes = Buffer.from(changed);
  files.find(file => file.name === 'admin-entry-policy.js').bytes = Buffer.from(patch.policyBytes);
  files.push({ name: 'native-admin.bundle.js', bytes: Buffer.from(bundleBytes), externalAttributes: 0, madeBy: 20 });
  return files;
}
export function validateBaseline(bytes, manifest) {
  check(sha(bytes) === BASELINE_SHA256 && manifest?.candidateZipSha256 === BASELINE_SHA256, 'BASELINE_HASH_MISMATCH');
  check(JSON.stringify(manifest.target) === JSON.stringify(TARGET) && manifest.candidateFileCount === 4047, 'BASELINE_TARGET_MISMATCH');
  const files = readZip(bytes);
  check(files.length === 4047 && files.filter(file => file.name.startsWith('node_modules/')).length === 4031
    && JSON.stringify(inventory(files)) === JSON.stringify(manifest.candidateInventory), 'BASELINE_INVENTORY_MISMATCH');
  return files;
}
export function assertBundleArtifact(bytes, metafile) {
  const external = Object.values(metafile.outputs).flatMap(output => output.imports || []).filter(item => item.external);
  check(external.every(item => isBuiltin(item.path)), 'BUNDLE_EXTERNAL_DEPENDENCY');
  check(!/\brequire\s*\(\s*['"](?:\.{1,2}\/|@cloudbase\/|wx-server-sdk)/.test(utf8(bytes)), 'BUNDLE_RUNTIME_BUSINESS_REQUIRE');
  try { new Script(utf8(bytes)); } catch { check(false, 'BUNDLE_SYNTAX_INVALID'); }
  return { builtinExternalImports: [...new Set(external.map(item => item.path))].sort(), noRuntimeBusinessRequires: true };
}
export async function buildNativeBundle() {
  const sdkPackageBytes = readFileSync(join(SDK_ROOT, 'package.json')), sdkPackage = JSON.parse(utf8(sdkPackageBytes));
  check(sdkPackage.name === '@cloudbase/node-sdk' && sdkPackage.version === SDK_VERSION, 'PINNED_SDK_VERSION_MISMATCH');
  const esbuild = createRequire(join(TOOLING, 'package.json'))('esbuild'), captured = new Map();
  const optionalImporter = resolve(SDK_ROOT, '../../debug/src/node.js'), optionalSource = readFileSync(optionalImporter);
  check(utf8(optionalSource).includes("const supportsColor = require('supports-color');")
    && utf8(optionalSource).includes('// Swallow - we only care if `supports-color` is available; it doesn\'t have to be.'),
  'OPTIONAL_LOGGER_FALLBACK_CONTRACT_CHANGED');
  const virtualName = 'native-optional-logger:supports-color', virtualBytes = Buffer.from('module.exports = false;\n');
  let optionalFallbackUsed = false;
  const result = await esbuild.build({ absWorkingDir: ROOT, entryPoints: [join(ROOT, 'cloudfunctions/hlApi/native-admin-runtime.js')],
    outfile: 'native-admin.bundle.js', bundle: true, write: false, platform: 'node', format: 'cjs', target: BUILD_TARGET,
    packages: 'bundle', metafile: true, logLevel: 'silent', alias: { '@cloudbase/node-sdk': SDK_ENTRY },
    plugins: [{ name: 'capture-exact-source-inputs', setup(build) {
      build.onResolve({ filter: /^supports-color$/ }, args => {
        check(resolve(args.importer) === optionalImporter, 'UNREVIEWED_OPTIONAL_DEPENDENCY');
        optionalFallbackUsed = true;
        return { path: 'supports-color', namespace: 'native-optional-logger' };
      });
      build.onLoad({ filter: /.*/, namespace: 'native-optional-logger' }, () => ({ contents: virtualBytes, loader: 'js' }));
      build.onLoad({ filter: /\.(?:[cm]?js|json)$/ }, args => {
        const bytes = readFileSync(args.path); captured.set(resolve(args.path), { path: resolve(args.path), bytes: bytes.length, sha256: sha(bytes) });
        return { contents: bytes, loader: args.path.endsWith('.json') ? 'json' : 'js' };
      });
    } }] });
  check(result.warnings.length === 0 && result.outputFiles.length === 1, 'BUNDLE_BUILD_WARNINGS_OR_LAYOUT');
  const bytes = Buffer.from(result.outputFiles[0].contents), proof = assertBundleArtifact(bytes, result.metafile);
  const inputs = Object.keys(result.metafile.inputs).map(name => {
    if (name === virtualName) return { path: virtualName, virtual: true, bytes: virtualBytes.length, sha256: sha(virtualBytes) };
    const path = resolve(ROOT, name), input = captured.get(path);
    check(input && input.sha256 === sha(readFileSync(path)), 'BUNDLE_INPUT_CHANGED_OR_UNRECORDED'); return input;
  }).sort((a, b) => a.path.localeCompare(b.path));
  const sdkInputs = inputs.filter(input => input.path.replaceAll('\\', '/').includes('/@cloudbase/node-sdk/'));
  check(sdkInputs.length > 0 && sdkInputs.every(input => {
    const path = relative(resolve(SDK_ROOT), input.path); return path && !path.startsWith('..') && !path.includes(':');
  }), 'BUNDLE_SDK_ALIAS_DRIFT');
  check(inputs.some(input => input.path === resolve(ROOT, 'cloudfunctions/hlApi/native-admin-service.js'))
    && inputs.some(input => input.path === resolve(ROOT, 'cloudfunctions/hlAdminOperations/mutation-service.js')),
  'BUNDLE_SHARED_SERVICES_MISSING');
  return { bytes, proof: { ...proof, optionalLoggerFallbacks: optionalFallbackUsed ? [{ module: 'supports-color',
    behavior: 'module.exports=false; preserve the absent optional terminal color detection fallback',
    virtualInput: virtualName, virtualInputSha256: sha(virtualBytes), importerPath: optionalImporter,
    importerSha256: sha(optionalSource), originalContract: 'debug/src/node.js optional require is enclosed in try/catch and explicitly ignores missing module' }] : [] },
    inputs, esbuildVersion: esbuild.version, sdk: { name: sdkPackage.name, version: SDK_VERSION,
    packagePath: join(SDK_ROOT, 'package.json'), packageSha256: sha(sdkPackageBytes), entryPath: SDK_ENTRY },
    metafile: result.metafile };
}

const NODE16_QA_SOURCE = String.raw`'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert').strict,Module=require('module'),v8=require('v8');
const bundlePath=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]),sdkEntry=path.resolve(process.argv[4]);
const crypto=require('crypto'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const suiteNames=['native-admin-service.test.js','admin-operations-read.test.js','admin-operations-mutation.test.js','admin-operations-boundaries.test.js','cockpit-service.test.js'];
let networkCalls=0,qaStage='version';const networkStages=[];
for(const name of ['http','https'])for(const method of ['request','get'])require(name)[method]=()=>{networkCalls++;networkStages.push(qaStage);throw new Error('QA_NETWORK_BLOCKED');};
(async()=>{
 assert.equal(process.version,'v16.13.0');
 const globalsBefore={structuredClone:typeof global.structuredClone,fetch:typeof global.fetch};
 qaStage='sdk_load';const sdk=require(sdkEntry);assert.equal(typeof sdk.init,'function');assert.equal(networkCalls,0);
 const originalLoad=Module._load,builtinImports=new Set();
 Module._load=function(name,parent,isMain){if(parent&&parent.filename===bundlePath){assert.ok(Module.builtinModules.includes(name)||Module.builtinModules.includes(name.replace(/^node:/,'')),'BUNDLE_NON_BUILTIN_REQUIRE');builtinImports.add(name);}return originalLoad.call(this,name,parent,isMain);};
 qaStage='bundle_load';const runtime=require(bundlePath);assert.equal(networkCalls,0);
 assert.equal(typeof runtime.authorizeNativeAdmin,'function');assert.equal(typeof runtime.executeNativeAdmin,'function');
 assert.throws(()=>runtime.authorizeNativeAdmin({id:2,status:1},{type:'access',userId:2},{MINIPROGRAM_ADMIN_USER_IDS:'1'}),e=>e.code===40360);
 const actor=runtime.authorizeNativeAdmin({id:1,status:1,authVersion:2},{type:'access',userId:1,authVersion:2},{MINIPROGRAM_ADMIN_USER_IDS:'1'});
 qaStage='bundle_prepare';const prepared=await runtime.executeNativeAdmin({action:'operations.prepare',args:{}},actor);assert.equal(networkCalls,0);
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
 assert.match(prepared.data.requestId,uuid);assert.match(prepared.requestId,uuid);assert.notEqual(prepared.data.requestId,prepared.requestId);
 await assert.rejects(runtime.executeNativeAdmin({action:'operations.prepare'},{uid:actor.uid}),e=>e.code===40360);
 await assert.rejects(runtime.executeNativeAdmin({action:'operations.prepare',args:{uid:'forged'}},actor),e=>e.code===42260);
 assert.deepEqual({structuredClone:typeof global.structuredClone,fetch:typeof global.fetch},globalsBefore);
 assert.equal(networkCalls,0);
 const cases=[];
 // Node 16.13 predates node:test. This shim only registers the existing test
 // functions; V8 cloning is used solely by their in-memory fixture helpers,
 // after the real unpolyfilled SDK/bundle checks above have completed.
 const register=(name,fn)=>{assert.equal(typeof fn,'function');cases.push({name,fn});};
 Module._load=function(name,parent,isMain){if(name==='node:test')return register;return originalLoad.call(this,name,parent,isMain);};
 global.structuredClone=value=>v8.deserialize(v8.serialize(value));
 qaStage='register_test_suites';for(const name of suiteNames)require(path.join(root,'tests',name));
 let passed=0;
 for(const item of cases){qaStage=item.name;await item.fn();passed++;}
 Module._load=originalLoad;
 assert.equal(networkCalls,0);
 console.log(JSON.stringify({passed:true,runtime:'Nodejs16.13',runtimeVersion:process.version,
   sdkVersion:JSON.parse(fs.readFileSync(path.resolve(sdkEntry,'../../package.json'),'utf8')).version,
   checks:{sdkLoads:true,bundleLoads:true,bundlePreparationAvoidsDatabaseInitialization:true,authorizationRejectsOtherBusinessUser:true,
    actualBundlePrepareReturnsIndependentUUIDs:true,forgedPreparationActorRejected:true,prepareArgsRejectedBeforeDatabase:true,
    noBundleGlobalPolyfills:true,networkCalls:0},
   builtinImports:Array.from(builtinImports).sort(),serviceTests:{passed,total:cases.length,
    files:suiteNames.map(name=>({path:path.join(root,'tests',name),sha256:hash(fs.readFileSync(path.join(root,'tests',name)))}))},
   testHarness:{nodeTestRegistrationShim:true,testOnlyStructuredClone:'v8 serialize/deserialize; enabled only after unpolyfilled bundle checks'}}));
})().catch(error=>{console.error(JSON.stringify({passed:false,runtime:'Nodejs16.13',code:error.code||'NODE16_RUNTIME_QA_FAILED',stage:qaStage,networkCalls,networkStages,rawErrorWithheld:true}));process.exitCode=1;});
`;

function writeExclusiveOrMatch(path, bytes) {
  if (existsSync(path)) check(readFileSync(path).equals(Buffer.from(bytes)), 'QA_ARTIFACT_ALREADY_DIFFERS');
  else writeFileSync(path, bytes, { flag: 'wx' });
}
export function verifyNode16Bundle(bundleBytes) {
  check(existsSync(NODE16) && sha(readFileSync(NODE16)) === NODE16_SHA256, 'VERIFIED_NODE16_RUNTIME_REQUIRED');
  const checksums = readFileSync(join(dirname(NODE16), 'SHASUMS256.txt'), 'utf8');
  check(checksums.split(/\r?\n/).some(line => line === `${NODE16_SHA256}  win-x64/node.exe`), 'OFFICIAL_NODE16_CHECKSUM_MISMATCH');
  const bundleSha256 = sha(bundleBytes), bundlePath = join(QA, `native-admin.${bundleSha256}.cjs`), runnerPath = join(QA, `node16-qa.${sha(Buffer.from(NODE16_QA_SOURCE))}.cjs`);
  writeExclusiveOrMatch(bundlePath, bundleBytes); writeExclusiveOrMatch(runnerPath, NODE16_QA_SOURCE);
  const result = spawnSync(NODE16, [runnerPath, bundlePath, ROOT, SDK_ENTRY], { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  let proof;
  try { proof = JSON.parse(result.stdout.trim() || result.stderr.trim()); } catch { check(false, 'NODE16_QA_OUTPUT_INVALID'); }
  if (proof.passed !== true) throw Object.assign(new Error('NODE16_RUNTIME_COMPATIBILITY_FAILED'), {
    safeCode: 'NODE16_RUNTIME_COMPATIBILITY_FAILED', qaDiagnostic: { stage: proof.stage, code: proof.code, networkCalls: proof.networkCalls, networkStages: proof.networkStages } });
  check(!result.error && result.status === 0 && proof.passed === true && proof.runtime === RUNTIME
    && proof.runtimeVersion === 'v16.13.0' && proof.sdkVersion === SDK_VERSION && proof.serviceTests.passed === proof.serviceTests.total,
  'NODE16_RUNTIME_COMPATIBILITY_FAILED');
  return { ...proof, bundleSha256, buildTarget: BUILD_TARGET, runtimeBinaryPath: NODE16, runtimeBinarySha256: NODE16_SHA256,
    runtimeDownloadUrl: 'https://nodejs.org/dist/v16.13.0/win-x64/node.exe',
    runtimeChecksumUrl: 'https://nodejs.org/dist/v16.13.0/SHASUMS256.txt', runtimeChecksumVerified: true,
    qaRunnerPath: runnerPath, qaRunnerSha256: sha(Buffer.from(NODE16_QA_SOURCE)),
    cloudReads: 0, cloudCodeWrites: 0, configurationWrites: 0, businessCalls: 0 };
}

export function verifyNativeBootstrap(indexBytes) {
  check(sha(readFileSync(NODE16)) === NODE16_SHA256, 'VERIFIED_NODE16_RUNTIME_REQUIRED');
  const script = String.raw`const fs=require('fs'),vm=require('vm'),assert=require('assert').strict;
const input=JSON.parse(fs.readFileSync(0,'utf8'));let calls=[];
(async()=>{
 assert.equal(process.version,'v16.13.0');new vm.Script(input.index);
 assert.equal(input.index.split(input.guard).length,2);
 assert.ok(input.index.indexOf(input.guard)<input.index.indexOf('    const session = await requireUser(apiToken);'));
 const run=vm.runInNewContext('(async function(path){'+input.guard+'\n})',{
  ensureCollectionsForPath:async path=>calls.push(['collections',path]),ensureSeed:async()=>calls.push(['seed'])});
 for(const path of ['/user/admin-entry','/user/admin/operations']){calls=[];await run(path);assert.deepEqual(calls,[]);}
 const others=['/user/profile','/auth/wx-login','/admin/dashboard','/internal/payment-orders/query','/user/admin-entry/','/user/admin/operations/','/user/admin/operations-extra'];
 for(const path of others){calls=[];await run(path);assert.deepEqual(calls,[['collections',path],['seed']]);}
 console.log(JSON.stringify({passed:true,runtimeVersion:process.version,candidateIndexParses:true,
  nativePathsSkipBootstrap:true,otherPathsPreserveBootstrap:true,bootstrapBeforeAccessCheck:true,otherPathsTested:others}));
})().catch(()=>{console.error(JSON.stringify({passed:false,rawErrorWithheld:true}));process.exitCode=1;});`;
  const result = spawnSync(NODE16, ['-e', script], { input: JSON.stringify({ index: utf8(indexBytes), guard: BOOTSTRAP_GUARD }),
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
  let proof; try { proof = JSON.parse(result.stdout.trim()); } catch { check(false, 'NODE16_BOOTSTRAP_QA_FAILED'); }
  check(!result.error && result.status === 0 && proof.passed === true, 'NODE16_BOOTSTRAP_QA_FAILED');
  return { ...proof, candidateIndexSha256: sha(indexBytes), guardSha256: sha(BOOTSTRAP_GUARD),
    skippedPaths: ['/user/admin-entry', '/user/admin/operations'] };
}

export async function prepare() {
  check(!existsSync(OUTPUT), 'OUTPUT_ALREADY_EXISTS');
  const baselinePath = join(BASELINE_DIR, 'hlApi.admin-entry.candidate.zip'), baseline = readFileSync(baselinePath);
  const manifest = JSON.parse(readFileSync(join(BASELINE_DIR, 'manifest.json'), 'utf8')), files = validateBaseline(baseline, manifest);
  const indexPath = join(ROOT, 'cloudfunctions/hlApi/index.js'), policyPath = join(ROOT, 'cloudfunctions/hlApi/admin-entry-policy.js');
  const patch = checkedNativePatch(readFileSync(indexPath), readFileSync(policyPath)), bundle = await buildNativeBundle();
  check(sha(readFileSync(indexPath)) === patch.localIndexSha256 && sha(readFileSync(policyPath)) === patch.policySha256, 'LOCAL_PATCH_CHANGED_DURING_BUILD');
  const result = patchNativeAdmin(files, patch, bundle.bytes), candidate = rootZip(result);
  const runtimeCompatibility = { ...verifyNode16Bundle(bundle.bytes), candidateZipSha256: sha(candidate),
    bootstrapGuard: verifyNativeBootstrap(result.find(file => file.name === 'index.js').bytes) };
  const beforeInventory = inventory(files), candidateInventory = inventory(result), beforeByName = new Map(beforeInventory.map(file => [file.name, file]));
  check(JSON.stringify(inventory(readZip(candidate))) === JSON.stringify(candidateInventory), 'ZIP_ROUNDTRIP_MISMATCH');
  const added = candidateInventory.filter(file => !beforeByName.has(file.name)).map(file => file.name);
  const changed = candidateInventory.filter(file => beforeByName.has(file.name)
    && JSON.stringify(beforeByName.get(file.name)) !== JSON.stringify(file)).map(file => file.name);
  check(JSON.stringify(added) === JSON.stringify(['native-admin.bundle.js'])
    && JSON.stringify(changed) === JSON.stringify(['admin-entry-policy.js', 'index.js'])
    && result.length === files.length + 1 && beforeInventory.every(file => candidateInventory.some(row => row.name === file.name)), 'PATCH_SCOPE_MISMATCH');
  for (const file of files.filter(file => file.name !== 'index.js' && file.name !== 'admin-entry-policy.js')) {
    check(JSON.stringify(beforeByName.get(file.name)) === JSON.stringify(candidateInventory.find(row => row.name === file.name)), 'UNRELATED_FILE_CHANGED');
  }
  const report = { preparedAt: new Date().toISOString(), target: TARGET, preparationOnly: true, runtime: RUNTIME, buildTarget: BUILD_TARGET,
    baselinePath, baselineZipSha256: sha(baseline), rollbackZipSha256: sha(baseline), candidateZipSha256: sha(candidate),
    sourceFileCount: files.length, candidateFileCount: result.length, changedFiles: changed, addedFiles: added, removedFiles: 0,
    unchangedFiles: files.length - changed.length, dependencyFilesPreserved: 4031, allOriginalDependencyBytesAndAttributesPreserved: true,
    allOtherBusinessBytesAndAttributesPreserved: true, nativeSdk: bundle.sdk, esbuildVersion: bundle.esbuildVersion,
    bundleSha256: sha(bundle.bytes), bundleBytes: bundle.bytes.length, bundleInputs: bundle.inputs, bundleProof: bundle.proof,
    runtimeCompatibilityEvidence: 'runtime-compatibility.json',
    nativeBootstrapGuard: true, bootstrapGuardSha256: patch.bootstrapGuardSha256,
    bootstrapSkippedPaths: ['/user/admin-entry', '/user/admin/operations'],
    localIndexSha256: patch.localIndexSha256, policySha256: patch.policySha256, routeSha256: patch.routeSha256, catchSha256: patch.catchSha256,
    beforeInventory, candidateInventory, requiresLiveBaselineReadbackBeforeDeployment: true,
    configurationWrites: 0, cloudCodeWrites: 0, cloudReads: 0, businessCalls: 0,
    scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
  mkdirSync(dirname(OUTPUT), { recursive: true }); mkdirSync(OUTPUT); mkdirSync(join(OUTPUT, 'hlApi'));
  for (const file of result.filter(file => !file.name.includes('/'))) writeFileSync(join(OUTPUT, 'hlApi', file.name), file.bytes, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.rollback.zip'), baseline, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.native-admin.candidate.zip'), candidate, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'bundle-metafile.json'), JSON.stringify(bundle.metafile, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'runtime-compatibility.json'), JSON.stringify(runtimeCompatibility, null, 2) + '\n', { flag: 'wx' });
  return { prepared: true, output: OUTPUT, candidateFileCount: result.length, candidateZipSha256: report.candidateZipSha256,
    changedFiles: changed, addedFiles: added, dependencyFilesPreserved: 4031, sdkVersion: SDK_VERSION,
    cloudCodeWrites: 0, configurationWrites: 0, cloudReads: 0, businessCalls: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.argv.length === 2, 'NO_DEPLOY_MODE_SUPPORTED'); console.log(JSON.stringify(await prepare())); }
  catch (error) { console.error(JSON.stringify({ prepared: false, diagnostic: error.safeCode || 'LOCAL_PREPARATION_FAILED',
    cloudCodeWrites: 0, configurationWrites: 0, cloudReads: 0, businessCalls: 0, rawErrorWithheld: true })); process.exitCode = 1; }
}
