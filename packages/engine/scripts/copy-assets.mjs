/**
 * Copy non-TS assets (JSON data files like the model catalog) from src/ into
 * dist/, preserving relative paths. tsc compiles only .ts, so data files the
 * runtime `require`s must be copied alongside the emitted JS.
 */
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(engineRoot, 'src');
const distDir = join(engineRoot, 'dist');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

let copied = 0;
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const dest = join(distDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  copied++;
}
console.log(`copied ${copied} asset(s) to dist`);
