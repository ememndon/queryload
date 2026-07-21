import { mkdir } from 'node:fs/promises';
import type { AppPaths } from './paths.js';

/**
 * Creates the `%APPDATA%/QueryLoad` layout on first run (Phase 0 acceptance):
 * `{ config.json, index/, metadata.db, logs/, quarantine/, certs/, models/ }`.
 *
 * Idempotent: safe to call on every start. Directories are created; files
 * (config.json, metadata.db) are created lazily by their owning subsystems.
 */
export async function ensureAppDataLayout(paths: AppPaths): Promise<void> {
  for (const dir of paths.requiredDirs) {
    await mkdir(dir, { recursive: true });
  }
}
