import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';
import { createRecoveryReadOnlyRequest } from './validate-recovery-wechat-credentials.mjs';

const require = createRequire(import.meta.url);
const { createVirtualPaymentClient, serverPaySig, assertVirtualPayer } = require('../cloudfunctions/hlApi/virtual-payment-policy.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
const target = { envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai' };
const mcp = new PaymentMcpClient(resolve(SDK, '..', 'cli.cjs'), { ...target, cwd: ROOT });
const safeResponse = response => ({ httpStatus: Number.isInteger(response?.status) ? response.status : null,
  code: Number.isSafeInteger(response?.data?.errcode) ? response.data.errcode : null,
  orderPresent: !!response?.data?.order,
  errorCategory: /signature|签名|pay_sig/i.test(String(response?.data?.errmsg || '')) ? 'signature'
    : /order.*(exist|found)|订单.*(不存在|未找到)/i.test(String(response?.data?.errmsg || '')) ? 'order_absent'
    : /参数|param/i.test(String(response?.data?.errmsg || '')) ? 'parameter' : 'other' });
const safeError = error => ({ transportFailure: true,
  code: ['ETIMEDOUT','ECONNRESET','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','ECONNREFUSED'].includes(error?.cause?.code || error?.code)
    ? error.cause?.code || error.code : 'TRANSPORT_UNCONFIRMED' });
let stage = 'connect';
try {
  await mcp.ready;
  const manager = await require(SDK).getCloudBaseManager({ cloudBaseOptions: { ...target, site: 'domestic' }, authStrategy: 'fail_fast' });
  const detail = await manager.functions.getFunctionDetail('hlApi');
  const env = Object.fromEntries(detail.Environment.Variables.map(x => [x.Key, x.Value]));
  if (detail.Status !== 'Active' || env.PAYMENT_INTEGRATION_READY !== 'false' || env.MATCHMAKING_PAYMENT_READY !== 'false' || env.VPAY_ENV !== '1') throw new Error();
  const users = await mcp.call('readNoSqlDatabaseContent', { collectionName: 'hl_users', query: { id: 1, status: 1 }, projection: { id: 1, openid: 1 }, limit: 2 });
  if (!users.success || users.data.length !== 1) throw new Error();
  const openid = assertVirtualPayer(users.data[0].openid);
  stage = 'token';
  const native = createRecoveryReadOnlyRequest();
  const token = await createVirtualPaymentClient({ appId: 'wx7e5c0f4d07d2f0f8', request: native }).accessToken(env.WX_APP_SECRET);
  const body = JSON.stringify({ openid, env: 1, order_id: `HLKP${randomBytes(12).toString('hex')}` });
  const sig = serverPaySig('/xpay/query_order', body, env.VPAY_SANDBOX_APP_KEY);
  const url = `https://api.weixin.qq.com/xpay/query_order?access_token=${encodeURIComponent(token)}&pay_sig=${sig}`;
  const controlUrl = url.slice(0, -sig.length) + (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  const report = { checkedAt: new Date().toISOString(), mode: 'sandbox_readonly_diagnostic', cloudWrites: 0, ordersCreated: 0, credentialsPersisted: false };
  stage = 'queries';
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(8000) });
    report.fetchValidSignature = safeResponse({ status: response.status, data: await response.json() });
  } catch (error) { report.fetchValidSignature = safeError(error); }
  try { report.nativeValidSignature = safeResponse(await native(url, { method: 'POST', body })); }
  catch (error) { report.nativeValidSignature = safeError(error); }
  try { report.nativeInvalidSignature = safeResponse(await native(controlUrl, { method: 'POST', body })); }
  catch (error) { report.nativeInvalidSignature = safeError(error); }
  writeFileSync(resolve(ROOT, 'output/formal-payment-20261019/probe-diagnostic.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch { console.log(JSON.stringify({ status: 'diagnostic_incomplete', stage, cloudWrites: 0 })); process.exitCode = 1; }
finally { mcp.close(); }
