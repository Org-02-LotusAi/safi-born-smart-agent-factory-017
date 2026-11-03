// RFC 8785 (JCS) canonical JSON + SHA-256 helpers. The only hashing path in the Factory.
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export class FactoryError extends Error {
  constructor(message, code = 'FACTORY_ERROR', details = undefined) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function canonicalJson(value) {
  const out = canonicalize(value);
  if (typeof out !== 'string') {
    throw new FactoryError('Cannot hash this value because it is not valid JSON data.', 'NOT_CANONICALIZABLE');
  }
  return out;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 of the RFC 8785 canonical form of `value`. */
export function hashObject(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}

/** Digest of a released object: canonical JSON with the `digest` field removed. */
export function digestOf(obj) {
  const { digest: _omit, ...rest } = obj;
  return hashObject(rest);
}

/** Text files are hashed with LF line endings so Windows checkouts agree. */
export function hashText(text) {
  return sha256Hex(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8'));
}
