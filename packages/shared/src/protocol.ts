/**
 * Engine <-> desktop handshake protocol.
 *
 * The engine and the Electron main share NO code paths other than the API
 * contract (non-negotiable rule #2). This descriptor is how the supervisor
 * discovers where the engine is listening and how to trust its certificate.
 */

export type EngineMode = 'desktop' | 'service';

/**
 * Emitted by the engine on stdout (after {@link ENGINE_READY_MARKER}) and also
 * persisted to `engine.runtime.json`. Contains everything a client needs to
 * open a pinned TLS connection — and nothing sensitive beyond the per-session
 * bearer token, which is scoped to this engine run only.
 */
export interface EngineReady {
  /** Descriptor schema version. */
  readonly v: 1;
  readonly mode: EngineMode;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  /**
   * SHA-256 fingerprint of the engine's self-signed certificate (DER),
   * lowercase hex, colon-free. Clients pin against exactly this value.
   */
  readonly certFingerprintSha256: string;
  /**
   * Bearer token minted for this engine run. The desktop supervisor hands it
   * to the sandboxed renderer via the preload bridge. Rotated every start.
   */
  readonly sessionToken: string;
  /** Millisecond epoch the engine came up (informational). */
  readonly startedAt: number;
}

/** Base HTTPS URL for a given descriptor, e.g. `https://127.0.0.1:8443`. */
export function engineBaseUrl(ready: Pick<EngineReady, 'host' | 'port'>): string {
  return `https://${ready.host}:${ready.port}`;
}
