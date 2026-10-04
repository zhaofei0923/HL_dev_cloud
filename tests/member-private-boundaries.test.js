const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'hlApi', 'index.js'),
  'utf8'
);

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return source.slice(from, to);
}

test('sensitive intake archives use a separate protected collection', () => {
  assert.match(source, /memberPrivateArchives:\s*'hl_member_private_archives'/);
  const payload = between('function privateArchivePayload', 'async function upsertMemberPrivateArchive');
  assert.match(payload, /verificationCredentialLocation/);
  assert.match(payload, /personalProfile:\s*intake\.personalProfile/);
  assert.match(payload, /businessRegistration:\s*intake\.businessRegistration/);
  assert.match(payload, /recordedByUserId/);
  const upsert = between('async function upsertMemberPrivateArchive', 'function privateArchiveView');
  assert.match(upsert, /\.doc\(`member_\$\{Number\(memberRow\.id\)\}`\)\.set/);
  const mediaView = between('async function privateArchiveViewWithMedia', 'const member =');
  assert.match(mediaView, /memberMediaURLMap\(photos\)/);
  assert.match(mediaView, /photos\.map\(fileID => urlMap\[fileID\]\)\.filter\(Boolean\)/);
});

test('manual intake is validated server-side and member number is server-generated', () => {
  assert.match(
    source,
    /path === '\/member\/manual'[\s\S]*requireCompleteIntake:\s*true/
  );
  const addManual = between('async addManual(matchmakerUserId', 'async detailOwn(matchmakerUserId');
  assert.match(addManual, /validateMemberIntake\(data,[\s\S]*privatePhotoOwnerKey:\s*String\(matchmakerUserId\)/);
  assert.match(addManual, /memberNo:\s*defaultMemberNo\(memberId\)/);
  assert.doesNotMatch(addManual, /memberNo:\s*data\.memberNo/);
  assert.match(addManual, /intakeStatus: 'pending'[\s\S]*status: requireCompleteIntake \? 0 : 1/);
  assert.match(addManual, /upsertMemberPrivateArchive\(row,[\s\S]*intakeStatus: 'complete'[\s\S]*status: 1/);
  const failureView = between('function fail(err)', 'function nowIso');
  assert.match(failureView, /Array\.isArray\(err\.details\)/);
  assert.match(failureView, /data:\s*details \? \{ details \} : null/);
});

test('private detail checks certified ownership before reading the archive', () => {
  const detail = between('async detailOwn(matchmakerUserId', 'async listOwn(matchmakerUserId');
  const guardIndex = detail.indexOf('Number(row.matchmakerId) !== Number(mm.id)');
  const activeAssignmentIndex = detail.indexOf('activeAssignments.length !== 1');
  const archiveReadIndex = detail.indexOf('getOne(C.memberPrivateArchives');
  assert.ok(guardIndex >= 0 && activeAssignmentIndex > guardIndex && archiveReadIndex > activeAssignmentIndex);
  assert.match(detail, /Number\(row\.status\) !== 1/);
  assert.match(source, /memberMatch && method === 'GET'[\s\S]*member\.detailOwn\(session\.userId/);
});

test('member summaries are allowlisted and never spread private member documents', () => {
  const view = between('async function memberView', 'async function profileMemberView');
  assert.doesNotMatch(view, /\.\.\.stripInternal\(member\)/);
  assert.match(view, /memberNo:\s*member\.memberNo/);
  assert.doesNotMatch(view, /privateArchive/);
});

test('cross-matchmaker resources pass through the public sanitizer', () => {
  const resources = between('async resources(matchmakerUserId', 'async showcase(userId');
  assert.match(resources, /publicMemberView\(row,[\s\S]*keepUserId:\s*true/);
  assert.match(resources, /sanitizePublicMemberRow\([\s\S]*profileMemberView/);
  assert.doesNotMatch(
    resources,
    /\.filter\(row => Number\(row\.status\) === 1 && row\.displayEnabled/
  );
  const sanitizer = between('function sanitizePublicMemberRow', 'async function publicMemberView');
  ['phone', 'memberNo', 'matchmakerId', 'displayEnabled', 'serviceLevel', 'expireAt', 'remark', 'privateArchive']
    .forEach(field => assert.match(sanitizer, new RegExp(`delete safe\\.${field}`)));
});

test('member and self-profile updates use an explicit profile-field allowlist', () => {
  const helper = between('function editableProfilePatch', 'function intakeProfilePatch');
  assert.match(helper, /PROFILE_MUTABLE_FIELDS/);
  const update = between('async update(matchmakerUserId', 'async remove(matchmakerUserId');
  assert.match(update, /editableProfilePatch\(data\)/);
  assert.doesNotMatch(update, /const profilePatch = \{ \.\.\.data \}/);
  const selfProfileRoute = between("if (method === 'PUT' && path === '/user/profile')", "if (method === 'POST' && path === '/matchmaker/apply')");
  assert.match(selfProfileRoute, /editableProfilePatch\(data\)/);
});

test('strict intake never copies verified income, asset conclusions, or private photos into a public profile', () => {
  const helper = between('function intakeProfilePatch', 'function memberTypeForIntake');
  assert.doesNotMatch(helper, /annualIncomePreTax|incomeRange|houseStatus|carStatus|lifePhotos|photos/);
  const addManual = between('async addManual(matchmakerUserId', 'async detailOwn(matchmakerUserId');
  assert.match(addManual, /else if \(!profile\)[\s\S]*profilePatch\.displayEnabled = false/);
  assert.match(addManual, /else if \(!profile\)[\s\S]*profilePatch\.photos = \[\]/);
});

test('manual intake refuses to take over a member assigned to another principal', () => {
  const addManual = between('async addManual(matchmakerUserId', 'async detailOwn(matchmakerUserId');
  assert.match(addManual, /activeMemberAssignment\(user\.id\)/);
  assert.match(addManual, /assignment\.matchmakerId[\s\S]*mm\.id[\s\S]*member already has another matchmaker/);
});

test('every member creation path assigns a deterministic member number', () => {
  const approval = between('async function approveMemberMatchmakerRequest', 'async function validateInviteEventForMatchmaker');
  const shareAccept = between('async function acceptMemberMatchmakerInvite', 'function matchesMemberFilters');
  assert.match(approval, /memberNo:\s*defaultMemberNo\(memberId\)/);
  assert.match(shareAccept, /memberNo:\s*defaultMemberNo\(memberId\)/);
  const view = between('async function memberView', 'async function profileMemberView');
  assert.match(view, /member\.memberNo \|\| defaultMemberNo\(member\.id/);
});
