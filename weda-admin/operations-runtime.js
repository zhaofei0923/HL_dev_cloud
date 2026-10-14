// Native Weda handler. Only the server determines actor identity and permission.
const PAGES = ['matchmakers', 'certifications', 'salons', 'plans', 'orders'];
// The editor evaluates lifecycle and handler resources as separate modules.
// Store their shared controller on the owning page, outside serialized state.
const CONTROLLER_KEY = Symbol.for('hl.admin.operations.controller');
const CONTROLLER_VERSION = 'hl-admin-operations-runtime-v2';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const display = value => value === null || value === undefined || value === '' ? '—' : String(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—';
const money = value => Number.isSafeInteger(value) && value >= 0 ? (value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝', revoked: '已撤销', expired: '已过期', unsubmitted: '未提交', upcoming: '待举办', cancelled: '已取消', ended: '已结束', confirming: '确认中', paid: '已支付', closed: '已关闭', failed: '失败', refunded: '已退款', fulfilled: '已履约', requires_review: '待核查' };
const KIND = { identity: '身份认证', education: '学历认证', vehicle: '车辆认证', property: '房产认证', assets: '资产认证' };
const SOURCE = { identity_document: '身份证明', chsi: '学信网', cscse: '留服认证', vehicle_license: '车辆行驶证', property_certificate: '房产证明', bank_statement: '银行证明', securities_statement: '证券证明', insurance_statement: '保险现金价值', combined_financial_statement: '综合证明' };
const ASSET_RANGE = { under_500k: '50万以下', '500k_2m': '50万–200万', '2m_5m': '200万–500万', '5m_10m': '500万–1000万', over_10m: '1000万以上' };
const status = value => STATUS[value] || display(value);
const orderStatus = value => value === 'pending' ? '待支付' : status(value);

export function amountYuanToFen(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, decimal = ''] = text.split('.');
  const fen = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(fen) && fen > 0 && fen <= 100000000 ? fen : null;
}

export function recordKey(pageId, row) {
  if (!object(row)) return null;
  if (pageId === 'certifications') return row.userId !== undefined && KIND[row.kind] && string(row.applicationId, 200)
    ? { userId: row.userId, kind: row.kind, applicationId: row.applicationId } : null;
  if (pageId === 'plans') return string(row.planCode || row.code, 100) ? { planCode: row.planCode || row.code } : null;
  if (pageId === 'orders') return string(row.outTradeNo, 100) ? { outTradeNo: row.outTradeNo } : null;
  return row.id !== undefined && row.id !== null ? { id: row.id } : null;
}

export function rowCells(pageId, row) {
  if (pageId === 'matchmakers') return [display(row.user?.nickname), display(row.matchmakerNo), display(row.city), count(row.memberCount), display(row.createdAt), ({ 0: '待认证', 1: '已拒绝', 2: '已认证' })[row.certificationStatus] || '—'];
  if (pageId === 'certifications') return [display(row.user?.nickname), KIND[row.kind] || '—', display(row.applicationId), display(row.submittedAt), status(row.status) + (row.verified === true ? ' / 当前有效' : '')];
  if (pageId === 'salons') return [display(row.title), display(row.organizer?.nickname), display(row.location), display(row.eventDate), count(row.currentParticipants), status(row.status)];
  if (pageId === 'plans') return [display(row.title), display(row.planCode || row.code), money(row.amountFen), row.durationDays == null ? '—' : row.durationDays + ' 天', row.active === true ? '启用' : row.active === false ? '停用' : '—', display(row.updatedAt)];
  return [display(row.outTradeNo), display(row.user?.nickname || row.userId), display(row.planTitle || row.planCode), money(row.amountFen), orderStatus(row.status), status(row.fulfillmentStatus), display(row.createdAt)];
}

function initial(pageId) {
  return { pageId, keyword: '', filter: '', rows: [], total: null, page: 1, pageSize: 10, totalText: '记录数 —', pageText: '第1页', hasPrevious: false, hasNext: false,
    loading: false, detailLoading: false, writing: false, error: '', message: '', selected: null, detail: null, detailText: '', materials: [], material: null, evidenceText: '', evidenceLoading: false,
    remark: '', feedback: '', source: '', sourceLabel: '', educationLevel: '', financialAssetRange: '', assetRangeLabel: '', evidenceReference: '', confirmation: null, canApprove: false, canReject: false, canRevoke: false, canCancel: false, canToggle: false };
}
function publish(ctx, patch) {
  ctx.model = { ...ctx.model, ...patch };
  ctx.page.setState({ ops: ctx.model });
}
function controllerAnchor(page) {
  try { return object(page) ? page[CONTROLLER_KEY] : null; } catch { return null; }
}
function controllerShape(capsule, page) {
  try {
    return object(capsule) && capsule.pageId === page.id && object(capsule.ctx)
      && capsule.ctx.capsule === capsule && typeof capsule.version === 'string'
      && typeof capsule.token === 'symbol' && typeof capsule.dispose === 'function';
  } catch { return false; }
}
export function getOperationsController(page) {
  const capsule = controllerAnchor(page);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(page, CONTROLLER_KEY);
    return controllerShape(capsule, page) && capsule.version === CONTROLLER_VERSION
      && descriptor?.value === capsule && descriptor.enumerable === false && descriptor.configurable === true
      ? capsule : null;
  } catch { return null; }
}
function eraseModel(model, replacement) {
  if (!object(model)) return;
  for (const key of Object.keys(model)) {
    if (!Object.hasOwn(replacement, key)) { try { delete model[key]; } catch {} }
  }
  // Existing published references must lose private fields before setState,
  // including when a hidden page's state setter is no longer callable.
  for (const [key, value] of Object.entries(replacement)) { try { model[key] = value; } catch {} }
}
function unavailable(page) {
  try { page.setState({ ops: { ...initial(page.id), error: '管理页面尚未正确初始化，请刷新页面后重试。' } }); } catch {}
}
function initializeController(page) {
  const previous = controllerAnchor(page);
  if (controllerShape(previous, page)) {
    try { previous.dispose(); } catch {}
  } else if (previous !== undefined && previous !== null) return null;
  const ctx = { page, pageId: page.id, active: false, started: false, generation: 0, readSequence: 0,
    detailSequence: 0, materialSequence: 0, evidenceSequence: 0, model: initial(page.id), pdfUrl: null, pdfWindows: [] };
  const capsule = { version: CONTROLLER_VERSION, pageId: page.id, ctx, token: Symbol('hl.operations.instance'),
    // Disposing an older runtime never publishes over a newer controller.
    dispose() { clear(ctx, '', false); } };
  ctx.capsule = capsule;
  try {
    Object.defineProperty(page, CONTROLLER_KEY, { value: capsule, enumerable: false, configurable: true, writable: false });
    if (getOperationsController(page) !== capsule) throw new Error('CONTROLLER_ANCHOR_UNAVAILABLE');
    return capsule;
  } catch {
    clear(ctx, '', false);
    try { if (controllerAnchor(page) === capsule) Reflect.deleteProperty(page, CONTROLLER_KEY); } catch {}
    return null;
  }
}
function clearDetail(ctx) {
  ctx.detailSequence++;
  ctx.materialSequence++;
  ctx.evidenceSequence++;
  closePdf(ctx);
  return { selected: null, detail: null, detailText: '', materials: [], material: null, evidenceText: '', evidenceLoading: false, remark: '', feedback: '', source: '', sourceLabel: '', educationLevel: '', financialAssetRange: '', assetRangeLabel: '', evidenceReference: '', confirmation: null, detailLoading: false, canApprove: false, canReject: false, canRevoke: false, canCancel: false, canToggle: false };
}
function closePdf(ctx) {
  const openedWindows = ctx.pdfWindows || [], url = ctx.pdfUrl;
  ctx.pdfUrl = null; ctx.pdfWindows = [];
  try {
    for (const opened of openedWindows) { try { opened.close(); } catch {} }
  } finally {
    try { if (url) URL.revokeObjectURL(url); } catch {}
    finally { ctx.pdfUrl = null; ctx.pdfWindows = []; }
  }
}
function clear(ctx, message = '', notify = true) {
  ctx.generation++;
  ctx.active = false;
  ctx.started = false;
  ctx.readSequence++;
  ctx.detailSequence++;
  ctx.materialSequence++;
  ctx.evidenceSequence++;
  const clean = { ...initial(ctx.pageId), error: message };
  const previousModel = ctx.model;
  eraseModel(previousModel, clean);
  ctx.model = clean;
  // A cloned observable dataset may hold a different object from ctx.model.
  // Only the still-owning capsule may scrub that page's published state.
  if (controllerAnchor(ctx.page) === ctx.capsule) {
    try {
      const published = ctx.page.dataset?.state?.ops;
      if (published !== previousModel && published !== clean) eraseModel(published, clean);
    } catch {}
  }
  closePdf(ctx);
  if (notify && controllerAnchor(ctx.page) === ctx.capsule) {
    try { ctx.page.setState({ ops: clean }); } catch {}
  }
}
function current(ctx, generation) {
  try {
    const page = $w.page;
    return ctx.active && ctx.generation === generation && getOperationsController(page) === ctx.capsule
      && page.id === ctx.pageId && page.__internal__?.active !== false;
  } catch { return false; }
}
function codeOf(error) { return String(error?.code ?? error?.errCode ?? error?.status ?? '').toUpperCase(); }
function forbidden(error) { return /^(?:401|403)|UNAUTH|FORBIDDEN|PERMISSION|TOKEN_EXPIRED|INVALID_ACCESS_TOKEN|LOGIN_REQUIRED/.test(codeOf(error)); }
function failed(ctx, error, patch = {}) {
  if (forbidden(error)) { clear(ctx, '登录已失效或无权访问，请重新使用已授权管理员账号登录。'); return; }
  const code = codeOf(error);
  if (/^409|VERSION|CONFLICT/.test(code)) publish(ctx, { ...clearDetail(ctx), ...patch, error: '记录已更新，请重新选择并读取最新详情后再处理。', writing: false });
  else publish(ctx, { ...patch, error: /^422|VALIDATION/.test(code) ? '提交参数未通过校验，请核对输入和当前记录状态。' : '操作未完成，请重试；请勿把失败视为已处理。', writing: false });
}
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('SECURE_REQUEST_ID_UNAVAILABLE');
}
async function call(action, args, id = requestId()) {
  const response = await $w.cloud.callFunction({ name: 'hlAdminOperations', data: { action, args, requestId: id } });
  if (!object(response?.result) || response.result.code !== 0 || !object(response.result.data)) throw { code: response?.result?.code || 'INVALID_RESPONSE' };
  return response.result.data;
}
function listArgs(model) {
  const args = { page: model.page, pageSize: 10 };
  if (model.keyword.trim()) args.keyword = model.keyword.trim().slice(0, 80);
  if (model.filter !== '') {
    if (model.pageId === 'plans') args.active = model.filter === 'true';
    else args.status = model.pageId === 'matchmakers' ? Number(model.filter) : model.filter;
  }
  return args;
}
async function loadList(ctx, page = 1) {
  if (ctx.model.writing) return;
  ctx.active = true;
  const generation = ctx.generation;
  const sequence = ++ctx.readSequence;
  publish(ctx, { ...clearDetail(ctx), page, rows: [], total: null, totalText: '记录数 —', hasPrevious: false, hasNext: false, loading: true, error: '', message: '' });
  try {
    const result = await call(ctx.page.id + '.list', listArgs(ctx.model));
    if (!current(ctx, generation) || sequence !== ctx.readSequence) return;
    if (!Array.isArray(result.list) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 10 || result.list.length > 10) throw { code: 'INVALID_LIST_RESPONSE' };
    const rows = result.list.filter(object).map(row => ({ record: row, key: ctx.page.id === 'certifications' && row.canView !== true ? null : recordKey(ctx.page.id, row), cells: rowCells(ctx.page.id, row) }));
    publish(ctx, { rows, total: result.total, loading: false, totalText: `共 ${result.total} 条记录`, pageText: `第 ${page} 页 / 共 ${Math.max(1, Math.ceil(result.total / 10))} 页`, hasPrevious: page > 1, hasNext: page * 10 < result.total });
  } catch (error) { if (current(ctx, generation) && sequence === ctx.readSequence) failed(ctx, error, { loading: false, rows: [] }); }
}

function details(pageId, value) {
  const pairs = [];
  const add = (label, item) => pairs.push(label + '：' + display(item));
  if (pageId === 'matchmakers') { add('主理人', value.user?.nickname); add('手机', value.user?.phone); add('编号', value.matchmakerNo); add('城市', value.city || value.profile?.city); add('名下会员', count(value.memberCount)); add('认证状态', ({ 0: '待认证', 1: '已拒绝', 2: '已认证' })[value.certificationStatus]); add('级别', value.level); add('团队', value.teamId); add('上级', value.parentId); add('沙龙数量', count(value.salonCount)); add('门店', [true, 1, '1'].includes(value.hasStore) ? '有' : [false, 0, '0'].includes(value.hasStore) ? '无' : '—'); add('审核记录', value.certificationRemark); add('更新时间', value.updatedAt); }
  else if (pageId === 'certifications') { add('会员', value.user?.nickname); add('认证类型', KIND[value.kind]); add('申请编号', value.applicationId); add('申请状态', status(value.applicationStatus || value.status)); add('当前展示状态', status(value.effectiveStatus)); add('当前认证有效', value.verified === true ? '是' : value.verified === false ? '否' : '—'); add('核验来源', SOURCE[value.source] || '—'); add('院校', value.institutionName); add('提交时间', value.submittedAt); add('审核时间', value.reviewedAt); add('申请人可见反馈', value.feedback); }
  else if (pageId === 'salons') { add('沙龙名称', value.title); add('主理人', value.organizer?.nickname); add('时间', value.eventDate); add('地点', value.location); add('状态', status(value.status)); add('报名人数', count(value.currentParticipants)); add('介绍', value.description); add('审核记录', value.reviewRemark); }
  else if (pageId === 'plans') { add('套餐', value.title); add('编号', value.planCode || value.code); add('现价（元）', money(value.amountFen)); add('类型', value.productType); add('有效期（天）', count(value.durationDays)); add('服务次数', count(value.serviceCount)); add('启用', value.active === true ? '是' : value.active === false ? '否' : '—'); add('说明', value.description); add('价格约束', '微信虚拟商品价格需与商品配置一致；此处只支持启停，不提交调价。'); }
  else { for (const [label, key] of [['订单号', 'outTradeNo'], ['会员', 'userId'], ['套餐', 'planTitle'], ['套餐编号', 'planCode'], ['币种', 'currency'], ['支付状态', 'status'], ['履约状态', 'fulfillmentStatus'], ['履约说明', 'fulfillmentMessage'], ['创建时间', 'createdAt'], ['支付时间', 'paidAt'], ['支付渠道', 'paymentProvider'], ['平台交易号', 'transactionId'], ['确认来源', 'confirmationSource'], ['核查原因', 'reviewReason'], ['退款编号', 'refundId'], ['退款时间', 'refundedAt']]) add(label, key === 'status' ? orderStatus(value[key]) : key === 'fulfillmentStatus' ? status(value[key]) : value[key]); add('订单金额（元）', money(value.amountFen)); add('退款金额（元）', money(value.refundAmountFen)); add('沙箱', value.isSandbox === true ? '是' : '否'); add('测试标记', value.isTest === true ? '是' : '否'); }
  return pairs.join('\n');
}
async function select(ctx, index) {
  if (ctx.model.loading || ctx.model.writing || !Number.isInteger(index)) return;
  const row = ctx.model.rows[index];
  if (!row?.key) return;
  const generation = ctx.generation;
  const cleared = clearDetail(ctx);
  const sequence = ctx.detailSequence;
  publish(ctx, { ...cleared, selected: row.key, detailLoading: true, error: '', message: '' });
  try {
    const detail = await call(ctx.page.id + '.detail', row.key);
    if (!current(ctx, generation) || sequence !== ctx.detailSequence) return;
    if (ctx.page.id !== 'orders' && (typeof detail.version !== 'string' || !/^v1_[a-f0-9]{64}$/.test(detail.version)) || JSON.stringify(recordKey(ctx.page.id, detail)) !== JSON.stringify(row.key)) throw { code: 'INVALID_DETAIL_RESPONSE' };
    const review = detail.canReview === true;
    const materials = Array.isArray(detail.materials) ? detail.materials.filter(object).map(item => ({ materialId: string(item.materialId || item.id, 200), label: string(item.title || item.name || item.materialId || item.id, 80) })).filter(item => item.materialId).slice(0, 10) : [];
    if (!materials.length && Array.isArray(detail.materialIds)) detail.materialIds.slice(0, 10).forEach(id => { if (string(id, 200)) materials.push({ materialId: id, label: '认证材料 ' + (materials.length + 1) }); });
    const source = ({ identity: 'identity_document', education: 'chsi', vehicle: 'vehicle_license', property: 'property_certificate', assets: 'bank_statement' })[detail.kind] || '';
    publish(ctx, { detail, detailText: details(ctx.page.id, detail), detailLoading: false, materials, source, sourceLabel: SOURCE[source] || '',
      canApprove: ctx.page.id === 'salons' ? detail.canApprove === true : review,
      canReject: ctx.page.id === 'salons' ? detail.canReject === true : review,
      canRevoke: ctx.page.id === 'certifications' && detail.canRevoke === true,
      canCancel: ctx.page.id === 'salons' && detail.canCancel === true,
      canToggle: ctx.page.id === 'plans' && detail.canUpdate === true && typeof detail.active === 'boolean' });
  } catch (error) { if (current(ctx, generation) && sequence === ctx.detailSequence) failed(ctx, error, { ...clearDetail(ctx) }); }
}

function prepare(ctx, operation) {
  const m = ctx.model;
  if (m.loading || m.detailLoading || m.writing || !m.detail?.version || !m.selected) return;
  const remark = string(m.remark, 500);
  const feedback = string(m.feedback, 500);
  const args = { ...m.selected, expectedVersion: m.detail.version };
  let action;
  let label;
  if (operation === 'price') { publish(ctx, { message: '价格受微信虚拟商品配置约束，当前只支持启停；未提交价格变更。' }); return; }
  if (operation === 'approve' && m.canApprove) {
    if (ctx.page.id === 'certifications') {
      const sources = { identity: ['identity_document'], education: ['chsi', 'cscse'], vehicle: ['vehicle_license'], property: ['property_certificate'], assets: ['bank_statement', 'securities_statement', 'insurance_statement', 'combined_financial_statement'] };
      if (!sources[m.selected.kind]?.includes(m.source) || !string(m.evidenceReference, 200)
        || m.selected.kind === 'education' && !['本科', '硕士', '博士'].includes(m.educationLevel)
        || m.selected.kind === 'assets' && !['under_500k', '500k_2m', '2m_5m', '5m_10m', 'over_10m'].includes(m.financialAssetRange)) {
        publish(ctx, { error: '请填写合法核验来源、核验引用，以及该类型要求的学历或资产区间。' }); return;
      }
    }
    action = ctx.page.id + '.review'; label = '审核通过';
    if (ctx.page.id === 'matchmakers') Object.assign(args, { certificationStatus: 2, remark });
    if (ctx.page.id === 'certifications') Object.assign(args, { status: 'approved', source: m.source, remark, feedback, ...(m.selected.kind === 'education' ? { educationLevel: m.educationLevel } : {}), ...(m.selected.kind === 'assets' ? { financialAssetRange: m.financialAssetRange } : {}), evidenceReference: string(m.evidenceReference, 200) });
    if (ctx.page.id === 'salons') Object.assign(args, { status: 'upcoming', remark });
  } else if (operation === 'reject' && m.canReject) {
    if (!(ctx.page.id === 'certifications' ? feedback : remark)) { publish(ctx, { error: ctx.page.id === 'certifications' ? '拒绝前请填写给申请人看的原因。' : '拒绝前请填写原因。' }); return; }
    action = ctx.page.id + '.review'; label = '拒绝申请';
    Object.assign(args, ctx.page.id === 'matchmakers' ? { certificationStatus: 1, remark } : ctx.page.id === 'certifications' ? { status: 'rejected', remark, feedback } : { status: 'rejected', remark });
  } else if (operation === 'revoke' && ctx.page.id === 'certifications' && m.canRevoke) {
    if (!feedback) { publish(ctx, { error: '撤销前请填写给申请人看的原因。' }); return; }
    action = 'certifications.review'; label = '撤销认证'; Object.assign(args, { status: 'revoked', remark, feedback });
  } else if (operation === 'cancel' && m.canCancel) {
    if (!remark) { publish(ctx, { error: '取消前请填写原因。' }); return; }
    action = 'salons.cancel'; label = '取消沙龙'; Object.assign(args, { reason: remark });
  } else if (operation === 'toggle' && m.canToggle) {
    action = 'plans.update'; label = m.detail.active ? '停用套餐' : '启用套餐'; Object.assign(args, { active: !m.detail.active });
  } else return;
  try {
    closePdf(ctx);
    const name = m.detail.user?.nickname || m.detail.title || m.detail.planTitle || '当前记录';
    const identity = ctx.page.id === 'certifications' ? `${KIND[m.selected.kind]} · 申请编号 ${m.selected.applicationId}` : ctx.page.id === 'plans' ? `套餐编号 ${m.selected.planCode}` : `编号 ${m.selected.id}`;
    const impact = operation === 'toggle' ? '仅改变后续购买入口的启用状态；已有订单和已购买权益不变。' : operation === 'cancel' ? '沙龙将取消，后续报名以更新后的活动状态为准。' : operation === 'revoke' ? '该认证将被撤销，申请人可看到反馈原因。' : '审核结果将记录到当前申请；给申请人的反馈将按填写内容展示。';
    const confirmation = { action, args, requestId: requestId(), label, summary: `${label}\n记录：${name}（${identity}）\n影响：${impact}\n内部备注：${remark || '未填写'}${ctx.page.id === 'certifications' ? '\n申请人可见反馈：' + (feedback || '未填写') + '\n核验来源：' + (SOURCE[m.source] || '未选择') + '\n核验引用：' + m.evidenceReference + (m.selected.kind === 'education' ? '\n学历：' + (m.educationLevel || '未选择') : m.selected.kind === 'assets' ? '\n资产档位：' + (ASSET_RANGE[m.financialAssetRange] || '未选择') : '') : ''}\n提交时将核对资料是否更新。请核对后点击“确认提交”。`, version: m.detail.version };
    publish(ctx, { confirmation, material: null, error: '', message: '此时仅保存本地草稿，尚未提交。' });
  } catch (error) { failed(ctx, error); }
}
async function submit(ctx) {
  const confirmation = ctx.model.confirmation;
  if (!confirmation || ctx.model.writing || ctx.model.detail?.version !== confirmation.version || JSON.stringify(ctx.model.selected) !== JSON.stringify(recordKey(ctx.page.id, ctx.model.detail))) return;
  const generation = ctx.generation;
  publish(ctx, { writing: true, error: '', material: null, message: '正在提交，请勿重复点击。' });
  try {
    await call(confirmation.action, confirmation.args, confirmation.requestId);
    if (!current(ctx, generation)) return;
    publish(ctx, { ...clearDetail(ctx), writing: false, message: '处理成功，正在刷新列表。' });
    await loadList(ctx, ctx.model.page);
    if (current(ctx, generation)) publish(ctx, { message: '处理成功；再次处理前请重新选择记录并读取最新版本。' });
  } catch (error) { if (current(ctx, generation)) failed(ctx, error, { message: '未确认成功。若重试，同一确认草稿将复用请求编号。' }); }
}

async function material(ctx, index) {
  const entry = ctx.model.materials[index];
  if (ctx.page.id !== 'certifications' || !entry || !ctx.model.detail || ctx.model.writing) return;
  const sequence = ++ctx.materialSequence;
  const generation = ctx.generation;
  const version = ctx.model.detail.version;
  const key = { ...ctx.model.selected };
  closePdf(ctx);
  publish(ctx, { material: null, error: '', message: '正在受控读取选中材料…' });
  try {
    const result = await call('certifications.material', { ...key, expectedVersion: version, materialId: entry.materialId });
    if (!current(ctx, generation) || sequence !== ctx.materialSequence || ctx.model.detail?.version !== version || JSON.stringify(ctx.model.selected) !== JSON.stringify(key)) return;
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(result.mimeType) || typeof result.contentBase64 !== 'string' || result.contentBase64.length > 15000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.contentBase64)) throw { code: 'INVALID_MATERIAL_RESPONSE' };
    const pdf = result.mimeType === 'application/pdf';
    if (pdf) {
      const bytes = Uint8Array.from(atob(result.contentBase64), character => character.charCodeAt(0));
      ctx.pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    }
    publish(ctx, { material: { src: pdf ? '' : `data:${result.mimeType};base64,${result.contentBase64}`, pdf, label: entry.label }, message: '仅在当前选择中显示；切换记录或离开页面即清除。' });
  } catch (error) { if (current(ctx, generation) && sequence === ctx.materialSequence) failed(ctx, error, { material: null, message: '' }); }
}

async function evidence(ctx) {
  if (ctx.page.id !== 'certifications' || !ctx.model.detail || ctx.model.writing || ctx.model.evidenceLoading) return;
  const generation = ctx.generation;
  const sequence = ctx.detailSequence;
  const evidenceSequence = ++ctx.evidenceSequence;
  const key = { ...ctx.model.selected };
  publish(ctx, { evidenceText: '', evidenceLoading: true, error: '' });
  try {
    const value = await call('certifications.evidence', { ...key, expectedVersion: ctx.model.detail.version });
    if (!current(ctx, generation) || sequence !== ctx.detailSequence || evidenceSequence !== ctx.evidenceSequence) return;
    const entries = [['核验码', value.verificationCode], ['证件编号', value.certificateNumber], ['申报资产区间', ASSET_RANGE[value.declaredFinancialAssetRange] || '—']];
    publish(ctx, { evidenceText: entries.map(([label, item]) => label + '：' + display(item)).join('\n'), evidenceLoading: false });
  } catch (error) { if (current(ctx, generation) && sequence === ctx.detailSequence && evidenceSequence === ctx.evidenceSequence) failed(ctx, error, { evidenceText: '', evidenceLoading: false }); }
}

export default async function operations(input = {}) {
  const target = input?.data?.target || {};
  const command = target.command || 'init';
  const page = command === 'clear' && input.cleanupPage ? input.cleanupPage
    : command === 'init' && input.lifecyclePage ? input.lifecyclePage : $w.page;
  if (!page || !PAGES.includes(page.id)) return;
  let capsule = getOperationsController(page);
  if (command === 'clear') {
    if (!capsule || Object.hasOwn(input, 'cleanupController') && input.cleanupController !== capsule) return;
    clear(capsule.ctx);
    if (input.disposeController === true) {
      try { if (controllerAnchor(page) === capsule) Reflect.deleteProperty(page, CONTROLLER_KEY); } catch {}
    }
    return;
  }
  if (command === 'init' && !capsule) capsule = initializeController(page);
  if (!capsule) { unavailable(page); return; }
  const ctx = capsule.ctx;
  if (command === 'init') { if (!ctx.active || !ctx.started) { ctx.started = true; return loadList(ctx); } return; }
  if (!ctx.active && ['query', 'reset'].includes(command)) { if (command === 'reset') publish(ctx, { keyword: '', filter: '' }); return loadList(ctx); }
  if (!ctx.active) return;
  if (command === 'edit') {
    if (ctx.model.writing || ctx.model.confirmation || !['keyword', 'remark', 'feedback', 'evidenceReference'].includes(target.field)) return;
    const value = input?.event?.detail?.value;
    if (typeof value === 'string') publish(ctx, { [target.field]: value.slice(0, target.field === 'keyword' ? 80 : 500), error: '' });
  } else if (command === 'choose') {
    if (page.id !== 'certifications' || !ctx.model.detail || ctx.model.writing || ctx.model.confirmation) return;
    const kind = ctx.model.selected?.kind;
    const allowed = target.field === 'source' ? ({ education: ['chsi', 'cscse'], assets: ['bank_statement', 'securities_statement', 'insurance_statement', 'combined_financial_statement'] })[kind]
      : target.field === 'educationLevel' && kind === 'education' ? ['本科', '硕士', '博士']
      : target.field === 'financialAssetRange' && kind === 'assets' ? Object.keys(ASSET_RANGE) : null;
    if (!allowed?.includes(target.value)) return;
    publish(ctx, { [target.field]: target.value, ...(target.field === 'source' ? { sourceLabel: SOURCE[target.value] } : target.field === 'financialAssetRange' ? { assetRangeLabel: ASSET_RANGE[target.value] } : {}), error: '' });
  } else if (command === 'filter' && !ctx.model.writing) { publish(ctx, { filter: String(target.value ?? ''), ...clearDetail(ctx) }); return loadList(ctx); }
  else if (command === 'query') return loadList(ctx);
  else if (command === 'reset' && !ctx.model.writing) { publish(ctx, { keyword: '', filter: '' }); return loadList(ctx); }
  else if (command === 'previous' && ctx.model.hasPrevious) return loadList(ctx, ctx.model.page - 1);
  else if (command === 'next' && ctx.model.hasNext) return loadList(ctx, ctx.model.page + 1);
  else if (command === 'select') return select(ctx, target.index);
  else if (command === 'detail') { const index = ctx.model.rows.findIndex(row => JSON.stringify(row.key) === JSON.stringify(ctx.model.selected)); if (index >= 0) return select(ctx, index); }
  else if (command === 'prepare') return prepare(ctx, target.operation);
  else if (command === 'cancelConfirmation' && !ctx.model.writing) publish(ctx, { confirmation: null, error: '', message: '已取消本地草稿，未发起提交。' });
  else if (command === 'submit') return submit(ctx);
  else if (command === 'material') return material(ctx, target.index);
  else if (command === 'evidence') return evidence(ctx);
  else if (command === 'openPdf' && ctx.pdfUrl) { const opened = window.open(ctx.pdfUrl, '_blank'); if (opened) { opened.opener = null; (ctx.pdfWindows ||= []).push(opened); } else publish(ctx, { error: '浏览器阻止了PDF窗口，请允许本次弹出后重试。' }); }
  else if (command === 'downloadPdf' && ctx.pdfUrl) { const link = document.createElement('a'); link.href = ctx.pdfUrl; link.download = '认证材料.pdf'; link.rel = 'noopener'; document.body.appendChild(link); link.click(); link.remove(); }
  else if (command === 'closeMaterial') { ctx.materialSequence++; ctx.evidenceSequence++; closePdf(ctx); publish(ctx, { material: null, evidenceText: '', evidenceLoading: false }); }
}
