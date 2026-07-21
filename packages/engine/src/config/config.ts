import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ENGINE_DEFAULT_SERVICE_PORT } from '@queryload/shared';
import type { EngineMode } from '@queryload/shared';

/**
 * Persisted, NON-SECRET engine configuration (`config.json`).
 *
 * Secrets never live here — private keys and tokens go through the DPAPI
 * secret store. This file holds only operational settings, safe to read and
 * back up in the clear.
 */
export interface EngineConfig {
  readonly schema: 1;
  /** Stable per-installation id (non-identifying, never transmitted). */
  instanceId: string;
  createdAt: number;
  /**
   * Preferred TLS port for service mode. Desktop mode ignores this and binds
   * an ephemeral port to avoid collisions.
   */
  servicePort: number;
  /**
   * Bind scope. `loopback` = 127.0.0.1 only (desktop + default). `lan` is set
   * only by an explicit admin action in Phase 6 (organization mode).
   */
  bind: 'loopback' | 'lan';
  /** The external Engine API is disabled by default (D48). */
  engineApiEnabled: boolean;
}

export function defaultConfig(): EngineConfig {
  return {
    schema: 1,
    instanceId: randomUUID(),
    createdAt: Date.now(),
    servicePort: ENGINE_DEFAULT_SERVICE_PORT,
    bind: 'loopback',
    engineApiEnabled: false,
  };
}

/** Load config.json, creating it with safe defaults on first run. */
export async function loadOrCreateConfig(configFile: string): Promise<EngineConfig> {
  let raw: string;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const fresh = defaultConfig();
      await saveConfig(configFile, fresh);
      return fresh;
    }
    throw err;
  }

  let parsed: Partial<EngineConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<EngineConfig>;
  } catch {
    // Corrupt JSON must not brick startup. Preserve the bad file for diagnostics
    // and self-heal with defaults.
    await writeFile(`${configFile}.corrupt`, raw, 'utf8').catch(() => undefined);
    const fresh = defaultConfig();
    await saveConfig(configFile, fresh);
    return fresh;
  }
  // Merge over defaults (older configs gain new fields), then validate every
  // field so a hand-edited or partially-corrupt value can't crash the engine.
  return sanitize({ ...defaultConfig(), ...parsed });
}

/** Coerce a loaded config to valid values, falling back to defaults per field. */
function sanitize(c: Partial<EngineConfig>): EngineConfig {
  const d = defaultConfig();
  const port = c.servicePort;
  return {
    schema: 1,
    instanceId: typeof c.instanceId === 'string' && c.instanceId.length > 0 ? c.instanceId : d.instanceId,
    createdAt: typeof c.createdAt === 'number' && c.createdAt > 0 ? c.createdAt : d.createdAt,
    servicePort:
      typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535
        ? port
        : d.servicePort,
    bind: c.bind === 'lan' ? 'lan' : 'loopback',
    engineApiEnabled: c.engineApiEnabled === true,
  };
}

export async function saveConfig(configFile: string, config: EngineConfig): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
}

/** Resolve the effective bind port for a given run mode. */
export function resolvePort(mode: EngineMode, config: EngineConfig, override?: number): number {
  if (typeof override === 'number') return override;
  // Desktop mode: ephemeral (0) so we never collide with another process.
  return mode === 'service' ? config.servicePort : 0;
}
