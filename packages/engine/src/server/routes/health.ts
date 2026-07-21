import type { ServerResponse } from 'node:http';
import type { HealthResponse } from '@queryload/shared';
import { sendOk } from '../respond.js';

/**
 * Liveness endpoint — unauthenticated by design. It reveals nothing about the
 * corpus, only that the process is up, so the supervisor can probe readiness
 * without holding the session token.
 */
export function handleHealth(res: ServerResponse, startedAt: number): void {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  };
  sendOk(res, body);
}
