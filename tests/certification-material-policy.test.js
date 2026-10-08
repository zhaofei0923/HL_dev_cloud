const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  MAX_MATERIAL_BYTES, validateMaterialInput, sealMaterial, openMaterial, sealVerification, openVerification
} = require('../cloudfunctions/hlApi/certification-material-policy');

const context = { userId: 7, kind: 'education', id: 'material_11111111-1111-4111-8111-111111111111' };
const jwtSecret = 'certification-material-fixture-secret-32-characters';
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const dedicated = { encryptionKey: `hex:${key.toString('hex')}`, jwtSecret };
const derived = { jwtSecret };
const clone = value => JSON.parse(JSON.stringify(value));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3l0AAAAASUVORK5CYII=', 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const invalidInput = error => error.status === 422 && error.code === 42240;
const invalidConfiguration = error => error.status === 503 && error.code === 50340;

function material(buffer, mimeType = 'image/png') {
  return { mimeType, base64: buffer.toString('base64') };
}

function modifyBytes(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

test('material validation accepts supported file headers and returns exact bytes and sizes', () => {
  for (const [buffer, mimeType] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [pdf, 'application/pdf']]) {
    const result = validateMaterialInput(material(buffer, mimeType));
    assert.deepEqual(result.buffer, buffer);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.size, buffer.length);
  }
});

test('material validation rejects empty, oversized, mismatched and unsupported formats', () => {
  const exactlyAllowed = Buffer.alloc(MAX_MATERIAL_BYTES);
  png.subarray(0, 8).copy(exactlyAllowed);
  assert.equal(validateMaterialInput(material(exactlyAllowed)).size, 512000);
  const tooLarge = Buffer.concat([exactlyAllowed, Buffer.from([0])]);
  for (const input of [undefined, {}, [], material(Buffer.alloc(0)), material(tooLarge), material(pdf),
    material(png, 'application/pdf'), material(png, 'image/jpeg'), material(jpeg, 'image/png'),
    material(Buffer.from('<svg/>'), 'image/svg+xml'), material(Buffer.from('RIFFfixtureWEBP'), 'image/webp'),
    material(png, 'Image/PNG'), material(png, 'application/octet-stream'), material(Buffer.from('x%PDF-1.4'), 'application/pdf'),
    material(Buffer.from([0xff, 0xd8]), 'image/jpeg'), material(png.subarray(0, 7))]) {
    assert.throws(() => validateMaterialInput(input), invalidInput);
  }
});

test('base64 requires the canonical standard alphabet, padding and unchanged pad bits', () => {
  for (const base64 of ['', 'Zg', 'Zh==', 'Zg===', 'Zg==\n', ' Zg==', 'Zg_=', 'Zg-=', 'Zg==garbage',
    'AA=A', 'data:image/png;base64,' + png.toString('base64'), png.toString('base64').slice(0, -1)]) {
    assert.throws(() => validateMaterialInput({ mimeType: 'image/png', base64 }), invalidInput);
  }
});

test('material seal returns ciphertext Buffer and authenticates a real binary round trip with both key sources', () => {
  for (const secrets of [dedicated, derived]) {
    const encrypted = sealMaterial(png, context, secrets);
    assert.ok(Buffer.isBuffer(encrypted));
    assert.deepEqual(openMaterial(encrypted, context, secrets), png);
    const envelope = JSON.parse(encrypted.toString('utf8'));
    assert.equal(envelope.algorithm, 'AES-256-GCM');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.keySource, secrets === dedicated ? 'dedicated' : 'jwt-derived-v1');
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
    assert.notEqual(envelope.data, png.toString('base64'));
    assert.ok(!encrypted.includes(png));
  }
});

test('each seal uses a fresh random 12-byte IV for identical material and metadata', () => {
  const materials = Array.from({ length: 24 }, () => JSON.parse(sealMaterial(pdf, context, dedicated).toString('utf8')));
  const metadata = Array.from({ length: 24 }, () => sealVerification({ verificationCode: 'fixture-code' }, context, dedicated));
  assert.equal(new Set(materials.map(item => item.iv)).size, 24);
  assert.equal(new Set(materials.map(item => item.data)).size, 24);
  assert.equal(new Set(metadata.map(item => item.iv)).size, 24);
});

test('verification metadata has an authenticated encrypted object round trip without exposed private fields', () => {
  const value = { verificationCode: 'PRIVATE_REPORT_CODE', certificateNumber: 'PRIVATE_CERT_NUMBER', declaredAssetTier: '2m_5m' };
  const envelope = sealVerification(value, context, dedicated);
  assert.deepEqual(openVerification(clone(envelope), context, dedicated), value);
  assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE_REPORT|PRIVATE_CERT|2m_5m|verificationCode|certificateNumber|declaredAssetTier/);
  for (const value of [null, 'code', [], Buffer.from('code'), new Date(), new Map(), new Set(), /code/,
    { toJSON: () => null }, { toJSON: () => 'transformed' }, { value: undefined }, { value: () => 'x' },
    { value: Symbol('x') }, { value: 1n }, { value: NaN }, { value: Infinity }, { code: 'x'.repeat(16385) }]) {
    assert.throws(() => sealVerification(value, context, dedicated), invalidInput);
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => sealVerification(cycle, context, dedicated), invalidInput);
});

test('authentication binds user, certification kind, record ID and format version', () => {
  const binary = sealMaterial(png, context, dedicated);
  const metadata = sealVerification({ certificateNumber: 'fixture' }, context, dedicated);
  for (const wrong of [{ ...context, userId: 8 }, { ...context, kind: 'assets' }, { ...context, id: 'different-record' },
    { ...context, version: 2 }]) {
    assert.throws(() => openMaterial(binary, wrong, dedicated), invalidInput);
    assert.throws(() => openVerification(metadata, wrong, dedicated), invalidInput);
  }
  assert.deepEqual(openMaterial(binary, { ...context, version: 1 }, dedicated), png);
});

test('purpose binding prevents treating encrypted material as metadata or metadata as material', () => {
  const binary = sealMaterial(Buffer.from('{"certificateNumber":"fixture"}'), context, dedicated);
  const metadata = sealVerification({ verificationCode: 'fixture' }, context, dedicated);
  assert.throws(() => openVerification(JSON.parse(binary.toString('utf8')), context, dedicated), invalidInput);
  assert.throws(() => openMaterial(Buffer.from(JSON.stringify(metadata)), context, dedicated), invalidInput);
});

test('tampered content, IV, authentication tag and key source never return plaintext', () => {
  const envelope = JSON.parse(sealMaterial(png, context, dedicated).toString('utf8'));
  for (const field of ['data', 'iv', 'tag']) {
    const changed = clone(envelope); changed[field] = modifyBytes(changed[field]);
    assert.throws(() => openMaterial(Buffer.from(JSON.stringify(changed)), context, dedicated), invalidInput);
  }
  const changedSource = { ...envelope, keySource: 'jwt-derived-v1' };
  assert.throws(() => openMaterial(Buffer.from(JSON.stringify(changedSource)), context, dedicated), invalidInput);
  const metadata = sealVerification({ verificationCode: 'fixture' }, context, dedicated);
  for (const field of ['data', 'iv', 'tag']) {
    const changed = { ...metadata, [field]: modifyBytes(metadata[field]) };
    assert.throws(() => openVerification(changed, context, dedicated), invalidInput);
  }
});

test('strict envelope validation rejects malformed records and unsupported cryptographic parameters', () => {
  const envelope = sealVerification({ verificationCode: 'fixture' }, context, dedicated);
  const malformed = [null, [], {}, { ...envelope, extra: 'value' }, { ...envelope, version: '1' },
    { ...envelope, version: 2 }, { ...envelope, algorithm: 'AES-256-CBC' }, { ...envelope, keySource: 'custom' },
    { ...envelope, iv: Buffer.alloc(11).toString('base64') }, { ...envelope, iv: Buffer.alloc(13).toString('base64') },
    { ...envelope, tag: Buffer.alloc(15).toString('base64') }, { ...envelope, tag: Buffer.alloc(17).toString('base64') },
    { ...envelope, data: '' }, { ...envelope, data: 'Zh==' }, { ...envelope, data: envelope.data + '\n' },
    { ...envelope, data: Buffer.alloc(16385).toString('base64') }];
  const missing = { ...envelope }; delete missing.tag; malformed.push(missing);
  for (const invalid of malformed) assert.throws(() => openVerification(invalid, context, dedicated), invalidInput);
  for (const invalid of [null, envelope, Buffer.from('not json'), Buffer.alloc(0), Buffer.alloc(700000)]) {
    assert.throws(() => openMaterial(invalid, context, dedicated), invalidInput);
  }
});

test('missing or weak keys fail as configuration errors and a malformed dedicated key cannot silently downgrade', () => {
  for (const secrets of [undefined, {}, { jwtSecret: '' }, { jwtSecret: 'x'.repeat(31) }, { jwtSecret: '汉'.repeat(11) },
    { jwtSecret: ' '.repeat(32) },
    { encryptionKey: key.toString('hex'), jwtSecret }, { encryptionKey: `hex:${'a'.repeat(63)}`, jwtSecret },
    { encryptionKey: `base64:${Buffer.alloc(31).toString('base64')}`, jwtSecret },
    { encryptionKey: `base64:${Buffer.alloc(33).toString('base64')}`, jwtSecret },
    { encryptionKey: `base64:${key.toString('base64')}\n`, jwtSecret }, { encryptionKey: ' ', jwtSecret }]) {
    assert.throws(() => sealMaterial(png, context, secrets), invalidConfiguration);
    assert.throws(() => sealVerification({ verificationCode: 'fixture' }, context, secrets), invalidConfiguration);
  }
  const sealed = sealMaterial(png, context, dedicated);
  assert.throws(() => openMaterial(sealed, context, derived), invalidConfiguration);
});

test('dedicated hex and base64 keys interoperate and dedicated keys take priority over JWT secrets', () => {
  const encodedKey = { encryptionKey: `base64:${key.toString('base64')}`, jwtSecret: 'different-jwt-secret-with-at-least-32-characters' };
  const sealed = sealMaterial(pdf, context, dedicated);
  assert.deepEqual(openMaterial(sealed, context, encodedKey), pdf);
  assert.deepEqual(openMaterial(sealMaterial(jpeg, context, encodedKey), context, dedicated), jpeg);
  const wrong = { encryptionKey: `hex:${Buffer.alloc(32, 9).toString('hex')}`, jwtSecret };
  assert.throws(() => openMaterial(sealed, context, wrong), invalidInput);
});

test('keySource preserves JWT-derived records after adding a dedicated key, while rotation requires the old secret', () => {
  const binary = sealMaterial(pdf, context, derived);
  const metadata = sealVerification({ certificateNumber: 'fixture' }, context, derived);
  assert.deepEqual(openMaterial(binary, context, dedicated), pdf);
  assert.deepEqual(openVerification(metadata, context, dedicated), { certificateNumber: 'fixture' });
  assert.throws(() => openMaterial(binary, context, { ...dedicated, jwtSecret: 'rotated-secret-at-least-thirty-two-characters' }), invalidInput);
  assert.throws(() => openMaterial(binary, context, { encryptionKey: dedicated.encryptionKey }), invalidConfiguration);
});

test('JWT key derivation is domain-separated and changing the key source is authenticated even with identical key bytes', () => {
  const sealed = JSON.parse(sealMaterial(pdf, context, derived).toString('utf8'));
  const derivedBytes = crypto.createHmac('sha256', Buffer.from(jwtSecret)).update('hl.member-certification.encryption.jwt-derived.v1').digest();
  const both = { jwtSecret, encryptionKey: `hex:${derivedBytes.toString('hex')}` };
  assert.throws(() => openMaterial(Buffer.from(JSON.stringify({ ...sealed, keySource: 'dedicated' })), context, both), invalidInput);
  const rawJwt = { encryptionKey: `hex:${Buffer.from(jwtSecret.slice(0, 32)).toString('hex')}` };
  assert.throws(() => openMaterial(Buffer.from(JSON.stringify({ ...sealed, keySource: 'dedicated' })), context, rawJwt), invalidInput);
});

test('context and plaintext validation reject ambiguous ownership or identifiers before encryption', () => {
  for (const invalid of [null, {}, { ...context, userId: '7' }, { ...context, userId: 0 },
    { ...context, userId: Number.MAX_SAFE_INTEGER + 1 }, { ...context, kind: '__proto__' },
    { ...context, id: '' }, { ...context, id: '../other' }, { ...context, id: 'x'.repeat(81) },
    { ...context, purpose: 'verification' }, { ...context, version: 2 }]) {
    assert.throws(() => sealMaterial(png, invalid, dedicated), invalidInput);
  }
  for (const invalid of ['bytes', new Uint8Array([1]), Buffer.alloc(0), Buffer.alloc(MAX_MATERIAL_BYTES + 1)]) {
    assert.throws(() => sealMaterial(invalid, context, dedicated), invalidInput);
  }
});

test('errors do not echo plaintext, supplied secrets or underlying authentication details', () => {
  const privateValue = 'PRIVATE_METADATA_NEVER_LOGGED';
  let error;
  try { sealVerification({ verificationCode: privateValue }, context, { encryptionKey: 'PRIVATE_INVALID_KEY', jwtSecret }); }
  catch (caught) { error = caught; }
  assert.ok(error);
  assert.doesNotMatch(error.message, /PRIVATE_|fixture-secret|unsupported|authenticate/i);
  const envelope = sealVerification({ verificationCode: privateValue }, context, dedicated);
  try { openVerification({ ...envelope, data: modifyBytes(envelope.data) }, context, dedicated); }
  catch (caught) { error = caught; }
  assert.doesNotMatch(error.message, /PRIVATE_|fixture-secret|authenticate|bad decrypt/i);
});
