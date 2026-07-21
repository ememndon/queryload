import type { ServerResponse } from 'node:http';
import type { ApiError, ApiErrorCode, ApiResult } from '@queryload/shared';

/**
 * Response helpers enforcing a uniform, hardened envelope.
 *
 * Every response carries defensive headers even though the engine only speaks
 * JSON: the renderer is treated as untrusted (D45), and these headers ensure a
 * response can never be coerced into executing as a document.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  // The engine serves data, never markup; forbid it being framed or scripted.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

function write(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, SECURITY_HEADERS);
  res.end(payload);
}

export function sendOk<T>(res: ServerResponse, data: T, status = 200): void {
  const body: ApiResult<T> = { ok: true, data };
  write(res, status, body);
}

const STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export function sendError(res: ServerResponse, code: ApiErrorCode, message: string): void {
  const error: ApiError = { code, message };
  const body: ApiResult<never> = { ok: false, error };
  write(res, STATUS_FOR[code], body);
}
