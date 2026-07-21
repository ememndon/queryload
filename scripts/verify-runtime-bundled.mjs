/**
 * Packaging preflight: refuse to build an installer with no inference runtime.
 *
 * This exists because the app shipped for months without one and nothing
 * noticed — every phase smoke uses a stub backend, so the missing binary only
 * surfaced when a real user pressed "Use this model" and nothing happened. A
 * build-time assertion is the cheapest place to catch it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const key = `${process.platform}-${process.arch}`;
const dir = join(root, 'vendor', 'llama', key);
const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

const fail = (msg) => {
  console.error(`\n✗ inference runtime not bundled\n\n${msg}\n`);
  process.exit(1);
};

if (!existsSync(dir)) {
  fail(`vendor/llama/${key} does not exist.\nRun:  npm run fetch:runtime`);
}
if (!existsSync(join(dir, exe))) {
  fail(`${exe} is missing from vendor/llama/${key}.\nRun:  npm run fetch:runtime -- --force`);
}

const manifestPath = join(dir, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail(`manifest.json is missing from vendor/llama/${key} — the runtime was staged by hand and its
provenance is unverified. Run:  npm run fetch:runtime -- --force`);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.sha256 || !manifest.tag) {
  fail('manifest.json has no pinned tag/sha256 — refusing to ship an unverified binary.');
}

console.log(`✓ inference runtime bundled — llama.cpp ${manifest.tag} (${manifest.files} files, ${key})`);
