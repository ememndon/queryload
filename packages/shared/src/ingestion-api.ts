/**
 * Phase 1 API contract — path management, ingestion status, workspaces.
 *
 * These types are the shared vocabulary between the engine (which owns the
 * index) and the renderer (a pure client). The renderer never reasons about
 * files directly — it reads these snapshots and issues these commands.
 */

/** A workspace: the unit of access control and retrieval scoping (D54). */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Vertical flavour — drives demo seeding and chunking hints, never shown raw. */
  readonly kind: 'general' | 'demo' | 'matter' | 'patient';
  readonly createdAt: number;
}

export type IndexedPathState =
  | 'scanning' // walking the tree / extracting
  | 'watching' // steady state, watcher live
  | 'offline' // NAS/mapped drive unavailable — index preserved
  | 'error';

/** A folder the user asked QueryLoad to index, plus its live status. */
export interface IndexedPathStatus {
  readonly id: string;
  readonly path: string;
  readonly workspaceId: string;
  readonly state: IndexedPathState;
  /** Files successfully indexed. */
  readonly filesIndexed: number;
  /** Files discovered in the current/last scan (denominator for progress). */
  readonly filesDiscovered: number;
  /** Files skipped (unknown type). */
  readonly filesSkipped: number;
  /** Files quarantined from this path. */
  readonly filesQuarantined: number;
  /** Estimated seconds remaining for the active scan, if one is running. */
  readonly etaSeconds: number | null;
  /** Human-readable status line, e.g. the NAS-offline banner text. */
  readonly message: string | null;
  readonly lastActivityAt: number;
}

/** A file that could not be parsed and was set aside (D46). */
export interface QuarantineEntry {
  readonly id: string;
  readonly path: string;
  readonly reason: string;
  readonly attempts: number;
  readonly at: number;
}

export interface IngestionStatusResponse {
  readonly paths: readonly IndexedPathStatus[];
  readonly totals: {
    readonly filesIndexed: number;
    readonly chunks: number;
    readonly quarantined: number;
    /** True while any path is actively scanning. */
    readonly busy: boolean;
  };
  readonly quarantine: readonly QuarantineEntry[];
}

export interface AddPathRequest {
  readonly path: string;
  /** Optional target workspace; defaults to the General workspace. */
  readonly workspaceId?: string;
}

/**
 * Overlap detail returned (as a 409 conflict) when the requested path is the
 * same as, inside, or contains an already-indexed path. The engine never
 * double-indexes; the UI shows this as a warning (D28).
 */
export interface PathOverlapConflict {
  readonly requested: string;
  readonly conflictsWith: string;
  readonly relationship: 'identical' | 'nested-inside' | 'contains';
}

export interface AddPathResponse {
  readonly path: IndexedPathStatus;
}

/** Route builders — keep literals in one place (parameterized routes included). */
export const IngestionRoutes = {
  workspaces: '/v1/workspaces',
  paths: '/v1/paths',
  path: (id: string): string => `/v1/paths/${encodeURIComponent(id)}`,
  ingestionStatus: '/v1/ingestion/status',
} as const;
