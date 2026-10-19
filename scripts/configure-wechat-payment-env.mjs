import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

const require = createRequire(import.meta.url);
const { assertPaymentConfig } = require('../integrations/wechat-pay/hl-payment-config-policy.js');
const { paymentTestAccess } = require('../cloudfunctions/hlApi/payment-test-policy.js');
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const merchant = JSON.parse(readFileSync(resolve(workspace, 'cloudfunctions/hlApi/payment-merchant-config.json'), 'utf8'));
const region = 'ap-shanghai';
let mcp;

// Use the official CLI's existing login. Cloud credentials are never read from
// its credential store, nor are merchant keys written to a configuration file.
function cli(bin, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bin, ...args, '-e', merchant.envId, '-r', region, '--json'], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { child.kill(); return; }
      chunks.push(chunk);
    });
    // Raw CLI errors may include the request; do not forward them to logs.
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('官方 CLI 无法启动')));
    child.on('close', status => {
      if (status !== 0) return reject(new Error('官方 CLI 操作未成功，未输出含凭据的原始结果'));
      try {
        const output = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(output.slice(output.indexOf('{')));
        if (!data || typeof data.data !== 'object' || data.error) throw new Error();
        resolveResult(data.data);
      } catch (_) { reject(new Error('官方 CLI 返回格式不符，未输出原始结果')); }
    });
  });
}

function variables(detail, name) {
  if (detail.FunctionName !== name || detail.Namespace !== merchant.envId || detail.Status !== 'Active') {
    throw new Error(`目标函数身份或状态不符: ${name}`);
  }
  const entries = detail.Environment?.Variables;
  if (!Array.isArray(entries)) throw new Error(`无法读取完整环境变量: ${name}`);
  return Object.fromEntries(entries.map(item => [item.Key, String(item.Value)]));
}

function validatePayment(vars, callbackToken) {
  assertPaymentConfig({ merchant, env: { PAYMENT_CALLBACK_TOKEN: callbackToken }, payConfig: {
    mchId: vars.merchantId, appId: vars.appId, mchSerialNo: vars.merchantSerialNumber,
    mchAPIv3Key: vars.apiV3Key, mchPrivateKey: vars.privateKey,
    mchWechatpayPublicKey: vars.wxPayPublicKey, mchWechatpayPublicKeyId: vars.wxPayPublicKeyId,
    jsapiNotifyUrl: vars.notifyURLPayURL
  } });
}

export function mergeVariables(existing, patch) {
  if (!existing || !patch || typeof existing !== 'object' || typeof patch !== 'object'
    || Array.isArray(existing) || Array.isArray(patch)) throw new Error('环境变量格式不符');
  const merged = { ...existing, ...patch };
  if (Object.values(merged).some(value => typeof value !== 'string')) throw new Error('环境变量必须为文本');
  return merged;
}

function assertNoSourceSecrets(directory, vars) {
  if (!isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw new Error('源码检查目录必须为已存在的绝对路径');
  const privatePem = String(vars.privateKey || '').replace(/\\n/g, '\n');
  const fragments = [String(vars.apiV3Key || ''), String(vars.PAYMENT_CALLBACK_TOKEN || ''),
    ...privatePem.split(/\r?\n/).filter(line => /^[a-zA-Z0-9+/=]{32,}$/.test(line))]
    .filter(value => value.length >= 32);
  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childPath = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('源码检查不接受符号链接');
      if (entry.isDirectory()) inspect(childPath);
      else {
        // Check bytes in every deployable file, including extensionless entry
        // points, build files and binary containers. Never print matching data.
        const source = readFileSync(childPath);
        if (fragments.some(secret => source.includes(Buffer.from(secret)))) throw new Error('源码中发现商户或内部通信凭据，停止部署');
      }
    }
  }
  inspect(directory);
}

async function verifyMerchant(directory, vars) {
  const source = `
    const PayService = require(process.argv[1] + '/services/payService.js');
    const { merchantQueryDiagnostic } = require(process.argv[2]);
    const outTradeNo = 'HLPREFLIGHT' + require('node:crypto').randomBytes(10).toString('hex');
    new PayService().queryOrderByOutTradeNo({ out_trade_no: outTradeNo, mchid: process.env.merchantId }).then(result => {
      console.log('HL_MERCHANT_PROBE=' + JSON.stringify(merchantQueryDiagnostic(result)));
    }).catch(() => { console.log('HL_MERCHANT_PROBE={"authenticated":false,"code":"PAYMENT_PREFLIGHT_FAILED"}'); });
  `;
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['-e', source, directory, resolve(workspace, 'scripts/wechat-merchant-probe-policy.cjs')], {
      cwd: workspace, env: { ...process.env, ...vars }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', () => {});
    const timeout = setTimeout(() => { child.kill(); reject(new Error('微信商户查单验证超时，未进行扣款')); }, 35000);
    child.on('error', () => { clearTimeout(timeout); reject(new Error('商户查单验证进程无法启动')); });
    child.on('close', () => {
      clearTimeout(timeout);
      const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).find(value => value.startsWith('HL_MERCHANT_PROBE='));
      try {
        const result = JSON.parse(line.slice('HL_MERCHANT_PROBE='.length));
        if (!result.authenticated) {
          const codes = ['PARAM_ERROR','INVALID_REQUEST','MCH_NOT_EXISTS','SIGN_ERROR','RULE_LIMIT','TRADE_ERROR','FREQUENCY_LIMITED','SYSTEM_ERROR'];
          const code = codes.includes(result.code) ? result.code : 'PAYMENT_PREFLIGHT_FAILED';
          const status = Number.isInteger(result.status) && result.status >= 400 && result.status <= 599 ? result.status : 0;
          return reject(new Error(`微信商户查单验证未通过: ${status}/${code}；未进行扣款`));
        }
        resolveResult({ authenticated: true, status: 404, code: 'ORDER_NOT_EXIST', realPaymentPerformed: false });
      } catch (_) { reject(new Error('微信商户查单验证未通过，未输出 SDK 原始结果或凭据')); }
    });
  });
}

async function update(bin, name, existing, patch) {
  const merged = mergeVariables(existing, patch);
  // The official tool merges on the cloud side. Only send this patch through
  // stdio, so merchant secrets are neither resent nor placed in process argv.
  await mcp.call('manageFunctions', { action: 'updateFunctionConfig', functionName: name, envVariables: patch });
  // Only environment variables are updated. Preserve runtime, memory, timeout,
  // networking and the Integration Center's complete merchant configuration.
  for (let attempt = 0; attempt < 10; attempt++) {
    const detail = await cli(bin, ['fn', 'detail', name]);
    if (detail.Status !== 'Active') { await new Promise(done => setTimeout(done, 1000)); continue; }
    const actual = variables(detail, name);
    if (Object.entries(merged).every(([key, value]) => actual[key] === value)) return actual;
    throw new Error(`环境变量核对未通过: ${name}`);
  }
  throw new Error(`函数尚未恢复运行状态: ${name}`);
}

async function main() {
  const args = process.argv.slice(2);
  const bin = args[args.indexOf('--cli-bin') + 1];
  const mcpBin = args[args.indexOf('--mcp-bin') + 1];
  const name = args[args.indexOf('--function-name') + 1];
  if (!args.includes('--cli-bin') || !bin || !isAbsolute(bin) || !existsSync(bin)
    || !args.includes('--function-name') || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name || '') || name === 'hlApi') {
    throw new Error('请明确指定官方 CLI 入口绝对路径与实际生成的支付函数名');
  }
  if (args.includes('--apply') || args.includes('--verify-internal')) {
    if (!args.includes('--mcp-bin') || !mcpBin || !isAbsolute(mcpBin) || !existsSync(mcpBin)) {
      throw new Error('环境更新或内部查询必须提供官方 MCP 入口，通过标准输入传递秘密');
    }
    mcp = new PaymentMcpClient(mcpBin, { envId: merchant.envId, region, cwd: workspace });
  }
  const [paymentDetail, businessDetail] = await Promise.all([
    cli(bin, ['fn', 'detail', name]), cli(bin, ['fn', 'detail', merchant.businessFunctionName])
  ]);
  let paymentVars = variables(paymentDetail, name);
  let businessVars = variables(businessDetail, merchant.businessFunctionName);
  if (paymentDetail.Type !== 'HTTP') throw new Error('支付目标必须为实际 HTTP 函数');
  if (businessVars.PAYMENT_FUNCTION_NAME && businessVars.PAYMENT_FUNCTION_NAME !== name) {
    throw new Error('业务函数已有其他支付目标，停止覆盖');
  }
  const configuredToken = paymentVars.PAYMENT_CALLBACK_TOKEN || businessVars.PAYMENT_CALLBACK_TOKEN || '';
  const token = configuredToken.trim().length >= 32 ? configuredToken : randomBytes(32).toString('hex');
  validatePayment(paymentVars, token);
  const sourceDirectory = args.includes('--check-source') ? args[args.indexOf('--check-source') + 1] : '';
  if (sourceDirectory) assertNoSourceSecrets(sourceDirectory, paymentVars);
  const paymentPatch = { PAYMENT_CALLBACK_TOKEN: token };
  const businessPatch = { PAYMENT_CALLBACK_TOKEN: token, PAYMENT_FUNCTION_NAME: name,
    PAYMENT_CREATE_PATH: '/hl-membership/create', PAYMENT_QUERY_PATH: '/hl-membership/query',
    PAYMENT_INTEGRATION_READY: 'false', MATCHMAKING_PAYMENT_READY: 'false', PAYMENT_TEST_ENABLED: 'false',
    PAYMENT_TEST_USER_ID: '', PAYMENT_TEST_EXPIRES_AT: '' };
  if (args.includes('--test-user-id')) {
    const testUserId = args[args.indexOf('--test-user-id') + 1];
    if (!/^[1-9]\d*$/.test(testUserId || '') || !Number.isSafeInteger(Number(testUserId))) {
      throw new Error('必须明确指定已核对且已获授权的测试用户 ID');
    }
    Object.assign(businessPatch, { PAYMENT_TEST_ENABLED: 'true', PAYMENT_TEST_USER_ID: testUserId,
      PAYMENT_TEST_EXPIRES_AT: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
    if (!paymentTestAccess(businessPatch, Number(testUserId))) throw new Error('测试窗口配置无效');
  }
  if (args.includes('--apply')) {
    // Disable checkout first; a partial setup must never open production payment.
    businessVars = await update(bin, merchant.businessFunctionName, businessVars, businessPatch);
    paymentVars = await update(bin, name, paymentVars, paymentPatch);
  }
  const sharedTokenMatches = paymentVars.PAYMENT_CALLBACK_TOKEN?.length >= 32
    && paymentVars.PAYMENT_CALLBACK_TOKEN === businessVars.PAYMENT_CALLBACK_TOKEN;
  let internalQueryCode;
  if (args.includes('--verify-internal')) {
    if (!sharedTokenMatches) throw new Error('两端内部令牌尚未匹配，不执行查询验证');
    const response = await mcp.call('manageFunctions', { action: 'invokeFunction', functionName: merchant.businessFunctionName, params: {
      path: '/internal/payment-orders/query', method: 'POST', data: {
        outTradeNo: 'INVALID_PREFLIGHT_ORDER', requesterOpenid: 'preflight-no-user', paymentProvider: 'jsapi',
        callbackToken: paymentVars.PAYMENT_CALLBACK_TOKEN
      }
    } });
    try {
      const result = response.data?.invokeResult || response.data || response;
      internalQueryCode = typeof result.RetMsg === 'string' ? JSON.parse(result.RetMsg).code
        : (result.result || result).code;
    }
    catch (_) { throw new Error('内部查询验证返回格式不符'); }
    if (internalQueryCode !== 40400) throw new Error(`内部查询验证未通过，业务代码: ${Number(internalQueryCode) || -1}`);
  }
  let merchantQuery;
  if (args.includes('--verify-merchant')) {
    if (!sourceDirectory) throw new Error('商户验证须明确提供已检查的实际源码目录');
    merchantQuery = await verifyMerchant(sourceDirectory, paymentVars);
  }
  console.log(JSON.stringify({ applied: args.includes('--apply'), envId: merchant.envId, functionName: name,
    merchantConfigurationValid: true, sharedTokenAlreadyConfigured: !!configuredToken,
    sharedTokenMatches: args.includes('--apply') ? true : !!sharedTokenMatches,
    sourceSecretsChecked: !!sourceDirectory, internalQueryCode, merchantQuery,
    changedKeys: { payment: Object.keys(paymentPatch), business: Object.keys(businessPatch) },
    integrationReady: businessVars.PAYMENT_INTEGRATION_READY === 'true',
    matchmakingIntegrationReady: businessVars.MATCHMAKING_PAYMENT_READY === 'true', secretsWrittenToDisk: false,
    paymentTestEnabled: businessVars.PAYMENT_TEST_ENABLED === 'true',
    paymentTestPrepared: args.includes('--test-user-id'),
    note: '配置历史JSAPI对账桥接；VIP与人工牵线正式支付均关闭，保留并核对其余已有环境变量。' }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mcp?.close());
}
