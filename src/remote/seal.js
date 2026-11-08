// Secrets for remote mode, all derived from PAPER_MCP_SEAL_KEY: AES-256-GCM sealing
// of Paper sessions at rest, HMAC signatures for OAuth state and cookies, SHA-256
// digests for tokens (only digests are stored), and random token material.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Letters and digits, `length` long (rejection-sampled, so unbiased). @param {number} length */
export function randomString(length) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length)) if (b < 248 && out.length < length) out += ALPHABET[b % 62];
  }
  return out;
}

/** @param {string} value */
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Constant-time string equality. @param {string} a @param {string} b */
export const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** @param {string} verifier PKCE S256 */
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/**
 * @param {string} secret PAPER_MCP_SEAL_KEY (any string; 32+ random bytes recommended)
 */
export function createSecrets(secret) {
  if (!secret || secret.length < 16) throw new Error('PAPER_MCP_SEAL_KEY must be set (at least 16 characters; `openssl rand -base64 32`).');
  /** @param {string} purpose */
  const derive = (purpose) => Buffer.from(crypto.hkdfSync('sha256', secret, 'paper-remote-mcp', purpose, 32));
  const sealKey = derive('seal'), signKey = derive('sign');

  /** @param {string} purpose @param {string} payload */
  const mac = (purpose, payload) => crypto.createHmac('sha256', signKey).update(`${purpose}\n${payload}`).digest('base64url');

  return {
    /** AES-256-GCM, bound to `purpose` (AAD). @param {string} purpose @param {string} plaintext */
    seal(purpose, plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
      cipher.setAAD(Buffer.from(purpose));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    },
    /** @param {string} purpose @param {string} sealed @returns {string | null} null: tampered, or sealed with another key */
    unseal(purpose, sealed) {
      try {
        const raw = Buffer.from(sealed, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
    /** `payload.signature`, JSON in base64url. @param {string} purpose @param {unknown} value */
    sign(purpose, value) {
      const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${payload}.${mac(purpose, payload)}`;
    },
    /** @template T @param {string} purpose @param {string | null | undefined} signed @returns {T | undefined} */
    verify(purpose, signed) {
      const [payload, signature, extra] = String(signed ?? '').split('.');
      if (!payload || !signature || extra !== undefined || !equal(signature, mac(purpose, payload))) return undefined;
      try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString());
      } catch {
        return undefined;
      }
    },
  };
}
/** @typedef {ReturnType<typeof createSecrets>} Secrets */
