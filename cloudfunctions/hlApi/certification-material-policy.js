'use strict';

const crypto = require('node:crypto');

const VERSION = 1;
const ALGORITHM = 'AES-256-GCM';
const MAX_MATERIAL_BYTES = 500 * 1024;
const MAX_VERIFICATION_BYTES = 16 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_MATERIAL_BYTES / 3) * 4;
const KINDS = new Set(['identity', 'education', 'vehicle', 'property', 'assets']);
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const KEY_SOURCES = new Set(['dedicated', 'jwt-derived-v1']);
const ENVELOPE_KEYS = ['version', 'algorithm', 'keySource', 'iv', 'tag', 'data'];
const DERIVATION_DOMAIN = 'hl.member-certification.encryption.jwt-derived.v1';
const AAD_DOMAIN = 'hl.member-certification.aead.v1';

function inputError(message = '认证材料或加密记录无效，请重新提交或联系工作人员') {
  const error = new Error(message);
  error.status = 422;
  error.code = 42240;
  return error;
}

function configurationError() {
  const error = new Error('认证材料加密功能暂未正确配置，请联系工作人员');
  error.status = 503;
  error.code = 50340;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

// Node's base64 decoder accepts whitespace, URL-safe symbols and truncated data.
// Require the standard alphabet, padding and the exact canonical re-encoding.
function decodeBase64(value, maximumBytes) {
  const maxLength = Math.ceil(maximumBytes / 3) * 4;
  if (typeof value !== 'string' || !value || value.length > maxLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw inputError();
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > maximumBytes || buffer.toString('base64') !== value) throw inputError();
  return buffer;
}

function validateMaterialInput(input) {
  if (!isObject(input) || !MIME_TYPES.has(input.mimeType)
    || typeof input.base64 !== 'string' || input.base64.length > MAX_BASE64_LENGTH) {
    throw inputError('请选择500KB以内的JPEG、PNG图片或PDF材料');
  }
  const buffer = decodeBase64(input.base64, MAX_MATERIAL_BYTES);
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pdf = buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'));
  if (!(input.mimeType === 'image/jpeg' && jpeg
    || input.mimeType === 'image/png' && png
    || input.mimeType === 'application/pdf' && pdf)) {
    throw inputError('材料文件内容与格式不一致，请选择JPEG、PNG图片或PDF');
  }
  return { buffer, mimeType: input.mimeType, size: buffer.length };
}

function normalizeContext(context) {
  if (!isObject(context) || Object.keys(context).some(key => !['userId', 'kind', 'id', 'version'].includes(key))
    || !Number.isSafeInteger(context.userId) || context.userId <= 0 || !KINDS.has(context.kind)
    || typeof context.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(context.id)
    || context.version !== undefined && context.version !== VERSION) throw inputError();
  return { userId: context.userId, kind: context.kind, id: context.id };
}

function dedicatedKey(value) {
  if (typeof value !== 'string') throw configurationError();
  if (/^hex:[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value.slice(4), 'hex');
  if (value.startsWith('base64:')) {
    try {
      const key = decodeBase64(value.slice(7), 32);
      if (key.length === 32) return key;
    } catch (_error) {
      // Configuration errors never repeat the supplied key in diagnostics.
    }
  }
  throw configurationError();
}

function derivedKey(value) {
  if (typeof value !== 'string' || value.length < 32 || !value.trim() || Buffer.byteLength(value, 'utf8') < 32) throw configurationError();
  return crypto.createHmac('sha256', Buffer.from(value, 'utf8')).update(DERIVATION_DOMAIN, 'utf8').digest();
}

function resolveKey(secrets, keySource) {
  if (!isObject(secrets)) throw configurationError();
  const dedicatedPresent = secrets.encryptionKey !== undefined && secrets.encryptionKey !== null && secrets.encryptionKey !== '';
  const source = keySource || (dedicatedPresent ? 'dedicated' : 'jwt-derived-v1');
  if (!KEY_SOURCES.has(source)) throw inputError();
  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey) : derivedKey(secrets.jwtSecret), keySource: source };
}

function associatedData(context, purpose, keySource) {
  return Buffer.from(JSON.stringify({ domain: AAD_DOMAIN, version: VERSION, algorithm: ALGORITHM,
    purpose, keySource, ...normalizeContext(context) }), 'utf8');
}

function seal(buffer, context, purpose, maximumBytes, secrets) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maximumBytes) throw inputError();
  const normalized = normalizeContext(context);
  const { key, keySource } = resolveKey(secrets);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(associatedData(normalized, purpose, keySource));
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return { version: VERSION, algorithm: ALGORITHM, keySource,
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}

function validateEnvelope(envelope, maximumBytes) {
  if (!isObject(envelope) || Object.keys(envelope).length !== ENVELOPE_KEYS.length
    || ENVELOPE_KEYS.some(key => !Object.prototype.hasOwnProperty.call(envelope, key))
    || envelope.version !== VERSION || envelope.algorithm !== ALGORITHM || !KEY_SOURCES.has(envelope.keySource)) {
    throw inputError();
  }
  const iv = decodeBase64(envelope.iv, 12);
  const tag = decodeBase64(envelope.tag, 16);
  const ciphertext = decodeBase64(envelope.data, maximumBytes);
  if (iv.length !== 12 || tag.length !== 16) throw inputError();
  return { iv, tag, ciphertext };
}

function open(envelope, context, purpose, maximumBytes, secrets) {
  const normalized = normalizeContext(context);
  const { iv, tag, ciphertext } = validateEnvelope(envelope, maximumBytes);
  const { key } = resolveKey(secrets, envelope.keySource);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(normalized, purpose, envelope.keySource));
    decipher.setAuthTag(tag);
    // No plaintext leaves the module before final() authenticates both content and AAD.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_error) {
    throw inputError();
  }
}

function sealMaterial(buffer, context, secrets) {
  return Buffer.from(JSON.stringify(seal(buffer, context, 'material', MAX_MATERIAL_BYTES, secrets)), 'utf8');
}

function openMaterial(buffer, context, secrets) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BASE64_LENGTH + 512) throw inputError();
  let envelope;
  try { envelope = JSON.parse(buffer.toString('utf8')); } catch (_error) { throw inputError(); }
  return open(envelope, context, 'material', MAX_MATERIAL_BYTES, secrets);
}

function serializeVerification(value) {
  if (!isObject(value) || Object.prototype.toString.call(value) !== '[object Object]') throw inputError();
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
        || typeof item === 'number' && !Number.isFinite(item)) throw inputError();
      return item;
    });
  } catch (_error) {
    throw inputError();
  }
  let normalized;
  try { normalized = JSON.parse(encoded); } catch (_error) { throw inputError(); }
  if (!isObject(normalized)) throw inputError();
  const buffer = Buffer.from(encoded, 'utf8');
  if (!buffer.length || buffer.length > MAX_VERIFICATION_BYTES) throw inputError();
  return buffer;
}

function sealVerification(value, context, secrets) {
  return seal(serializeVerification(value), context, 'verification', MAX_VERIFICATION_BYTES, secrets);
}

function openVerification(envelope, context, secrets) {
  const plaintext = open(envelope, context, 'verification', MAX_VERIFICATION_BYTES, secrets);
  let value;
  try { value = JSON.parse(plaintext.toString('utf8')); } catch (_error) { throw inputError(); }
  serializeVerification(value);
  return value;
}

module.exports = { MAX_MATERIAL_BYTES, validateMaterialInput, sealMaterial, openMaterial, sealVerification, openVerification };
