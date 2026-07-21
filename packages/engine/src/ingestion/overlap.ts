import { isAbsolute, relative, resolve } from 'node:path';
import type { PathOverlapConflict } from '@queryload/shared';

/**
 * Overlap / nesting detection (D28). Adding a path that is identical to, inside
 * of, or a parent of an already-indexed path must warn and refuse rather than
 * double-index. Comparison is case-insensitive (Windows filesystem semantics).
 */
export function detectOverlap(
  candidate: string,
  existing: readonly string[],
): PathOverlapConflict | null {
  const c = normalize(candidate);
  for (const raw of existing) {
    const e = normalize(raw);
    if (c === e) return { requested: candidate, conflictsWith: raw, relationship: 'identical' };
    if (isSubpath(c, e)) {
      return { requested: candidate, conflictsWith: raw, relationship: 'nested-inside' };
    }
    if (isSubpath(e, c)) {
      return { requested: candidate, conflictsWith: raw, relationship: 'contains' };
    }
  }
  return null;
}

function normalize(p: string): string {
  return resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/** True if `child` is strictly inside `parent`. */
function isSubpath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}
