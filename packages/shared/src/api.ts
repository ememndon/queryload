/**
 * The QueryLoad engine API contract.
 *
 * This is the ONLY surface shared between the engine and the UI. Both sides
 * import these types; neither imports the other's implementation. As phases
 * land, endpoints are added here first, then implemented in the engine and
 * consumed in the renderer.
 */

/** Uniform success/error envelope for every JSON endpoint. */
export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export interface ApiError {
  /** Stable machine code, e.g. `unauthorized`, `not_found`, `internal`. */
  readonly code: ApiErrorCode;
  /** Human-readable, appliance-grade message. No stack traces, no jargon. */
  readonly message: string;
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

/** Liveness — unauthenticated, returns no data about the corpus. */
export interface HealthResponse {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}

/** Authenticated engine introspection used by the shell and diagnostics. */
export interface EngineInfoResponse {
  readonly appName: string;
  readonly version: string;
  readonly mode: 'desktop' | 'service';
  readonly startedAt: number;
  /** True when steady-state; the engine performs no outbound requests. */
  readonly network: {
    /** Whether the engine is bound to loopback only (desktop) or LAN (server). */
    readonly bind: 'loopback' | 'lan';
    /** Always false until an admin explicitly enables the external Engine API. */
    readonly engineApiEnabled: boolean;
  };
}

/** Endpoint path builders — keep string literals in one place. */
export const ApiRoutes = {
  health: '/health',
  engineInfo: '/v1/engine/info',
} as const;
