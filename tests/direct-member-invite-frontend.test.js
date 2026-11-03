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

test('opening a guest invitation never logs in or joins, while explicit confirmation preserves direct free joining', async () => {
  for (const source of ['inviteCode', 'matchmakerShare']) {
    let resolves = 0, accepts = 0, logins = 0;
    const instance = invitation(source, {
      resolveMatchmakerInvite: async () => { resolves++; return { matchmakerNo: 'MM001', alreadyAssigned: false }; },
      acceptMatchmakerInvite: async () => { accepts++; return { invite: { matchmakerNo: 'MM001' } }; }
    });
    instance.session.token = ''; instance.session.user = null;
    instance.services.auth.loginByWechat = async () => {
      logins++; instance.session.token = 'voluntary-login'; instance.session.user = { id: 5 };
    };
    await instance.start();
    assert.equal(instance.page.data.loggedIn, false);
    assert.equal(instance.page.data.actionText, '微信登录并确认加入');
    assert.equal(logins, 0); assert.equal(resolves, 0); assert.equal(accepts, 0);
    assert.equal(instance.requests.length, 0);
    assert.equal(instance.calls.navigation.length, 0);
    await instance.page.confirmInvite();
    assert.equal(logins, 1); assert.equal(resolves, 1);
    assert.equal(source === 'inviteCode' ? instance.requests.length : accepts, 1);
    assert.equal(instance.page.data.autoDone, true);
    assert.match(instance.page.data.autoMessage, /免费会员/);
    assert.equal(instance.calls.storage.length, 0);
  }
});

test('already logged-in share invitations also wait for a confirmation before joining', async () => {
  let accepts = 0;
  const instance = invitation('matchmakerShare', {
    acceptMatchmakerInvite: async () => { accepts++; return { invite: { matchmakerNo: 'MM001' } }; }
  });
  await instance.start();
  assert.equal(accepts, 0);
  await instance.page.confirmInvite();
  assert.equal(accepts, 1);
  await instance.page.confirmInvite();
  assert.equal(accepts, 1);
});

test('guest confirmation deduplicates login and leaving during login never accepts an invitation', async () => {
  const pending = deferred(); let logins = 0, resolves = 0;
  const instance = invitation('inviteCode', {
    resolveMatchmakerInvite: async () => { resolves++; return { matchmakerNo: 'MM001' }; }
  });
  instance.session.token = ''; instance.session.user = null;
  instance.services.auth.loginByWechat = async () => { logins++; await pending.promise;
    instance.session.token = 'new-session'; instance.session.user = { id: 2 }; };
  await instance.start();
  const confirming = instance.page.confirmInvite();
  await instance.page.confirmInvite();
  assert.equal(logins, 1);
  instance.page.onHide();
  pending.resolve(); await confirming;
  assert.equal(resolves, 0);
  assert.equal(instance.requests.length, 0);
  assert.equal(instance.calls.navigation.length, 0);
  assert.equal(instance.page.data.loginLoading, false);
});

test('old authenticated invite data is cleared on a return as a guest without another implicit login', async () => {
  const instance = invitation('inviteCode');
  await instance.start(); assert.ok(instance.page.data.invite);
  instance.page.onHide(); instance.session.token = ''; instance.session.user = null;
  await instance.page.onShow();
  assert.equal(instance.page.data.invite, null);
  assert.equal(instance.page.data.loggedIn, false);
  assert.equal(instance.page.data.canSubmit, true);
  assert.equal(instance.requests.length, 0);
});
