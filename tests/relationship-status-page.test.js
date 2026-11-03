const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/miniprogram-runtime');

function pageRuntime() {
  const overview = { relationshipStatus: 'single', displayEnabled: true, candidates: [{ userId: 2, displayName: '匹配对象' }], incomingInvitations: [], outgoingInvitations: [] };
  return runtime('pages/user/relationship-status.js', {
    source: true,
    request: async (path, options = {}) => {
      if (options.method === 'POST') {
        if (path === '/member/relationship-status') {
          overview.relationshipStatus = options.data.status;
          overview.displayEnabled = false;
        }
        if (path === '/member/unmatch') overview.candidates = [];
        return {};
      }
      return overview;
    }
  });
}

test('relationship page preselects chat peer, refuses missing reason and refreshes after unmatching', async () => {
  const { page, calls } = pageRuntime();
  page.onLoad({ targetUserId: '2' });
  await page.onShow();
  assert.equal(page.data.selectedName, '匹配对象');
  await page.unmatch();
  assert.equal(calls.requests.filter(row => row.path === '/member/unmatch').length, 0);
  page.onReasonChange({ detail: { value: '2' } });
  await page.unmatch();
  const mutation = calls.requests.find(row => row.path === '/member/unmatch');
  assert.equal(mutation.options.data.reason, '消息不回复');
  assert.equal(mutation.options.data.targetUserId, 2);
  assert.equal(page.data.candidates.length, 0);
  assert.equal(page.data.selectedIndex, -1);
});

test('success declaration refreshes hidden state and recovery keeps hidden', async () => {
  const { page } = pageRuntime();
  page.onLoad({});
  await page.onShow();
  await page.declareSuccess();
  assert.equal(page.data.relationshipStatus, 'coupled');
  assert.equal(page.data.displayEnabled, false);
  await page.restoreSingle();
  assert.equal(page.data.relationshipStatus, 'single');
  assert.equal(page.data.displayEnabled, false);
});

test('returning to profile after success refreshes hidden status while preserving unsaved profile text', async () => {
  let status = 'single';
  const { page } = runtime('pages/user/profile.js', {
    source: true,
    request: async () => ({ profile: { realName: '原姓名', city: '上海', photos: [], relationshipStatus: status, displayEnabled: status !== 'coupled' } }),
    memberApi: { certifications: async () => ({ entries: ['identity', 'education', 'vehicle', 'property', 'assets'].map(kind => ({ kind, status: 'unsubmitted', verified: false })) }) }
  });
  await page.onShow();
  page.updateForm('realName', '尚未保存的姓名');
  status = 'coupled';
  await page.loadProfile(true);
  assert.equal(page.data.form.realName, '尚未保存的姓名');
  assert.equal(page.data.form.relationshipStatus, 'coupled');
  assert.equal(page.data.form.displayEnabled, false);
  assert.equal(page.data.formDirty, true);
});
