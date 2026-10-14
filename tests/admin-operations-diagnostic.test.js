'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { validationDiagnostic: diagnostic } = require('../cloudfunctions/hlAdminOperations/validation-diagnostic');
const { businessRequest } = require('../cloudfunctions/hlAdminOperations/request-envelope');

test('business envelope rejects unsupported shapes and business accessors without invoking getters', () => {
  for (const value of [null, [], Object.create({}), vm.runInNewContext('({})')]) {
    assert.throws(() => businessRequest(value), error => error.code === 42260 && diagnostic('envelope', error) === 'ENVELOPE_SHAPE');
  }
  let getterCalls = 0;
  for (const key of ['action', 'args', 'requestId']) {
    assert.throws(() => businessRequest(Object.defineProperty({}, key, { get() { getterCalls++; throw new Error('private'); } })),
      error => error.code === 42260 && diagnostic('envelope', error) === 'ENVELOPE_ACCESSOR');
  }
  assert.equal(getterCalls, 0);
});

test('business projection never enumerates or reads unknown transport fields and does not forward them', () => {
  let getterCalls = 0;
  const args = { page: 1, pageSize: 10 };
  const event = { action: 'plans.list', args, requestId: 'test-operation', userInfo: { token: 'canary' },
    requestContext: 'canary', ['canary-private-key-name']: 'canary-private-value', [Symbol('canary')]: true };
  Object.defineProperty(event, 'accessToken', { get() { getterCalls++; throw new Error('private'); } });
  const projected = businessRequest(new Proxy(event, { ownKeys() { throw new Error('must not enumerate transport'); } }));
  assert.deepEqual(projected, { action: 'plans.list', args, requestId: 'test-operation' });
  assert.equal(projected.args, args);
  assert.equal(JSON.stringify(projected).includes('canary'), false);
  assert.equal(getterCalls, 0);
  assert.deepEqual(businessRequest(Object.assign(Object.create(null), { action: 'plans.list' })), { action: 'plans.list' });
});

test('business validation diagnostic uses a fixed message map and never returns arbitrary failure fields', () => {
  assert.equal(diagnostic('business', new Error('套餐启停筛选须为布尔值')), 'ARGS_ACTIVE');
  assert.equal(diagnostic('business', new Error('分页参数无效')), 'ARGS_PAGE');
  assert.equal(diagnostic('business', new Error('canary-private-error')), 'BUSINESS_VALIDATION');
  assert.equal(diagnostic('envelope', { diagnosticCode: 'canary-private-code' }), 'ENVELOPE_FORMAT');
  assert.equal(diagnostic('untrusted-canary', {}), 'VALIDATION_UNCLASSIFIED');
});
