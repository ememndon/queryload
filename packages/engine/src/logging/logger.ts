import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import type { EngineMode } from '@queryload/shared';

export type Logger = ReturnType<typeof pino>;

/** Keys whose values must never appear in a log line (redacted at every level). */
const SECRET_KEYS = [
  'sessionToken',
  'token',
  'keyPem',
  'key',
  'password',
  'passphrase',
  'secret',
  'authorization',
  'joinCode',
] as const;

/**
 * Build the engine logger.
 *
 * - Service mode: file logging only (headless Windows Service, no console) —
 *   Phase 0 requirement. Logs land in `logs/engine-service.log`.
 * - Desktop mode: JSON to stdout (captured by the Electron supervisor) AND a
 *   file, so diagnostics survive even when no window is attached.
 *
 * Log records never contain document content (data-locality + honest
 * diagnostics rule D14): subsystems pass identifiers and counts, not text.
 */
export function createLogger(mode: EngineMode, logsDir: string): Logger {
  const logFile = join(logsDir, mode === 'service' ? 'engine-service.log' : 'engine.log');
  const fileStream = createWriteStream(logFile, { flags: 'a' });

  const streams: Array<{ stream: NodeJS.WritableStream }> = [{ stream: fileStream }];
  if (mode === 'desktop') {
    streams.push({ stream: process.stdout });
  }

  return pino(
    {
      level: process.env.QUERYLOAD_LOG_LEVEL ?? 'info',
      base: { mode, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        // Belt-and-braces: never let a secret leak into a log line. Covers the
        // common secret-bearing keys at the top level and one level of nesting.
        paths: [...SECRET_KEYS, ...SECRET_KEYS.map((k) => `*.${k}`)],
        censor: '[redacted]',
      },
    },
    pino.multistream(streams),
  );
}
