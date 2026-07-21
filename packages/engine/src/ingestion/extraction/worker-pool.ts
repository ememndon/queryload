import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../../logging/logger.js';
import type { ExtractionJob, ExtractionResult } from './types.js';

interface PendingJob {
  readonly job: ExtractionJob;
  readonly resolve: (r: ExtractionResult) => void;
  timer: NodeJS.Timeout | null;
}

interface Worker {
  child: ChildProcess;
  busy: boolean;
  job: PendingJob | null;
}

export interface WorkerPoolOptions {
  readonly size: number;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

/**
 * A pool of isolation workers. Extraction jobs queue and run on the next free
 * worker. A worker that crashes or exceeds the timeout resolves its job as a
 * failure (so the file is quarantined, not retried forever) and is replaced by
 * a fresh process. The engine is never affected by a bad parse.
 */
export class ExtractionWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly queue: Array<{ job: ExtractionJob; resolve: (r: ExtractionResult) => void }> =
    [];
  private destroyed = false;
  private readonly workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));

  constructor(private readonly options: WorkerPoolOptions) {
    for (let i = 0; i < Math.max(1, options.size); i++) this.spawn();
  }

  extract(job: ExtractionJob): Promise<ExtractionResult> {
    if (this.destroyed) return Promise.resolve({ ok: false, error: 'pool shut down' });
    return new Promise<ExtractionResult>((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  private spawn(): void {
    const child = fork(this.workerPath, [], { env: { ...process.env } });
    const worker: Worker = { child, busy: false, job: null };

    child.on('message', (result: ExtractionResult) => {
      const pending = worker.job;
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      worker.job = null;
      worker.busy = false;
      pending.resolve(result);
      this.pump();
    });

    child.on('exit', (code, signal) => {
      const pending = worker.job;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        worker.job = null;
        pending.resolve({
          ok: false,
          error: `extraction worker exited (code=${String(code)}, signal=${String(signal)})`,
        });
      }
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      if (!this.destroyed) this.spawn();
      this.pump();
    });

    child.on('error', (err) => this.options.logger.error({ err: err.message }, 'worker error'));

    this.workers.push(worker);
  }

  private pump(): void {
    if (this.destroyed) return;
    for (const worker of this.workers) {
      if (this.queue.length === 0) break;
      if (worker.busy) continue;
      const next = this.queue.shift();
      if (next) this.assign(worker, next.job, next.resolve);
    }
  }

  private assign(worker: Worker, job: ExtractionJob, resolve: (r: ExtractionResult) => void): void {
    worker.busy = true;
    const pending: PendingJob = { job, resolve, timer: null };
    worker.job = pending;
    pending.timer = setTimeout(() => {
      if (worker.job !== pending) return;
      worker.job = null;
      this.options.logger.warn({ file: job.filePath }, 'extraction timed out; killing worker');
      resolve({ ok: false, error: 'extraction timed out' });
      worker.child.kill('SIGKILL'); // exit handler respawns a clean worker
    }, this.options.timeoutMs);
    worker.child.send(job);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const q of this.queue) q.resolve({ ok: false, error: 'pool shut down' });
    this.queue.length = 0;
    for (const worker of this.workers) {
      if (worker.job?.timer) clearTimeout(worker.job.timer);
      worker.child.kill('SIGKILL');
    }
    this.workers.length = 0;
    await Promise.resolve();
  }
}
