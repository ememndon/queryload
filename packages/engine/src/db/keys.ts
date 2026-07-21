import { randomBytes } from 'node:crypto';
import type { SecretStore } from '../security/secret-store.js';

/**
 * The SQLCipher master passphrase for `metadata.db`.
 *
 * A 32-byte random secret, generated on first run and sealed by Windows DPAPI
 * via the {@link SecretStore}. It never exists in the clear on disk. Without
 * it, `metadata.db` — which holds all document text, file paths, and chunk
 * content — is unreadable ciphertext (D43, Phase 1 acceptance).
 */
const DB_KEY_SECRET_NAME = 'metadata-db-key';

export async function getOrCreateDbKey(store: SecretStore): Promise<string> {
  const existing = await store.get(DB_KEY_SECRET_NAME);
  if (existing) return existing.toString('utf8');
  const key = randomBytes(32).toString('base64');
  await store.set(DB_KEY_SECRET_NAME, Buffer.from(key, 'utf8'));
  return key;
}
