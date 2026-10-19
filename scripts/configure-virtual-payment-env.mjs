import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentMcpClient } from './cloudbase-payment-mcp-client.mjs';

// Configure hlApi's virtual payment (小程序虚拟支付) environment variables.
// Secrets arrive ONLY through this process's environment, never through argv,
// and are forwarded to the official MCP over stdio. Nothing secret is printed,
// logged, or written to disk.
//
// Required shell environment:
//   VPAY_OFFER_ID           虚拟支付 OfferID（支付应用ID，数字）
//   VPAY_ENV                '0' 现网 / '1' 沙箱
//   VPAY_APP_KEY            现网 AppKey（VPAY_ENV=0 时生效）
//   VPAY_SANDBOX_APP_KEY    沙箱 AppKey（VPAY_ENV=1 时生效）
//   WX_APP_SECRET           小程序 AppSecret（code2session 与 access_token 用）
//
// Usage:
//   node scripts/configure-virtual-payment-env.mjs --cli-bin <tcb CLI 绝对路径> --mcp-bin <MCP 绝对路径> [--apply]

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const merchant = JSON.parse(readFileSync(resolve(workspace, 'cloudfunctions/hlApi/payment-merchant-config.json'), 'utf8'));
const region = 'ap-shanghai';
const businessFunction = merchant.businessFunctionName;

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
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('官方 CLI 无法启动')));
    child.on('close', status => {
      if (status !== 0) return reject(new Error('官方 CLI 操作未成功'));
      try {
        const output = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(output.slice(output.indexOf('{')));
        if (!data || typeof data.data !== 'object' || data.error) throw new Error();
        resolveResult(data.data);
      } catch (_) { reject(new Error('官方 CLI 返回格式不符')); }
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

function readPatch() {
  const offerId = String(process.env.VPAY_OFFER_ID || '').trim();
  const envMode = String(process.env.VPAY_ENV || '').trim();
  const appKey = String(process.env.VPAY_APP_KEY || '').trim();
  const sandboxAppKey = String(process.env.VPAY_SANDBOX_APP_KEY || '').trim();
  const appSecret = String(process.env.WX_APP_SECRET || '').trim();
  if (!/^\d{6,20}$/.test(offerId)) throw new Error('VPAY_OFFER_ID 必须为虚拟支付基本配置中的数字 OfferID');
  if (!['0', '1'].includes(envMode)) throw new Error('VPAY_ENV 必须为 0（现网）或 1（沙箱）');
  const activeKey = envMode === '1' ? sandboxAppKey : appKey;
  if (activeKey.length < 16 || activeKey.length > 128) throw new Error('当前生效环境的 AppKey 缺失或格式无效');
  if (appSecret.length < 16 || appSecret.length > 128) throw new Error('WX_APP_SECRET 缺失或格式无效');
  // 两把 AppKey 都写入，沙箱/现网切换只改 VPAY_ENV；缺失的一把允许保留云端原值。
  const patch = { VPAY_OFFER_ID: offerId, VPAY_ENV: envMode, WX_APP_SECRET: appSecret };
  if (appKey) patch.VPAY_APP_KEY = appKey;
  if (sandboxAppKey) patch.VPAY_SANDBOX_APP_KEY = sandboxAppKey;
  return patch;
}

async function main() {
  const args = process.argv.slice(2);
  const bin = args[args.indexOf('--cli-bin') + 1];
  const mcpBin = args[args.indexOf('--mcp-bin') + 1];
  if (!args.includes('--cli-bin') || !bin || !isAbsolute(bin) || !existsSync(bin)
    || !args.includes('--mcp-bin') || !mcpBin || !isAbsolute(mcpBin) || !existsSync(mcpBin)) {
    throw new Error('必须提供官方 CLI 与 MCP 入口的绝对路径');
  }
  const patch = readPatch();
  const mcp = new PaymentMcpClient(mcpBin, { envId: merchant.envId, region, cwd: workspace });
  try {
    const before = variables(await cli(bin, ['fn', 'detail', businessFunction]), businessFunction);
    if (String(before.PAYMENT_CALLBACK_TOKEN || '').trim().length < 32) {
      throw new Error('hlApi 内部通信令牌尚未配置，请先完成支付集成基础配置');
    }
    const expected = { ...before, ...patch };
    if (args.includes('--apply')) {
      await mcp.call('manageFunctions', { action: 'updateFunctionConfig', functionName: businessFunction, envVariables: patch });
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const detail = await cli(bin, ['fn', 'detail', businessFunction]);
      if (detail.Status !== 'Active') { await new Promise(done => setTimeout(done, 1000)); continue; }
      const actual = variables(detail, businessFunction);
      if (!args.includes('--apply')) {
        console.log(JSON.stringify({
          applied: false,
          callbackTokenReady: true,
          plannedKeys: Object.keys(patch),
          offerIdMatches: actual.VPAY_OFFER_ID === patch.VPAY_OFFER_ID,
          envModeMatches: actual.VPAY_ENV === patch.VPAY_ENV,
          activeAppKeyReady: String(actual[patch.VPAY_ENV === '1' ? 'VPAY_SANDBOX_APP_KEY' : 'VPAY_APP_KEY'] || '').length >= 16,
          appSecretReady: String(actual.WX_APP_SECRET || '').length >= 16,
          vipPaymentEnabled: actual.PAYMENT_INTEGRATION_READY === 'true',
          matchmakingPaymentEnabled: actual.MATCHMAKING_PAYMENT_READY === 'true',
          note: '核对模式：未写入任何环境变量。加 --apply 生效。'
        }, null, 2));
        return;
      }
      if (Object.entries(expected).every(([key, value]) => actual[key] === value)) {
        console.log(JSON.stringify({
          applied: true,
          functionName: businessFunction,
          offerId: patch.VPAY_OFFER_ID,
          envMode: patch.VPAY_ENV === '1' ? 'sandbox' : 'production',
          changedKeys: Object.keys(patch),
          callbackTokenPreserved: actual.PAYMENT_CALLBACK_TOKEN === before.PAYMENT_CALLBACK_TOKEN,
          checkoutGatesPreserved: actual.PAYMENT_INTEGRATION_READY === before.PAYMENT_INTEGRATION_READY
            && actual.MATCHMAKING_PAYMENT_READY === before.MATCHMAKING_PAYMENT_READY,
          secretsWrittenToDisk: false,
          note: 'VIP与人工牵线共用的虚拟支付环境变量已回读一致；两项正式收款开关均未改动。'
        }, null, 2));
        return;
      }
      throw new Error('环境变量回读核对未通过');
    }
    throw new Error('函数尚未恢复运行状态');
  } finally {
    mcp.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
