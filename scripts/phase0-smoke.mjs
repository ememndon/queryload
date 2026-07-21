/**
 * Phase 0 smoke test — proves the engine seam end-to-end.
 *
 * Spawns the built engine against a throwaway data dir, waits for its ready
 * handshake, then verifies over real TLS:
 *   1. The app-data layout was created.
 *   2. /health is reachable over HTTPS and unauthenticated.
 *   3. The engine's certificate validates for 127.0.0.1 and its SHA-256
 *      fingerprint matches the ready descriptor (pinning material).
 *   4. /v1/engine/info rejects a missing token (401) and accepts the real one.
 *   5. The self-signed cert is NOT trusted by the public CA store (proving it
 *      is a private, pinned identity — not a web certificate).
 *
 * Exit code 0 = all pass. Used as living evidence for the Phase 0 acceptance
 * list and re-runnable at any time: `node scripts/phase0-smoke.mjs`.
 */
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('..', import.meta.url));
const engineEntry = join(root, 'packages', 'engine', 'dist', 'index.js');
const dataDir = mkdtempSync(join(tmpdir(), 'queryload-smoke-'));

const MARKER = 'QUERYLOAD_ENGINE_READY';
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function httpsGet({ port, path, ca, token, rejectUnauthorized = true }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        ca,
        rejectUnauthorized,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const child = spawn(process.execPath, [engineEntry, '--mode', 'desktop', '--data-dir', dataDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('engine did not report ready in 30s')), 30000);
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.startsWith(MARKER)) {
      clearTimeout(timer);
      resolve(JSON.parse(line.slice(MARKER.length).trim()));
    }
  });
  createInterface({ input: child.stderr }).on('line', (l) => console.error(`[engine:err] ${l}`));
  child.on('exit', (code) => reject(new Error(`engine exited early (code ${code})`)));
});

console.log(`\nEngine ready on https://${ready.host}:${ready.port} (pid ${ready.pid})\n`);

try {
  // 1. App-data layout
  for (const sub of ['index', 'logs', 'quarantine', 'certs', 'models', 'config.json']) {
    check(`app-data created: ${sub}`, existsSync(join(dataDir, sub)));
  }

  const certPem = readFileSync(join(dataDir, 'certs', 'engine.crt'), 'utf8');
  const fp = new X509Certificate(certPem).fingerprint256.replaceAll(':', '').toLowerCase();

  // 3. Cert fingerprint matches the ready descriptor (pinning material)
  check('cert fingerprint matches ready descriptor', fp === ready.certFingerprintSha256);

  // 2. /health over TLS, validated against the engine cert as CA
  const health = await httpsGet({ port: ready.port, path: '/health', ca: certPem });
  const healthJson = JSON.parse(health.body);
  check('GET /health → 200 over TLS', health.status === 200 && healthJson.ok === true);
  check('health status ok', healthJson.data?.status === 'ok');

  // 4a. engine/info without token → 401
  const noAuth = await httpsGet({ port: ready.port, path: '/v1/engine/info', ca: certPem });
  check('GET /v1/engine/info (no token) → 401', noAuth.status === 401);

  // 4b. engine/info with token → 200
  const authed = await httpsGet({
    port: ready.port,
    path: '/v1/engine/info',
    ca: certPem,
    token: ready.sessionToken,
  });
  const infoJson = JSON.parse(authed.body);
  check(
    'GET /v1/engine/info (token) → 200 QueryLoad',
    authed.status === 200 && infoJson.data?.appName === 'QueryLoad',
  );
  check('engine reports loopback bind', infoJson.data?.network?.bind === 'loopback');
  check('engine API disabled by default', infoJson.data?.network?.engineApiEnabled === false);

  // 5. Cert is NOT trusted by the public CA store (private, pinned identity)
  let rejectedByPublicCa = false;
  try {
    await httpsGet({ port: ready.port, path: '/health', rejectUnauthorized: true });
  } catch {
    rejectedByPublicCa = true;
  }
  check('self-signed cert rejected by public CA store (pinning required)', rejectedByPublicCa);
} finally {
  child.kill('SIGTERM');
  setTimeout(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 500);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 1200);
