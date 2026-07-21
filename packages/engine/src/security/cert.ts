import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';
import { ENGINE_LOOPBACK_HOST } from '@queryload/shared';
import type { SecretStore } from './secret-store.js';

/**
 * The engine's self-signed TLS identity (D44). The certificate is public and
 * stored in the clear; the private key is sealed in the {@link SecretStore}
 * (DPAPI). The SHA-256 fingerprint is what clients pin on first join — the
 * join code is the trust bootstrap in server mode; in desktop mode the
 * supervisor pins the fingerprint it receives over the ready handshake.
 */
export interface EngineCertificate {
  /** PEM certificate (public). */
  certPem: string;
  /** PEM private key (sensitive — never leaves the process except into TLS). */
  keyPem: string;
  /** SHA-256 of the DER certificate, lowercase hex, colon-free. */
  fingerprintSha256: string;
}

const CERT_FILENAME = 'engine.crt';
const KEY_SECRET_NAME = 'engine-tls-key';

/** SHA-256 fingerprint of a PEM cert, normalized to lowercase colon-free hex. */
export function fingerprintOf(certPem: string): string {
  const x509 = new X509Certificate(certPem);
  return x509.fingerprint256.replaceAll(':', '').toLowerCase();
}

function generate(): { certPem: string; keyPem: string } {
  const attrs = [{ name: 'commonName', value: ENGINE_LOOPBACK_HOST }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });
  return { certPem: pems.cert, keyPem: pems.private };
}

/**
 * Load the engine certificate, generating and sealing it on first run.
 * The private key is stored via DPAPI; the public cert sits next to it.
 */
export async function loadOrCreateCertificate(
  certsDir: string,
  keyStore: SecretStore,
): Promise<EngineCertificate> {
  const certFile = join(certsDir, CERT_FILENAME);

  const existingKey = await keyStore.get(KEY_SECRET_NAME);
  let certPem: string | null = null;
  try {
    certPem = await readFile(certFile, 'utf8');
  } catch {
    certPem = null;
  }

  if (existingKey && certPem) {
    return {
      certPem,
      keyPem: existingKey.toString('utf8'),
      fingerprintSha256: fingerprintOf(certPem),
    };
  }

  // First run (or a half-written state): generate fresh and persist atomically
  // enough for our purposes — key sealed via DPAPI, cert written in the clear.
  const { certPem: newCert, keyPem: newKey } = generate();
  await keyStore.set(KEY_SECRET_NAME, Buffer.from(newKey, 'utf8'));
  await writeFile(certFile, newCert, 'utf8');
  return { certPem: newCert, keyPem: newKey, fingerprintSha256: fingerprintOf(newCert) };
}
