'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLAIM_INVITE_TTL_MS,
  archivedMergedOpenid,
  claimExpiresAt,
  claimTokenMatches,
  createClaimToken,
  fillTargetProfileBlanks,
  hashClaimToken,
  isClaimExpired,
  isManualIdentity,
  maskMemberNo,
  maskName,
  maskPhone,
  normalizeMainlandPhone,
  parseClaimToken
} = require('../cloudfunctions/hlApi/account-claim-policy');

test('manual identity recognition is strict', () => {
  assert.equal(isManualIdentity('manual_12'), true);
  assert.equal(isManualIdentity(' manual_12 '), true);
  assert.equal(isManualIdentity('manual_demo'), false);
  assert.equal(isManualIdentity('wx_manual_12'), false);
  assert.equal(isManualIdentity('merged_12_deadbeef'), false);
});

test('claim invitation token is high entropy, scoped to one member and verifiable by hash', () => {
  const token = createClaimToken(42, size => Buffer.alloc(size, 7));
  const parsed = parseClaimToken(token);
  assert.deepEqual(parsed, { memberId: 42, token });
  assert.match(token, /^42\.[A-Za-z0-9_-]{43}$/);
  assert.equal(claimTokenMatches(token, hashClaimToken(token)), true);
  assert.equal(claimTokenMatches(token.replace(/^42/, '43'), hashClaimToken(token)), false);
  assert.equal(parseClaimToken('42.short'), null);
});

test('claim invitation expires after the fixed seven-day window', () => {
  const now = Date.UTC(2026, 8, 13, 0, 0, 0);
  const expiresAt = claimExpiresAt(now);
  assert.equal(new Date(expiresAt).getTime() - now, CLAIM_INVITE_TTL_MS);
  assert.equal(isClaimExpired(expiresAt, now + CLAIM_INVITE_TTL_MS - 1), false);
  assert.equal(isClaimExpired(expiresAt, now + CLAIM_INVITE_TTL_MS), true);
  assert.equal(isClaimExpired('bad-date', now), true);
});

test('claim preview helpers never expose full identity values', () => {
  assert.equal(maskName('张晓明'), '张**');
  assert.equal(maskPhone('13812345678'), '138****5678');
  assert.equal(maskMemberNo('HL2026001234'), '********1234');
  assert.notEqual(maskName('张晓明'), '张晓明');
  assert.notEqual(maskPhone('13812345678'), '13812345678');
  assert.notEqual(maskMemberNo('HL2026001234'), 'HL2026001234');
});

test('principal-supplied claim phone is normalized as a mainland mobile number', () => {
  assert.equal(normalizeMainlandPhone('+86 138-1234-5678'), '13812345678');
  assert.equal(normalizeMainlandPhone('12812345678'), '');
  assert.equal(normalizeMainlandPhone('1381234'), '');
});

test('manual profile remains authoritative and only blank public fields are filled', () => {
  const patch = fillTargetProfileBlanks(
    { realName: '手工姓名', city: '', photos: [], displayEnabled: false },
    { realName: '微信姓名', city: '成都', photos: ['cloud://photo'], displayEnabled: true },
    ['realName', 'city', 'photos']
  );
  assert.deepEqual(patch, { city: '成都', photos: ['cloud://photo'] });
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'displayEnabled'), false);
});

test('merged source openid is deterministic and cannot remain the real openid', () => {
  const archived = archivedMergedOpenid(7, 'o-real-openid');
  assert.match(archived, /^merged_7_[a-f0-9]{24}$/);
  assert.notEqual(archived, 'o-real-openid');
  assert.equal(archivedMergedOpenid(7, 'o-real-openid'), archived);
});
