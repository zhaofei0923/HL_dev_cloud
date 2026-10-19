const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../scripts/enable-formal-payment.mjs');
const environment = () => ({ VPAY_ENV: '1', PAYMENT_INTEGRATION_READY: 'false', MATCHMAKING_PAYMENT_READY: 'false',
  PAYMENT_TEST_ENABLED: 'false', VIP_MEMBERSHIP_CATALOG_READY: 'true', VPAY_OFFER_ID: '123456789',
  VPAY_SANDBOX_APP_KEY: 'sandbox-only-fixture-key', WX_APP_SECRET: 'wx-secret-fixture-value',
  PAYMENT_CALLBACK_TOKEN: 'callback-fixture-token-with-32-characters', JWT_SECRET: 'preserve-existing-jwt', ADMIN_CODE: 'preserve-existing-admin' });

test('formal activation selects production credentials and both gates while preserving all other values', async () => {
  const { formalPatch, assertEnvironmentReadback } = await load(), before = environment();
  const patch = formalPatch(before, 'production-fixture-key');
  assert.deepEqual(patch, { VPAY_APP_KEY: 'production-fixture-key', VPAY_ENV: '0', PAYMENT_INTEGRATION_READY: 'true',
    MATCHMAKING_PAYMENT_READY: 'true', PAYMENT_TEST_ENABLED: 'false' });
  const proof = assertEnvironmentReadback(before, { ...before, ...patch }, patch);
  assert.equal(proof.environmentSha256.length, 64);
  assert.equal(before.VPAY_ENV, '1');
});
test('sandbox keys, missing base configuration, and active test windows cannot enable formal payment', async () => {
  const { formalPatch } = await load(), env = environment();
  for (const key of ['', 'short', 'key with whitespace', env.VPAY_SANDBOX_APP_KEY]) assert.throws(() => formalPatch(env, key));
  assert.throws(() => formalPatch({ ...env, PAYMENT_CALLBACK_TOKEN: '' }, 'production-fixture-key'));
  assert.throws(() => formalPatch({ ...env, PAYMENT_TEST_ENABLED: 'true' }, 'production-fixture-key'));
  assert.throws(() => formalPatch({ ...env, VIP_MEMBERSHIP_CATALOG_READY: 'false' }, 'production-fixture-key'));
});
test('readback fails when existing authentication configuration is missing or changed', async () => {
  const { formalPatch, assertEnvironmentReadback } = await load(), before = environment();
  const patch = formalPatch(before, 'production-fixture-key'), after = { ...before, ...patch };
  delete after.JWT_SECRET;
  assert.throws(() => assertEnvironmentReadback(before, after, patch), /ENVIRONMENT_READBACK_MISMATCH/);
  assert.throws(() => assertEnvironmentReadback(before, { ...before, ...patch, ADMIN_CODE: 'changed' }, patch));
  assert.throws(() => assertEnvironmentReadback(before, { ...before, NEW_KEY: 'unsafe' }, { NEW_KEY: 'unsafe' }), /PATCH_SCOPE_INVALID/);
});
test('uncompleted payment, fulfillment, delivery or review prevents environment migration', async () => {
  const { orderBlockers } = await load();
  const paid = { status: 'paid', fulfillmentStatus: 'fulfilled', paymentProvider: 'virtual', virtualPaymentEnv: 1, virtualDeliveryStatus: 'confirmed' };
  assert.equal(orderBlockers([paid, { status: 'closed', virtualPaymentEnv: 1 }], []).safeToSwitch, true);
  for (const changed of [{ status: 'pending' }, { status: 'confirming' }, { paymentReviewRequired: true },
    { fulfillmentStatus: 'requires_review' }, { fulfillmentStatus: 'pending' }, { virtualDeliveryStatus: 'pending' }]) {
    assert.equal(orderBlockers([{ ...paid, ...changed }], []).safeToSwitch, false);
  }
  assert.equal(orderBlockers([], [{ _id: 'paymentPendingUser_1', orderDocumentId: 'pending' }]).safeToSwitch, false);
  assert.equal(orderBlockers([], [{ _id: 'paymentPendingUser_1', blockedReviewDocumentId: 'review' }]).safeToSwitch, false);
  assert.throws(() => orderBlockers(new Array(1000).fill(paid), []), /READ_LIMIT_REACHED/);
});
