/**
 * Static audit for non-negotiable rule #1: ZERO network calls at runtime.
 *
 * This scans the source of the shipped packages (engine, ui, desktop) for
 * outbound-network primitives and absolute http(s) URLs. It is a guard, not a
 * proof — the real proof is a packet capture in Phase 7 — but it fails the
 * build the moment someone adds `fetch('https://...')` to a shipped path.
 *
 * Allowed exceptions (documented, narrow):
 *   - loopback URLs (127.0.0.1 / localhost) — the local engine transport.
 *   - The renderer's fetch(), which targets only the pinned loopback engine.
 *   - The model-download subsystem (Phase 2), which is explicitly user-initiated
 *     first-run activity, flagged via a `// @network-allowed:model-download`
 *     marker on the line.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['packages/engine/src', 'packages/desktop/src', 'packages/ui/src'];

const FORBIDDEN = [
  { re: /\bhttps?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi, why: 'absolute remote URL' },
  { re: /\b(?:dns|dgram)\b\s*\.\s*(?:resolve|lookup|createSocket)/g, why: 'DNS / UDP socket' },
  { re: /new\s+WebSocket\s*\(/g, why: 'WebSocket' },
  { re: /\bnavigator\.sendBeacon\b/g, why: 'sendBeacon (telemetry)' },
  { re: /\bXMLHttpRequest\b/g, why: 'XMLHttpRequest' },
];

const ALLOW_MARKER = '@network-allowed';

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) out.push(full);
  }
  return out;
}

const findings = [];
for (const rel of SCAN_DIRS) {
  const files = walk(join(root, rel));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(ALLOW_MARKER)) return;
      for (const { re, why } of FORBIDDEN) {
        re.lastIndex = 0;
        if (re.test(line)) {
          findings.push({ file: relative(root, file), line: i + 1, why, text: line.trim() });
        }
      }
    });
  }
}

if (findings.length > 0) {
  console.error('✗ Runtime-network audit FAILED. Forbidden patterns found:\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.why}]\n    ${f.text}`);
  }
  console.error(
    '\nIf this is the user-initiated first-run model download, mark the line with ' +
      `"// ${ALLOW_MARKER}:model-download".`,
  );
  process.exit(1);
}

console.log('✓ Runtime-network audit passed: no remote network primitives in shipped source.');
