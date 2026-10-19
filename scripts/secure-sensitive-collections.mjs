import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicitly approved on 2026-10-13: only these four production ACLs.
// No document read/write, payment action, function deployment or app publishing.
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const COLLECTIONS = Object.freeze([
  'hl_profiles', 'hl_member_private_archives', 'hl_member_identity_claims', 'hl_member_certifications'
]);
const [sdkFile, mode = 'inspect'] = process.argv.slice(2);
if (!sdkFile || !['inspect', 'apply'].includes(mode)) {
  console.error('Usage: node scripts/secure-sensitive-collections.mjs <official-MCP-dist/index.cjs> [inspect|apply]');
  process.exit(2);
}
const evidence = resolve(import.meta.dirname, '../output/cloud-sensitive-permissions-20261013.json');
let phase = 'initialize';
const record = { envId: ENV_ID, region: 'ap-shanghai', capturedAt: new Date().toISOString(),
  mode, status: 'reading', collections: [] };
const persist = async () => {
  await mkdir(resolve(import.meta.dirname, '../output'), { recursive: true });
  await writeFile(evidence, JSON.stringify(record, null, 2) + '\n');
};

try {
  const { getCloudBaseManager } = createRequire(import.meta.url)(resolve(sdkFile));
  const manager = await getCloudBaseManager({ cloudBaseOptions: {
    envId: ENV_ID, region: 'ap-shanghai', site: 'domestic'
  }, authStrategy: 'fail_fast' });
  const call = async (Action, Param) => {
    phase = Action;
    const result = await manager.commonService().call({ Action, Param });
    const response = result?.Response ?? result;
    if (!response || response.Error) throw new Error('Cloud rule operation did not succeed');
    return response;
  };
  const read = async collection => {
    const params = { EnvId: ENV_ID, CollectionName: collection };
    const acl = await call('DescribeDatabaseACL', params);
    const safe = await call('DescribeSafeRule', params);
    if (typeof acl.AclTag !== 'string' || typeof safe.AclTag !== 'string'
      || safe.Rule !== null && safe.Rule !== undefined && typeof safe.Rule !== 'string') throw new Error('Unknown rule shape');
    return { aclTag: acl.AclTag, safeRuleTag: safe.AclTag, rule: safe.Rule ?? '',
      aclRequestId: acl.RequestId, ruleRequestId: safe.RequestId };
  };
  for (const collection of COLLECTIONS) record.collections.push({ collection, before: await read(collection), status: 'read' });
  if (mode === 'inspect') {
    record.status = 'inspected';
    console.log(JSON.stringify(record, null, 2));
  } else {
    // Preserve the pre-change state before making any cloud modification.
    record.status = 'approved-preflight';
    await persist();
    if (record.collections.some(item => item.before.aclTag !== 'PRIVATE'
      || item.before.safeRuleTag !== 'PRIVATE' || item.before.rule !== '')) {
      throw new Error('Rules changed since review; refusing to overwrite');
    }
    for (const item of record.collections) {
      const current = await read(item.collection);
      if (current.aclTag !== 'PRIVATE' || current.safeRuleTag !== 'PRIVATE' || current.rule !== '') {
        throw new Error('Concurrent rule change; refusing to overwrite');
      }
      item.status = 'modifying';
      await persist();
      const modified = await call('ModifySafeRule', { EnvId: ENV_ID, CollectionName: item.collection, AclTag: 'ADMINONLY' });
      item.modifyRequestId = modified.RequestId;
      item.status = 'modified-awaiting-verification';
      await persist();
      item.after = await read(item.collection);
      if (item.after.aclTag !== 'ADMINONLY' || item.after.safeRuleTag !== 'ADMINONLY') throw new Error('ACL read-back did not match');
      item.status = 'verified';
      await persist();
    }
    record.status = 'all-four-adminonly-verified';
    record.completedAt = new Date().toISOString();
    await persist();
    console.log(JSON.stringify(record, null, 2));
  }
} catch (error) {
  record.status = 'stopped';
  record.failedPhase = phase;
  if (mode === 'apply') await persist();
  const safeReasons = ['Rules changed since review; refusing to overwrite',
    'Concurrent rule change; refusing to overwrite', 'ACL read-back did not match', 'Unknown rule shape'];
  console.error(JSON.stringify({ status: 'stopped', phase,
    reason: safeReasons.includes(error?.message) ? error.message : 'Cloud operation failed; raw response withheld',
    verifiedCollections: record.collections.filter(item => item.status === 'verified').map(item => item.collection) }));
  process.exitCode = 1;
}
