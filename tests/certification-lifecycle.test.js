const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../cloudfunctions/hlApi/showcase-policy');

const approved = reviewedAt => ({ status: 'approved', source: 'bank_statement', financialAssetRange: '2m_5m', reviewedAt });
const profile = assets => ({ showcaseCertification: { policyVersion: 1, assets }, assetCategoryConsent: true, assetRangeDisclosure: true });

test('financial certification lasts six calendar months, including month-end and exact expiry', () => {
  const review = approved('2026-08-31T10:15:00.000Z');
  const expiry = '2027-02-28T10:15:00.000Z';
  assert.equal(policy.assetCertificationExpiresAt(review), expiry);
  assert.equal(policy.assetCertificationExpiresAt(approved('2023-08-31T10:15:00Z')), '2024-02-29T10:15:00.000Z');
  const before = Date.parse(expiry) - 1;
  assert.equal(policy.categoryRank('assets', profile(review), 0, before), 3);
  assert.equal(policy.publicCertificationFields(profile(review), before).financialAssetRange, '2m_5m');
  const atExpiry = Date.parse(expiry);
  assert.equal(policy.categoryRank('assets', profile(review), 0, atExpiry), null);
  const publicFields = policy.publicCertificationFields(profile(review), atExpiry);
  assert.equal(publicFields.assetVerified, false);
  assert.equal('financialAssetRange' in publicFields, false);
  const own = policy.ownCertificationOverview({ current: { assets: review } }, atExpiry).entries.find(row => row.kind === 'assets');
  assert.equal(own.status, 'expired');
  assert.equal(own.verified, false);
  assert.equal(own.expiresAt, expiry);
});

test('missing, invalid and future verification dates do not grant assets, nor does an extended explicit deadline', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  for (const review of [approved(undefined), approved('invalid'), approved('2027-01-01T00:00:00Z'),
    { ...approved('2026-01-01T00:00:00Z'), expiresAt: '2030-01-01T00:00:00Z' },
    { ...approved('2026-10-01T00:00:00Z'), expiresAt: 'invalid' }]) {
    assert.equal(policy.categoryRank('assets', profile(review), 0, now), null);
    assert.equal(policy.publicCertificationFields(profile(review), now).assetVerified, false);
  }
});

test('renewal pending or rejected cannot extend an old asset certification and renewed approval restores it', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const current = { assets: approved('2026-01-01T00:00:00Z') };
  const record = { current, applications: { assets: { status: 'pending', submittedAt: '2026-10-01T00:00:00Z' } } };
  let own = policy.ownCertificationOverview(record, now).entries.find(row => row.kind === 'assets');
  assert.equal(own.status, 'pending'); assert.equal(own.verified, false);
  record.applications.assets = { status: 'rejected', feedback: '请补充最新证明' };
  own = policy.ownCertificationOverview(record, now).entries.find(row => row.kind === 'assets');
  assert.equal(own.status, 'expired'); assert.equal(own.feedback, '请补充最新证明');
  record.current.assets = approved('2026-10-07T00:00:00Z');
  record.applications.assets = { status: 'approved' };
  own = policy.ownCertificationOverview(record, now).entries.find(row => row.kind === 'assets');
  assert.equal(own.status, 'approved'); assert.equal(own.verified, true);
  assert.equal(own.expiresAt, '2027-04-07T00:00:00.000Z');
});

test('rejected education renewal retains verified level and shows feedback separately from the old approval', () => {
  const own = policy.ownCertificationOverview({
    current: { education: { status: 'approved', source: 'chsi', level: '本科', feedback: '原审核通过' } },
    applications: { education: { status: 'rejected', source: 'cscse', feedback: '硕士材料需要补充' } }
  }).entries.find(row => row.kind === 'education');
  assert.equal(own.status, 'rejected'); assert.equal(own.verified, true);
  assert.equal(own.verifiedEducation, '本科'); assert.equal(own.feedback, '硕士材料需要补充');
});
