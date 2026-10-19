import { createHmac } from 'node:crypto';

const present = value => value !== undefined && value !== null && value !== '';
const masked = value => typeof value !== 'string' || /redacted|masked|\*{2,}/i.test(value);
function validKey(value) {
  if (masked(value)) return false;
  if (/^hex:[a-fA-F0-9]{64}$/.test(value)) return true;
  if (!value.startsWith('base64:')) return false;
  const encoded = value.slice(7), bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === encoded;
}

/** Domain keys may be copied to this service; the JWT signing secret never is. */
export function certificationEnvironment(variables) {
  const result = {};
  if (present(variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY)) {
    if (!validKey(variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY)) throw new Error('Certificate encryption key is invalid');
    result.MEMBER_CERTIFICATION_ENCRYPTION_KEY = variables.MEMBER_CERTIFICATION_ENCRYPTION_KEY;
  }
  if (present(variables.MEMBER_CERTIFICATION_JWT_DERIVED_KEY)) {
    if (!validKey(variables.MEMBER_CERTIFICATION_JWT_DERIVED_KEY)) throw new Error('Retained certificate domain key is invalid');
    result.MEMBER_CERTIFICATION_JWT_DERIVED_KEY = variables.MEMBER_CERTIFICATION_JWT_DERIVED_KEY;
  } else if (!masked(variables.JWT_SECRET) && variables.JWT_SECRET.length >= 32 && variables.JWT_SECRET.trim()) {
    result.MEMBER_CERTIFICATION_JWT_DERIVED_KEY = 'hex:' + createHmac('sha256', Buffer.from(variables.JWT_SECRET))
      .update('hl.member-certification.encryption.jwt-derived.v1', 'utf8').digest('hex');
  }
  if (!Object.keys(result).length) throw new Error('Certificate decryption configuration unavailable');
  return result;
}
