/**
 * Full regression runner (Phase 7): builds once, then runs every phase's
 * acceptance smoke test, the UI layout test, and the runtime-network audit, and
 * prints a single pass/fail board. Non-zero exit if anything fails.
 *
 * Run: node scripts/regression.mjs
 */
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, cmd, args) {
  process.stdout.write(`\n▶ ${label}\n`);
  // Only .cmd shims (npm.cmd) need a shell on Windows; running node.exe directly
  // via a shell would mangle its space-containing path.
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd.endsWith('.cmd') });
  return { label, ok: r.status === 0 };
}

const results = [];

// Build everything once (the phase smokes import the built engine dist).
results.push(run('build', npm, ['run', 'build']));

// Static quality gates.
results.push(run('typecheck', npm, ['run', 'typecheck']));
results.push(run('lint', npm, ['run', 'lint']));
results.push(run('runtime-network audit', npm, ['run', 'verify:network']));

// Every phase's acceptance smoke test (engine already built).
for (const phase of [0, 1, 2, 3, 4, 5, 6, 7]) {
  results.push(
    run(`phase ${phase} acceptance`, process.execPath, [`scripts/phase${phase}-smoke.mjs`]),
  );
}

// UI layout regression (D79).
results.push(run('ui layout (D79)', npm, ['run', 'test', '-w', '@queryload/ui']));

console.log('\n──────── Regression summary ────────');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'}  ${r.label}`);
const failures = results.filter((r) => !r.ok);
console.log(`\n${failures.length === 0 ? '✓ ALL GREEN' : `✗ ${failures.length} FAILED`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
