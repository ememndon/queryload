import { createRequire } from 'node:module';

/**
 * Engine version — derived from the engine package.json so there is a single
 * source of truth (bumping the package version flows through automatically).
 * Falls back to '0.0.0' if the manifest can't be resolved (e.g. an unusual
 * packaging layout), so this never throws at startup. The release gate should
 * assert this is not '0.0.0' before shipping.
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const ENGINE_VERSION = readVersion();
