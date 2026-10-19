'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const prep = import('../scripts/prepare-native-admin-deployment.mjs');
const zip = import('../scripts/prepare-admin-entry-rebuild.mjs');
const source = name => fs.readFileSync(path.join(__dirname, '../cloudfunctions/hlApi', name));
const bundle = Buffer.from("module.exports={authorizeNativeAdmin(){},executeNativeAdmin(){}};");
const workspace = path.resolve(__dirname, '..');
const tooling = path.join(workspace, 'output/admin-operations-20261014/build-tooling');
const sdkRoot = 'C:/Users/12157/AppData/Local/Temp/hl-cockpit-sdk-20261014/node_modules/@cloudbase/node-sdk';
const node16 = path.join(workspace, 'output/native-admin-20261015/runtime-qa/node-v16.13.0-win-x64/node.exe');
function externalToolchainSkip({ build = false } = {}) {
  const missing = [];
  if (process.platform !== 'win32') missing.push('Windows Node 16 runtime host');
  if (!fs.existsSync(node16)) missing.push('pinned Node 16 executable');
  if (build) {
    if (!fs.existsSync(path.join(path.dirname(node16), 'SHASUMS256.txt'))) missing.push('Node 16 official checksums');
    if (!fs.existsSync(path.join(tooling, 'package.json'))) missing.push('local esbuild tooling');
    else {
      try { createRequire(path.join(tooling, 'package.json')).resolve('esbuild'); }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        missing.push('local esbuild package');
      }
    }
    if (![path.join(sdkRoot, 'package.json'), path.join(sdkRoot, 'dist/index.js'),
      path.resolve(sdkRoot, '../../debug/src/node.js')].every(filename => fs.existsSync(filename))) {
      missing.push('pinned local CloudBase SDK');
    }
  }
  return missing.length ? `External deployment toolchain integration test: missing ${missing.join(', ')}` : false;
}
async function patch() { return (await prep).checkedNativePatch(source('index.js'), source('admin-entry-policy.js')); }
function fixture(newline = '\n') {
  return [
    { name: 'index.js', bytes: Buffer.from(["const crypto = require('node:crypto');", 'async function main(){', '  try {',
      '    await ensureCollectionsForPath(path);', '    await ensureSeed();',
      '    const session = await requireUser(apiToken);',
      "    if (method === 'GET' && path === '/user/admin-entry') {", '      const user = await getById(C.users, session.userId);',
      '      return ok(miniprogramAdminEntry(user, session, process.env));', '    }', "    return 'unrelated business bytes';", '  } catch (err) {',
      "    const failedPath = String(event.path || '/');", '    throw err;', '  }', '}',
      'const compatibility={jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY};'].join(newline)), externalAttributes: 0x81a40000, madeBy: 0x0314 },
    { name: 'admin-entry-policy.js', bytes: Buffer.from('module.exports={legacy:true};'), externalAttributes: 0x81a40000, madeBy: 0x0314 },
    { name: 'package.json', bytes: Buffer.from('{"name":"native-preparation-fixture"}'), externalAttributes: 0, madeBy: 20 },
    { name: 'certification-material-policy.js', bytes: Buffer.from('immutable compatibility module'), externalAttributes: 0, madeBy: 20 },
    { name: 'node_modules/fixture/raw.bin', bytes: Buffer.from([0, 255, 7, 19]), externalAttributes: 0x81a40000, madeBy: 0x0314 }
  ];
}
test('native patch changes only two files and adds its bundle while retaining original bytes and attributes', async () => {
  const { patchNativeAdmin, NATIVE_ROUTE, NATIVE_CATCH, BOOTSTRAP_GUARD, BOOTSTRAP_ORIGINAL } = await prep, { inventory, rootZip, readZip } = await zip;
  const original = fixture(), before = inventory(original), checked = await patch(), result = patchNativeAdmin(original, checked, bundle);
  assert.deepEqual(inventory(original), before);
  assert.equal(result.length, original.length + 1);
  for (const file of original) {
    const after = result.find(row => row.name === file.name);
    assert.equal(after.externalAttributes, file.externalAttributes); assert.equal(after.madeBy, file.madeBy);
    if (!['index.js', 'admin-entry-policy.js'].includes(file.name)) assert.ok(after.bytes.equals(file.bytes));
  }
  const changed = result.find(row => row.name === 'index.js').bytes.toString();
  assert.equal(changed.replace('\n' + NATIVE_ROUTE, '').replace('\n' + NATIVE_CATCH, '').replace(BOOTSTRAP_GUARD, BOOTSTRAP_ORIGINAL), original[0].bytes.toString());
  assert.ok(result.find(row => row.name === 'admin-entry-policy.js').bytes.equals(source('admin-entry-policy.js')));
  assert.deepEqual(inventory(readZip(rootZip(result))), inventory(result));
});
test('missing and duplicated anchors, incompatible baselines, already patched archives and drifted blocks fail closed', async () => {
  const { patchNativeAdmin, checkedNativePatch } = await prep, checked = await patch(), original = fixture();
  const text = original[0].bytes.toString();
  for (const bad of [text.replace("    const failedPath = String(event.path || '/');", ''),
    text + "\n    const failedPath = String(event.path || '/');", text.replace('jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY', 'incompatible:null'),
    text + "\nconst unknown='/user/admin/operations';", text.replace("path === '/user/admin-entry'", "path === '/changed'")]) {
    assert.throws(() => patchNativeAdmin([{ ...original[0], bytes: Buffer.from(bad) }, ...original.slice(1)], checked, bundle));
  }
  assert.throws(() => patchNativeAdmin(patchNativeAdmin(original, checked, bundle), checked, bundle));
  assert.throws(() => patchNativeAdmin(original, { ...checked, route: checked.route + '\n' }, bundle));
  assert.throws(() => patchNativeAdmin(original, { ...checked, bootstrapGuard: checked.bootstrapGuard.replace('/user/admin-entry', '/user') }, bundle));
  assert.throws(() => checkedNativePatch(Buffer.from(source('index.js').toString().replace("console.warn('native_admin_request_failed', { code: nativeCode, requestId });", "console.warn(err);")), source('admin-entry-policy.js')));
  assert.throws(() => checkedNativePatch(Buffer.from(source('index.js').toString().replace("path !== '/user/admin-entry'", "!path.startsWith('/user')")), source('admin-entry-policy.js')));
});
test('CRLF and binary dependencies survive and invalid source encodings are rejected', async () => {
  const { patchNativeAdmin } = await prep, checked = await patch(), original = fixture('\r\n');
  const result = patchNativeAdmin(original, checked, bundle), index = result[0].bytes.toString();
  assert.equal(index.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(result.at(-2).bytes.equals(original.at(-1).bytes));
  assert.throws(() => patchNativeAdmin([{ ...original[0], bytes: Buffer.concat([original[0].bytes, Buffer.from([255])]) }, ...original.slice(1)], checked, bundle));
});
test('bundle permits Node builtins only and rejects unresolved sibling or SDK dependencies', async () => {
  const { assertBundleArtifact } = await prep;
  assert.equal(assertBundleArtifact(bundle, { outputs: { bundle: { imports: [{ path: 'node:crypto', external: true }] } } }).noRuntimeBusinessRequires, true);
  for (const name of ['./native-admin-service', '../hlAdminOperations/read-service', '@cloudbase/node-sdk', 'wx-server-sdk']) {
    assert.throws(() => assertBundleArtifact(Buffer.from(`require('${name}');`), { outputs: { bundle: { imports: [{ path: name, external: true }] } } }));
  }
});
test('external deployment toolchain: real bundle pins SDK 3.18.3 and Node16.13, inlines shared services and leaves only builtin imports',
  { skip: externalToolchainSkip({ build: true }) }, async () => {
  const { buildNativeBundle, verifyNode16Bundle, SDK_VERSION, BUILD_TARGET, RUNTIME, OUTPUT } = await prep, result = await buildNativeBundle();
  assert.equal(SDK_VERSION, '3.18.3'); assert.equal(result.sdk.version, '3.18.3');
  assert.equal(BUILD_TARGET, 'node16.13'); assert.equal(RUNTIME, 'Nodejs16.13'); assert.ok(OUTPUT.endsWith('backend-candidate-v3'));
  assert.equal(result.proof.noRuntimeBusinessRequires, true);
  assert.ok(result.inputs.some(input => input.path.replaceAll('\\', '/').endsWith('/cloudfunctions/hlAdminOperations/mutation-service.js')));
  assert.ok(result.inputs.every(input => /^[a-f0-9]{64}$/.test(input.sha256)));
  assert.ok(result.bytes.length > 10000);
  const runtime = verifyNode16Bundle(result.bytes);
  assert.equal(runtime.runtimeVersion, 'v16.13.0'); assert.equal(runtime.passed, true);
  assert.equal(runtime.checks.networkCalls, 0); assert.equal(runtime.checks.noBundleGlobalPolyfills, true);
  assert.equal(runtime.serviceTests.passed, runtime.serviceTests.total); assert.ok(runtime.serviceTests.total >= 100);
});
test('bootstrap skips only the two exact native paths and authorization still precedes native business reads', async () => {
  const { BOOTSTRAP_GUARD } = await prep;
  let calls = [];
  const run = vm.runInNewContext('(async function(path, permitted) {\n' + BOOTSTRAP_GUARD
    + '\n await requireUser(permitted); await privateRead(); })', {
    ensureCollectionsForPath: async path => calls.push(['collections', path]), ensureSeed: async () => calls.push(['seed']),
    requireUser: async permitted => { calls.push(['access']); if (!permitted) throw new Error('ACCESS_DENIED'); },
    privateRead: async () => calls.push(['privateRead'])
  });
  for (const route of ['/user/admin-entry', '/user/admin/operations']) {
    calls = []; await run(route, true); assert.deepEqual(calls, [['access'], ['privateRead']]);
    calls = []; await assert.rejects(run(route, false), /ACCESS_DENIED/); assert.deepEqual(calls, [['access']]);
  }
  for (const route of ['/user/profile', '/auth/wx-login', '/admin/dashboard', '/user/admin-entry/', '/user/admin/operations-extra']) {
    calls = []; await run(route, true); assert.deepEqual(calls, [['collections', route], ['seed'], ['access'], ['privateRead']]);
  }
});

test('external deployment toolchain: Node16 verifies the patched native bootstrap',
  { skip: externalToolchainSkip() }, async () => {
  const { verifyNativeBootstrap, patchNativeAdmin } = await prep;
  const candidate = patchNativeAdmin(fixture(), await patch(), bundle);
  const proof = verifyNativeBootstrap(candidate.find(file => file.name === 'index.js').bytes);
  assert.equal(proof.runtimeVersion, 'v16.13.0'); assert.equal(proof.nativePathsSkipBootstrap, true);
  assert.equal(proof.otherPathsPreserveBootstrap, true);
});
test('baseline pin prevents arbitrary or altered deployment sources', async () => {
  const { validateBaseline, BASELINE_SHA256 } = await prep;
  assert.equal(BASELINE_SHA256, '73e5e3a4f7a36841047a1985f7d31a89d86634fcc68a8c09a39f6674cc33df42');
  assert.throws(() => validateBaseline(Buffer.from('not the approved baseline'), { candidateZipSha256: BASELINE_SHA256 }));
});
