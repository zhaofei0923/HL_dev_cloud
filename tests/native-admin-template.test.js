'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('every native admin template binding parses as an expression, including inactive subpackage branches', () => {
  const files = ['pages/admin/portal.wxml', 'admin-console/workspace/index.wxml', 'admin-console/detail/index.wxml'];
  let expressions = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, '../miniprogram', file), 'utf8');
    for (const binding of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      expressions++;
      assert.doesNotThrow(() => new vm.Script('(' + binding[1] + ')'), file + ': ' + binding[0]);
    }
  }
  assert.ok(expressions > 100, 'all three pages and their conditional bindings must be included');
});
