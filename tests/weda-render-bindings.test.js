'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Observable runtimes warn and stop tracking out-of-range indices even when a
// surrounding conditional hides a row. Exercise every binding independently.
function observed(array) {
  return new Proxy(array, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= target.length) throw new Error('Observable index out of bounds');
    return Reflect.get(target, key, receiver);
  } });
}
function model(hasRow) {
  return { loading: false, writing: false, detailLoading: false, evidenceLoading: false,
    rows: observed(hasRow ? [{ cells: observed(['fixture']), key: { id: 1 } }] : []),
    materials: observed(hasRow ? [{ label: 'fixture' }] : []), detail: hasRow ? { kind: 'identity' } : null,
    selected: hasRow ? { id: 1, kind: 'identity' } : null, confirmation: null, material: null, evidenceText: '' };
}
function cockpit() {
  return { metrics: observed(Array(6).fill('0')), memberCounts: observed(Array(4).fill('0')),
    matchmakerCounts: observed(Array(3).fill('0')), mixRows: observed([]), ranking: observed([]),
    memberTrend: [], revenueTrend: [], productPie: [] };
}
const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../weda-admin/app.cals.json'), 'utf8'));

for (const hasRow of [false, true]) test(`every native page binding avoids observable out-of-range reads with ${hasRow ? 'one short row' : 'no rows'}`, () => {
  let checked = 0;
  for (const page of app.items) {
    const $page = { dataset: { state: { ops: model(hasRow), cockpit: cockpit(), loading: false, error: '' } } };
    function walk(node) {
      const expressions = [...Object.entries(node.attributes || {}), ...Object.entries(node.directives || {})].filter(([key]) => key.startsWith(':'));
      for (const [key, expression] of expressions) {
        assert.doesNotThrow(() => new Function('$page', `return (${expression});`)($page), `${page.id}/${node.id}/${key}`);
        checked++;
      }
      for (const child of node.items || []) walk(child);
    }
    walk(page);
  }
  assert.ok(checked > 600);
});
