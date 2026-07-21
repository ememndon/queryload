import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dpapiProtect, dpapiUnprotect, type DpapiScope } from './dpapi.js';

/**
 * A tiny at-rest secret store: named blobs, each DPAPI-encrypted on disk.
 *
 * Used in Phase 0 for the engine's TLS private key. As later phases land, the
 * SQLCipher master key and API tokens live here too. The stored file is
 * `<name>.enc` and is meaningless without DPAPI unsealing on the same
 * user/machine.
 */
export class SecretStore {
  constructor(
    private readonly dir: string,
    private readonly scope: DpapiScope,
  ) {}

  private fileFor(name: string): string {
    return join(this.dir, `${name}.enc`);
  }

  async has(name: string): Promise<boolean> {
    try {
      await readFile(this.fileFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /** Store bytes, encrypted. Overwrites any existing secret of this name. */
  async set(name: string, plaintext: Buffer): Promise<void> {
    const file = this.fileFor(name);
    await mkdir(dirname(file), { recursive: true });
    const sealed = dpapiProtect(plaintext, this.scope);
    await writeFile(file, sealed);
  }

  /** Retrieve and decrypt bytes, or null if the secret does not exist. */
  async get(name: string): Promise<Buffer | null> {
    let sealed: Buffer;
    try {
      sealed = await readFile(this.fileFor(name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return dpapiUnprotect(sealed, this.scope);
  }
}
