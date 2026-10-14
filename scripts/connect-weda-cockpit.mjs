import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MARKER = '// HL_COCKPIT_READONLY_V1';
const STATE = '$page.dataset.state';
const VIEW = `${STATE}.cockpit`;
const COLORS = ['#A35D45', '#4C6C5E', '#B98A62', '#8C7970', '#8D9C88', '#BD9D83'];
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';

function value(path, fallback = '—') {
  return `${VIEW} ? ${VIEW}.${path} : ${JSON.stringify(fallback)}`;
}

function textNode(id, expression, style = {}) {
  return { id, component: 'WdText', attributes: { ':text': expression, overflow: false, userSelect: true, style: { display: 'block', margin: '0px', fontFamily: FONT, fontSize: '12px', lineHeight: '22px', color: '#2F2924', wordBreak: 'break-word', ...style } } };
}

function rowNode(id, items, columns) {
  return { id, component: 'Container', attributes: { style: { boxSizing: 'border-box', display: 'grid', gridTemplateColumns: columns, gap: '12px', alignItems: 'center', padding: '12px 14px', minWidth: '490px', borderBottom: '1px solid #E7DED3' } }, items };
}

export function connectCockpit(original, runtimeCode) {
  runtimeCode = runtimeCode.replace(/\r\n/g, '\n');
  const app = structuredClone(original);
  if (app.name !== 'hl-admin-weda' || app.schemaVersion !== '4.0.0') throw new Error('Unexpected Weda application');
  const page = app.items?.find(item => item.id === 'overview' && item.type === 'PAGE');
  if (!page) throw new Error('Missing overview page');
  const nodes = new Map();
  function index(node) {
    if (nodes.has(node.id)) throw new Error(`Duplicate overview node ${node.id}`);
    nodes.set(node.id, node);
    for (const child of node.items || []) index(child);
  }
  index(page);
  const get = id => { const node = nodes.get(id); if (!node) throw new Error(`Missing cockpit node ${id}`); return node; };
  function bind(id, attribute, expression) {
    const node = get(id);
    node.attributes ||= {};
    delete node.attributes[attribute];
    node.attributes[`:${attribute}`] = expression;
  }
  function show(id, expression) {
    get(id).directives = { ...get(id).directives, ':if': expression };
  }
  function setText(id, text) {
    const node = get(id);
    delete node.attributes[':text'];
    node.attributes.text = text;
  }
  page.dataset ||= {};
  page.dataset.state ||= {};
  const definitions = {
    cockpit: { label: '只读经营统计', varType: 'state', dataType: 'object', initialValue: null },
    loading: { label: '统计加载中', varType: 'state', dataType: 'boolean', initialValue: true },
    error: { label: '统计加载错误', varType: 'state', dataType: 'string', initialValue: '' },
  };
  for (const [key, definition] of Object.entries(definitions)) {
    const old = page.dataset.state[key];
    if (old && !isDeepStrictEqual(old, definition)) throw new Error(`Refuse to replace existing page variable ${key}`);
    page.dataset.state[key] = definition;
  }
  const lifecycle = `${MARKER}\nexport default {\n  onPageLoad() {\n    return $w.page.handler.loadCockpit();\n  }\n};\n`;
  const additions = [
    { type: 'CODE', codeType: 'handler-fn', name: 'loadCockpit', path: 'overview/handler/loadCockpit', code: `${MARKER}\n${runtimeCode}` },
    { type: 'CODE', codeType: 'lifecycle', name: 'lifecycle', path: 'overview/lifecycle', code: lifecycle },
  ];
  page.resources ||= [];
  for (const resource of additions) {
    const old = page.resources.find(item => item.path === resource.path || item.codeType === resource.codeType && item.name === resource.name);
    if (old && !old.code?.startsWith(MARKER)) throw new Error(`Refuse to overwrite existing page resource ${resource.path}`);
    page.resources = page.resources.filter(item => item !== old);
    page.resources.push(resource);
  }
  for (let i = 0; i < 6; i++) bind(`cockpitMetricValue${i}`, 'text', value(`metrics[${i}]`));
  ['memberVip', 'memberOrdinary', 'memberVerified', 'memberPublic'].forEach((id, i) => bind(`${id}Value`, 'text', value(`memberCounts[${i}]`)));
  for (let i = 0; i < 3; i++) bind(`matchmakerHealthValue${i}`, 'text', value(`matchmakerCounts[${i}]`));
  bind('cockpitPeriod', 'text', value('periodLabel', '统计周期 · 近30天'));
  bind('cockpitUpdateText', 'text', `${STATE}.loading ? '正在加载经营统计…' : ${STATE}.error ? ${STATE}.error : (${VIEW} ? ${VIEW}.updatedLabel : '尚未加载经营统计')`);
  bind('cockpitDataNote', 'text', `${STATE}.error ? '统计未取得，所有指标显示 —，不代表零。' : (${VIEW} ? ${VIEW}.qualityText : '统计加载中；所有 — 均表示尚未取得数据。')`);
  setText('draftStatus', '只读经营统计');
  setText('memberGrowthDetail', '按当前有效档案的首次建档日期回算，不代表历史每日在册人数。');
  setText('memberGrowthLegend1Label', '累计建档');
  bind('memberGrowthAxisStart', 'text', `${VIEW} ? '近' + ${VIEW}.periodDays + '天' : '近30天'`);
  bind('revenueTrendAxisStart', 'text', `${VIEW} ? '近' + ${VIEW}.periodDays + '天' : '近30天'`);
  bind('memberGrowthChart', 'datasourceVariable', value('memberTrend', []));
  bind('revenueTrendChart', 'datasourceVariable', value('revenueTrend', []));
  get('memberGrowthChart').attributes.setColor = [COLORS[0], COLORS[1]];
  get('revenueTrendChart').attributes.setColor = [COLORS[0], COLORS[2], COLORS[1]];
  for (const [prefix, field, title] of [['memberGrowth', 'hasMemberTrend', 'memberEmptyTitle'], ['revenueTrend', 'hasRevenueTrend', 'revenueEmptyTitle']]) {
    show(`${prefix}Empty`, `!(${VIEW} && ${VIEW}.${field})`);
    bind(`${prefix}EmptyTitle`, 'text', `${STATE}.loading ? '正在加载统计…' : (${VIEW} ? ${VIEW}.${title} : '统计暂不可用')`);
    bind(`${prefix}EmptyCopy`, 'text', `${STATE}.error ? ${STATE}.error : '未知值不记为零，缺失日期保留为空缺。'`);
  }
  bind('revenueMixChart', 'datasourceVariable', value('productPie', []));
  bind('revenueMixChart', 'setColor', value('productColors', COLORS));
  show('revenueMixEmptyRing', `!(${VIEW} && ${VIEW}.hasProductPie)`);
  bind('revenueMixEmptyLabel', 'text', `${STATE}.loading ? '加载中' : (${VIEW} ? ${VIEW}.mixEmptyLabel : '占比暂不可统计')`);
  // Show individual order-snapshot products, not guessed membership categories.
  const mixPanel = get('revenueMixPanel');
  mixPanel.items = mixPanel.items.filter(item => !/^revenueMixRow\d+$/.test(item.id));
  const mixRows = [];
  for (let i = 0; i < 10; i++) {
    const item = `${VIEW}.mixRows[${i}]`;
    const exists = `${VIEW} && ${VIEW}.mixRows.length > ${i}`;
    const row = rowNode(`revenueMixRow${i}`, [
      { id: `cockpitMixName${i}`, component: 'Container', attributes: { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '7px', minWidth: '0px' } }, items: [
        { id: `cockpitMixDot${i}`, component: 'Container', attributes: { style: { width: '7px', height: '7px', flexShrink: 0, borderRadius: '50%', backgroundColor: COLORS[i % COLORS.length] } }, items: [] },
        textNode(`cockpitMixTitle${i}`, `${exists} ? ${item}.title : '—'`),
      ] },
      textNode(`cockpitMixAmount${i}`, `${exists} ? ${item}.amount : '—'`, { fontWeight: 600 }),
      textNode(`cockpitMixShare${i}`, `${exists} ? ${item}.share : '— %'`, { color: '#736256' }),
    ], 'minmax(0, 1fr) auto auto');
    row.attributes.style.minWidth = '0px';
    row.attributes.style.gap = '8px';
    row.attributes.style.padding = '10px 0px';
    row.directives = { ':if': exists };
    mixRows.push(row);
  }
  const mixFootnote = mixPanel.items.findIndex(item => item.id === 'revenueMixFootnote');
  mixPanel.items.splice(mixFootnote < 0 ? mixPanel.items.length : mixFootnote, 0, ...mixRows);
  const scroll = get('matchmakerRankScroll');
  scroll.items = scroll.items.filter(item => !/^cockpitRankRow\d+$/.test(item.id));
  for (let i = 0; i < 10; i++) {
    const item = `${VIEW}.ranking[${i}]`;
    const exists = `${VIEW} && ${VIEW}.ranking.length > ${i}`;
    const row = rowNode(`cockpitRankRow${i}`, ['name', 'city', 'memberCount', 'newAssignments'].map((key, column) => textNode(`cockpitRank${i}Cell${column}`, `${exists} ? ${item}.${key} : '—'`)), '1.25fr 1fr 1fr 1.2fr');
    row.directives = { ':if': exists };
    scroll.items.push(row);
  }
  bind('matchmakerRankColumn3', 'text', `${VIEW} ? '近' + ${VIEW}.periodDays + '天新增归属' : '近30天新增归属'`);
  show('matchmakerRankEmpty', `!(${VIEW} && ${VIEW}.hasRanking)`);
  bind('matchmakerRankEmptyTitle', 'text', `${STATE}.loading ? '正在加载主理人分析…' : (${VIEW} ? ${VIEW}.rankingEmptyTitle : '主理人分析暂不可用')`);
  bind('matchmakerRankEmptyCopy', 'text', `${STATE}.error ? ${STATE}.error : '仅展示认证通过主理人，姓名已脱敏，最多10位。'`);
  bind('cockpitEntryDetail0', 'text', value('pendingMatchmakers', '待审核 —'));
  setText('cockpitEntryDetail1', '认证申请管理');
  setText('cockpitEntryDetail2', '沙龙申请管理');
  for (const originalPage of original.items) if (originalPage.id !== 'overview' && !isDeepStrictEqual(app.items.find(item => item.id === originalPage.id), originalPage)) throw new Error('Unexpected change outside overview');
  if (!isDeepStrictEqual(app.templates, original.templates) || !isDeepStrictEqual(app.extra, original.extra)) throw new Error('Unexpected application configuration change');
  return app;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const input = resolve(ROOT, option('--input') || 'weda-admin/app.cals.json');
  const output = option('--output');
  const original = JSON.parse(await readFile(input, 'utf8'));
  const runtimeCode = await readFile(resolve(ROOT, 'weda-admin/cockpit-runtime.js'), 'utf8');
  const connected = connectCockpit(original, runtimeCode);
  if (args.includes('--write') || output) await writeFile(output ? resolve(ROOT, output) : input, JSON.stringify(connected, null, 2) + '\n');
  console.log(JSON.stringify({ mode: args.includes('--write') || output ? 'local-file-written' : 'check-only', input, output: output ? resolve(ROOT, output) : args.includes('--write') ? input : null, functionName: 'hlAdminCockpit', page: 'overview', lifecycle: 'onPageLoad', variables: ['cockpit', 'loading', 'error'], otherPagesUnchanged: true, cloudWritten: false }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
