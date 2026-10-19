'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const baselineHash = 'f18bf5731b51c7f7b446b9db7657dbec501d55dce59c3c404960082f78d77da4';
const baselinePath = path.join(root, 'output/native-admin-performance-20261019/hlApi.performance.zip');
const archiveOptions = { skip: existsSync(baselinePath) ? false
  : 'Requires the verified historical deployment archive; deployment artifact checks must run where this archive is available.' };
const catalogName = 'vip-membership-service.js';
const bundleName = 'native-admin.bundle.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let fixturePromise;

function fixture() {
  return fixturePromise ||= (async () => {
    const deployment = await import('../scripts/deploy-matchmaking-counts.mjs');
    const zip = await import('../scripts/prepare-admin-entry-rebuild.mjs');
    // The original must come from the already verified deployment archive,
    // never from the working source that this deployment is intended to change.
    const bytes = readFileSync(baselinePath);
    assert.equal(sha(bytes), baselineHash, 'test fixture must be the accepted live baseline');
    const files = zip.readZip(bytes);
    assert.equal(files.length, 4048);
    const original = files.find(file => file.name === catalogName).bytes;
    // The historical deployment proof remains executable after later service work.
    // Production callers omit this test-only expected-source argument and still
    // require the current working source to equal the immutable catalog patch.
    return { ...deployment, ...zip, files, original,
      replaceCatalogFiles: (rows, bytes) => deployment.replaceCatalogFiles(rows, bytes, deployment.patchCatalog(original)) };
  })();
}

function loadCatalog(bytes) {
  const context = { module: { exports: {} }, require(name) {
    if (name === 'node:crypto') return require(name);
    if (name === './relationship-policy') return { isPremiumMembership() { throw new Error('catalog inspection must not execute business operations'); } };
    throw new Error('unexpected module dependency: ' + name);
  } };
  vm.runInNewContext(bytes.toString('utf8'), context);
  const { DEFAULT_MEMBERSHIP_PLANS, RETIRED_MATCHMAKING_PLAN_CODES } = context.module.exports;
  return JSON.parse(JSON.stringify({ plans: DEFAULT_MEMBERSHIP_PLANS, retired: RETIRED_MATCHMAKING_PLAN_CODES }));
}

test('catalog patch changes only the approved two products and retirement list from the verified archive', archiveOptions, async () => {
  const { original, patchCatalog } = await fixture();
  const patched = patchCatalog(original);
  const old = loadCatalog(original), next = loadCatalog(patched);
  assert.deepEqual(next.plans.slice(0, 4), old.plans.slice(0, 4), 'all VIP benefits remain identical');
  assert.deepEqual(next.plans.slice(4), [
    { ...old.plans[4], planCode: 'matchmaking_double', title: '人工牵线2次', serviceCount: 2 },
    { ...old.plans[5], planCode: 'matchmaking_month_6', serviceCount: 6 }
  ]);
  assert.deepEqual(old.plans.slice(4).map(plan => [plan.planCode, plan.serviceCount]), [
    ['matchmaking_single', 1], ['matchmaking_month_3', 3]
  ]);
  assert.deepEqual(next.retired, [...old.retired, 'matchmaking_single', 'matchmaking_month_3']);
  const source = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
  const outsideCatalog = bytes => source(bytes).replace(
    /const DEFAULT_MEMBERSHIP_PLANS = Object\.freeze\(\[[\s\S]*?const RETIRED_MATCHMAKING_PLAN_CODES = Object\.freeze\(\[[\s\S]*?\]\);/,
    '[catalog-and-retirement-list]');
  assert.equal(outsideCatalog(patched), outsideCatalog(original), 'fulfillment, refunds and all unrelated service code remain byte-identical');
  assert.throws(() => patchCatalog(patched), /CATALOG_BASELINE_MISMATCH/, 'already patched input must not be silently accepted');
  assert.throws(() => patchCatalog(Buffer.from(source(original).replace('serviceCount: 3, sortOrder: 20', 'serviceCount: 4, sortOrder: 20'))), /CATALOG_BASELINE_MISMATCH/);
  assert.throws(() => patchCatalog(Buffer.concat([original, Buffer.from("\n// { planCode: 'matchmaking_single', title: '人工牵线单次', productType: 'matchmaking', amountFen: 298000, durationDays: 30, serviceCount: 1, sortOrder: 30 }\n")])), /CATALOG_BASELINE_MISMATCH/);
});

test('catalog replacement rejects unrelated service edits and ambiguous package layouts', archiveOptions, async () => {
  const { original, files, replaceCatalogFiles } = await fixture();
  const bundle = Buffer.from('verified-bundle-fixture');
  const mutated = files.map(file => file.name === catalogName
    ? { ...file, bytes: Buffer.concat([original, Buffer.from('\n// unrelated service change\n')]) } : file);
  assert.throws(() => replaceCatalogFiles(mutated, bundle), /UNRELATED_CATALOG_SOURCE_CHANGE/);
  for (const name of [catalogName, bundleName]) {
    assert.throws(() => replaceCatalogFiles(files.filter(file => file.name !== name), bundle), /BUNDLE_LAYOUT_INVALID/);
    assert.throws(() => replaceCatalogFiles([...files, files.find(file => file.name === name)], bundle), /BUNDLE_LAYOUT_INVALID/);
  }
  assert.throws(() => replaceCatalogFiles(files, Buffer.alloc(0)), /BUNDLE_LAYOUT_INVALID/);
  assert.throws(() => replaceCatalogFiles(files, 'not-a-buffer'), /BUNDLE_LAYOUT_INVALID/);
});

test('catalog deployment preserves all 4046 other ZIP files and every file attribute through archive roundtrip', archiveOptions, async () => {
  const { files, original, replaceCatalogFiles, inventory, rootZip, readZip } = await fixture();
  const before = inventory(files);
  const bundle = Buffer.from('verified-bundle-fixture');
  const replaced = replaceCatalogFiles(files, bundle);
  const roundtrip = readZip(rootZip(replaced));
  assert.deepEqual(inventory(roundtrip), inventory(replaced));
  assert.deepEqual(inventory(files), before, 'packaging must not mutate original buffers or entries');
  assert.equal(files.find(file => file.name === catalogName).bytes.equals(original), true);
  const next = new Map(roundtrip.map(file => [file.name, file]));
  const changed = [];
  for (const file of files) {
    const after = next.get(file.name);
    assert.ok(after, file.name);
    assert.equal(after.externalAttributes, file.externalAttributes, file.name + ' attributes');
    assert.equal(after.madeBy, file.madeBy, file.name + ' creator attributes');
    if (!after.bytes.equals(file.bytes)) changed.push(file.name);
    if (![catalogName, bundleName].includes(file.name)) assert.deepEqual(after, file, file.name);
  }
  assert.equal(roundtrip.length, files.length);
  assert.deepEqual(changed.sort(), [bundleName, catalogName].sort());
  assert.equal(next.get(bundleName).bytes.equals(bundle), true);
});

test('bundle input scope permits the catalog alone and rejects other code, dependencies, insertion, removal or no change', async () => {
  const { assertInputScope } = await import('../scripts/deploy-matchmaking-counts.mjs');
  const allowed = path.join(root, 'cloudfunctions/hlApi/vip-membership-service.js');
  const unrelated = path.join(root, 'cloudfunctions/hlApi/membership-payment-policy.js');
  const dependency = path.join(root, 'node_modules/@cloudbase/node-sdk/index.js');
  const before = [{ path: allowed, sha256: 'old' }, { path: unrelated, sha256: 'same' }, { path: dependency, sha256: 'same-dependency' }];
  const after = [{ path: allowed, sha256: 'new' }, ...before.slice(1)];
  assert.deepEqual(assertInputScope(before, after), [allowed]);
  assert.throws(() => assertInputScope(before, before), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  for (const index of [1, 2]) {
    assert.throws(() => assertInputScope(before, after.map((input, i) => i === index ? { ...input, sha256: 'changed' } : input)), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  }
  assert.throws(() => assertInputScope(before, after.slice(0, 2)), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  assert.throws(() => assertInputScope(before, [...after, { path: path.join(root, 'unexpected.js'), sha256: 'new' }]), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
  assert.throws(() => assertInputScope(before, [after[0], after[1], { path: path.join(root, 'replacement.js'), sha256: 'same-dependency' }]), /UNRELATED_BUNDLE_SOURCE_CHANGE/);
});
