const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'weda-admin', 'operations-runtime.js'), 'utf8');
let number = 0;
const version = character => 'v1_' + character.repeat(64);
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const reply = data => ({ result: { code: 0, data } });
const list = (rows = [{ id: 1 }, { id: 2 }], page = 1, total = rows.length) => ({ list: rows, total, page, pageSize: 10 });
const detail = (id = 1, extra = {}) => ({ id, version: version(id === 1 ? 'a' : 'b'), canReview: true, user: { nickname: '测试姓名', phone: 'fixture-private-phone' }, ...extra });
async function harness(pageId, fn, run) {
  const runtime = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#operations-' + ++number);
  const previous = Object.getOwnPropertyDescriptor(globalThis, '$w');
  const state = {};
  const requests = [];
  const page = { id: pageId, __internal__: { active: true }, setState(value) { Object.assign(state, value); } };
  Object.defineProperty(globalThis, '$w', { configurable: true, writable: true, value: { page, cloud: { async callFunction(request) { requests.push(structuredClone(request)); return fn(request.data, requests.length); } } } });
  const command = (command, target = {}, eventValue) => runtime.default({ data: { target: { command, ...target } }, ...(eventValue !== undefined ? { event: { detail: { value: eventValue } } } : {}) });
  try { return await run({ runtime, state, page, requests, command }); }
  finally { if (previous) Object.defineProperty(globalThis, '$w', previous); else delete globalThis.$w; }
}

test('operation reads use the fixed function, pagination/filter contract and fresh detail version', async () => {
  await harness('matchmakers', ({ action, args }) => reply(action.endsWith('.list') ? list([{ id: 1, memberCount: 0 }], args.page, 21) : detail()), async ({ state, requests, command }) => {
    await command('init');
    assert.equal(state.ops.rows[0].cells[3], '0');
    await command('edit', { field: 'keyword' }, '测试');
    await command('query');
    await command('next');
    assert.equal(state.ops.page, 2);
    await command('filter', { value: '1' });
    await command('select', { index: 0 });
    assert.equal(state.ops.detail.version, version('a'));
    assert.match(state.ops.detailText, /fixture-private-phone/);
    assert.ok(requests.every(r => r.name === 'hlAdminOperations'));
    assert.deepEqual(requests.at(-2).data.args, { page: 1, pageSize: 10, keyword: '测试', status: 1 });
    assert.deepEqual(requests.at(-1).data.args, { id: 1 });
    assert.ok(requests.every(r => Object.keys(r.data).sort().join(',') === 'action,args,requestId'));
    assert.ok(requests.every(r => /^[0-9a-f-]{36}$/.test(r.data.requestId)));
  });
});

test('prepare is local only, explicit confirmation writes once and duplicate clicks cannot resubmit', async () => {
  const pending = deferred();
  await harness('matchmakers', ({ action }) => action.endsWith('.review') ? pending.promise : Promise.resolve(reply(action.endsWith('.list') ? list() : detail())), async ({ state, requests, command }) => {
    await command('init'); await command('select', { index: 0 });
    await command('edit', { field: 'remark' }, '核验通过');
    await command('prepare', { operation: 'approve' });
    assert.equal(requests.length, 2);
    assert.equal(state.ops.confirmation.args.expectedVersion, version('a'));
    const write = command('submit'); await command('submit');
    assert.equal(requests.filter(r => r.data.action.endsWith('.review')).length, 1);
    assert.deepEqual(requests.at(-1).data.args, { id: 1, expectedVersion: version('a'), certificationStatus: 2, remark: '核验通过' });
    pending.resolve(reply({ version: version('b') })); await write;
    assert.equal(state.ops.detail, null);
    assert.equal(state.ops.confirmation, null);
  });
});

test('uncertain write retries retain the same requestId and immutable payload', async () => {
  let writes = 0;
  await harness('matchmakers', ({ action }) => {
    if (action.endsWith('.review')) { if (++writes === 1) throw new Error('fixture-network-error'); return reply({ version: version('b') }); }
    return reply(action.endsWith('.list') ? list() : detail());
  }, async ({ state, requests, command }) => {
    await command('init'); await command('select', { index: 0 });
    await command('edit', { field: 'remark' }, '拒绝原因'); await command('prepare', { operation: 'reject' });
    await command('submit'); assert.ok(state.ops.confirmation);
    await command('edit', { field: 'remark' }, '不允许改变确认中的草稿');
    await command('submit');
    const writeRequests = requests.filter(r => r.data.action.endsWith('.review'));
    assert.equal(writeRequests.length, 2);
    assert.deepEqual(writeRequests[0], writeRequests[1]);
  });
});

test('switching selection drops drafts and ignores stale detail responses or versions', async () => {
  const one = deferred(); const two = deferred();
  await harness('matchmakers', ({ action, args }) => action.endsWith('.list') ? reply(list()) : args.id === 1 ? one.promise : two.promise, async ({ state, command }) => {
    await command('init'); const first = command('select', { index: 0 }); const second = command('select', { index: 1 });
    two.resolve(reply(detail(2))); await second;
    await command('prepare', { operation: 'approve' });
    one.resolve(reply(detail(1))); await first;
    assert.equal(state.ops.detail.id, 2);
    assert.equal(state.ops.confirmation.args.id, 2);
    assert.equal(state.ops.confirmation.args.expectedVersion, version('b'));
    await command('query');
    assert.equal(state.ops.detail, null); assert.equal(state.ops.confirmation, null);
    await command('submit');
  });
});

test('logout/clear invalidates in-flight data and removes private details before another page becomes active', async () => {
  const pending = deferred();
  await harness('matchmakers', ({ action }) => action.endsWith('.list') ? reply(list()) : pending.promise, async ({ state, page, runtime, command, requests }) => {
    await command('init'); const reading = command('select', { index: 0 });
    globalThis.$w.page = { id: 'orders' };
    await runtime.default({ cleanupPage: page, data: { target: { command: 'clear' } } });
    pending.resolve(reply(detail())); await reading;
    assert.equal(state.ops.detail, null); assert.equal(state.ops.detailText, ''); assert.equal(state.ops.material, null); assert.deepEqual(state.ops.rows, []);
    globalThis.$w.page = page; await command('submit');
    assert.equal(requests.length, 2);
  });
});

test('403 and stale-version failures clear private state and disable writes until a new detail read', async () => {
  for (const code of [40360, 40960]) {
    await harness('matchmakers', ({ action }) => action.endsWith('.review') ? { result: { code, message: 'fixture-private-error' } } : reply(action.endsWith('.list') ? list() : detail()), async ({ state, requests, command }) => {
      await command('init'); await command('select', { index: 0 }); await command('prepare', { operation: 'approve' }); await command('submit');
      assert.equal(state.ops.detail, null); assert.equal(state.ops.confirmation, null); assert.equal(state.ops.canApprove, false); assert.equal(state.ops.material, null);
      assert.doesNotMatch(state.ops.error, /fixture-private-error/);
      const length = requests.length; await command('submit'); assert.equal(requests.length, length);
    });
  }
});

test('plans show canonical money, never submit price/title and toggle only after confirmation', async () => {
  await harness('plans', ({ action }) => reply(action.endsWith('.list') ? list([{ planCode: 'vip_week', amountFen: 6160, active: true }]) : action.endsWith('.detail') ? { planCode: 'vip_week', version: version('a'), amountFen: 6160, active: true, canUpdate: true, priceEditable: false } : { version: version('b') }), async ({ runtime, state, requests, command }) => {
    await command('init'); assert.equal(state.ops.rows[0].cells[2], '61.60'); await command('select', { index: 0 });
    await command('prepare', { operation: 'price' }); assert.equal(state.ops.confirmation, null);
    await command('prepare', { operation: 'toggle' }); assert.equal(requests.length, 2);
    await command('submit');
    const write = requests.find(r => r.data.action === 'plans.update');
    assert.deepEqual(write.data.args, { planCode: 'vip_week', expectedVersion: version('a'), active: false });
    assert.equal(runtime.amountYuanToFen('61.60'), 6160); assert.equal(runtime.amountYuanToFen('0.01'), 1);
    for (const bad of ['1.001', '1e3', '-1', 'NaN', '0', '1000000.01']) assert.equal(runtime.amountYuanToFen(bad), null);
  });
});

test('certification evidence and one selected material require explicit requests and clear on selection changes', async () => {
  const row = { userId: 1, kind: 'identity', applicationId: 'app-fixture', canView: true };
  const cert = { ...row, version: version('a'), canReview: true, materials: [{ id: 'material-fixture', mimeType: 'image/png' }] };
  await harness('certifications', ({ action, args }) => {
    if (action.endsWith('.list')) return reply(list([row]));
    if (action.endsWith('.detail')) return reply(cert);
    assert.equal(args.expectedVersion, version('a'));
    return reply(action.endsWith('.material') ? { id: 'material-fixture', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=' } : { verificationCode: 'fixture-sensitive-code' });
  }, async ({ state, requests, command }) => {
    await command('init'); await command('select', { index: 0 });
    assert.equal(requests.length, 2); assert.equal(state.ops.material, null); assert.equal(state.ops.evidenceText, '');
    await command('evidence'); assert.match(state.ops.evidenceText, /fixture-sensitive-code/);
    await command('material', { index: 0 }); assert.match(state.ops.material.src, /^data:image\/png;base64,/);
    assert.deepEqual(requests.at(-1).data.args, { userId: 1, kind: 'identity', applicationId: 'app-fixture', expectedVersion: version('a'), materialId: 'material-fixture' });
    await command('closeMaterial'); assert.equal(state.ops.material, null); assert.equal(state.ops.evidenceText, '');
    await command('select', { index: 0 }); assert.equal(state.ops.evidenceText, '');
  });
});

test('certification approval validates type-specific evidence and never copies internal remarks into public feedback', async () => {
  const row = { userId: 1, kind: 'education', applicationId: 'app-fixture', canView: true };
  await harness('certifications', ({ action }) => reply(action.endsWith('.list') ? list([row]) : { ...row, version: version('a'), canReview: true }), async ({ state, requests, command }) => {
    await command('init'); await command('select', { index: 0 }); await command('prepare', { operation: 'approve' });
    assert.equal(state.ops.confirmation, null);
    await command('edit', { field: 'remark' }, '内部核验备注'); await command('prepare', { operation: 'reject' }); assert.equal(state.ops.confirmation, null);
    await command('edit', { field: 'evidenceReference' }, 'fixture-reference'); await command('choose', { field: 'educationLevel', value: '本科' });
    await command('prepare', { operation: 'approve' });
    assert.equal(state.ops.confirmation.args.source, 'chsi');
    assert.equal(state.ops.confirmation.args.feedback, '');
    assert.equal(state.ops.confirmation.args.remark, '内部核验备注');
    assert.doesNotMatch(state.ops.confirmation.summary, /v1_[a-f0-9]{64}|chsi/);
    assert.match(state.ops.confirmation.summary, /学信网|提交时将核对资料是否更新/);
    assert.equal(requests.length, 2);
  });
});

test('Chinese certification choices map to strict internal enums and invalid or frozen choices do not change drafts', async () => {
  const row = { userId: 1, kind: 'assets', applicationId: 'fixture-assets', canView: true };
  await harness('certifications', ({ action }) => reply(action.endsWith('.list') ? list([row]) : { ...row, version: version('a'), canReview: true }), async ({ state, command }) => {
    await command('init'); await command('select', { index: 0 });
    await command('choose', { field: 'source', value: 'insurance_statement' }); await command('choose', { field: 'financialAssetRange', value: '2m_5m' });
    assert.equal(state.ops.sourceLabel, '保险现金价值'); assert.equal(state.ops.assetRangeLabel, '200万–500万');
    await command('choose', { field: 'uid', value: 'administrator' }); await command('choose', { field: 'educationLevel', value: '博士' }); await command('choose', { field: 'source', value: 'chsi' });
    assert.equal(state.ops.source, 'insurance_statement'); assert.equal(state.ops.educationLevel, ''); assert.equal(state.ops.uid, undefined);
    await command('edit', { field: 'evidenceReference' }, 'fixture-reference'); await command('prepare', { operation: 'approve' });
    assert.equal(state.ops.confirmation.args.financialAssetRange, '2m_5m'); assert.match(state.ops.confirmation.summary, /保险现金价值|200万–500万/);
    await command('choose', { field: 'financialAssetRange', value: 'under_500k' }); assert.equal(state.ops.financialAssetRange, '2m_5m');
    assert.doesNotMatch(state.ops.detailText, /v1_[a-f0-9]{64}/);
  });
});

test('invalid detail identity or missing version fails closed and cannot create a write confirmation', async () => {
  for (const value of [{ id: 2, version: version('a'), canReview: true }, { id: 1, canReview: true }]) {
    await harness('matchmakers', ({ action }) => reply(action.endsWith('.list') ? list() : value), async ({ state, requests, command }) => {
      await command('init'); await command('select', { index: 0 }); await command('prepare', { operation: 'approve' }); await command('submit');
      assert.equal(state.ops.detail, null); assert.equal(state.ops.confirmation, null); assert.equal(requests.length, 2);
    });
  }
});

test('orders remain read only, show pending as awaiting payment and accept detail without a mutation version', async () => {
  const order = { outTradeNo: 'fixture-order', amountFen: 6160, status: 'pending', user: { nickname: '测试会员' } };
  await harness('orders', ({ action }) => reply(action.endsWith('.list') ? list([order]) : order), async ({ state, requests, command }) => {
    await command('init'); assert.equal(state.ops.rows[0].cells[4], '待支付');
    await command('select', { index: 0 }); assert.equal(state.ops.detail.outTradeNo, 'fixture-order');
    assert.match(state.ops.detailText, /支付状态：待支付/);
    for (const operation of ['approve', 'reject', 'revoke', 'cancel', 'toggle']) await command('prepare', { operation });
    await command('submit'); assert.equal(requests.length, 2); assert.equal(state.ops.confirmation, null);
  });
});

test('certification rows without canView never load private details', async () => {
  await harness('certifications', () => reply(list([{ userId: 1, kind: 'identity', applicationId: 'fixture-inactive', canView: false } ])), async ({ state, requests, command }) => {
    await command('init'); assert.equal(state.ops.rows[0].key, null);
    await command('select', { index: 0 }); assert.equal(requests.length, 1); assert.equal(state.ops.detail, null);
  });
});

test('PDF material uses only a scoped Blob, and changing selection closes its viewer and revokes the URL', async t => {
  const created = []; const revoked = []; let closed = 0;
  t.mock.method(URL, 'createObjectURL', blob => { created.push(blob); return 'blob:fixture-pdf'; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { open(url) { assert.equal(url, 'blob:fixture-pdf'); return { close() { closed++; } }; } } });
  const row = { userId: 1, kind: 'identity', applicationId: 'fixture-pdf', canView: true };
  try {
    await harness('certifications', ({ action }) => reply(action.endsWith('.list') ? list([row]) : action.endsWith('.detail') ? { ...row, version: version('a'), materials: [{ id: 'pdf' }] } : { id: 'pdf', mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjQ=' }), async ({ state, command }) => {
      await command('init'); await command('select', { index: 0 }); await command('material', { index: 0 });
      assert.equal(state.ops.material.pdf, true); assert.equal(state.ops.material.src, ''); assert.equal(created[0].type, 'application/pdf');
      await command('openPdf'); await command('query');
      assert.deepEqual(revoked, ['blob:fixture-pdf']); assert.equal(closed, 1); assert.equal(state.ops.material, null);
    });
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
});

test('a material response arriving after deselection cannot restore private image content', async () => {
  const pending = deferred(); const row = { userId: 1, kind: 'identity', applicationId: 'fixture-image', canView: true };
  await harness('certifications', ({ action }) => action.endsWith('.material') ? pending.promise : reply(action.endsWith('.list') ? list([row]) : { ...row, version: version('a'), materials: [{ id: 'image' }] }), async ({ state, command }) => {
    await command('init'); await command('select', { index: 0 }); const material = command('material', { index: 0 });
    await command('query'); pending.resolve(reply({ mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=' })); await material;
    assert.equal(state.ops.material, null); assert.equal(state.ops.detail, null);
  });
});

test('closing evidence invalidates a deferred response and repeated clicks do not duplicate the private read', async () => {
  const pending = deferred(); const row = { userId: 1, kind: 'identity', applicationId: 'fixture-evidence', canView: true };
  await harness('certifications', ({ action }) => action.endsWith('.evidence') ? pending.promise : reply(action.endsWith('.list') ? list([row]) : { ...row, version: version('a') }), async ({ state, requests, command }) => {
    await command('init'); await command('select', { index: 0 }); const reading = command('evidence');
    assert.equal(state.ops.evidenceLoading, true); await command('evidence'); assert.equal(requests.filter(r => r.data.action.endsWith('.evidence')).length, 1);
    await command('closeMaterial'); pending.resolve(reply({ verificationCode: 'fixture-must-not-return' })); await reading;
    assert.equal(state.ops.evidenceText, ''); assert.equal(state.ops.evidenceLoading, false); assert.equal(state.ops.material, null);
  });
});

test('new evidence request after closing wins over an older response on the same selected application', async () => {
  const old = deferred(); const recent = deferred(); let calls = 0;
  const row = { userId: 1, kind: 'identity', applicationId: 'fixture-evidence', canView: true };
  await harness('certifications', ({ action }) => action.endsWith('.evidence') ? ++calls === 1 ? old.promise : recent.promise : reply(action.endsWith('.list') ? list([row]) : { ...row, version: version('a') }), async ({ state, command }) => {
    await command('init'); await command('select', { index: 0 }); const first = command('evidence'); await command('closeMaterial'); const second = command('evidence');
    recent.resolve(reply({ verificationCode: 'fixture-current' })); await second;
    old.resolve(reply({ verificationCode: 'fixture-old' })); await first;
    assert.match(state.ops.evidenceText, /fixture-current/); assert.doesNotMatch(state.ops.evidenceText, /fixture-old/);
  });
});
