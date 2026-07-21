/**
 * Product-wide constants shared by every package.
 *
 * This file is the single source of truth for identity strings, on-disk
 * layout, and network defaults. It intentionally contains NO logic and NO
 * imports so it can be consumed by the engine (Node), the desktop main
 * (Node), and the renderer (browser sandbox) alike.
 */

export const APP_NAME = 'QueryLoad';
export const APP_VENDOR = 'Tenslor';
/** Windows AppData folder name — `%APPDATA%/QueryLoad`. */
export const APP_DATA_DIRNAME = 'QueryLoad';

export const TAGLINE = 'Your documents, your hardware, your answers. Nothing leaves the building.';

/**
 * Loopback host for the engine. Hard-coded to IPv4 loopback so a
 * misconfigured hostname can never resolve off-machine. In server mode
 * (Phase 6) the admin explicitly opts the bind address up to the LAN.
 */
export const ENGINE_LOOPBACK_HOST = '127.0.0.1';

/**
 * Default TLS port when the engine runs headless as a Windows Service.
 * In desktop mode the engine binds an ephemeral port (0) and reports the
 * actual port back to the Electron main via the ready handshake.
 */
export const ENGINE_DEFAULT_SERVICE_PORT = 8443;

/** API version prefix. Everything data-bearing lives under this. */
export const API_PREFIX = '/v1';

/** Header carrying the per-session bearer token on every data request. */
export const AUTH_HEADER = 'authorization';

/**
 * Filenames inside `%APPDATA%/QueryLoad`. Kept here so the engine and the
 * desktop supervisor agree on exact paths without importing each other.
 */
export const APP_DATA_FILES = {
  config: 'config.json',
  metadataDb: 'metadata.db',
  /** Written by the engine on startup so the supervisor/service can find it. */
  runtime: 'engine.runtime.json',
} as const;

export const APP_DATA_DIRS = {
  index: 'index',
  logs: 'logs',
  quarantine: 'quarantine',
  certs: 'certs',
  models: 'models',
} as const;

/**
 * The single line the engine prints to stdout once it is listening, so the
 * Electron supervisor can parse the connection descriptor without racing on
 * the runtime file. Everything after the marker is JSON (EngineReady).
 */
export const ENGINE_READY_MARKER = 'QUERYLOAD_ENGINE_READY';
