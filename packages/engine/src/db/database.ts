import { BetterSqlite3, type Db } from './sqlite.js';
import { migrate } from './schema.js';
import type { SecretStore } from '../security/secret-store.js';
import { getOrCreateDbKey } from './keys.js';
import type { Logger } from '../logging/logger.js';

/**
 * Opens the SQLCipher-encrypted metadata database.
 *
 * The passphrase comes from the DPAPI-sealed key store, so the file is
 * unreadable ciphertext without the current user/machine's DPAPI context. WAL
 * mode + a busy timeout keep the ingestion workers and the API responsive
 * under concurrent access. Foreign keys are enforced so a deleted file cascades
 * to its chunks (retention correctness, Phase 5).
 */
export async function openDatabase(
  dbFile: string,
  keyStore: SecretStore,
  logger: Logger,
): Promise<Db> {
  const key = await getOrCreateDbKey(keyStore);
  const db = new BetterSqlite3(dbFile);

  // Order matters: declare the cipher, then supply the key, before any I/O.
  db.pragma("cipher='sqlcipher'");
  db.pragma(`key='${key.replace(/'/g, "''")}'`);

  // Prove the key is correct with a trivial read; a wrong key throws here.
  try {
    db.pragma('user_version', { simple: true });
  } catch (err) {
    db.close();
    throw new Error(
      `Failed to open the encrypted metadata database — the key may be wrong or the file corrupt. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  logger.info('metadata database open (SQLCipher, migrated)');
  return db;
}
