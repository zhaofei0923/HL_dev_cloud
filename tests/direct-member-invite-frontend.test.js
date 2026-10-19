const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

function invitation(source, overrides = {}) {
  const requests = [];
  const instance = runtime('pages/user/matchmaker-invite.js', {
    source: true,
    memberApi: {
      resolveMatchmakerInvite: async () => ({ matchmakerNo: 'MM001', alreadyAssigned: false }),
      requestMatchmaker: async data => {
        requests.push(data);
        return { status: 'approved', alreadyAssigned: false,
          invite: { matchmakerNo: 'MM001' }, request: { id: 9, status: 'approved' } };
      },
      ...overrides
    }
  });
  return { ...instance, requests, start: () => instance.page.onLoad({ code: 'MM001', source }) };
}

test('manual and QR invitations require confirmation and become free members immediately after success', async () => {
  for (const source of ['scan', 'inviteCode', 'manual']) {
    const instance = invitation(source);
    await instance.start();
    assert.equal(instance.requests.length, 0, 'opening a manual invite does not submit without confirmation');
    assert.equal(instance.page.data.canSubmit, true);
    await instance.page.submitRequest();
    assert.equal(instance.requests.length, 1);
    assert.equal(instance.requests[0].source, source);
    assert.equal(instance.page.data.canSubmit, false);
    assert.equal(instance.page.data.invite.alreadyAssigned, true);
    assert.equal(instance.page.data.invite.existingRequest.status, 'approved');
    assert.match(instance.page.data.autoMessage, /免费会员/);
    assert.deepEqual(instance.calls.toasts, ['加入成功']);
    assert.equal(instance.calls.storage.length, 0, 'invite joining does not invent paid subscription entitlements');
    await instance.page.submitRequest();
    assert.equal(instance.requests.length, 1, 'success disables duplicate submissions');
    instance.advance(500);
    assert.equal(instance.calls.navigation[0].url, '/pages/user/profile');
  }
});

test('an old pending invitation can be retried to complete the direct join', async () => {
  const instance = invitation('inviteCode', {
    resolveMatchmakerInvite: async () => ({ alreadyAssigned: false, existingRequest: { id: 9, status: 'pending' } })
  });
  await instance.start();
  assert.equal(instance.page.data.canSubmit, true);
  await instance.page.submitRequest();
  assert.equal(instance.page.data.invite.existingRequest.status, 'approved');
  assert.equal(instance.page.data.autoDone, true);
});

test('existing membership cannot be reassigned from the manual invitation page', async () => {
  const instance = invitation('scan', {
    resolveMatchmakerInvite: async () => ({ alreadyAssigned: true, assignedMatchmakerId: 7 })
  });
  await instance.start();
  assert.equal(instance.page.data.canSubmit, false);
  await instance.page.submitRequest();
  assert.equal(instance.requests.length, 0);
});

test('a pending server result is never displayed as an activated membership', async () => {
  const instance = invitation('inviteCode', { requestMatchmaker: async () => ({ status: 'pending' }) });
  await instance.start();
  await instance.page.submitRequest();
  assert.equal(instance.page.data.autoDone, false);
  assert.equal(instance.page.data.autoMessage, '');
  assert.match(instance.page.data.errorText, /状态尚未确认/);
  assert.equal(instance.page.data.submitting, false);
  instance.advance(1000);
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.calls.toasts.length, 0);
});

test('duplicate taps share one joining attempt and failures remain visible for a fresh invitation retry', async () => {
  const pending = deferred(); let writes = 0;
  const instance = invitation('inviteCode', { requestMatchmaker: () => { writes += 1; return pending.promise; } });
  await instance.start();
  const first = instance.page.submitRequest();
  await flush();
  await instance.page.submitRequest();
  assert.equal(writes, 1);
  pending.reject(new Error('邀请已失效'));
  await first;
  assert.equal(instance.page.data.errorText, '邀请已失效');
  assert.equal(instance.page.data.submitting, false);
  assert.equal(instance.page.data.autoDone, false);
  await instance.page.loadInvite();
  assert.equal(instance.page.data.errorText, '');
  assert.equal(instance.page.data.canSubmit, true);
});
