/**
 * A minimal promise concurrency limiter. Keeps at most `limit` tasks running at
 * once (matched to the extraction worker count) so a large archive scan and a
 * burst of watcher events stay bounded rather than spawning unbounded work.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
