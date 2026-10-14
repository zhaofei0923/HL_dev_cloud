const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'weda-admin', 'cockpit-runtime.js'), 'utf8');
let moduleNumber = 0;

// The native Weda resource is ESM while this repository's Node tests are CJS.
// Import the actual, unmodified source; each test gets its own request counter.
function runtime() {
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return import(url + '#cockpit-runtime-test-' + ++moduleNumber);
}

function data(overrides = {}) {
  return {
    asOf: '2026-10-14T02:15:00.000Z',
    period: { days: 30, startAt: '2026-09-15T00:00:00+08:00', endAt: '2026-10-14T02:15:00.000Z', timeZone: 'Asia/Shanghai' },
    members: { total: 0, newCount: null, vip: 0, ordinary: null, verified: null, publicCount: 0, trend: [], quality: { warnings: [] } },
    matchmakers: { approved: 0, pending: null, rejected: 0, active30d: null, ranking: [] },
    revenue: { paidFen: 0, refundFen: null, netFen: null, paidTransactions: 0, refundTransactions: null, trend: [], products: [], quality: { productsComplete: true, warnings: [] } },
    quality: { warnings: [] },
    ...overrides,
  };
}

function success(value = data()) {
  return { result: { code: 0, data: value } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function withWeda(callFunction, run, initialState = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '$w');
  const state = { ...initialState };
  const updates = [];
  const requests = [];
  const page = { id: 'overview', setState(update) { updates.push(update); Object.assign(state, update); } };
  const api = { page, cloud: { callFunction(request) { requests.push(request); return callFunction(request); } } };
  Object.defineProperty(globalThis, '$w', { configurable: true, writable: true, value: api });
  try {
    return await run({ page, state, updates, requests });
  } finally {
    if (previous) Object.defineProperty(globalThis, '$w', previous);
    else delete globalThis.$w;
  }
}

test('cockpit formatting distinguishes verified zero from null, missing and invalid values', async () => {
  const { formatCount, formatFen } = await runtime();
  assert.equal(formatCount(0), '0');
  assert.equal(formatFen(0), '0.00');
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatFen(123456), '1,234.56');
  for (const value of [null, undefined, '', '0', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatCount(value), '—');
    assert.equal(formatFen(value), '—');
  }
  assert.equal(formatFen(-150, true), '-1.50');
});

test('cockpit metrics preserve unknown counts and money without replacing them with zero', async () => {
  const { createCockpitView } = await runtime();
  const view = createCockpitView(data());
  assert.deepEqual(view.metrics, ['0', '—', '0', '0.00', '—', '—']);
  assert.deepEqual(view.memberCounts, ['0', '—', '—', '0']);
  assert.deepEqual(view.matchmakerCounts, ['0', '—', '—']);
  assert.equal(view.pendingMatchmakers, '待审核 —');
  assert.equal(view.mixEmptyLabel, '本期无已核验实付');
  assert.equal(view.hasProductPie, false);
  assert.match(view.qualityText, /— 表示暂不可统计，0 表示已核实零值/);
});

test('native Line and Pie data use XLabel and YLabels arrays, preserving zero and null gaps', async () => {
  const { createCockpitView } = await runtime();
  const input = data();
  input.members.trend = [
    { date: '2026-10-12', newCount: 0, cumulative: 2 },
    { date: '2026-10-13', newCount: null, cumulative: null },
    { date: '2026-02-30', newCount: 100, cumulative: 100 },
    { date: 'invalid', newCount: 100, cumulative: 100 },
  ];
  input.revenue.trend = [{ date: '2026-10-12', paidFen: 0, refundFen: null, netFen: -150 }];
  input.revenue.paidFen = 12345;
  input.revenue.products = [
    { code: 'a', title: '测试套餐甲', paidFen: 10000 },
    { code: 'b', title: '测试套餐乙', paidFen: 2345 },
    { code: 'zero', title: '测试零金额', paidFen: 0 },
  ];
  const view = createCockpitView(input);
  assert.deepEqual(view.memberTrend, [
    { date: '2026-10-12', XLabel: { Name: 'date', Value: '10-12' }, YLabels: [{ Name: 'newCount', Cn_Name: '新增会员', Value: 0 }, { Name: 'cumulative', Cn_Name: '累计建档', Value: 2 }] },
    { date: '2026-10-13', XLabel: { Name: 'date', Value: '10-13' }, YLabels: [{ Name: 'newCount', Cn_Name: '新增会员', Value: null }, { Name: 'cumulative', Cn_Name: '累计建档', Value: null }] },
  ]);
  assert.deepEqual(view.revenueTrend, [
    { date: '2026-10-12', XLabel: { Name: 'date', Value: '10-12' }, YLabels: [{ Name: 'paidFen', Cn_Name: '实付金额', Value: 0 }, { Name: 'refundFen', Cn_Name: '退款金额', Value: null }, { Name: 'netFen', Cn_Name: '净收款', Value: -1.5 }] },
  ]);
  assert.deepEqual(view.productPie, [
    { XLabel: { Name: 'product', Value: '测试套餐甲' }, YLabels: [{ Name: 'paidFen', Cn_Name: '实付金额', Value: 100 }] },
    { XLabel: { Name: 'product', Value: '测试套餐乙' }, YLabels: [{ Name: 'paidFen', Cn_Name: '实付金额', Value: 23.45 }] },
  ]);
  assert.deepEqual(view.productColors, ['#A35D45', '#4C6C5E']);
  assert.equal(view.hasMemberTrend, true);
  assert.equal(view.hasRevenueTrend, true);
  assert.equal(view.hasProductPie, true);
});

test('long trends retain all daily points and ISO dates with at most eight short labels including both ends', async () => {
  const { createCockpitView } = await runtime();
  for (const days of [7, 30, 90]) {
    const input = data();
    input.members.trend = Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 17 + i)).toISOString().slice(0, 10), newCount: i === 1 ? null : i, cumulative: 100 + i }));
    const rows = createCockpitView(input).memberTrend;
    assert.equal(rows.length, days);
    assert.deepEqual(rows.map(row => row.date), input.members.trend.map(row => row.date));
    assert.deepEqual(rows.map(row => row.YLabels[0].Value), input.members.trend.map(row => row.newCount));
    assert.ok(rows.filter(row => row.XLabel.Value).length <= 8);
    assert.equal(rows[0].XLabel.Value, rows[0].date.slice(5));
    assert.equal(rows.at(-1).XLabel.Value, rows.at(-1).date.slice(5));
  }
});

test('all unknown trends and incomplete product classifications cannot produce apparent chart totals', async () => {
  const { createCockpitView } = await runtime();
  const input = data();
  input.members.trend = [{ date: '2026-10-14', newCount: null, cumulative: null }];
  input.revenue.trend = [{ date: '2026-10-14', paidFen: null, refundFen: null, netFen: null }];
  input.revenue.paidFen = 100;
  input.revenue.products = [{ title: '测试套餐', paidFen: 100 }];
  input.revenue.quality.productsComplete = false;
  let view = createCockpitView(input);
  assert.deepEqual(view.memberTrend, []);
  assert.deepEqual(view.revenueTrend, []);
  assert.deepEqual(view.productPie, []);
  assert.equal(view.mixRows[0].share, '— %');
  input.revenue.quality.productsComplete = true;
  input.revenue.products[0].paidFen = 99;
  assert.deepEqual(createCockpitView(input).productPie, []);
  input.revenue.products[0].paidFen = null;
  view = createCockpitView(input);
  assert.equal(view.mixRows[0].amount, '—');
  assert.deepEqual(view.productPie, []);
});

test('ranking limits rows, masks names and keeps unknown assignments distinct from zero', async () => {
  const { createCockpitView } = await runtime();
  const input = data();
  input.matchmakers.ranking = Array.from({ length: 12 }, () => ({ name: '甲测试姓名', city: '', memberCount: null, newAssignments: 0 }));
  const view = createCockpitView(input);
  assert.equal(view.ranking.length, 10);
  assert.deepEqual(view.ranking[0], { name: '甲**', city: '未填写', memberCount: '—', newAssignments: '0' });
  assert.equal(view.hasRanking, true);
});

test('loading calls only hlAdminCockpit with an allowed period and never forwards identity fields', async () => {
  const { default: loadCockpit } = await runtime();
  const periods = [7, 30, 90, 8, '7', null, undefined];
  await withWeda(async () => success(), async ({ requests, state }) => {
    for (const periodDays of periods) {
      await loadCockpit({ uid: 'fixture-do-not-forward', role: 'administrator', key: 'fixture-do-not-forward', data: { target: { periodDays, uid: 'fixture-do-not-forward' }, role: 'administrator' } });
    }
    assert.deepEqual(requests, periods.map(periodDays => ({ name: 'hlAdminCockpit', data: { periodDays: [7, 30, 90].includes(periodDays) ? periodDays : 30 } })));
    assert.equal(state.loading, false);
    assert.equal(state.error, '');
    assert.ok(state.cockpit);
  });
});

test('a 403 after success clears all stale statistics and exposes no raw server message', async () => {
  const { default: loadCockpit } = await runtime();
  const denied = deferred();
  let count = 0;
  await withWeda(() => ++count === 1 ? Promise.resolve(success()) : denied.promise, async ({ state, updates }) => {
    await loadCockpit();
    assert.ok(state.cockpit);
    const pending = loadCockpit();
    assert.deepEqual(state, { cockpit: null, loading: true, error: '' });
    denied.resolve({ result: { code: 403, message: 'fixture-private-server-detail' } });
    assert.equal(await pending, null);
    assert.equal(state.cockpit, null);
    assert.equal(state.loading, false);
    assert.match(state.error, /无权查看经营统计/);
    assert.doesNotMatch(state.error, /fixture-private-server-detail/);
    assert.deepEqual(updates.at(-2), { cockpit: null, loading: true, error: '' });
  });
});

test('an older successful response cannot overwrite a newer completed request', async () => {
  const { default: loadCockpit } = await runtime();
  const first = deferred();
  const second = deferred();
  let count = 0;
  await withWeda(() => ++count === 1 ? first.promise : second.promise, async ({ state, updates }) => {
    const older = loadCockpit({ data: { target: { periodDays: 7 } } });
    const newer = loadCockpit({ data: { target: { periodDays: 90 } } });
    const recent = data(); recent.members.total = 20; recent.period.days = 90;
    second.resolve(success(recent));
    const currentView = await newer;
    const updateCount = updates.length;
    const stale = data(); stale.members.total = 10; stale.period.days = 7;
    first.resolve(success(stale));
    assert.equal(await older, null);
    assert.equal(state.cockpit, currentView);
    assert.equal(state.cockpit.metrics[0], '20');
    assert.equal(state.cockpit.periodDays, 90);
    assert.equal(updates.length, updateCount);
  });
});

test('an old request failure cannot erase newer data and old success cannot revive data after a new 403', async () => {
  for (const oldFails of [true, false]) {
    const { default: loadCockpit } = await runtime();
    const oldRequest = deferred();
    const newRequest = deferred();
    let count = 0;
    await withWeda(() => ++count === 1 ? oldRequest.promise : newRequest.promise, async ({ state, updates }) => {
      const older = loadCockpit();
      const newer = loadCockpit();
      newRequest.resolve(oldFails ? success() : { result: { code: 403 } });
      await newer;
      const saved = { ...state };
      const updateCount = updates.length;
      if (oldFails) oldRequest.reject(new Error('fixture-old-network-error'));
      else oldRequest.resolve(success());
      assert.equal(await older, null);
      assert.deepEqual(state, saved);
      assert.equal(updates.length, updateCount);
      assert.equal(state.cockpit === null, !oldFails);
    });
  }
});

test('malformed and transport failures fail closed without turning unavailable statistics into zero', async () => {
  const { default: loadCockpit } = await runtime();
  for (const outcome of [undefined, { code: 0, data: data() }, { result: { code: 0, data: {} } }, new Error('fixture-secret-transport-message')]) {
    await withWeda(async () => { if (outcome instanceof Error) throw outcome; return outcome; }, async ({ state }) => {
      assert.equal(await loadCockpit(), null);
      assert.equal(state.cockpit, null);
      assert.equal(state.loading, false);
      assert.match(state.error, /暂时无法加载/);
      assert.doesNotMatch(state.error, /fixture-secret/);
    }, { cockpit: { metrics: ['stale'] } });
  }
});

test('loading another page does not call the function or mutate its state', async () => {
  const { default: loadCockpit } = await runtime();
  await withWeda(async () => { throw new Error('must not call'); }, async ({ page, requests, updates }) => {
    page.id = 'orders';
    assert.equal(await loadCockpit(), null);
    assert.deepEqual(requests, []);
    assert.deepEqual(updates, []);
  });
});
