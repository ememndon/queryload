import { randomUUID } from 'node:crypto';
import type { InferenceBackend, InferenceRequest, InferenceResult } from './backend.js';

interface Job {
  readonly id: string;
  readonly userId: string;
  readonly req: InferenceRequest;
  readonly onToken: (t: string) => void;
  readonly resolve: (r: InferenceResult) => void;
  readonly reject: (e: unknown) => void;
  readonly signal: AbortSignal;
}

export interface SubmitHandle {
  readonly id: string;
  readonly done: Promise<InferenceResult>;
}

/**
 * Budget for the FIRST token. Before a model can answer it must read the whole
 * prompt, and a long RAG prompt on a CPU-only machine legitimately takes
 * minutes with no output at all. This is deliberately far larger than the
 * idle timeout below: silence before the first token is normal, silence in the
 * middle of a stream is not.
 *
 * A 60s budget here was killing every real query on a 4-thread machine — the
 * user saw "The answer could not be generated" while the model was working
 * perfectly.
 */
const FIRST_TOKEN_TIMEOUT_MS = 900_000;
/** Abort if the stream stalls for this long AFTER it has started flowing. */
const IDLE_TIMEOUT_MS = 120_000;
/**
 * Hard wall-clock cap. Sized for the worst realistic case — a long answer at
 * roughly one token per second on a slow CPU — since the user can always stop
 * a running answer themselves. This is a hang-breaker, not a patience limit.
 */
const MAX_JOB_MS = 1_800_000;

/**
 * Inference scheduler (D42): N parallel slots (matching llama.cpp continuous
 * batching), with the request QUEUE as overflow-only behaviour and **per-user
 * round-robin fairness** so one heavy user cannot starve others. Queued
 * requests can report their exact position in line.
 */
export class InferenceScheduler {
  private readonly running = new Set<string>();
  private readonly userQueues = new Map<string, Job[]>();
  private readonly rrOrder: string[] = [];
  private rrPointer = 0;

  constructor(
    private backend: InferenceBackend,
    private readonly slots: number,
  ) {}

  setBackend(backend: InferenceBackend): void {
    this.backend = backend;
    this.pump();
  }

  submit(req: InferenceRequest, onToken: (t: string) => void, signal: AbortSignal): SubmitHandle {
    const id = randomUUID();
    const done = new Promise<InferenceResult>((resolve, reject) => {
      this.enqueue({ id, userId: req.userId, req, onToken, resolve, reject, signal });
    });
    this.pump();
    return { id, done };
  }

  get available(): boolean {
    return this.backend.available;
  }
  get totalSlots(): number {
    return this.slots;
  }
  get busySlots(): number {
    return this.running.size;
  }
  get queueDepth(): number {
    let n = 0;
    for (const q of this.userQueues.values()) n += q.length;
    return n;
  }

  /** 0 = running; N = Nth in line; -1 = unknown/finished. */
  positionOf(id: string): number {
    if (this.running.has(id)) return 0;
    const order = this.simulateFairOrder();
    const idx = order.indexOf(id);
    return idx < 0 ? -1 : idx + 1;
  }

  private enqueue(job: Job): void {
    let q = this.userQueues.get(job.userId);
    if (!q) {
      q = [];
      this.userQueues.set(job.userId, q);
      this.rrOrder.push(job.userId);
    }
    q.push(job);
  }

  private pump(): void {
    while (this.running.size < this.slots && this.backend.available) {
      const job = this.takeNextFair();
      if (!job) break;
      void this.run(job);
    }
  }

  /** Pick the next job round-robin across users (FIFO within a user). */
  private takeNextFair(): Job | null {
    const n = this.rrOrder.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.rrPointer + i) % n;
      const user = this.rrOrder[idx]!;
      const q = this.userQueues.get(user);
      if (q && q.length > 0) {
        const job = q.shift()!;
        if (q.length === 0) {
          // Prune the now-empty user so rrOrder/userQueues don't grow without
          // bound as distinct users come and go in long-running server mode.
          this.userQueues.delete(user);
          this.rrOrder.splice(idx, 1);
          this.rrPointer = this.rrOrder.length === 0 ? 0 : idx % this.rrOrder.length;
        } else {
          this.rrPointer = (idx + 1) % this.rrOrder.length;
        }
        return job;
      }
    }
    return null;
  }

  private async run(job: Job): Promise<void> {
    this.running.add(job.id);

    // Watchdog: link the caller's signal to an internal controller, and abort on
    // either an idle-token timeout (a stalled sidecar mid-generation) or a hard
    // wall-clock cap. Without this, a hung backend.run() would hold the slot
    // forever and, repeated, wedge every slot (H3).
    const ac = new AbortController();
    const onCallerAbort = (): void => ac.abort();
    if (job.signal.aborted) ac.abort();
    else job.signal.addEventListener('abort', onCallerAbort, { once: true });

    // The first token gets the prefill budget; every token after it gets the
    // tighter idle budget.
    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => ac.abort(),
      FIRST_TOKEN_TIMEOUT_MS,
    );
    const hardTimer = setTimeout(() => ac.abort(), MAX_JOB_MS);
    const onToken = (t: string): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
      job.onToken(t);
    };

    try {
      const result = await this.backend.run(job.req, onToken, ac.signal);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      job.signal.removeEventListener('abort', onCallerAbort);
      this.running.delete(job.id);
      this.pump();
    }
  }

  /** Replays the round-robin rule over a snapshot to get the exact dispatch order. */
  private simulateFairOrder(): string[] {
    const clone = new Map<string, string[]>();
    for (const [user, q] of this.userQueues)
      clone.set(
        user,
        q.map((j) => j.id),
      );
    let pointer = this.rrPointer;
    const order: string[] = [];
    const n = this.rrOrder.length;
    let remaining = this.queueDepth;
    while (remaining > 0) {
      let picked = false;
      for (let i = 0; i < n; i++) {
        const idx = (pointer + i) % n;
        const user = this.rrOrder[idx]!;
        const q = clone.get(user);
        if (q && q.length > 0) {
          order.push(q.shift()!);
          pointer = (idx + 1) % n;
          remaining--;
          picked = true;
          break;
        }
      }
      if (!picked) break;
    }
    return order;
  }
}
