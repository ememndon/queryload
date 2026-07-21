import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Logger } from '../logging/logger.js';
import type { Repositories, IndexedPathRow, ChunkRow, FileRow } from '../db/repos.js';
import type { VectorStore, VectorRecord } from '../index/vector-store.js';
import type { Embedder } from '../embedding/embedder.js';
import type { FormatHandlerRegistry } from './extraction/registry.js';
import type { ExtractionWorkerPool } from './extraction/worker-pool.js';
import { chunkDocument } from './chunking/chunker.js';
import { hashFile } from './hashing.js';
import { ocr } from './extraction/ocr.js';
import type { WalkedFile } from './walker.js';

export type IngestStatus = 'indexed' | 'unchanged' | 'skipped' | 'quarantined' | 'deferred';

/**
 * Sanity cap on a single file's size. Several handlers read the whole file into
 * memory (readFile), so an enormous file (a stray disk image, a multi-GB log)
 * would OOM the isolation worker. We quarantine it with a clear reason instead.
 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * A file whose stored state cannot improve unless its bytes change (or OCR is
 * later provisioned). 'empty' has no extractable text and always will; an
 * 'ocr-deferred' page can only improve once OCR exists. Treating these like
 * 'indexed' for change-detection avoids pointlessly re-extracting them on every
 * scan and every reboot.
 */
function isSettled(status: string): boolean {
  if (status === 'indexed' || status === 'empty') return true;
  if (status === 'ocr-deferred') return !ocr.isAvailable();
  return false;
}

export interface IngestOutcome {
  readonly status: IngestStatus;
  readonly chunks?: number;
  readonly reason?: string;
}

export interface PipelineDeps {
  readonly repos: Repositories;
  readonly vectors: VectorStore;
  readonly embedder: Embedder;
  readonly pool: ExtractionWorkerPool;
  readonly registry: FormatHandlerRegistry;
  readonly logger: Logger;
  /** Max parse attempts before a file is left quarantined (never retried forever). */
  readonly maxAttempts: number;
}

/**
 * Ingests a single file end to end: change-detect → extract (in an isolation
 * worker) → chunk → embed → persist to the encrypted index. Idempotent: the
 * vector + chunk writes are delete-then-insert keyed by file id, so re-running
 * on an unchanged or modified file always converges to the correct state.
 */
export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async ingestFile(file: WalkedFile, indexedPath: IndexedPathRow): Promise<IngestOutcome> {
    const { repos, registry, logger } = this.deps;
    const path = file.path;

    if (!registry.supports(path)) return { status: 'skipped' };

    const existing = repos.files.getByPath(path);
    if (
      existing &&
      isSettled(existing.status) &&
      existing.mtime === file.mtimeMs &&
      existing.size === file.size
    ) {
      return { status: 'unchanged' };
    }

    // Don't retry a persistently failing file forever (D46). A change (newer
    // mtime) clears the quarantine via the watcher before we get here.
    if (repos.quarantine.attemptsFor(path) >= this.deps.maxAttempts) {
      return { status: 'quarantined', reason: 'exceeded parse attempts' };
    }

    // Guard against pathological inputs before any whole-file read.
    if (file.size > MAX_FILE_BYTES) {
      repos.quarantine.record(randomUUID(), path, indexedPath.id, 'file exceeds size limit', Date.now());
      logger.warn({ path, size: file.size }, 'file quarantined: exceeds size limit');
      return { status: 'quarantined', reason: 'file exceeds size limit' };
    }

    const hash = await hashFile(path);

    // Retention tombstone: this exact content was purged by the documents policy.
    // Don't silently re-ingest it (that would defeat retention); re-index only if
    // the bytes have since changed, in which case the stale tombstone is cleared.
    const tomb = repos.tombstones.get(path);
    if (tomb) {
      if (tomb.hash === hash) return { status: 'skipped', reason: 'purged by retention policy' };
      repos.tombstones.remove(path);
    }

    if (existing && existing.hash === hash && isSettled(existing.status)) {
      // Same bytes, only mtime moved — refresh mtime but PRESERVE updated_at so a
      // re-scan doesn't reset the retention clock (updated_at = time last indexed).
      repos.files.upsert({ ...existing, mtime: file.mtimeMs });
      return { status: 'unchanged' };
    }

    const ext = extname(path).toLowerCase();
    const result = await this.deps.pool.extract({ filePath: path, ext });
    if (!result.ok) {
      repos.quarantine.record(randomUUID(), path, indexedPath.id, result.error, Date.now());
      logger.warn({ path, error: result.error }, 'file quarantined');
      return { status: 'quarantined', reason: result.error };
    }

    const doc = result.document;
    const chunks = chunkDocument(doc);
    const fileId = existing?.id ?? randomUUID();
    const pageCount = doc.pages.reduce((max, p) => Math.max(max, p.page ?? 0), 0);

    if (chunks.length === 0) {
      // Nothing extractable (e.g. scanned doc awaiting OCR) — record the file but
      // index no chunks. It will be reprocessed when OCR is provisioned.
      this.writeFileRow(existing, {
        id: fileId,
        path,
        indexedPathId: indexedPath.id,
        workspaceId: indexedPath.workspace_id,
        hash,
        mtime: file.mtimeMs,
        size: file.size,
        type: doc.type,
        status: doc.ocrDeferred ? 'ocr-deferred' : 'empty',
        pageCount,
      });
      await this.deps.vectors.deleteFile(fileId);
      repos.chunks.deleteByFile(fileId);
      return { status: doc.ocrDeferred ? 'deferred' : 'indexed', chunks: 0 };
    }

    const embeddings = await this.deps.embedder.embed(chunks.map((c) => c.text));

    // One chunk id shared by the SQLite row (holds the text) and the LanceDB
    // record (holds the vector), so retrieval can join a vector hit back to its
    // authoritative text + page.
    const ids = chunks.map(() => randomUUID());

    const chunkRows: ChunkRow[] = chunks.map((c, i) => ({
      id: ids[i]!,
      file_id: fileId,
      workspace_id: indexedPath.workspace_id,
      ordinal: c.ordinal,
      page: c.page,
      char_start: c.charStart,
      char_end: c.charEnd,
      hash: c.hash,
      token_count: c.tokenCount,
      text: c.text,
    }));

    const vectorRecords: VectorRecord[] = chunks.map((c, i) => ({
      id: ids[i]!,
      file_id: fileId,
      workspace_id: indexedPath.workspace_id,
      page: c.page ?? 0,
      ordinal: c.ordinal,
      vector: embeddings[i]!,
    }));

    // Write the parent file row FIRST (foreign keys require it before chunks),
    // as 'indexing'. Only after vectors land do we flip it to 'indexed', so a
    // failure mid-write leaves a non-'indexed' row that the next scan reprocesses.
    this.writeFileRow(existing, {
      id: fileId,
      path,
      indexedPathId: indexedPath.id,
      workspaceId: indexedPath.workspace_id,
      hash,
      mtime: file.mtimeMs,
      size: file.size,
      type: doc.type,
      status: 'indexing',
      pageCount,
    });
    repos.chunks.deleteByFile(fileId);
    repos.chunks.insertMany(chunkRows);
    await this.deps.vectors.upsertFileChunks(fileId, vectorRecords);
    repos.files.setStatus(fileId, 'indexed');
    repos.quarantine.removeByPath(path);

    return { status: 'indexed', chunks: chunks.length };
  }

  /** Purge a file entirely from the index (chunks + vectors + row). */
  async removeFile(path: string): Promise<void> {
    const existing = this.deps.repos.files.getByPath(path);
    if (!existing) return;
    await this.deps.vectors.deleteFile(existing.id);
    this.deps.repos.chunks.deleteByFile(existing.id);
    this.deps.repos.files.deleteByPath(path);
    this.deps.repos.quarantine.removeByPath(path);
  }

  private writeFileRow(
    existing: FileRow | undefined,
    v: {
      id: string;
      path: string;
      indexedPathId: string;
      workspaceId: string;
      hash: string;
      mtime: number;
      size: number;
      type: string;
      status: string;
      pageCount: number;
    },
  ): void {
    void existing;
    this.deps.repos.files.upsert({
      id: v.id,
      path: v.path,
      indexed_path_id: v.indexedPathId,
      workspace_id: v.workspaceId,
      hash: v.hash,
      mtime: v.mtime,
      size: v.size,
      type: v.type,
      status: v.status,
      page_count: v.pageCount,
      updated_at: Date.now(),
    });
  }
}
