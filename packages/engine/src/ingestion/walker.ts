import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface WalkedFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Names we never index: OS/editor junk and app lock files. */
const IGNORED_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', '.git']);

function isIgnored(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith('.') || name.startsWith('~$') || IGNORED_NAMES.has(lower);
}

/**
 * Recursively walk a directory, yielding files with stat info. Unreadable
 * directories and files are skipped (never fatal). Iterative (explicit stack)
 * so deep trees don't blow the call stack. Honours an AbortSignal so a removed
 * path or shutdown stops the walk promptly.
 */
export async function* walk(
  root: string,
  signal?: AbortSignal,
): AsyncGenerator<WalkedFile, void, void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip, don't fail the whole walk
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      // Ignore symlinks entirely (both here and in the watcher, which sets
      // followSymlinks:false) — following them risks cycles and double-indexing
      // a file via both its real path and a link. Keep the two in agreement.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = await stat(full);
          yield { path: full, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
        } catch {
          continue;
        }
      }
    }
  }
}
