import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { protectedDigests } from './deploy-admin-entry-compatibility.mjs';

const ROOT = resolve(import.meta.dirname || 'scripts', '..');
const OUT = resolve(ROOT, 'output/formal-payment-20261019');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const TARGET = { envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai', functionName: 'hlApi' };
const sha = value => createHash('sha256').update(value).digest('hex');
let stage = 'schema';
const mcp = new PaymentMcpClient(resolve(SDK, '..', 'cli.cjs'), { ...TARGET, cwd: ROOT });
try {
  await mcp.ready;
  const listed = await mcp.request('tools/list', {});
  const schemas = listed.tools.filter(tool => ['queryFunctions', 'manageFunctions', 'readNoSqlDatabaseContent'].includes(tool.name));
  if (schemas.length !== 3) throw new Error('MCP_SCHEMA_MISSING');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'mcp-schemas.json'), JSON.stringify(schemas, null, 2));
  stage = 'function_read';
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  const detail = await manager.functions.getFunctionDetail(TARGET.functionName);
  if (detail.FunctionName !== TARGET.functionName || detail.Namespace !== TARGET.envId || detail.Status !== 'Active') throw new Error('TARGET_NOT_ACTIVE');
  const values = detail.Environment?.Variables;
  if (!Array.isArray(values)) throw new Error('ENVIRONMENT_UNAVAILABLE');
  const env = Object.fromEntries(values.map(item => [item.Key, String(item.Value)]));
  const code = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  const keyReady = key => (env[key] || '').length >= 16 && (env[key] || '').length <= 128;
  const report = { status: 'inspected', checkedAt: new Date().toISOString(), target: TARGET,
    codeSha256: code.CodeSha256, protectedDigests: protectedDigests(detail),
    flags: Object.fromEntries(['VPAY_ENV', 'PAYMENT_PROVIDER', 'PAYMENT_INTEGRATION_READY', 'MATCHMAKING_PAYMENT_READY', 'PAYMENT_TEST_ENABLED', 'SEED_DATA'].map(key => [key, env[key] ?? null])),
    readiness: { productionAppKeyPresent: !!env.VPAY_APP_KEY, productionAppKeyFormatReady: keyReady('VPAY_APP_KEY'),
      sandboxAppKeyFormatReady: keyReady('VPAY_SANDBOX_APP_KEY'), productionAndSandboxKeysDiffer: !!env.VPAY_APP_KEY && env.VPAY_APP_KEY !== env.VPAY_SANDBOX_APP_KEY,
      appSecretFormatReady: keyReady('WX_APP_SECRET'), offerIdFormatReady: /^\d{6,20}$/.test(env.VPAY_OFFER_ID || ''),
      callbackTokenReady: (env.PAYMENT_CALLBACK_TOKEN || '').length >= 32 },
    environmentKeyNames: Object.keys(env).sort(), cloudWrites: 0, paymentCalls: 0, credentialsPersisted: false };
  writeFileSync(resolve(OUT, 'inspection.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ status: 'incomplete', stage, rawErrorWithheld: true, cloudWrites: 0 }));
  process.exitCode = 1;
} finally { mcp.close(); }
