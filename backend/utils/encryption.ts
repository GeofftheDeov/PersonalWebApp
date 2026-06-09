import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const k = process.env.VAULT_ENCRYPTION_KEY || '';
  if (!k) throw new Error('VAULT_ENCRYPTION_KEY env var is not set');
  // Accept 64-char hex (32 raw bytes) or a 32-char ASCII string
  if (k.length === 64 && /^[0-9a-fA-F]+$/.test(k)) return Buffer.from(k, 'hex');
  const buf = Buffer.from(k, 'utf8');
  if (buf.length !== 32) throw new Error('VAULT_ENCRYPTION_KEY must be 32 bytes (UTF-8) or a 64-char hex string');
  return buf;
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded blob: 12-byte IV + 16-byte GCM auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a base64 blob produced by encrypt().
 */
export function decrypt(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}
