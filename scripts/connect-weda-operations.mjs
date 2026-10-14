import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MARKER = '// HL_OPERATIONS_V1';
const S = '$page.dataset.state.ops';
const font = '"PingFang SC", "Microsoft YaHei", sans-serif';
const colors = { ink: '#2F2924', primary: '#A35D45', card: '#FFFDF9', border: '#E7DED3' };
const states = {
  matchmakers: [['', '全部审核状态'], ['0', '待审核'], ['1', '已拒绝'], ['2', '已通过']],
  certifications: [['', '全部状态'], ...[['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝'], ['revoked', '已撤销'], ['expired', '已过期'], ['unsubmitted', '未提交']]],
  salons: [['', '全部状态'], ['pending', '待审核'], ['upcoming', '待举办'], ['rejected', '已拒绝'], ['cancelled', '已取消'], ['ended', '已结束']],
  plans: [['', '全部套餐'], ['true', '已启用'], ['false', '已停用']],
  orders: [['', '全部状态'], ['pending', '待支付'], ['confirming', '确认中'], ['paid', '已支付'], ['closed', '已关闭'], ['failed', '失败'], ['refunded', '已退款']],
};
const val = (field, fallback = '') => `${S} ? ${S}.${field} : ${JSON.stringify(fallback)}`;
const box = (id, items, style = {}) => ({ id, component: 'Container', attributes: { style: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minWidth: '0px', ...style } }, items });
const text = (id, value, dynamic = false, style = {}) => ({ id, component: 'WdText', attributes: { [dynamic ? ':text' : 'text']: value, overflow: false, userSelect: true, style: { display: 'block', fontFamily: font, fontSize: '13px', lineHeight: '24px', color: colors.ink, margin: '0px', wordBreak: 'break-word', ...style } } });
function listener(pageId, command, data = {}, eventName = 'tap') {
  return [{ id: `${eventName}_${command}_${data.field || data.index || data.operation || data.value || 'default'}`, eventName, type: 'rematch', handler: { name: 'operations', module: pageId, params: { target: { command, ...data } } } }];
}
function button(pageId, id, label, command, data = {}, disabled = `${S} && ${S}.writing`, primary = false) {
  return { id, component: 'WdButton', attributes: { text: label, theme: primary ? 'primary' : 'secondary', variant: primary ? 'base' : 'outline', size: 'md', formType: 'button', ':disabled': disabled, class: `hl-button ${primary ? 'hl-primary' : 'hl-secondary'}`, style: { fontFamily: font, fontSize: '13px', lineHeight: '22px', padding: '8px 12px', height: 'auto', minHeight: '38px', whiteSpace: 'normal', color: primary ? '#FFF8ED' : colors.primary, backgroundColor: primary ? colors.primary : colors.card, border: `1px solid ${colors.border}`, borderRadius: '8px' } }, listeners: listener(pageId, command, data) };
}
function field(pageId, id, label, name, placeholder, visible) {
  const result = box(id, [text(id + 'Label', label), { id: id + 'Input', component: 'WdInput', attributes: { name, type: 'text', template: 'inputBox', labelVisible: false, maxLength: name === 'keyword' ? 80 : 500, clearable: true, placeholder, ':inputValue': val(name), ':status': `${S} && (${S}.writing || ${S}.confirmation) ? 'disabled' : 'edit'`, class: 'hl-input', style: { width: '100%', fontFamily: font, fontSize: '14px', lineHeight: '24px' } }, listeners: listener(pageId, 'edit', { field: name }, 'change') }], { gap: '5px', flex: '1 1 250px' });
  if (visible) result.directives = { ':if': visible };
  return result;
}
function choices(pageId, id, label, name, options, visible) {
  const current = name === 'source' ? 'sourceLabel' : name === 'financialAssetRange' ? 'assetRangeLabel' : name;
  const result = box(id, [text(id + 'Label', label), box(id + 'Buttons', options.map(([value, label], index) => button(pageId, id + 'Choice' + index, label, 'choose', { field: name, value }, `!${S} || !${S}.detail || ${S}.writing || ${S}.confirmation`)), { flexDirection: 'row', gap: '8px', flexWrap: 'wrap' }), text(id + 'Current', `${S} ? '当前选择：' + (${S}.${current} || '未选择') : '未选择'`, true)], { gap: '8px' });
  result.directives = { ':if': visible };
  return result;
}

export function operationsLifecycle(pageId) {
  if (!Object.hasOwn(states, pageId)) throw new Error('Unknown operations page');
  return `${MARKER}\n// Import directly: editor lifecycle receivers do not expose the page handler table.\nimport operations from './handler/operations';\nlet ownerPage;\n\nfunction initialize() {\n  const page = $page;\n  if (!page || page.id !== '${pageId}') throw new Error('管理页面上下文不匹配，请刷新页面');\n  ownerPage = page;\n  return operations({ lifecyclePage: page, data: { target: { command: 'init' } } });\n}\n\nfunction cleanup() {\n  // A page hidden before its load has no controller or private state to clear.\n  if (!ownerPage) return;\n  return operations({ cleanupPage: ownerPage, data: { target: { command: 'clear' } } });\n}\n\nexport default {\n  onPageLoad() { return initialize(); },\n  onPageShow() { return initialize(); },\n  onPageHide() { return cleanup(); },\n  onPageUnload() { return cleanup(); }\n};\n`;
}

export function connectOperations(original, runtimeCode) {
  runtimeCode = runtimeCode.replace(/\r\n/g, '\n');
  const app = structuredClone(original);
  if (app.name !== 'hl-admin-weda' || app.schemaVersion !== '4.0.0') throw new Error('Unexpected operations application');
  for (const pageId of Object.keys(states)) {
    const page = app.items.find(page => page.id === pageId && page.type === 'PAGE');
    if (!page) throw new Error('Missing page ' + pageId);
    const nodes = new Map();
    function index(node) { nodes.set(node.id, node); for (const child of node.items || []) index(child); }
    index(page);
    const get = id => { const node = nodes.get(id); if (!node) throw new Error(`Missing ${pageId}/${id}`); return node; };
    page.dataset ||= {};
    page.dataset.state ||= {};
    const definition = { varType: 'state', dataType: 'object', initialValue: null, label: '管理操作交互状态' };
    if (page.dataset.state.ops && !isDeepStrictEqual(page.dataset.state.ops, definition)) throw new Error('Existing ops variable differs');
    page.dataset.state.ops = definition;
    const lifecycle = operationsLifecycle(pageId);
    for (const resource of [
      { type: 'CODE', codeType: 'handler-fn', name: 'operations', path: `${pageId}/handler/operations`, code: MARKER + '\n' + runtimeCode },
      { type: 'CODE', codeType: 'lifecycle', name: 'lifecycle', path: `${pageId}/lifecycle`, code: lifecycle },
    ]) {
      page.resources ||= [];
      const previous = page.resources.find(item => item.path === resource.path || item.codeType === resource.codeType && item.name === resource.name);
      if (previous && !previous.code?.startsWith(MARKER)) throw new Error('Refuse to overwrite unrelated resource ' + resource.path);
      page.resources = page.resources.filter(item => item !== previous);
      page.resources.push(resource);
    }
    get('draftStatus').attributes.text = '受控管理操作';
    const notice=pageId==='orders'?'当前连接正式业务数据；本页提供订单查询和详情。':'当前连接正式业务数据；审核、取消和套餐启停将在确认提交后生效。';
    get('connectionNotice').items = [text('connectionNoticeCopy', `${S} && ${S}.error ? ${S}.error : (${S} && ${S}.message ? ${S}.message : '${notice}')`, true)];
    const listCard = get('listCard');
    const header = structuredClone(get('tableHeader'));
    let columnCount = header.items.length;
    if (pageId === 'orders' && !header.items.some(item => item.id === 'column7')) {
      header.items.push(box('column7', [text('columnLabel7', '操作')]));
      columnCount++;
    }
    if (pageId === 'orders') {
      const amount = header.items.find(item => item.id === 'column3')?.items?.[0];
      if (amount) amount.attributes.text = '订单金额（元）';
    }
    header.attributes.style.gridTemplateColumns = `repeat(${columnCount}, minmax(100px, 1fr))`;
    header.attributes.style.minWidth = columnCount * 110 + 'px';
    const readBusy = `!${S} || ${S}.loading || ${S}.writing`;
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const exists = `${S} && ${S}.rows.length > ${i}`;
      const cells = Array.from({ length: columnCount - 1 }, (_, column) => text(`opsRow${i}Cell${column}`, `${exists} && ${S}.rows[${i}].cells.length > ${column} ? ${S}.rows[${i}].cells[${column}] : '—'`, true));
      cells.push(button(pageId, `opsSelect${i}`, '选择 / 详情', 'select', { index: i }, `${readBusy} || !(${exists}) || !${S}.rows[${i}].key`));
      const row = box(`opsRow${i}`, cells, { display: 'grid', gridTemplateColumns: `repeat(${columnCount}, minmax(100px, 1fr))`, gap: '12px', minWidth: columnCount * 110 + 'px', padding: '12px', alignItems: 'center', borderBottom: `1px solid ${colors.border}` });
      row.directives = { ':if': exists };
      rows.push(row);
    }
    listCard.items = [
      box('filters', [
        field(pageId, 'keyword', '关键词', 'keyword', '输入关键词后点击查询'),
        box('filterActions', [button(pageId, 'queryButton', '查询', 'query', {}, readBusy, true), button(pageId, 'refreshButton', '重置', 'reset', {}, readBusy)], { flexDirection: 'row', flexWrap: 'wrap', gap: '10px' }),
      ], { flexDirection: 'row', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-end' }),
      box('status', [text('statusLabel', '状态筛选（点击即查询）'), box('statusChoices', states[pageId].map(([value, label], index) => button(pageId, `opsStatus${index}`, label, 'filter', { value }, readBusy)), { flexDirection: 'row', gap: '8px', flexWrap: 'wrap' }), text('opsSelectedFilter', `${S} ? '当前状态：' + (${S}.filter || '全部') : '当前状态：全部'`, true)], { gap: '8px', marginTop: '16px', marginBottom: '20px' }),
      box('tableScroll', [header, ...rows], { overflowX: 'auto', maxWidth: '100%' }),
      { ...box('emptyRecords', [text('emptyTitle', `${S} && ${S}.loading ? '正在加载…' : (${S} && ${S}.error ? '记录未取得' : '暂无符合条件的记录')`, true), text('emptyDescription', '没有加载成功时不显示演示记录；请检查权限或调整筛选。')], { padding: '30px 10px', alignItems: 'center' }), directives: { ':if': `!${S} || !${S}.rows.length` } },
      box('tableFooter', [text('recordCount', val('totalText', '记录数 —'), true), text('paginationPending', val('pageText', '第1页'), true), button(pageId, 'opsPrevious', '上一页', 'previous', {}, `${readBusy} || !${S}.hasPrevious`), button(pageId, 'opsNext', '下一页', 'next', {}, `${readBusy} || !${S}.hasNext`)], { flexDirection: 'row', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginTop: '18px' }),
    ];
    const selected = `${S} && ${S}.detail`;
    const actions = [button(pageId, 'operation0', pageId === 'certifications' ? '查看申请 / 材料' : pageId === 'orders' ? '查看订单详情' : pageId === 'plans' ? '查看套餐' : '查看资料', 'detail', {}, `!${S} || !${S}.selected || ${S}.detailLoading || ${S}.writing`)];
    if (['matchmakers', 'certifications', 'salons'].includes(pageId)) actions.push(button(pageId, 'operation1', '审核通过', 'prepare', { operation: 'approve' }, `!${S} || !${S}.canApprove || ${S}.writing`, true), button(pageId, 'operation2', '拒绝申请', 'prepare', { operation: 'reject' }, `!${S} || !${S}.canReject || ${S}.writing`));
    if (pageId === 'salons') actions.push(button(pageId, 'operation3', '取消沙龙', 'prepare', { operation: 'cancel' }, `!${S} || !${S}.canCancel || ${S}.writing`));
    if (pageId === 'certifications') actions.push(button(pageId, 'operation3', '撤销认证', 'prepare', { operation: 'revoke' }, `!${S} || !${S}.canRevoke || ${S}.writing`));
    if (pageId === 'plans') actions.push(button(pageId, 'operation2', '启用 / 停用', 'prepare', { operation: 'toggle' }, `!${S} || !${S}.canToggle || ${S}.writing`, true));
    const detailFields = [];
    if (pageId !== 'orders' && pageId !== 'plans') detailFields.push(field(pageId, 'opsRemark', '内部审核备注 / 沙龙取消原因（拒绝前必填原因）', 'remark', '仅本地草稿，确认后才提交', selected));
    if (pageId === 'certifications') detailFields.push(
      field(pageId, 'opsFeedback', '给申请人看的反馈 / 拒绝原因（拒绝必填）', 'feedback', '将给申请人展示，勿填内部信息', selected),
      { ...text('opsFixedSource', `${S} ? '核验来源：' + (${S}.sourceLabel || '未选择') : '核验来源待选择'`, true), directives: { ':if': selected } },
      choices(pageId, 'opsEducationSource', '选择学历核验来源', 'source', [['chsi', '学信网'], ['cscse', '留服认证']], `${selected} && ${S}.selected.kind === 'education'`),
      choices(pageId, 'opsAssetsSource', '选择资产核验来源', 'source', [['bank_statement', '银行证明'], ['securities_statement', '证券证明'], ['insurance_statement', '保险现金价值'], ['combined_financial_statement', '综合证明']], `${selected} && ${S}.selected.kind === 'assets'`),
      field(pageId, 'opsEvidenceReference', '核验引用（通过必填，勿填完整证件号）', 'evidenceReference', '核验凭据的可审计引用', selected),
      choices(pageId, 'opsEducationLevel', '选择核验学历', 'educationLevel', [['本科', '本科'], ['硕士', '硕士'], ['博士', '博士']], `${selected} && ${S}.selected.kind === 'education'`),
      choices(pageId, 'opsAssetRange', '选择已核验的资产档位', 'financialAssetRange', [['under_500k', '50万以下'], ['500k_2m', '50万–200万'], ['2m_5m', '200万–500万'], ['5m_10m', '500万–1000万'], ['over_10m', '1000万以上']], `${selected} && ${S}.selected.kind === 'assets'`),
      button(pageId, 'opsEvidence', '查看核验信息（敏感）', 'evidence', {}, `!${S} || !${S}.detail || ${S}.writing || ${S}.evidenceLoading`),
      text('opsEvidenceText', val('evidenceText'), true, { whiteSpace: 'pre-wrap' }),
    );
    const materials = pageId === 'certifications' ? [
      ...Array.from({ length: 10 }, (_, index) => { const b = button(pageId, `opsMaterial${index}`, '查看选中材料', 'material', { index }, `!${S} || !${S}.detail || ${S}.writing`); b.attributes[':text'] = `${S} && ${S}.materials.length > ${index} ? ${S}.materials[${index}].label : '材料'`; b.directives = { ':if': `${S} && ${S}.materials.length > ${index}` }; return b; }),
      { id: 'opsMaterialImage', component: 'WdImage', attributes: { ':src': `${S} && ${S}.material ? ${S}.material.src : ''`, fit: 'contain', imgPreview: false, alt: '仅当前申请的受控材料', style: { width: '100%', maxHeight: '600px' } }, directives: { ':if': `${S} && ${S}.material && !${S}.material.pdf` } },
      { ...button(pageId, 'opsOpenPdf', '查看当前PDF（新窗口）', 'openPdf'), directives: { ':if': `${S} && ${S}.material && ${S}.material.pdf` } },
      { ...button(pageId, 'opsDownloadPdf', '下载当前PDF', 'downloadPdf'), directives: { ':if': `${S} && ${S}.material && ${S}.material.pdf` } },
      { ...button(pageId, 'opsCloseMaterial', '关闭并清除材料 / 核验信息', 'closeMaterial'), directives: { ':if': `${S} && (${S}.material || ${S}.evidenceText || ${S}.evidenceLoading)` } },
    ] : [];
    const confirmation = box('opsConfirmation', [text('opsConfirmationTitle', '二次确认 · 尚未提交', false, { fontWeight: 700 }), text('opsConfirmationText', `${S} && ${S}.confirmation ? ${S}.confirmation.summary : ''`, true, { whiteSpace: 'pre-wrap' }), box('opsConfirmActions', [button(pageId, 'opsConfirm', '确认提交', 'submit', {}, `!${S} || !${S}.confirmation || ${S}.writing`, true), button(pageId, 'opsCancelConfirm', '返回修改 / 取消', 'cancelConfirmation')], { flexDirection: 'row', gap: '10px', flexWrap: 'wrap' })], { gap: '12px', padding: '18px', border: '2px solid #A35D45', borderRadius: '8px', backgroundColor: '#F1E5DC' });
    confirmation.directives = { ':if': `${S} && ${S}.confirmation` };
    get('operationPanel').items = [
      text('operationHeading', pageId === 'orders' ? '订单详情（只读）' : '记录处理', false, { fontSize: '18px', lineHeight: '28px', fontWeight: 700 }),
      text('operationNote', pageId==='orders'?'选择一条订单查看支付与履约详情；本页不提供退款或手工履约。':pageId === 'plans' ? '固定价格由微信虚拟商品规则约束，此处只开放查看和启停，不影响已购买权益或已有订单。' : '先选择一条记录取得最新版本；所有审核仅在二次确认后提交。'),
      box('operationButtons', actions, { flexDirection: 'row', flexWrap: 'wrap', gap: '10px' }),
      text('opsDetailStatus', `${S} && ${S}.detailLoading ? '正在读取最新详情…' : (${S} && ${S}.detail ? '已读取最新详情' : '请先选择记录')`, true),
      text('opsDetailText', val('detailText'), true, { whiteSpace: 'pre-wrap' }), ...detailFields, ...materials, confirmation,
    ];
    get('operationPanel').attributes.style = { ...get('operationPanel').attributes.style, flexDirection: 'column', alignItems: 'stretch', gap: '16px' };
  }
  if (!isDeepStrictEqual(app.items.find(page => page.id === 'overview'), original.items.find(page => page.id === 'overview')) || !isDeepStrictEqual(app.templates, original.templates) || !isDeepStrictEqual(app.extra, original.extra)) throw new Error('Unexpected overview or application layout changes');
  return app;
}

async function main() {
  const args = process.argv.slice(2);
  const input = resolve(ROOT, 'weda-admin/app.cals.json');
  const app = connectOperations(JSON.parse(await readFile(input, 'utf8')), await readFile(resolve(ROOT, 'weda-admin/operations-runtime.js'), 'utf8'));
  if (args.includes('--write')) await writeFile(input, JSON.stringify(app, null, 2) + '\n');
  console.log(JSON.stringify({ mode: args.includes('--write') ? 'local-file-written' : 'check-only', pages: Object.keys(states), function: 'hlAdminOperations', overviewPreserved: true, cloudWritten: false, priceEditingAllowed: false, generatedPages: app.items.length }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
