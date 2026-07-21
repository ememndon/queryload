/**
 * The join code is the trust bootstrap for organization mode (D25/D44/D55).
 *
 * It encodes the server's address, its TLS certificate fingerprint (so the
 * client can PIN the exact certificate — the code doubles as the cert-pinning
 * bootstrap), and a shared secret that authorizes the device to join. A client
 * that has the join code can discover the server (or use the embedded address),
 * pin its certificate, and present the secret to be admitted.
 */
export interface JoinInfo {
  readonly v: 1;
  readonly host: string;
  readonly port: number;
  /** SHA-256 fingerprint of the server cert, colon-free lowercase hex. */
  readonly fingerprint: string;
  /** Authorization secret; the server admits only devices presenting it. */
  readonly secret: string;
}

export function encodeJoinCode(info: JoinInfo): string {
  return Buffer.from(JSON.stringify(info), 'utf8').toString('base64url');
}

export function decodeJoinCode(code: string): JoinInfo | null {
  try {
    const parsed = JSON.parse(Buffer.from(code.trim(), 'base64url').toString('utf8')) as JoinInfo;
    if (
      parsed.v === 1 &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.fingerprint === 'string' &&
      typeof parsed.secret === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Client-side pin check: the presented cert must match the pinned fingerprint. */
export function certMatchesPin(expectedFingerprint: string, presentedFingerprint: string): boolean {
  return (
    expectedFingerprint.length > 0 &&
    expectedFingerprint.toLowerCase() === presentedFingerprint.toLowerCase()
  );
}
