import type { EngineMode } from '@queryload/shared';
import { Engine, type EngineOptions } from './engine.js';

/**
 * Engine CLI entry.
 *
 * Usage:
 *   node dist/index.js [--mode desktop|service] [--data-dir <path>] [--port <n>]
 *
 * `--service` is shorthand for `--mode service` (headless Windows Service).
 * The desktop supervisor launches this with `--mode desktop`.
 */
function parseArgs(argv: readonly string[]): EngineOptions {
  let mode: EngineMode = 'desktop';
  let dataDir: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--service':
        mode = 'service';
        break;
      case '--mode': {
        const value = argv[++i];
        if (value !== 'desktop' && value !== 'service') {
          throw new Error(`--mode must be "desktop" or "service", got "${value ?? ''}"`);
        }
        mode = value;
        break;
      }
      case '--data-dir':
        dataDir = argv[++i];
        break;
      case '--port': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`--port must be 0-65535, got "${String(value)}"`);
        }
        port = value;
        break;
      }
      default:
        // Ignore the `--` separator injected by npm-run/tsx and unknown flags.
        break;
    }
  }

  return dataDir === undefined
    ? port === undefined
      ? { mode }
      : { mode, port }
    : port === undefined
      ? { mode, dataDir }
      : { mode, dataDir, port };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const engine = new Engine(options);

  const shutdown = (signal: string): void => {
    process.stderr.write(`engine received ${signal}, shutting down\n`);
    engine
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await engine.start();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`engine failed to start: ${message}\n`);
  process.exit(1);
});
