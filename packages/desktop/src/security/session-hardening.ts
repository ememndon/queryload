import { X509Certificate } from 'node:crypto';
import type { Session } from 'electron';

/**
 * Locks down the Electron session (D45):
 *  - Pins the engine's self-signed certificate by SHA-256 fingerprint, so the
 *    renderer trusts exactly one cert on loopback and nothing else.
 *  - Applies a strict Content-Security-Policy to every response.
 *  - Denies every permission request (camera, mic, geolocation, notifications…).
 *
 * The renderer is treated as untrusted. This function is the single place that
 * decides what the renderer's network + capability surface is allowed to be.
 */
export interface HardeningOptions {
  /** Latest engine cert fingerprint (colon-free lowercase hex); updated on restart. */
  getEngineFingerprint: () => string | null;
  isDev: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function fingerprintOfPem(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  } catch {
    return null;
  }
}

export function applySessionHardening(session: Session, options: HardeningOptions): void {
  // --- TLS pinning: trust only the engine's cert, only on loopback. ---
  session.setCertificateVerifyProc((request, callback) => {
    const expected = options.getEngineFingerprint();
    const presented = fingerprintOfPem(request.certificate.data);
    const hostOk = LOOPBACK_HOSTS.has(request.hostname);
    if (expected && presented && hostOk && presented === expected) {
      callback(0); // trusted
    } else {
      callback(-2); // reject
    }
  });

  // --- CSP on every response. No remote content, ever. ---
  const csp = buildCsp(options.isDev);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // --- Deny all powerful web permissions. ---
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

function buildCsp(isDev: boolean): string {
  // Engine traffic is HTTPS on loopback; that is the only connect target.
  const connect = 'connect-src https://127.0.0.1:* https://localhost:*';
  if (isDev) {
    // Vite dev server + HMR websocket. Dev only — never shipped.
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
      "style-src 'self' 'unsafe-inline' http://localhost:5173",
      "font-src 'self' data:",
      "img-src 'self' data:",
      `${connect} ws://localhost:5173 http://localhost:5173`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    connect,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
