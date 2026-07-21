import { stat, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { extname } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type {
  IndexedPathStatus,
  IndexingEstimate,
  IngestionStatusResponse,
  PathOverlapConflict,
  QuarantineEntry,
  Workspace,
} from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import type { Repositories, IndexedPathRow } from '../db/repos.js';
import type { VectorStore } from '../index/vector-store.js';
import type { Embedder } from '../embedding/embedder.js';
import { createDefaultRegistry, type FormatHandlerRegistry } from './extraction/registry.js';
import { ExtractionWorkerPool } from './extraction/worker-pool.js';
import { Pipeline } from './pipeline.js';
import { walk, type WalkedFile } from './walker.js';
import { detectOverlap } from './overlap.js';
import { GENERAL_WORKSPACE_ID } from '../db/schema.js';
import { ConcurrencyLimiter } from './concurrency.js';

export class PathOverlapError extends Error {
  constructor(readonly conflict: PathOverlapConflict) {
    super('The folder overlaps a folder QueryLoad already indexes.');
    this.name = 'PathOverlapError';
  }
}
export class PathNotFoundError extends Error {
  constructor(path: string) {
    super(`The folder does not exist or is not a directory: ${path}`);
    this.name = 'PathNotFoundError';
  }
}

interface PathRuntime {
  discovered: number;
  skipped: number;
  scanning: boolean;
  offline: boolean;
  scanStartedAt: number | null;
  processed: number;
  watcher: FSWatcher | null;
  abort: AbortController | null;
  offlineTimer: NodeJS.Timeout | null;
}

const OFFLINE_RETRY_MS = 30_000;

/**
 * Owns the whole ingestion lifecycle for every indexed path: add/remove,
 * initial + incremental scanning with live progress, file watching, NAS-offline
 * grace, and the status snapshot the UI renders. It is the engine's single
 * front door to the index.
 */
export class IngestionManager {
  private readonly registry: FormatHandlerRegistry;
  private readonly pool: ExtractionWorkerPool;
  private readonly pipeline: Pipeline;
  private readonly limiter: ConcurrencyLimiter;
  private readonly concurrency: number;
  private readonly runtimes = new Map<string, PathRuntime>();

  constructor(
    private readonly repos: Repositories,
    private readonly vectors: VectorStore,
    embedder: Embedder,
    private readonly logger: Logger,
  ) {
    this.registry = createDefaultRegistry();
    const concurrency = Math.max(1, Math.min(cpus().length - 1, 4));
    this.concurrency = concurrency;
    this.pool = new ExtractionWorkerPool({ size: concurrency, timeoutMs: 120_000, logger });
    this.limiter = new ConcurrencyLimiter(concurrency);
    this.pipeline = new Pipeline({
      repos,
      vectors,
      embedder,
      pool: this.pool,
      registry: this.registry,
      logger,
      maxAttempts: 3,
    });
  }

  /** On boot, resume every known path: reconcile (delta-only) + re-watch. */
  init(): void {
    for (const row of this.repos.paths.list()) {
      this.runtimes.set(row.id, freshRuntime());
      this.startWatcher(row);
      void this.scanPath(row);
    }
  }

  listWorkspaces(): Workspace[] {
    return this.repos.workspaces.list();
  }

  /**
   * Sample-based indexing-time estimate for a large archive (D40). Counts
   * supported files, times extraction of a small spread-out sample, and
   * extrapolates across the parallel worker pool.
   */
  async estimate(path: string): Promise<IndexingEstimate> {
    const files: WalkedFile[] = [];
    try {
      for await (const f of walk(path)) {
        if (this.registry.supports(f.path)) files.push(f);
      }
    } catch {
      /* unreadable/offline — fall through with what we have */
    }
    const fileCount = files.length;
    if (fileCount === 0) {
      return {
        path,
        fileCount: 0,
        estimatedSeconds: 0,
        summary: 'No indexable documents found here.',
      };
    }
    const sampleN = Math.min(6, fileCount);
    const sample = spread(files, sampleN);
    const t0 = Date.now();
    await Promise.all(
      sample.map((f) =>
        this.limiter.run(() =>
          this.pool.extract({ filePath: f.path, ext: extname(f.path).toLowerCase() }),
        ),
      ),
    );
    const perFileMs = (Date.now() - t0) / sampleN;
    const estimatedSeconds = Math.max(
      1,
      Math.round((perFileMs * fileCount) / (this.concurrency * 1000)),
    );
    return {
      path,
      fileCount,
      estimatedSeconds,
      summary: humanizeEstimate(fileCount, estimatedSeconds),
    };
  }

  async addPath(inputPath: string, workspaceId?: string): Promise<IndexedPathStatus> {
    let isDir = false;
    try {
      isDir = (await stat(inputPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new PathNotFoundError(inputPath);

    const conflict = detectOverlap(inputPath, this.repos.paths.allPaths());
    if (conflict) throw new PathOverlapError(conflict);

    const ws =
      workspaceId && this.repos.workspaces.exists(workspaceId) ? workspaceId : GENERAL_WORKSPACE_ID;
    const now = Date.now();
    const row: IndexedPathRow = {
      id: randomUUID(),
      path: inputPath,
      workspace_id: ws,
      state: 'scanning',
      added_at: now,
      last_activity_at: now,
      message: null,
    };
    this.repos.paths.insert(row);
    this.runtimes.set(row.id, freshRuntime());
    this.startWatcher(row);
    void this.scanPath(row);
    return this.statusForPath(row);
  }

  async removePath(id: string): Promise<void> {
    const row = this.repos.paths.getById(id);
    if (!row) return;
    const rt = this.runtimes.get(id);
    rt?.abort?.abort();
    if (rt?.offlineTimer) clearTimeout(rt.offlineTimer);
    await rt?.watcher?.close();
    this.runtimes.delete(id);

    // Purge vectors in one batched delete (LanceDB isn't cascaded by SQLite),
    // then the DB cascade removes files + chunks + quarantine rows for this path.
    await this.vectors.deleteFiles(this.repos.files.idsByIndexedPath(id));
    this.repos.paths.remove(id);
    this.logger.info({ id, path: row.path }, 'indexed path removed and purged');
  }

  getStatus(): IngestionStatusResponse {
    const paths = this.repos.paths.list().map((row) => this.statusForPath(row));
    const quarantine: QuarantineEntry[] = this.repos.quarantine.list().map((q) => ({
      id: q.id,
      path: q.path,
      reason: q.reason,
      attempts: q.attempts,
      at: q.at,
    }));
    return {
      paths,
      totals: {
        filesIndexed: this.repos.files.countTotalIndexed(),
        chunks: this.repos.chunks.countTotal(),
        quarantined: this.repos.quarantine.countTotal(),
        busy: [...this.runtimes.values()].some((r) => r.scanning),
      },
      quarantine,
    };
  }

  /** Rebuild the whole index (D73): purge everything, then re-scan all paths. */
  async rebuildAll(): Promise<void> {
    await this.purgeIndex();
    for (const row of this.repos.paths.list()) {
      if (!this.runtimes.has(row.id)) this.runtimes.set(row.id, freshRuntime());
      void this.scanPath(row);
    }
    this.logger.info('index rebuild started');
  }

  /**
   * Purge every indexed file + its vectors WITHOUT re-scanning or touching
   * watchers. Used at boot when the embedder has changed (D19): the caller then
   * runs {@link init} so every file is re-extracted and re-embedded from scratch
   * with the new embedder. A plain delta scan would NOT do this — it skips files
   * whose content hash is unchanged, leaving stale vectors from the old embedder.
   */
  async purgeIndex(): Promise<void> {
    const ids: string[] = [];
    for (const row of this.repos.paths.list()) {
      ids.push(...this.repos.files.idsByIndexedPath(row.id));
    }
    await this.vectors.deleteFiles(ids);
    for (const id of ids) this.repos.files.deleteById(id);
    this.logger.info('index purged');
  }

  async shutdown(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      rt.abort?.abort();
      if (rt.offlineTimer) clearTimeout(rt.offlineTimer);
      await rt.watcher?.close();
    }
    this.runtimes.clear();
    await this.pool.destroy();
  }

  // --- internals ---

  private statusForPath(row: IndexedPathRow): IndexedPathStatus {
    const current = this.repos.paths.getById(row.id) ?? row;
    const rt = this.runtimes.get(row.id) ?? freshRuntime();
    return {
      id: current.id,
      path: current.path,
      workspaceId: current.workspace_id,
      state: current.state,
      filesIndexed: this.repos.files.countIndexed(current.id),
      filesDiscovered: rt.discovered,
      filesSkipped: rt.skipped,
      filesQuarantined: this.repos.quarantine.countForIndexedPath(current.id),
      etaSeconds: this.eta(rt),
      message: current.message,
      lastActivityAt: current.last_activity_at,
    };
  }

  private eta(rt: PathRuntime): number | null {
    if (!rt.scanning || rt.processed === 0 || rt.scanStartedAt === null) return null;
    const elapsed = (Date.now() - rt.scanStartedAt) / 1000;
    const rate = rt.processed / Math.max(elapsed, 0.001);
    const remaining = Math.max(0, rt.discovered - rt.processed);
    return rate > 0 ? Math.round(remaining / rate) : null;
  }

  private async scanPath(row: IndexedPathRow): Promise<void> {
    const rt = this.runtimes.get(row.id);
    if (!rt) return;
    // Cancel any scan already in progress for this path, then run under a fresh
    // controller captured locally. Using the local `abort` (not rt.abort) for
    // every check means a superseding scan can't leave the old one's in-flight
    // callbacks running concurrently — they observe THEIR controller's abort.
    rt.abort?.abort();
    const abort = new AbortController();
    rt.abort = abort;
    rt.scanning = true;
    rt.offline = false;
    rt.processed = 0;
    rt.discovered = 0;
    rt.skipped = 0;
    rt.scanStartedAt = Date.now();
    this.setState(row.id, 'scanning', null);

    // Availability check — a missing root means the drive/NAS is offline.
    try {
      if (!(await stat(row.path)).isDirectory()) throw new Error('not a directory');
    } catch {
      this.markOffline(row);
      return;
    }

    // Pass 1: discover supported files (fast, stat-only) for a real denominator.
    const files: WalkedFile[] = [];
    try {
      for await (const f of walk(row.path, abort.signal)) {
        if (this.registry.supports(f.path)) files.push(f);
        else rt.skipped++;
      }
    } catch {
      this.markOffline(row);
      return;
    }
    if (abort.signal.aborted) return;
    rt.discovered = files.length;

    // Pass 2: ingest with bounded concurrency (delta-only via hash/mtime).
    await Promise.all(
      files.map((f) =>
        this.limiter.run(async () => {
          if (abort.signal.aborted) return;
          try {
            await this.pipeline.ingestFile(f, row);
          } catch (err) {
            this.logger.error({ path: f.path, err: describe(err) }, 'ingest failed');
          }
          rt.processed++;
          this.touch(row.id);
        }),
      ),
    );

    if (abort.signal.aborted) return;
    rt.scanning = false;
    this.setState(row.id, 'watching', null);
    this.logger.info(
      { path: row.path, indexed: this.repos.files.countIndexed(row.id) },
      'scan complete',
    );
  }

  private startWatcher(row: IndexedPathRow): void {
    const rt = this.runtimes.get(row.id);
    if (!rt) return;
    // chokidar honors followSymlinks at runtime but its v4+ types omit it, so we
    // build the options as a variable (a fresh object literal in the call would
    // trip excess-property checking). Symlinks are never indexed — matches the
    // walker, so scan and watch stay consistent.
    const watchOptions = {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth: 32,
    };
    const watcher = watch(row.path, watchOptions);
    watcher.on('add', (p: string) => this.enqueueIngest(row, p));
    watcher.on('change', (p: string) => {
      this.repos.quarantine.removeByPath(p); // a change is a fresh chance to parse
      this.enqueueIngest(row, p);
    });
    watcher.on('unlink', (p: string) => {
      this.limiter
        .run(() => this.pipeline.removeFile(p))
        .catch((err: unknown) =>
          this.logger.error({ p, err: describe(err) }, 'unlink purge failed'),
        );
      this.touch(row.id);
    });
    watcher.on('error', (err: unknown) => {
      this.logger.warn({ path: row.path, err: describe(err) }, 'watcher error');
      void this.checkOffline(row);
    });
    rt.watcher = watcher;
  }

  private enqueueIngest(row: IndexedPathRow, filePath: string): void {
    if (!this.registry.supports(filePath)) return;
    this.limiter
      .run(async () => {
        // lstat (not stat) so a symlink is seen as a symlink and skipped — the
        // walker ignores symlinks too, keeping scan and watch consistent.
        const st = await lstat(filePath).catch(() => null);
        if (!st?.isFile()) return;
        await this.pipeline.ingestFile(
          { path: filePath, size: st.size, mtimeMs: Math.round(st.mtimeMs) },
          row,
        );
        this.touch(row.id);
      })
      .catch((err: unknown) =>
        this.logger.error({ filePath, err: describe(err) }, 'watch ingest failed'),
      );
  }

  private markOffline(row: IndexedPathRow): void {
    const rt = this.runtimes.get(row.id);
    if (!rt) return;
    rt.scanning = false;
    rt.offline = true;
    const drive = row.path.slice(0, 2);
    this.setState(
      row.id,
      'offline',
      `${drive} offline — index preserved, will resume when reconnected.`,
    );
    this.logger.warn({ path: row.path }, 'path offline; index preserved');
    if (rt.offlineTimer) clearTimeout(rt.offlineTimer);
    rt.offlineTimer = setTimeout(() => void this.checkOffline(row), OFFLINE_RETRY_MS);
  }

  private async checkOffline(row: IndexedPathRow): Promise<void> {
    const rt = this.runtimes.get(row.id);
    if (!rt) return;
    const available = await stat(row.path)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (available) {
      this.logger.info({ path: row.path }, 'path back online; rescanning');
      void this.scanPath(row);
    } else {
      rt.offline = true;
      if (rt.offlineTimer) clearTimeout(rt.offlineTimer);
      rt.offlineTimer = setTimeout(() => void this.checkOffline(row), OFFLINE_RETRY_MS);
    }
  }

  private setState(id: string, state: IndexedPathRow['state'], message: string | null): void {
    this.repos.paths.updateState(id, state, message, Date.now());
  }
  private touch(id: string): void {
    const row = this.repos.paths.getById(id);
    if (row) this.repos.paths.updateState(id, row.state, row.message, Date.now());
  }
}

function freshRuntime(): PathRuntime {
  return {
    discovered: 0,
    skipped: 0,
    scanning: false,
    offline: false,
    scanStartedAt: null,
    processed: 0,
    watcher: null,
    abort: null,
    offlineTimer: null,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Pick `n` items spread evenly across a list (a representative sample). */
function spread<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}

function humanizeEstimate(count: number, seconds: number): string {
  const docs = count.toLocaleString('en-US');
  let time: string;
  if (seconds >= 3600) {
    const h = Math.round((seconds / 3600) * 10) / 10;
    time = `${h} hour${h === 1 ? '' : 's'}`;
  } else if (seconds >= 60) {
    time = `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}`;
  } else {
    time = `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return `~${docs} document${count === 1 ? '' : 's'}: estimated ${time}, runs in the background.`;
}
