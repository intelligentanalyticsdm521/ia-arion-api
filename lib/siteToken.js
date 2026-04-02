import crypto from 'node:crypto';

/** Generate a cryptographically-random 64-byte hex site token. */
export function generateSiteToken() {
  return crypto.randomBytes(64).toString('hex');
}

/** SHA-256 hash a raw site token for storage / comparison. */
export function hashSiteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
