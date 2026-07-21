import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiRoutes, GovernanceRoutes, ServerRoutes } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import { isAuthorized } from './auth.js';
import { SESSION_HEADER } from './actor.js';
import { sendError } from './respond.js';
import { handleHealth } from './routes/health.js';
import { dispatchApi, type RouteContext } from './api-routes.js';

export interface HttpsServerDeps {
  readonly certPem: string;
  readonly keyPem: string;
  readonly sessionToken: string;
  readonly startedAt: number;
  readonly logger: Logger;
  readonly routes: RouteContext;
}

/**
 * The engine's HTTPS server. TLS is mandatory even on loopback (D44).
 *
 * Request flow: `/health` is open (liveness only); everything else requires a
 * valid session bearer token, then delegates to the explicit `/v1` dispatcher.
 * There is no framework and no implicit routing — the authorized surface is
 * exactly what you can read here and in api-routes.ts.
 */
export function createHttpsServer(deps: HttpsServerDeps): Server {
  const server = createServer(
    { cert: deps.certPem, key: deps.keyPem, minVersion: 'TLSv1.2' },
    (req: IncomingMessage, res: ServerResponse) => {
      handle(req, res, deps).catch((err: unknown) => {
        deps.logger.error({ err: describe(err) }, 'unhandled request error');
        if (!res.headersSent) sendError(res, 'internal', 'An internal error occurred.');
      });
    },
  );

  server.on('clientError', (_err, socket) => socket.destroy());
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpsServerDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  const path = url.pathname;

  // CORS for the app's own trusted renderer, which runs at a different origin
  // (http://localhost:5173 in dev, file:// in production) than the loopback
  // engine. Restricted to those known-local origins rather than reflecting any
  // Origin, so no other web origin can script the loopback API — defence in
  // depth on top of the bearer/session token. Preflight (OPTIONS) is answered
  // directly; requests with no Origin (native fetch) are unaffected.
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type, x-queryload-session',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Liveness — unauthenticated, reveals nothing about the corpus.
  if (method === 'GET' && path === ApiRoutes.health) {
    handleHealth(res, deps.startedAt);
    return;
  }

  // Public bootstrap endpoints: user login and the device-join handshake need
  // no transport token (LAN clients don't hold the local per-run token).
  const isPublic = path === GovernanceRoutes.login || path === ServerRoutes.join;
  if (!isPublic) {
    // Authorized by EITHER the local transport bearer (the desktop renderer) OR
    // a valid user session (a LAN client in server mode). The per-request actor
    // then decides identity, role, and workspace access.
    const transportOk = isAuthorized(req, deps.sessionToken);
    const userSession = deps.routes.auth.authenticate(userSessionToken(req));
    if (!transportOk && !userSession) {
      sendError(res, 'unauthorized', 'A valid session token is required.');
      return;
    }
  }

  const handled = await dispatchApi(method, url, req, res, deps.routes);
  if (!handled) sendError(res, 'not_found', `No route for ${method} ${path}.`);
}

/**
 * Trusted renderer origins: the production desktop + LAN client apps load from
 * file:// (Origin "null"), and the Vite dev server is http://localhost:5173 (or
 * 127.0.0.1). Any loopback host on any port is accepted; nothing else.
 */
function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true; // file:// renderer
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function userSessionToken(req: IncomingMessage): string {
  const raw = req.headers[SESSION_HEADER];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
