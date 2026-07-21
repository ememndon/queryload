import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Encrypted config/index export (D50/D73): "config/index export is always
 * encrypted." AES-256-GCM with a key derived from the user's passphrase via
 * scrypt. The authentication tag means a wrong passphrase (or a tampered blob)
 * fails to decrypt rather than yielding garbage.
 *
 * Blob layout: MAGIC(4) | salt(16) | iv(12) | tag(16) | ciphertext.
 */
const MAGIC = Buffer.from('QLX1');

/**
 * scrypt cost. Raised well above Node's defaults (N=2^14) to strengthen the
 * offline brute-force resistance of an exportable blob. Used symmetrically by
 * encrypt + decrypt; maxmem is sized for N·r·128 bytes (2^16·8·128 = 64 MiB).
 */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function encryptExport(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

export function decryptExport(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < 48 || !blob.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Not a QueryLoad encrypted export.');
  }
  const salt = blob.subarray(4, 20);
  const iv = blob.subarray(20, 32);
  const tag = blob.subarray(32, 48);
  const ciphertext = blob.subarray(48);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() throws if the passphrase is wrong or the blob was tampered with.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
