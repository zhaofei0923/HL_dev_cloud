import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

// Uses the official MCP SDK's existing login; never reads credential files.
// Only this existing application's design history is writable. No create/publish API.
const ENV_ID = 'cloud1-d2gza7q9c8d69c721';
const REGION = 'ap-shanghai';
const APP_ID = 'app-pq2auygx';
const APP_NAME = 'hl-admin-weda';
const APP_TITLE = 'HL运营管理后台';
const [sdkFile, mode = 'inspect'] = process.argv.slice(2);
if (!sdkFile || !['inspect', 'backup', 'save', 'verify'].includes(mode)) {
  console.error('Usage: node scripts/weda-admin-draft.mjs <official-MCP-dist/index.cjs> [inspect|backup|save|verify]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'weda-admin/app.cals.json');
const evidence = resolve(root, 'output/weda-admin-draft-20261013.json');
const baselineFile = resolve(root, 'output/weda-admin-redesign-baseline.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
let phase = 'initialize';

function payload(result) {
  const value = result?.Response ?? result;
  if (!value || value.Error) throw new Error('Cloud API did not succeed');
  return value;
}
function appId(value) { return value?.Id ?? value?.id ?? value?.WeAppId ?? value?.weAppId; }
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid application/history ID');
  return value;
}
function safeHistoryId(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid history ID');
  return number;
}
function parseJson(value) { return typeof value === 'string' ? (value.trim() ? JSON.parse(value) : undefined) : value; }

try {
  const { getCloudBaseManager } = createRequire(import.meta.url)(resolve(sdkFile));
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: ENV_ID, region: REGION, site: 'domestic' }, authStrategy: 'fail_fast' });
  const call = async (Action, Param) => { phase = Action; return payload(await manager.commonService('lowcode').call({ Action, Param })); };
  const fetchHistory = async (id, historyId) => {
    const signed = await call('DescribeAppHistoryPreSignUrl', { HttpMethod: 'get', WeAppsId: id, HisIds: [historyId] });
    const entry = signed.Data?.[0];
    const url = entry?.DownloadUrl || entry?.downloadUrl || entry?.UploadUrl || entry?.uploadUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('History read-back unavailable');
    phase = 'fetch-history';
    const fetched = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!fetched.ok) throw new Error('History read-back failed');
    return parseJson(await fetched.text());
  };
  const listed = await call('DescribeApps', { EnvId: ENV_ID, Limit: 100, Offset: 0 });
  const apps = listed.Weapps ?? listed.WeApps ?? listed.Data?.Weapps ?? listed.Data?.WeApps;
  if (!Array.isArray(apps)) throw new Error('Unrecognized application listing');
  const summary = {
    envId: ENV_ID, region: REGION, capturedAt: new Date().toISOString(),
    appCount: listed.Count ?? listed.Data?.Count ?? apps.length,
    listRequestId: listed.RequestId,
    apps: apps.map(app => ({ id: appId(app), name: app.Name ?? app.name, title: app.Title ?? app.title }))
  };
  if (mode === 'inspect') {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    if (summary.appCount > apps.length) throw new Error('Incomplete application listing; fixed application lookup unavailable');
    const cals = JSON.parse(await readFile(source, 'utf8'));
    if (cals.name !== APP_NAME || cals.label !== APP_TITLE || cals.schemaVersion !== '4.0.0'
      || cals.items.filter(item => item.type === 'PAGE').length !== 6) throw new Error('Unexpected draft source');
    const overview = cals.items.find(item => item.id === 'overview' && item.type === 'PAGE');
    const cockpitHandler = overview?.resources?.find(resource => resource.type === 'CODE'
      && resource.codeType === 'handler-fn' && resource.path === 'overview/handler/loadCockpit');
    const handlerCode = cockpitHandler?.code;
    // This is evidence of the reviewed CALS connection only. Saving/read-back
    // does not prove a successful browser request or server authorization.
    const businessApiConnected = typeof handlerCode === 'string'
      && handlerCode.startsWith('// HL_COCKPIT_READONLY_V1\n')
      && (handlerCode.match(/\bcallFunction\s*\(/g) || []).length === 1
      && /\$w\.cloud\.callFunction\s*\(\s*\{\s*name\s*:\s*(['"])hlAdminCockpit\1\s*,/.test(handlerCode);
    const connectedFunction = businessApiConnected ? 'hlAdminCockpit' : null;
    let known;
    try { known = JSON.parse(await readFile(evidence, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (known && (known.envId !== ENV_ID || known.region !== REGION || known.name !== APP_NAME)) {
      throw new Error('Recovery state belongs to another draft');
    }
    if (known?.appId !== undefined && known.appId !== APP_ID) throw new Error('Recovery state application ID differs from fixed application');
    // Local evidence can be absent in a fresh checkout. Always locate the fixed
    // ID in the current cloud listing; never recover by a name or create an app.
    const matching = apps.filter(app => appId(app) === APP_ID);
    if (matching.length !== 1) throw new Error('Fixed application ID was not uniquely found in current cloud listing');
    const id = safeId(appId(matching[0]));
    const detail = await call('DescribeAppDetail', { WeAppId: id, Name: id, EnvId: ENV_ID });
    const metadata = detail.Data;
    if (!metadata || safeId(appId(metadata)) !== id) throw new Error('Draft ownership check failed');
    const detailName = metadata.Name ?? metadata.name;
    const detailEnv = metadata.EnvId ?? metadata.envId ?? metadata.EnvironmentInformation?.EnvironmentId;
    if (![APP_NAME, id].includes(detailName) || detailEnv !== ENV_ID
      || (metadata.Title ?? metadata.title) !== APP_TITLE) throw new Error('Draft ownership check failed');
    const latest = parseJson(metadata.LatestHistory ?? metadata.latestHistory);
    const latestId = latest?.id ?? latest?.Id;
    if (mode === 'backup') {
      const historyId = safeHistoryId(latestId);
      const content = await fetchHistory(id, historyId);
      const backupPath = resolve(root, `output/weda-admin-before-redesign-${historyId}.json`);
      await mkdir(resolve(root, 'output'), { recursive: true });
      await writeFile(backupPath, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
      await writeFile(baselineFile, JSON.stringify({ appId: id, envId: ENV_ID, historyId,
        capturedAt: new Date().toISOString(), sourceSha256: sha256(JSON.stringify(content)), backupPath }, null, 2) + '\n');
      console.log(JSON.stringify({ appId: id, historyId, backupPath, matchesLocal: isDeepStrictEqual(content, cals) }, null, 2));
      process.exit(0);
    }
    let saveRequestId = known?.saveRequestId;
    if (mode === 'save') {
      if (latestId) {
        const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
        if (baseline.appId !== id || baseline.envId !== ENV_ID || baseline.historyId !== safeHistoryId(latestId)) {
          throw new Error('Cloud draft changed since backup; preserve concurrent edits');
        }
      }
      const saveParams = { WeAppId: id, HistoryContent: JSON.stringify(cals), Comment: businessApiConnected
        ? '运营驾驶舱接入 hlAdminCockpit 只读真实统计；会员、主理人与经营收款分析；未发布'
        : '运营驾驶舱界面设计；业务统计尚未接入；未发布' };
      if (latest?.id ?? latest?.Id) saveParams.CommitBaseline = safeHistoryId(latest.id ?? latest.Id);
      else saveParams.IsFirstCommit = true;
      const saved = await call('UpdateWeAppContentByAppId', saveParams);
      saveRequestId = saved.RequestId;
      await mkdir(resolve(root, 'output'), { recursive: true });
      await writeFile(evidence, JSON.stringify({ ...summary, appId: id, name: APP_NAME,
        createdRequestId: known?.createdRequestId, saveRequestId, status: 'design-saved-awaiting-readback', published: false,
        businessApiConnected, connectedFunction, browserPreviewVerified: false }, null, 2) + '\n');
    }
    const history = await call('DescribeHistoryListByAppId', { PageNum: 1, PageSize: 1, WeAppId: id });
    const histories = history.Data?.List ?? history.Data?.list;
    if (!Array.isArray(histories) || !histories.length) throw new Error('Saved history not found');
    const historyId = safeHistoryId(appId(histories[0]));
    // The presigned URL is used in memory only, never printed or saved.
    const readback = await fetchHistory(id, historyId);
    phase = 'compare-history';
    if (!isDeepStrictEqual(readback, cals)) throw new Error('History differs from local design');
    const record = { ...summary, appId: id, name: APP_NAME, cloudAppName: detailName, title: APP_TITLE,
      createdRequestId: known?.createdRequestId, saveRequestId, historyRequestId: history.RequestId, historyId,
      sourceSha256: sha256(JSON.stringify(cals)), pageIds: cals.items.filter(item => item.type === 'PAGE').map(item => item.id),
      status: 'design-saved-and-readback-verified', published: false, businessApiConnected, connectedFunction,
      browserPreviewVerified: false,
      verificationScope: 'design-history-readback-only',
      lastDeployTime: metadata.LastDeployTime, lastWebCiStatus: metadata.LastWebCiStatus,
      consoleUrl: `https://tcb.cloud.tencent.com/dev?envId=${ENV_ID}#/lowcode/apps` };
    await mkdir(resolve(root, 'output'), { recursive: true });
    await writeFile(evidence, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record, null, 2));
  }
} catch (error) {
  // SDK errors may contain signed requests or credentials. Keep diagnostics bounded.
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : 'DRAFT_OPERATION_FAILED';
  const safeReasons = ['History read-back unavailable', 'History read-back failed', 'History differs from local design',
    'Saved history not found', 'Invalid history ID', 'Draft ownership check failed',
    'Cloud draft changed since backup; preserve concurrent edits',
    'Incomplete application listing; fixed application lookup unavailable',
    'Recovery state application ID differs from fixed application',
    'Fixed application ID was not uniquely found in current cloud listing'];
  console.error(JSON.stringify({ code, phase, reason: safeReasons.includes(error?.message) ? error.message : undefined,
    message: '微搭设计稿操作未完成；未输出凭据或签名地址。' }));
  process.exitCode = 1;
}
