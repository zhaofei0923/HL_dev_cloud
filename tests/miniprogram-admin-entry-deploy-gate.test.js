'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const deploy = import('../scripts/deploy-miniprogram-admin-entry.mjs');

test('entry deployment requires verified recovery health and an exact current environment digest', async () => {
  const { recoveryGate } = await deploy;
  const recovery = { status: 'restored_verified', healthPassed: true, envId: 'cloud1-d2gza7q9c8d69c721',
    functionName: 'hlApi', configurationSha256: 'a'.repeat(64) };
  assert.doesNotThrow(() => recoveryGate(recovery, 'a'.repeat(64)));
  assert.throws(() => recoveryGate({ ...recovery, healthPassed: false }, 'a'.repeat(64)), /RECOVERY_NOT_VERIFIED/);
  assert.throws(() => recoveryGate({ ...recovery, status: 'incomplete' }, 'a'.repeat(64)), /RECOVERY_NOT_VERIFIED/);
  assert.throws(() => recoveryGate(recovery, 'b'.repeat(64)), /CURRENT_ENVIRONMENT_DIFFERS_FROM_RECOVERY/);
});
