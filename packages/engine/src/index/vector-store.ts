import { connect, type Connection, type Table } from '@lancedb/lancedb';
import type { Logger } from '../logging/logger.js';

/**
 * The vector index (LanceDB, embedded/file-based).
 *
 * CRITICAL data-locality property: this store holds ONLY numeric embeddings and
 * opaque ids (chunk/file/workspace UUIDs, page, ordinal). It contains NO
 * document text — every human-readable string lives in the SQLCipher-encrypted
 * metadata DB. So the two "homes" for content are the originals and the
 * encrypted index; LanceDB adds vectors, not a third copy of the text (D34–D36).
 *
 * Workspace scoping is applied as a PRE-filter on search (the ethical wall,
 * D54): the filter runs before ANN ranking so vectors from other workspaces are
 * never even considered. The renderer never filters — the wall is in the query.
 */
export interface VectorRecord {
  readonly id: string;
  readonly file_id: string;
  readonly workspace_id: string;
  readonly page: number;
  readonly ordinal: number;
  readonly vector: number[];
}

export interface VectorSearchHit {
  readonly id: string;
  readonly file_id: string;
  readonly workspace_id: string;
  readonly page: number;
  readonly distance: number;
}

const TABLE = 'chunks';
const ID_RE = /^[A-Za-z0-9_-]+$/;
/** Compact the dataset after this many mutating ops (delete/add fragment it). */
const COMPACT_EVERY = 200;
/** Max ids per `IN (...)` predicate so a bulk delete stays a few round-trips. */
const DELETE_BATCH = 500;

/** Guard against filter-string injection; our ids are UUIDs, so this is cheap. */
function assertSafeId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Unsafe id for vector filter: ${id}`);
}

export class VectorStore {
  private conn: Connection | null = null;
  private table: Table | null = null;
  /** Serializes all mutating ops: LanceDB table create/append/delete must not
   * race (concurrent scans would otherwise double-create the table). Reads stay
   * concurrent. */
  private writeLock: Promise<unknown> = Promise.resolve();
  /** Mutating ops since the last compaction. */
  private mutations = 0;

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  async open(): Promise<void> {
    this.conn = await connect(this.dir);
    const names = await this.conn.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.conn.openTable(TABLE);
    }
    this.logger.info({ hasTable: this.table !== null }, 'vector store open');
  }

  /**
   * Compact the dataset periodically. LanceDB keeps every delete/add as a new
   * fragment + version; without this the on-disk index grows unbounded and
   * scans slow down. Called inside the write lock after a mutation. Best-effort.
   */
  private async compactIfDue(): Promise<void> {
    if (++this.mutations < COMPACT_EVERY || !this.table) return;
    this.mutations = 0;
    try {
      await this.table.optimize();
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'vector store compaction failed');
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeLock.then(fn, fn);
    this.writeLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Replace all vectors for a file (delete-then-insert = idempotent reindex). */
  upsertFileChunks(fileId: string, records: readonly VectorRecord[]): Promise<void> {
    assertSafeId(fileId);
    return this.serialize(async () => {
      if (records.length === 0) {
        if (this.table) await this.table.delete(`file_id = '${fileId}'`);
        return;
      }
      const rows = records as unknown as Record<string, unknown>[];
      if (!this.table) {
        // First data defines the schema (vector dim inferred from row length).
        this.table = await this.conn!.createTable(TABLE, rows);
        return;
      }
      await this.table.delete(`file_id = '${fileId}'`);
      await this.table.add(rows);
      await this.compactIfDue();
    });
  }

  deleteFile(fileId: string): Promise<void> {
    assertSafeId(fileId);
    return this.serialize(async () => {
      if (!this.table) return;
      await this.table.delete(`file_id = '${fileId}'`);
      await this.compactIfDue();
    });
  }

  /**
   * Delete every vector for a set of files in as few predicate deletes as
   * possible (batched `file_id IN (...)`), under a single write-lock hold —
   * instead of one serialized round-trip per file.
   */
  deleteFiles(fileIds: readonly string[]): Promise<void> {
    for (const id of fileIds) assertSafeId(id);
    return this.serialize(async () => {
      if (!this.table || fileIds.length === 0) return;
      for (let i = 0; i < fileIds.length; i += DELETE_BATCH) {
        const inList = fileIds
          .slice(i, i + DELETE_BATCH)
          .map((id) => `'${id}'`)
          .join(', ');
        await this.table.delete(`file_id IN (${inList})`);
      }
      await this.compactIfDue();
    });
  }

  /** Delete every vector belonging to a workspace (retention / path removal). */
  deleteWorkspace(workspaceId: string): Promise<void> {
    assertSafeId(workspaceId);
    return this.serialize(async () => {
      if (!this.table) return;
      await this.table.delete(`workspace_id = '${workspaceId}'`);
      await this.compactIfDue();
    });
  }

  /**
   * Top-k nearest chunks WITHIN a workspace. The workspace filter is a
   * pre-filter, so it constrains the candidate set before ranking. Used by
   * retrieval in Phase 3.
   */
  async search(
    vector: readonly number[],
    workspaceId: string,
    k: number,
  ): Promise<VectorSearchHit[]> {
    assertSafeId(workspaceId);
    if (!this.table) return [];
    const rows = (await this.table
      .vectorSearch(vector as number[])
      .where(`workspace_id = '${workspaceId}'`)
      .limit(k)
      .toArray()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      file_id: String(r.file_id),
      workspace_id: String(r.workspace_id),
      page: Number(r.page),
      distance: Number(r._distance ?? 0),
    }));
  }

  async countRows(): Promise<number> {
    if (!this.table) return 0;
    return this.table.countRows();
  }

  close(): Promise<void> {
    this.table?.close();
    this.conn?.close();
    this.table = null;
    this.conn = null;
    return Promise.resolve();
  }
}
