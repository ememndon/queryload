import { createDefaultRegistry } from './registry.js';
import type { ExtractionJob, ExtractionResult } from './types.js';

/**
 * Isolation worker entry (D46).
 *
 * Runs as a SEPARATE process, forked by the pool. Its only capability is:
 * receive a file path, extract text, return it. It never touches the encrypted
 * index, the DB key, or the network — so a hostile or corrupt document that
 * crashes a parser can, at worst, take down this disposable process. The pool
 * quarantines the offending file and respawns a clean worker.
 */
const registry = createDefaultRegistry();

process.on('message', (job: ExtractionJob) => {
  void run(job);
});

async function run(job: ExtractionJob): Promise<void> {
  try {
    const handler = registry.resolve(job.filePath);
    if (!handler) {
      send({ ok: false, error: `No handler for ${job.ext}` });
      return;
    }
    const document = await handler.extract(job.filePath);
    send({ ok: true, document });
  } catch (err) {
    send({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}

function send(result: ExtractionResult): void {
  process.send?.(result);
}
