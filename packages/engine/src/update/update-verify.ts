import { verify, createPublicKey } from 'node:crypto';

/**
 * Update packages are signature-verified with the project's own key before
 * applying (D10/D50). The public key is embedded in the app; the private key is
 * held offline by the project and never ships. Until the real release key is
 * wired in (a build-time step), this is empty and ALL updates are rejected —
 * the safe default.
 */
export const PROJECT_PUBLIC_KEY_PEM = '';

/**
 * Verify an Ed25519 signature over an update payload. Returns false on any
 * error (missing key, malformed signature, tampered payload) — fail closed.
 */
export function verifyUpdate(
  payload: Buffer,
  signature: Buffer,
  publicKeyPem: string = PROJECT_PUBLIC_KEY_PEM,
): boolean {
  if (!publicKeyPem) return false;
  try {
    // Ed25519 uses a null digest algorithm.
    return verify(null, payload, createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}
