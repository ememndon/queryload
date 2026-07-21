// Assemble a self-contained, production-only engine bundle for packaging.
//
// The desktop app spawns the engine as a separate Node process (Electron-as-Node
// via ELECTRON_RUN_AS_NODE), loading it from resources/engine/dist/index.js. For
// that to work in a packaged build, the engine needs its OWN production
// node_modules next to its dist — the workspace root's hoisted node_modules is
// not shipped. This script produces:
//
//   staging/engine/
//     package.json        (production deps only; workspace dep stripped)
//     dist/               (the compiled engine + copied assets)
//     node_modules/       (production deps, incl. native addons)
//       @queryload/shared (the workspace dep, provided by direct copy)
//
// electron-builder then copies staging/engine -> resources/engine, and the
// afterPack hook rebuilds the native modules for Electron's ABI.
//
// Run AFTER `npm run build` (needs packages/engine/dist and packages/shared/dist).
import { existsSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = join(root, 'packages', 'engine');
const sharedDir = join(root, 'packages', 'shared');
const stageRoot = join(root, 'staging');
const stageDir = join(stageRoot, 'engine');

const log = (m) => console.log(`[stage-engine] ${m}`);

if (!existsSync(join(engineDir, 'dist', 'index.js'))) {
  throw new Error('packages/engine/dist not found — run `npm run build` first.');
}
if (!existsSync(join(sharedDir, 'dist'))) {
  throw new Error('packages/shared/dist not found — run `npm run build` first.');
}

// 1. Clean staging.
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 2. Compiled engine (dist includes copied assets like the model catalog).
cpSync(join(engineDir, 'dist'), join(stageDir, 'dist'), { recursive: true });

// 3. A production package.json. Drop the workspace dep (@queryload/shared is
//    provided by direct copy in step 5) and devDependencies; keep runtime +
//    optional deps. "type":"module" MUST stay so Node treats dist as ESM.
const pkg = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'));
const deps = { ...(pkg.dependencies ?? {}) };
delete deps['@queryload/shared'];
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  main: pkg.main ?? './dist/index.js',
  dependencies: deps,
  optionalDependencies: pkg.optionalDependencies ?? {},
};
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);

// 4. Install production dependencies. Native addons compile for the CURRENT Node
//    ABI here; the afterPack hook rebuilds them for Electron's ABI at pack time.
log('installing production dependencies (compiles native modules — may take a few minutes)…');
execSync('npm install --omit=dev --no-audit --no-fund --install-strategy=hoisted', {
  cwd: stageDir,
  stdio: 'inherit',
});

// 5. Provide the workspace dependency @queryload/shared by direct copy of its
//    build (it is not published to any registry).
const sharedTarget = join(stageDir, 'node_modules', '@queryload', 'shared');
mkdirSync(sharedTarget, { recursive: true });
cpSync(join(sharedDir, 'dist'), join(sharedTarget, 'dist'), { recursive: true });
cpSync(join(sharedDir, 'package.json'), join(sharedTarget, 'package.json'));

log(`done — staged engine at ${stageDir}`);
