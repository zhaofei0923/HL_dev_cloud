'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const moduleUnderTest = import('../scripts/repair-admin-entry-compatibility.mjs');

test('only the verified environmental-COS CodeConfig failure is eligible for repair', async () => {
  const { allowedRepairStatus } = await moduleUnderTest;
  const failure = { Status: 'UpdateFailed', StatusReasons: [{ ErrorCode: 'InvalidParameterValue.CodeConfig',
    ErrorMessage: 'format codeCosInfo failed: get baseCodeCosInfo tmp token failed assume role failed' }] };
  assert.equal(allowedRepairStatus(failure), true);
  assert.equal(allowedRepairStatus({ Status: 'Active' }), true);
  assert.equal(allowedRepairStatus({ ...failure, Status: 'Updating' }), false);
  assert.equal(allowedRepairStatus({ ...failure, StatusReasons: [{ ErrorCode: 'Other', ErrorMessage: 'different' }] }), false);
});

test('native TempCos upload passes the signed authorization only in memory and code request uses TempCosObjectName', async () => {
  const { tempCosUploadPlan, repairCodeArguments } = await moduleUnderTest;
  const plan = tempCosUploadPlan({ appId: '1234567890', env: 'cloud1-d2gza7q9c8d69c721', namespace: 'cloud1-d2gza7q9c8d69c721' },
    { Date: '2026-10-15', Sign: 'isolated-not-real-fixture-authorization' });
  assert.equal(plan.key, '/2026-10-15/1234567890/cloud1-d2gza7q9c8d69c721/hlApi.zip');
  assert.equal(plan.headers.Authorization, 'isolated-not-real-fixture-authorization');
  const args = repairCodeArguments(plan.key);
  assert.deepEqual(args.code, { CosBucketRegion: 'ap-shanghai', TempCosObjectName: plan.key });
  assert.equal(args.func.installDependency, false);
  assert.doesNotMatch(JSON.stringify(args), /authorization|envVariables|CosBucketName/);
});
