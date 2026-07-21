import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AUTH_HEADER } from '@queryload/shared';

/**
 * Constant-time bearer-token check for the loopback API.
 *
 * The session token is minted per engine run and handed to the renderer via
 * the preload bridge. Even on loopback we authenticate every data request so
 * that another local process cannot read the corpus by guessing the port.
 */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers[AUTH_HEADER];
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);

  const a = Buffer.from(presented);
  const b = Buffer.from(expectedToken);
  // timingSafeEqual requires equal lengths; length mismatch is an early, safe no.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
