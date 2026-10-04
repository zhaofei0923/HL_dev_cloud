'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiSource = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'),
  'utf8'
);
const authClientSource = fs.readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'services', 'auth.ts'),
  'utf8'
);
const claimPageSource = fs.readFileSync(
  path.join(__dirname, '..', 'miniprogram', 'pages', 'user', 'member-claim.ts'),
  'utf8'
);

function between(start, end) {
  const from = apiSource.indexOf(start);
  const to = apiSource.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return apiSource.slice(from, to);
}

test('claim preview is public-by-token while confirmation is access-session scoped', () => {
  const previewRoute = apiSource.indexOf("path === '/auth/member-claim/preview'");
  const sessionGuard = apiSource.indexOf('const session = await requireUser(apiToken);');
  const confirmRoute = apiSource.indexOf("path === '/auth/member-claim/confirm'");
  assert.ok(previewRoute >= 0 && previewRoute < sessionGuard);
  assert.ok(confirmRoute > sessionGuard);
  assert.match(apiSource, /confirmMemberIdentityClaim\(session\.userId, data\.token, data\.code\)/);
});

test('access sessions are checked against current account status and auth version', () => {
  const requireUser = between('async function requireUser(token)', 'function requireAdmin(token)');
  assert.match(requireUser, /getById\(C\.users, session\.userId\)/);
  assert.match(requireUser, /Number\(user\.status\) !== 1/);
  assert.match(requireUser, /user\.mergedIntoUserId/);
  assert.match(requireUser, /tokenAuthVersion !== userAuthVersion/);
  assert.match(requireUser, /401, 40100/);
});

test('claim confirmation rechecks trusted WeChat identity and verified phone', () => {
  const confirm = between('async function confirmMemberIdentityClaim', 'const auth = {');
  assert.match(confirm, /assertWechatCallerOwnsUser\(sourceUser\)/);
  assert.match(confirm, /exchangeWechatPhone\(phoneCode\)/);
  assert.match(confirm, /String\(context\.targetUser\.phone \|\| ''\) !== phone/);
  assert.match(confirm, /sourceAccountConflictReasons\(sourceUser\.id\)/);
  assert.match(confirm, /db\.runTransaction/);
});

test('transaction preserves manual user as canonical and tombstones the temporary WeChat user', () => {
  const confirm = between('async function confirmMemberIdentityClaim', 'const auth = {');
  assert.match(confirm, /targetPatch = \{[\s\S]*openid: trustedOpenid[\s\S]*identityStatus: 'claimed'/);
  assert.match(confirm, /sourcePatch = \{[\s\S]*openid: archivedMergedOpenid[\s\S]*phone: ''[\s\S]*status: 0[\s\S]*mergedIntoUserId: Number\(currentTarget\.id\)/);
  assert.doesNotMatch(confirm, /\.create\(/);
  assert.match(confirm, /targetRef\.update\(\{\s*data: targetPatch\s*\}\)/);
  assert.match(confirm, /sourceRef\.update\(\{\s*data: sourcePatch\s*\}\)/);
  assert.match(confirm, /claimRef\.update\(\{\s*data: claimedPatch\s*\}\)/);
  assert.match(confirm, /issueUserSession\(result\.canonicalUser\)/);
});

test('claim transaction rechecks member ownership, matchmaker validity, and source phone', () => {
  const confirm = between('async function confirmMemberIdentityClaim', 'const auth = {');
  const transaction = confirm.slice(confirm.indexOf('db.runTransaction'));

  assert.match(transaction, /const memberRef = transaction\.collection\(C\.members\)\.doc\(/);
  assert.match(transaction, /const matchmakerRef = transaction\.collection\(C\.matchmakers\)\.doc\(/);
  assert.match(transaction, /memberRef\.get\(\)/);
  assert.match(transaction, /matchmakerRef\.get\(\)/);
  assert.match(transaction, /const currentMember = [^;]+\.data/);
  assert.match(transaction, /const currentMatchmaker = [^;]+\.data/);
  assert.match(transaction, /Number\(currentMember\.status\) !== 1/);
  assert.match(transaction, /Number\(currentMember\.userId\) !== Number\(currentTarget\.id\)/);
  assert.match(transaction, /Number\(currentMember\.matchmakerId\) !== Number\(currentMatchmaker\.id\)/);
  assert.match(transaction, /Number\(currentMatchmaker\.status\) !== 1/);
  assert.match(transaction, /Number\(currentMatchmaker\.certificationStatus\) !== 2/);
  assert.match(transaction, /currentSource\.phone[\s\S]*String\(currentSource\.phone\)[\s\S]*!== phone/);
  assert.match(transaction, /where\(\{ phone \}\)\.limit\(3\)\.get\(\)/);
  assert.match(transaction, /where\(\{ openid: trustedOpenid \}\)\.limit\(3\)\.get\(\)/);
  assert.match(transaction, /currentPhoneOwners\.length !== 1/);
  assert.match(transaction, /currentOpenidOwners\.length !== 1/);
});

test('a repeated successful claim can recover the canonical account session', () => {
  const confirm = between('async function confirmMemberIdentityClaim', 'const auth = {');
  const claimedBranch = confirm.slice(
    confirm.indexOf('if (context.claimed)'),
    confirm.indexOf('if (Number(context.targetUser.id)')
  );

  assert.match(claimedBranch, /context\.claim\.canonicalUserId/);
  assert.match(claimedBranch, /context\.claim\.claimedBySourceUserId/);
  assert.match(claimedBranch, /getById\(C\.users, context\.claim\.canonicalUserId\)/);
  assert.match(claimedBranch, /issueUserSession\(canonicalUser\)/);
  assert.match(claimedBranch, /idempotent: true/);
});

test('invite generation is transactionally locked against a concurrent claim', () => {
  const invite = between('async function createMemberIdentityClaimInvite', 'const CLAIM_PROFILE_FIELDS');

  assert.match(invite, /db\.runTransaction/);
  assert.match(invite, /const memberRef = transaction\.collection\(C\.members\)\.doc\(/);
  assert.match(invite, /const targetRef = transaction\.collection\(C\.users\)\.doc\(/);
  assert.match(invite, /memberRef\.get\(\)/);
  assert.match(invite, /targetRef\.get\(\)/);
  assert.match(invite, /const claimRef = transaction\.collection\(C\.identityClaims\)\.doc\(identityClaimDocumentId\(memberRow\.id\)\)/);
  assert.match(invite, /const claimQuery = transaction\.collection\(C\.identityClaims\)/);
  assert.match(invite, /const currentClaim = [^;]+[\s\S]*snapshots\[3\]\.data/);
  assert.match(invite, /currentClaim[\s\S]*String\(currentClaim\.status\) === 'claimed'/);
  assert.match(invite, /const claimInviteVersion = hashClaimToken\(token\)/);
  assert.match(invite, /targetRef\.update\(\{\s*data: \{ claimInviteVersion, updatedAt: timestamp \}\s*\}\)/);
  assert.match(invite, /claimInviteVersion,[\s\S]*status: 'pending'/);
  assert.match(invite, /claimRef\.set\(\{\s*data: claim\s*\}\)/);
  assert.doesNotMatch(invite, /db\.collection\(C\.identityClaims\)[\s\S]*\.set\(\{ data: claim \}\)/);
});

test('ordinary phone binding cannot silently claim a manual member', () => {
  const bind = between('async bindWechatPhone(userId, code)', 'async previewMemberIdentityClaim(token)');
  assert.match(bind, /assertWechatCallerOwnsUser\(user\)/);
  assert.match(bind, /isManualIdentity\(existing\.openid\)/);
  assert.match(bind, /主理人发送的认领邀请/);
  assert.doesNotMatch(bind, /confirmMemberIdentityClaim/);
});

test('frontend changes session only after explicit claim confirmation', () => {
  assert.match(authClientSource, /\/auth\/member-claim\/confirm/);
  assert.match(authClientSource, /preserveSessionOnUnauthorized: true/);
  assert.match(authClientSource, /setSession\(session\)/);
  assert.match(claimPageSource, /open-type="getPhoneNumber"|confirmManualMemberClaim/);
  assert.match(claimPageSource, /confirmManualMemberClaim\(this\.data\.token, code\)/);
});
