const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');
const VERSION = 'v1_' + 'a'.repeat(64), NEXT = 'v1_' + 'b'.repeat(64);
const UUID = '6d05ef75-aacd-41c9-afcb-c645de748914';
const event = dataset => ({ currentTarget: { dataset } });
const input = (field, value) => ({ ...event({ field }), detail: { value } });
const allowed = () => ({ allowed: true, ready: true, mode: 'native' });
function record(resource, kind = 'identity') {
  if (resource === 'certifications') return { userId: 12, kind, applicationId: 'application_12', version: VERSION,
    status: 'pending', canView: true, canReview: true, canRevoke: true, user: { nickname: '认证申请样例', phone: '13800000000' }, materials: [] };
  if (resource === 'plans') return { planCode: 'vip_week', title: '周会员', version: VERSION, active: true, canUpdate: true, amountFen: 6160 };
  if (resource === 'orders') return { outTradeNo: 'order_12', status: 'paid', amountFen: 6160, planTitle: '周会员', fulfillmentStatus: 'fulfilled' };
  return { id: 12, version: VERSION, user: { nickname: '主理人样例', phone: '13800000000' }, title: '沙龙样例',
    certificationStatus: 0, status: 'pending', canReview: true, canApprove: true, canReject: true, canCancel: true };
}
function options(resource, row) {
  return { resource, id: String(row.id), userId: String(row.userId), kind: row.kind,
    applicationId: row.applicationId, planCode: row.planCode, outTradeNo: row.outTradeNo };
}
function nativeRuntime(page, handle, config = {}) {
  const files = [], deletions = [], documents = [], shares = [], writes = [];
  const fileSystem = { readdir: x => x.success?.({ files: [] }),
    unlink: x => { deletions.push(x.filePath); x.success?.({}); },
    writeFile: x => { files.push(x.filePath); writes.push(x); x.success?.({}); } };
  const r = runtime(page, { source: true,
    wx: { hideShareMenu: x => shares.push(x), env: { USER_DATA_PATH: '/private' },
      getFileSystemManager: () => fileSystem,
      openDocument: x => { documents.push(x); x.success?.({}); },
      previewImage: () => { throw new Error('private materials must not use a shareable image viewer'); },
      ...config.wx },
    request: async (url, opts) => {
      if (url === '/user/admin-entry') return (config.entry || allowed)();
      assert.equal(url, '/user/admin/operations');
      assert.equal(opts.method, 'POST'); assert.equal(opts.showError, false);
      assert.deepEqual(Object.keys(opts.data).sort(), opts.data.requestId ? ['action', 'args', 'requestId'] : ['action', 'args']);
      if (opts.data.action === 'operations.prepare') return { requestId: UUID };
      return handle(opts.data.action, opts.data.args, opts.data.requestId);
    } });
  r.load(path.join(miniprogramRoot, 'services/api.ts')).request = r.services.api.request;
  return { ...r, files, deletions, documents, shares, writes, fileSystem };
}
const ops = r => r.calls.requests.filter(x => x.path === '/user/admin/operations').map(x => x.options.data);
function successfulMutation(action, args, requestId) {
  const target = action.startsWith('certifications') ? { userId: args.userId, kind: args.kind, applicationId: args.applicationId }
    : action === 'plans.update' ? { planCode: args.planCode } : { id: args.id };
  return { action, target, requestId, version: NEXT, status: 'approved', updatedAt: '2026-10-15T09:00:00Z' };
}

test('source-only modules load before build; every management list supports search, paging and typed filters', async () => {
  for (const resource of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
    const row = record(resource);
    const r = nativeRuntime('admin-console/workspace/index.js', async (action, args) => {
      assert.equal(action, resource + '.list');
      return { list: [row], total: 21, page: args.page, pageSize: args.pageSize };
    });
    r.page.onLoad({ resource }); await r.page.onShow();
    assert.equal(r.page.data.ready, true); assert.equal(r.page.data.rows.length, 1);
    assert.equal(typeof r.page.data.rows[0].rowKey, 'string'); assert.ok(r.page.data.rows[0].rowKey.startsWith(resource + ':'));
    await r.page.next(); assert.equal(ops(r).at(-1).args.page, 2);
    r.page.onKeyword(input('keyword', '检索')); await r.page.search();
    assert.equal(ops(r).at(-1).args.keyword, '检索'); assert.equal(ops(r).at(-1).args.page, 1);
    await r.page.setFilter({ ...event({ field: 'filterIndex' }), detail: { value: resource === 'plans' ? '2' : '1' } });
    assert.equal(ops(r).at(-1).args[resource === 'plans' ? 'active' : 'status'], resource === 'plans' ? false : resource === 'matchmakers' ? '0' : 'pending');
    r.page.openDetail(event({ index: 0 })); assert.match(r.calls.navigation.at(-1).url, /^\/admin-console\/detail\/index\?resource=/);
    assert.equal(r.calls.storage.length, 0); assert.equal(r.shares.length, 1);
    r.page.onHide(); assert.equal(r.page.data.rows.length, 0); assert.equal(r.page.data.keyword, '');
  }
});
test('paid service queue exposes waiting users and filters pending assignment through the native route', async () => {
  const row = { userId: 12, user: { nickname: '服务会员' }, status: 'pending_assignment', contactProgress: '待平台分配主理人', remainingCount: 2 };
  const r = nativeRuntime('admin-console/workspace/index.js', async (action, args) => {
    assert.equal(action, 'services.list'); return { list: [row], total: 1, page: args.page, pageSize: args.pageSize };
  });
  r.page.onLoad({ resource: 'services' }); await r.page.onShow();
  assert.equal(r.page.data.rows[0].status, '待分配主理人');
  await r.page.setFilter({ ...event({ field: 'filterIndex' }), detail: { value: '1' } });
  assert.equal(ops(r).at(-1).args.status, 'pending_assignment');
  r.page.openDetail(event({ index: 0 })); assert.match(r.calls.navigation.at(-1).url, /resource=services&userId=12/);
});
test('service reassignment is concrete, confirmed, version checked and private drafts clear on hide', async () => {
  const row = { userId: 12, user: { nickname: '服务会员' }, version: VERSION, canAssign: true, hasExistingAssignment: true,
    assignment: { memberRecordId: 5, matchmakerId: 30, nickname: '原主理人' }, principals: [{ id: 40, nickname: '新主理人', matchmakerNo: 'MM40' }], packages: [] };
  const confirmations = [];
  const r = nativeRuntime('admin-console/detail/index.js', async (action, args, requestId) => action === 'services.detail' ? row
    : { action, target: { userId: 12, matchmakerId: 40 }, requestId, version: NEXT, status: 'pending_contact' },
  { wx: { showModal: options => { confirmations.push(options); options.success({ confirm: true }); } } });
  r.page.onLoad({ resource: 'services', userId: '12' }); await r.page.onShow();
  r.page.onChoice({ ...event({ field: 'principalIndex' }), detail: { value: '1' } });
  r.page.onFieldInput(input('serviceReason', '原主理人休假，平台协调移交'));
  await r.page.prepareWrite(event({ command: 'assign' }));
  const write = ops(r).find(item => item.action === 'services.assign');
  assert.ok(write); assert.equal(write.args.confirmReassign, true); assert.equal(write.args.matchmakerId, 40);
  assert.equal(write.args.expectedVersion, VERSION); assert.match(confirmations[0].content, /更换已有服务关系/);
  r.page.onFieldInput(input('serviceReason', '私密草稿')); r.page.onHide();
  assert.equal(r.page.data.serviceReason, ''); assert.equal(r.page.data.principalOptions.length, 1);
  assert.equal(r.page.data.servicePackages.length, 0); assert.equal(r.page._detail, null);
});
test('service extension validates bounded days and confirms existing and revised expiry before sending', async () => {
  const row = { userId: 12, version: VERSION, packages: [{ id: 'package_12', planTitle: '人工牵线2次', orderNo: 'order_12',
    expireAt: '2026-10-01T00:00:00.000Z', originalExpireAt: '2026-10-01T00:00:00.000Z', remainingCount: 2,
    totalCount: 2, usedCount: 0, status: 'expired', canExtend: true }] };
  const confirmations = [];
  const r = nativeRuntime('admin-console/detail/index.js', async (action, args, requestId) => action === 'services.detail' ? row
    : { action, target: { userId: 12, packageId: 'package_12' }, requestId, version: NEXT, status: 'expired' },
  { wx: { showModal: options => { confirmations.push(options); options.success({ confirm: true }); } } });
  r.page.onLoad({ resource: 'services', userId: '12' }); await r.page.onShow();
  r.page.onFieldInput(input('serviceReason', '平台联系延误'));
  r.page.onFieldInput(input('extensionDays', '31')); await r.page.prepareWrite(event({ command: 'extend' }));
  assert.equal(ops(r).some(item => item.action === 'services.extend'), false);
  r.page.onFieldInput(input('extensionDays', '3')); await r.page.prepareWrite(event({ command: 'extend' }));
  const write = ops(r).find(item => item.action === 'services.extend'); assert.equal(write.args.days, 3);
  assert.match(confirmations[0].content, /2026-10-01T00:00:00.000Z/); assert.match(confirmations[0].content, /2026-10-04T00:00:00.000Z/);
  assert.match(confirmations[0].content, /可能仍未恢复有效/);
});
test('direct list and detail calls cannot grant themselves administrator access', async () => {
  for (const page of ['admin-console/workspace/index.js', 'admin-console/detail/index.js']) {
    const r = nativeRuntime(page, () => { throw Object.assign(new Error('denied before reading business records'), { code: 40360 }); });
    r.page.onLoad({ resource: 'matchmakers', id: '12', allowed: 'true', role: 'administrator' });
    await r.page.onShow(); assert.equal(ops(r).length, 1); assert.match(r.page.data.error, /管理权限/);
    assert.equal(r.page.data.ready, false); assert.equal(r.page._visible, false);
    assert.equal(r.calls.requests.some(call => call.path === '/user/admin-entry'), false);
  }
});
test('all list and detail screens start their authorized data request immediately without an extra permission round trip', async () => {
  for (const resource of ['matchmakers', 'certifications', 'salons', 'plans', 'orders']) {
    for (const type of ['list', 'detail']) {
      const pending = deferred(), row = record(resource);
      const r = nativeRuntime(type === 'list' ? 'admin-console/workspace/index.js' : 'admin-console/detail/index.js',
        action => { assert.equal(action, resource + '.' + type); return pending.promise; },
        { entry: () => { throw new Error('redundant entry request'); } });
      r.page.onLoad(options(resource, row));
      const loading = r.page.onShow();
      assert.equal(r.calls.requests.length, 1, resource + '.' + type);
      assert.equal(ops(r).length, 1); assert.equal(r.page.data.loading, true);
      pending.resolve(type === 'list' ? { list: [row], total: 1, page: 1, pageSize: 10 } : row);
      await loading;
      assert.equal(r.page.data.ready, true); assert.equal(r.calls.requests.length, 1);
    }
  }
});
test('revoked list permissions clear prior results and private query input on the next request', async () => {
  let revoked = false;
  const r = nativeRuntime('admin-console/workspace/index.js', async (_action, args) => {
    if (revoked) throw Object.assign(new Error('permission revoked'), { code: 40360 });
    return { list: [record('matchmakers')], total: 21, page: args.page, pageSize: args.pageSize };
  });
  r.page.onLoad({ resource: 'matchmakers' }); await r.page.onShow();
  r.page.onKeyword(input('keyword', '私密查询')); revoked = true;
  await r.page.next();
  assert.equal(r.page.data.ready, false); assert.equal(r.page.data.rows.length, 0);
  assert.equal(r.page.data.keyword, ''); assert.equal(r.page.data.total, 0); assert.equal(r.page.data.hasNext, false);
  r.page.openDetail(event({ index: 0 })); assert.equal(r.calls.navigation.length, 0);
});
test('old-account list responses cannot erase or expose a replacement account list', async () => {
  const old = deferred(); let calls = 0;
  const r = nativeRuntime('admin-console/workspace/index.js', async (_action, args) => ++calls === 1 ? old.promise
    : { list: [{ ...record('matchmakers'), user: { nickname: '新账号结果' } }], page: args.page, pageSize: args.pageSize, total: 1 });
  r.page.onLoad({ resource: 'matchmakers' }); const first = r.page.onShow(); await flush();
  r.session.token = 'new-session'; r.session.user = { id: 2 }; await r.page.onShow();
  old.resolve({ list: [{ ...record('matchmakers'), user: { nickname: '旧账号机密' } }], page: 1, pageSize: 10, total: 1 }); await first;
  assert.equal(r.page.data.rows[0].title, '新账号结果');
  r.session.token = 'third-session'; r.page.openDetail(event({ index: 0 }));
  assert.equal(r.page.data.rows.length, 0); assert.equal(r.calls.navigation.length, 0);
});
test('all five certification approvals preserve kind, source, validated conclusion and record version', async () => {
  for (const kind of ['identity', 'education', 'vehicle', 'property', 'assets']) {
    const row = record('certifications', kind);
    const r = nativeRuntime('admin-console/detail/index.js', async (action, args, requestId) => action.endsWith('.detail') ? row : successfulMutation(action, args, requestId));
    r.page.onLoad(options('certifications', row)); await r.page.onShow();
    r.page.onFieldInput(input('evidenceReference', '内部核验记录20261015'));
    if (kind === 'education') r.page.onChoice({ ...event({ field: 'educationIndex' }), detail: { value: '2' } });
    if (kind === 'assets') r.page.onChoice({ ...event({ field: 'assetIndex' }), detail: { value: '3' } });
    await r.page.prepareWrite(event({ command: 'approve' }));
    const write = ops(r).find(x => x.action === 'certifications.review');
    assert.equal(write.requestId, UUID); assert.equal(write.args.kind, kind); assert.equal(write.args.applicationId, row.applicationId);
    assert.equal(write.args.expectedVersion, VERSION); assert.equal(write.args.status, 'approved');
    assert.equal(write.args.evidenceReference, '内部核验记录20261015');
    if (kind === 'education') assert.equal(write.args.educationLevel, '硕士');
    if (kind === 'assets') assert.equal(write.args.financialAssetRange, '2m_5m');
    assert.equal(r.calls.storage.length, 0);
  }
});
test('all management write variants retain business keys and only the supported mutation fields', async () => {
  const cases = [
    ['matchmakers', 'reject', 'matchmakers.review', { certificationStatus: 1, remark: '核对原因' }],
    ['certifications', 'reject', 'certifications.review', { status: 'rejected', remark: '核对原因', feedback: '申请人反馈' }],
    ['certifications', 'revoke', 'certifications.review', { status: 'revoked', remark: '核对原因', feedback: '申请人反馈' }],
    ['salons', 'approve', 'salons.review', { status: 'upcoming', remark: '核对原因' }],
    ['salons', 'reject', 'salons.review', { status: 'rejected', remark: '核对原因' }],
    ['salons', 'cancel', 'salons.cancel', { reason: '核对原因' }],
    ['plans', 'toggle', 'plans.update', { active: false }]
  ];
  for (const [resource, command, action, expected] of cases) {
    const row = record(resource);
    const r = nativeRuntime('admin-console/detail/index.js', async (name, args, id) => name.endsWith('.detail') ? row : successfulMutation(name, args, id));
    r.page.onLoad(options(resource, row)); await r.page.onShow();
    r.page.onFieldInput(input('remark', '核对原因')); r.page.onFieldInput(input('feedback', '申请人反馈'));
    await r.page.prepareWrite(event({ command }));
    const write = ops(r).find(x => x.action === action);
    const key = resource === 'certifications' ? { userId: row.userId, kind: row.kind, applicationId: row.applicationId }
      : resource === 'plans' ? { planCode: row.planCode } : { id: row.id };
    assert.deepEqual(JSON.parse(JSON.stringify(write.args)), { ...key, expectedVersion: VERSION, ...expected }); assert.equal(write.requestId, UUID);
  }
});
test('a live permission denial clears loaded private details, drafts and material access immediately', async () => {
  for (const operation of ['evidence', 'material', 'write']) {
    const row = { ...record('certifications'), materials: [{ id: 'material_1', kind: 'identity', mimeType: 'application/pdf', size: 14 }] };
    let reads = 0;
    const r = nativeRuntime('admin-console/detail/index.js', async action => {
      if (action.endsWith('.detail') && (operation !== 'write' || ++reads === 1)) return row;
      throw Object.assign(new Error('administrator permission revoked'), { code: 40360 });
    });
    r.page.onLoad(options('certifications', row)); await r.page.onShow();
    r.page.onFieldInput(input('feedback', '私密审核草稿'));
    if (operation === 'evidence') await r.page.viewEvidence();
    else if (operation === 'material') await r.page.viewMaterial(event({ id: 'material_1' }));
    else await r.page.prepareWrite(event({ command: 'reject' }));
    assert.equal(r.page.data.ready, false); assert.equal(r.page.data.fields.length, 0); assert.equal(r.page.data.materials.length, 0);
    assert.equal(r.page.data.feedback, ''); assert.equal(r.page._detail, null); assert.equal(r.page._pending, null);
    assert.equal(ops(r).some(x => x.action === 'certifications.review'), false);
  }
});
test('writes reread detail and require explicit confirmation; changed versions never prepare or submit', async () => {
  const row = record('matchmakers'), confirmations = [];
  const r = nativeRuntime('admin-console/detail/index.js', async (action) => {
    assert.equal(action, 'matchmakers.detail'); return { ...row };
  }, { wx: { showModal: x => confirmations.push(x) } });
  r.page.onLoad(options('matchmakers', row)); await r.page.onShow();
  const pending = r.page.prepareWrite(event({ command: 'approve' })); await flush();
  assert.equal(ops(r).filter(x => x.action === 'matchmakers.detail').length, 2);
  assert.equal(ops(r).some(x => x.action === 'matchmakers.review'), false);
  confirmations[0].success({ confirm: false }); await pending;
  assert.equal(ops(r).some(x => x.action === 'matchmakers.review'), false);
  row.version = NEXT;
  await r.page.prepareWrite(event({ command: 'approve' }));
  assert.equal(ops(r).filter(x => x.action === 'operations.prepare').length, 1);
  assert.match(r.page.data.error, /更新|刷新/);
});
test('unknown write outcomes retain the same request ID and immutable payload until confirmed retry', async () => {
  const row = record('matchmakers'); let attempts = 0;
  const r = nativeRuntime('admin-console/detail/index.js', async (action, args, id) => {
    if (action.endsWith('.detail')) return row;
    if (++attempts === 1) throw new Error('network disconnected');
    return successfulMutation(action, args, id);
  });
  r.page.onLoad(options('matchmakers', row)); await r.page.onShow();
  r.page.onFieldInput(input('remark', '原审核备注'));
  await r.page.prepareWrite(event({ command: 'approve' }));
  assert.equal(r.page.data.pendingRetry, true);
  r.page.onFieldInput(input('remark', '不得改变原操作'));
  assert.equal(r.page.data.remark, '原审核备注');
  await r.page.retryWrite();
  const writes = ops(r).filter(x => x.action === 'matchmakers.review');
  assert.equal(writes.length, 2); assert.equal(writes[0].requestId, writes[1].requestId);
  assert.equal(JSON.stringify(writes[0].args), JSON.stringify(writes[1].args));
  assert.equal(ops(r).filter(x => x.action === 'operations.prepare').length, 1);
  assert.equal(r.page.data.pendingRetry, false);
});
test('409 conflicts discard the pending command, refresh details and never replay it', async () => {
  const row = record('plans'); let reads = 0;
  const r = nativeRuntime('admin-console/detail/index.js', async action => {
    if (action.endsWith('.detail')) return { ...row, version: ++reads > 2 ? NEXT : VERSION };
    throw Object.assign(new Error('changed'), { code: 40960 });
  });
  r.page.onLoad(options('plans', row)); await r.page.onShow();
  await r.page.prepareWrite(event({ command: 'toggle' })); await r.page.retryWrite();
  assert.equal(ops(r).filter(x => x.action === 'plans.update').length, 1);
  assert.equal(r.page._detail.version, NEXT); assert.equal(r.page.data.pendingRetry, false);
  assert.match(r.page.data.error, /未自动重放/);
});
test('a confirmed dialog from a hidden page or previous account cannot submit a mutation', async () => {
  for (const change of ['hide', 'account']) {
    const row = record('matchmakers'), modals = [];
    const r = nativeRuntime('admin-console/detail/index.js', async action => { assert.ok(action.endsWith('.detail')); return row; }, { wx: { showModal: x => modals.push(x) } });
    r.page.onLoad(options('matchmakers', row)); await r.page.onShow();
    const preparing = r.page.prepareWrite(event({ command: 'approve' })); await flush();
    if (change === 'hide') r.page.onHide(); else { r.session.token = 'replacement'; r.session.user = { id: 2 }; }
    modals[0].success({ confirm: true }); await preparing;
    assert.equal(ops(r).some(x => x.action === 'matchmakers.review'), false);
    assert.equal(r.page.data.fields.length, 0);
  }
});
test('certification evidence and material responses after leaving cannot restore sensitive state', async () => {
  const row = record('certifications'), pending = deferred();
  const r = nativeRuntime('admin-console/detail/index.js', async action => action.endsWith('.detail') ? row : pending.promise);
  r.page.onLoad(options('certifications', row)); await r.page.onShow();
  const reading = r.page.viewEvidence(); r.page.onHide();
  pending.resolve({ userId: 12, kind: row.kind, applicationId: row.applicationId, verificationCode: 'private-code' }); await reading;
  assert.equal(r.page.data.evidenceFields.length, 0); assert.equal(r.page.data.fields.length, 0);
  assert.equal(JSON.stringify(r.page.data).includes('private-code'), false);
});
test('private images stay in-page, PDF menus stay disabled and temporary files are deleted on hide', async () => {
  for (const mimeType of ['image/png', 'application/pdf']) {
    const content = mimeType === 'image/png' ? Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]) : Buffer.from('%PDF-1.4\n%%EOF');
    const row = { ...record('certifications'), materials: [{ id: 'material_1', kind: 'identity', mimeType, size: content.length }] };
    const r = nativeRuntime('admin-console/detail/index.js', async action => action.endsWith('.detail') ? row
      : { id: 'material_1', mimeType, size: content.length, contentBase64: content.toString('base64') });
    r.page.onLoad(options('certifications', row)); await r.page.onShow(); await r.page.viewMaterial(event({ id: 'material_1' }));
    assert.equal(r.files.length, 1); assert.equal(r.calls.storage.length, 0);
    if (mimeType === 'application/pdf') assert.equal(r.documents[0].showMenu, false);
    else assert.equal(r.page.data.materialPath, r.files[0]);
    r.page.onHide(); assert.equal(r.page.data.materialPath, ''); assert.ok(r.deletions.includes(r.files[0]));
    assert.equal(r.page.data.fields.length, 0);
  }
});
test('a file write completing after hide is cleaned even when the first unlink preceded file creation', async () => {
  const content = Buffer.from('%PDF-1.4\n%%EOF'), row = { ...record('certifications'), materials: [{ id: 'material_1', kind: 'identity', mimeType: 'application/pdf', size: content.length }] };
  const r = nativeRuntime('admin-console/detail/index.js', async action => action.endsWith('.detail') ? row
    : { id: 'material_1', mimeType: 'application/pdf', size: content.length, contentBase64: content.toString('base64') });
  const writes = []; r.fileSystem.writeFile = x => writes.push(x);
  r.page.onLoad(options('certifications', row)); await r.page.onShow();
  const reading = r.page.viewMaterial(event({ id: 'material_1' })); await flush();
  r.page.onHide(); writes[0].success({}); await reading;
  assert.equal(r.documents.length, 0); assert.ok(r.deletions.filter(x => x === writes[0].filePath).length >= 2);
});
test('orders stay read-only and private pages expose no save, share or raw-JSON rendering controls', async () => {
  const row = record('orders');
  const r = nativeRuntime('admin-console/detail/index.js', async action => { assert.equal(action, 'orders.detail'); return row; });
  r.page.onLoad(options('orders', row)); await r.page.onShow(); await r.page.prepareWrite(event({ command: 'approve' }));
  assert.equal(ops(r).length, 1); assert.equal(r.page.data.canApprove, false);
  assert.equal(r.page.onShareAppMessage, undefined); assert.equal(r.page.onShareTimeline, undefined);
  const markup = fs.readFileSync(path.join(miniprogramRoot, 'admin-console/detail/index.wxml'), 'utf8');
  assert.match(markup, /show-menu-by-longpress="\{\{false\}\}"/);
  assert.doesNotMatch(markup, /<web-view|open-type="share"|JSON\.stringify|saveImageToPhotosAlbum/);
});
