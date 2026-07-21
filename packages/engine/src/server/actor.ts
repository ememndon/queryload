import type { IncomingMessage } from 'node:http';
import type { RoleName } from '@queryload/shared';
import { DEFAULT_USER_ID } from '../db/schema.js';
import type { AuthService } from '../auth/auth-service.js';

/** The identity acting on a request, resolved per request (the multi-user wall). */
export interface Actor {
  readonly userId: string;
  readonly role: RoleName;
  readonly anonymous: boolean;
}

/** Header carrying the user's session token (distinct from the transport bearer). */
export const SESSION_HEADER = 'x-queryload-session';

/**
 * Resolve who is making the request.
 *
 * - Server mode (LAN): a valid user session token is required; without it the
 *   caller is anonymous and gets nothing. This is how the ethical wall holds
 *   across users — every request is attributed to a real user, and membership
 *   + role are enforced against THAT user.
 * - Desktop mode: no session header falls back to the local single-user
 *   identity (an admin), matching the pre-server single-machine model.
 */
export function resolveActor(req: IncomingMessage, auth: AuthService, serverMode: boolean): Actor {
  const raw = req.headers[SESSION_HEADER];
  const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (token) {
    const session = auth.authenticate(token);
    if (session) return { userId: session.userId, role: session.role, anonymous: false };
    return { userId: '', role: 'member', anonymous: true };
  }
  if (serverMode) return { userId: '', role: 'member', anonymous: true };
  return { userId: DEFAULT_USER_ID, role: auth.roleOf(DEFAULT_USER_ID), anonymous: false };
}
