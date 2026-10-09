import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installMarker = '// HL membership payment integration';
const callbackMarker = '// HL: await business fulfillment before acknowledging the callback';
const originalCallback = /this\.orderService\.handlerUnifiedTrigger\(payResult\)\.catch\(err => \{\s*console\.error\('\[PayService\] 异步处理支付回调业务失败:', err\);\s*\}\);/;

function readSource(target, filename) {
  const sourcePath = join(target, filename);
  if (!existsSync(sourcePath) || lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error(`缺少标准集成源码或文件为符号链接：${filename}`);
  }
  const taskRelativePath = relative(target, realpathSync(sourcePath));
  if (taskRelativePath.startsWith('..') || isAbsolute(taskRelativePath)) throw new Error('集成源码路径越出目标目录');
  return readFileSync(sourcePath, 'utf8');
}

export function prepareIntegration(targetPath, functionName) {
  if (!functionName || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(functionName) || functionName === 'hlApi') {
    throw new Error('请提供集成中心实际生成的支付函数名称');
  }
  const target = realpathSync(resolve(targetPath));
  if (basename(target) !== functionName) throw new Error('目标目录名必须与实际支付函数名称一致');
  if (!lstatSync(join(target, 'services')).isDirectory() || lstatSync(join(target, 'services')).isSymbolicLink()) {
    throw new Error('缺少标准 services 目录');
  }
  let app = readSource(target, 'app.js');
  let service = readSource(target, 'services/payService.js');
  const orderService = readSource(target, 'services/orderService.js');
  const packageJson = JSON.parse(readSource(target, 'package.json'));
  readSource(target, 'scf_bootstrap');
  if (!app.includes('const express = require(\'express\');')
    || !app.includes('const config = require(\'./config/config\');')
    || !orderService.includes('handlerUnifiedTrigger')
    || !service.includes('async queryOrderByOutTradeNo(')
    || !service.includes('async unifiedOrder(')) {
    throw new Error('生成函数模板与已核验的官方版本不符，请先检查实际源码');
  }

  const insertion = `${installMarker}
require('./services/hl-membership-routes').install(app, {
  express,
  PayService: require('./services/payService'),
  OrderService: require('./services/orderService'),
  cloud: require('wx-server-sdk'),
  payConfig: config.payConfig,
  merchant: require('./services/hl-member-merchant.json'),
  env: process.env
});

`;
  const routerAnchor = "const payRouter = require('./routes/pay');";
  if (!app.includes(installMarker)) {
    if (app.split(routerAnchor).length !== 2) throw new Error('无法唯一定位生成函数的路由入口');
    app = app.replace(routerAnchor, insertion + routerAnchor);
  }
  if (!service.includes(callbackMarker)) {
    const callbackMatches = service.match(new RegExp(originalCallback.source, 'g')) || [];
    if (callbackMatches.length !== 1) throw new Error('无法安全定位生成函数的异步回调钩子，请检查实际模板');
    service = service.replace(originalCallback, `${callbackMarker}\n        await this.orderService.handlerUnifiedTrigger(payResult);`);
  }
  if (!packageJson.dependencies || !packageJson.dependencies.express || !packageJson.dependencies['wechatpay-node-v3']) {
    throw new Error('支付函数缺少已核验的官方依赖');
  }
  if (!packageJson.dependencies['wx-server-sdk'] && existsSync(join(target, 'package-lock.json'))) {
    throw new Error('支付函数存在依赖锁文件，请先添加 wx-server-sdk 并更新锁文件');
  }
  packageJson.dependencies['wx-server-sdk'] ||= '~2.4.0';

  const merchant = JSON.parse(readFileSync(join(workspace, 'cloudfunctions/hlApi/payment-merchant-config.json'), 'utf8'));
  const changes = [
    { file: 'app.js', content: app },
    { file: 'services/payService.js', content: service },
    { file: 'package.json', content: JSON.stringify(packageJson, null, 2) + '\n' },
    { file: 'services/hl-member-merchant.json', content: JSON.stringify(merchant, null, 2) + '\n' },
    ...['hl-membership-bridge.js', 'hl-membership-routes.js'].map(filename => ({
      file: `services/${filename}`, content: readFileSync(join(workspace, 'integrations/wechat-pay', filename), 'utf8')
    }))
  ];
  for (const change of changes) {
    const taskTargetPath = join(target, change.file);
    if (existsSync(taskTargetPath) && lstatSync(taskTargetPath).isSymbolicLink()) throw new Error(`不更新符号链接：${change.file}`);
    const taskParentPath = realpathSync(dirname(taskTargetPath));
    if (relative(target, taskParentPath).startsWith('..')) throw new Error('写入路径越出支付函数目录');
  }
  return { target, functionName, merchant, changes };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log('Usage: node scripts/prepare-wechat-payment-integration.mjs --target <absolute function directory> --function-name <actual generated name> [--apply]');
    return;
  }
  const target = args[args.indexOf('--target') + 1];
  const functionName = args[args.indexOf('--function-name') + 1];
  if (!args.includes('--target') || !args.includes('--function-name') || !target || !isAbsolute(target)) {
    throw new Error('必须明确提供支付函数的绝对目录和实际函数名');
  }
  const result = prepareIntegration(target, functionName);
  if (args.includes('--apply')) {
    const originals = result.changes.map(change => {
      const taskPath = join(result.target, change.file);
      return { taskPath, content: existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : null };
    });
    try {
      for (const change of result.changes) writeFileSync(join(result.target, change.file), change.content, 'utf8');
    } catch (error) {
      // Restore existing files. New support files are harmless until app.js loads them.
      for (const original of originals) if (original.content !== null) writeFileSync(original.taskPath, original.content, 'utf8');
      throw error;
    }
  }
  console.log(JSON.stringify({
    applied: args.includes('--apply'), functionName: result.functionName,
    merchantId: result.merchant.merchantId, appId: result.merchant.appId,
    files: result.changes.map(change => change.file),
    createPath: '/hl-membership/create', queryPath: '/hl-membership/query',
    note: '仅准备/修改本地生成函数源码；不创建集成，不写入商户凭证，不部署。'
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
