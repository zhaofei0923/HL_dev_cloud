const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Compile the owned source in memory; generated files remain under the root build.
function runtime(create) {
  const file = path.join(__dirname, '..', 'miniprogram', 'pages', 'matchmaker', 'salon-form.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const session = { token: 'account-a', user: { id: 1 } };
  const calls = { writes: [], toasts: [], backs: 0, warnings: [] };
  const now = Date.UTC(2026, 9, 7);
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  let definition;
  vm.runInNewContext(source, {
    exports: {}, Page: options => { definition = options; }, Date: ClockDate,
    require(name) {
      if (name.endsWith('/utils/page-session')) return {
        pageSessionScope: () => session.token ? `${session.user.id}:${session.token}` : ''
      };
      if (name.endsWith('/services/salon')) return { salonApi: {
        create(form) {
          calls.writes.push(structuredClone(form));
          return create ? create(form, calls.writes.length) : Promise.resolve({ id: 7 });
        }
      } };
      throw new Error(`Unmocked import ${name}`);
    },
    wx: {
      showToast: options => calls.toasts.push(options.title),
      navigateBack: () => { calls.backs += 1; }
    },
    console: { warn: (...values) => calls.warnings.push(values) }
  }, { filename: file });
  const page = { ...definition, data: structuredClone(definition.data), setData(update) {
    for (const [key, value] of Object.entries(update)) {
      const parts = key.split('.');
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = structuredClone(value);
    }
  } };
  page.onLoad();
  page.onShow();
  return { page, session, calls, now };
}

function fill(page, title = '待审核活动') {
  page.onInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: title } });
  page.onInput({ currentTarget: { dataset: { field: 'location' } }, detail: { value: '会客厅' } });
}

test('current form creates once, preserves future local time and navigates on current success', async () => {
  const pending = deferred();
  const { page, calls, now } = runtime(() => pending.promise);
  assert.ok(new Date(page.data.form.eventDate).getTime() > now);
  page.onDateChange({ detail: { value: '2026-10-09' } });
  page.onTimeChange({ detail: { value: '10:30' } });
  const local = new Date(page.data.form.eventDate);
  assert.equal(local.getHours(), 10);
  assert.equal(local.getMinutes(), 30);
  fill(page);
  const first = page.save();
  await page.save();
  assert.equal(calls.writes.length, 1);
  assert.equal(page.data.saving, true);
  pending.resolve({ id: 7 });
  await first;
  assert.deepEqual(calls.toasts, ['已提交审核']);
  assert.equal(calls.backs, 1);
  assert.equal(page.data.saving, false);
});

test('leaving or unloading discards old completion and immediately releases progress', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const pending = deferred();
    const { page, calls } = runtime(() => pending.promise);
    fill(page);
    const saving = page.save();
    page[lifecycle]();
    assert.equal(page.data.saving, false);
    pending.resolve({ id: 7 });
    await saving;
    assert.equal(calls.backs, 0);
    assert.equal(calls.toasts.length, 0);
    await page.save();
    assert.equal(calls.writes.length, 1, 'a hidden form cannot start a new request');
  }
});

test('returning retains same-account draft and old completion cannot unlock a newer save', async () => {
  const older = deferred(), newer = deferred();
  const { page, calls } = runtime((_form, count) => count === 1 ? older.promise : newer.promise);
  fill(page, '保留的草稿');
  const first = page.save();
  page.onHide();
  page.onShow();
  assert.equal(page.data.form.title, '保留的草稿');
  assert.equal(page.data.saving, false);
  const second = page.save();
  assert.equal(calls.writes.length, 2);
  older.resolve({ id: 7 });
  await first;
  assert.equal(page.data.saving, true);
  assert.equal(calls.backs, 0);
  assert.equal(calls.toasts.length, 0);
  newer.resolve({ id: 8 });
  await second;
  assert.equal(page.data.saving, false);
  assert.equal(calls.backs, 1);
});

test('changed account rejects old response even before onShow and clears old draft on return', async () => {
  const pending = deferred();
  const { page, session, calls, now } = runtime(() => pending.promise);
  fill(page, '甲账号草稿');
  const saving = page.save();
  session.token = 'account-b'; session.user = { id: 2 };
  pending.resolve({ id: 7 });
  await saving;
  assert.equal(calls.backs, 0);
  assert.equal(calls.toasts.length, 0);
  page.onShow();
  assert.equal(page.data.saving, false);
  assert.equal(page.data.form.title, '');
  assert.equal(page.data.form.location, '');
  assert.ok(new Date(page.data.form.eventDate).getTime() > now);
});

test('renewed credentials or logout discard old result and cannot submit the previous draft', async () => {
  for (const token of ['account-a-renewed', '']) {
    const pending = deferred();
    const { page, session, calls } = runtime(() => pending.promise);
    fill(page);
    const saving = page.save();
    session.token = token;
    page.onShow();
    pending.resolve({ id: 7 });
    await saving;
    assert.equal(calls.backs, 0);
    assert.equal(page.data.saving, false);
    assert.equal(page.data.form.title, '');
    await page.save();
    assert.equal(calls.writes.length, 1);
  }
});

test('current failure allows retry while obsolete failure cannot mutate a newer request', async () => {
  let attempt = 0;
  const current = runtime(() => ++attempt === 1 ? Promise.reject(new Error('network failed')) : Promise.resolve({ id: 8 }));
  fill(current.page);
  await current.page.save();
  assert.equal(current.page.data.saving, false);
  assert.equal(current.calls.backs, 0);
  await current.page.save();
  assert.equal(current.calls.writes.length, 2);
  assert.equal(current.calls.backs, 1);

  const older = deferred(), newer = deferred();
  const { page, calls } = runtime((_form, count) => count === 1 ? older.promise : newer.promise);
  fill(page);
  const first = page.save();
  page.onHide(); page.onShow();
  const second = page.save();
  older.reject(new Error('obsolete failure'));
  await first;
  assert.equal(page.data.saving, true);
  assert.equal(calls.warnings.length, 0);
  newer.resolve({ id: 8 });
  await second;
  assert.equal(calls.backs, 1);
});
