/**
 * Generate a CycloneDX SBOM (non-negotiable rule #7 / D50).
 *
 * Reads the resolved dependency graph from package-lock.json and emits a
 * CycloneDX 1.5 JSON document. Scoped to the SHIPPED surface — dev-only
 * toolchain packages (electron-builder, eslint, tsc, …) are excluded so the SBOM
 * reflects what actually ships, not the build environment. Each component
 * carries its license (when known) and its integrity hash from the lockfile.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

let lock;
try {
  lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
} catch {
  console.error('package-lock.json not found. Run "npm install" first.');
  process.exit(1);
}

/** Map an npm integrity string ("sha512-<base64>") to a CycloneDX hash entry. */
function hashOf(integrity) {
  if (typeof integrity !== 'string' || !integrity.includes('-')) return null;
  const [alg, b64] = integrity.split('-', 2);
  const cdxAlg = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' }[alg];
  if (!cdxAlg) return null;
  try {
    return { alg: cdxAlg, content: Buffer.from(b64, 'base64').toString('hex') };
  } catch {
    return null;
  }
}

const components = [];
let skippedDev = 0;
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue; // the root project itself
  if (!pkg.version) continue;
  // Only the shipped surface: exclude dev-only toolchain so the SBOM doesn't
  // overstate what actually ships.
  if (pkg.dev) {
    skippedDev++;
    continue;
  }
  const name = path.replace(/^.*node_modules\//, '');
  const hash = hashOf(pkg.integrity);
  components.push({
    type: 'library',
    name,
    version: pkg.version,
    ...(pkg.license ? { licenses: [{ license: { id: String(pkg.license) } }] } : {}),
    ...(hash ? { hashes: [hash] } : {}),
    ...(pkg.resolved ? { purl: `pkg:npm/${name}@${pkg.version}` } : {}),
  });
}

// Deterministic ordering for reproducible SBOMs.
components.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: { type: 'application', name: 'queryload', version: lock.version ?? '0.0.0' },
  },
  components,
};

const outDir = join(root, 'dist-meta');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'sbom.cdx.json');
writeFileSync(outFile, JSON.stringify(sbom, null, 2), 'utf8');
console.log(
  `✓ SBOM written: ${outFile} (${components.length} shipped components; ${skippedDev} dev-only excluded)`,
);
