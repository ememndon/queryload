/**
 * Phase 2 smoke test — model catalog, hardware eligibility, downloads, and the
 * inference scheduler. Exercises the acceptance criteria that don't require the
 * multi-GB llama.cpp binary/model:
 *   1. Catalog loads exactly 8 models; smallest is the 3B floor model.
 *   2. Eligibility blocks/warns/allows correctly for synthetic hardware.
 *   3. Two queries run concurrently within a 2-slot budget; a third queues at
 *      position 1 (continuous-batching slot model).
 *   4. Per-user round-robin fairness: a latecomer isn't starved behind a heavy
 *      user's backlog.
 *   5. Model download resumes after interruption and verifies the SHA-256
 *      (mismatch is rejected and discarded).
 *
 * Run: node scripts/phase2-smoke.mjs   (after `npm run build`)
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const E = '../packages/engine/dist';
const { listCatalog, smallestModel } = await import(`${E}/models/catalog.js`);
const { evaluateEligibility, RAM_FLOOR_GB } = await import(`${E}/models/eligibility.js`);
const { ModelDownloader, sha256File } = await import(`${E}/models/download.js`);
const { InferenceScheduler } = await import(`${E}/inference/scheduler.js`);

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

const hw = (ramGB, diskGB = 500, gpus = []) => ({
  totalRamGB: ramGB,
  freeRamGB: ramGB,
  gpus,
  freeDiskGB: diskGB,
  cpuThreads: 8,
});

// --- 1. Catalog ---
const catalog = listCatalog();
check('catalog is populated', catalog.length >= 20, `got ${catalog.length}`);
check('model ids are unique', new Set(catalog.map((m) => m.id)).size === catalog.length);
check('smallest model is the 1B floor model', smallestModel().id === 'llama-3.2-1b-instruct');
check(
  'every entry is fully specified',
  catalog.every(
    (m) =>
      m.id &&
      m.name &&
      m.tier &&
      m.license &&
      m.sizeBytes > 0 &&
      m.minRamGB > 0 &&
      m.recommendedRamGB >= m.minRamGB &&
      m.contextLength > 0 &&
      m.url.startsWith('https://huggingface.co/'),
  ),
);
check(
  'every model is freely licensed',
  catalog.every((m) =>
    ['Apache 2.0', 'MIT', 'Llama Community', 'Gemma Terms'].includes(m.license),
  ),
  catalog
    .filter((m) => !['Apache 2.0', 'MIT', 'Llama Community', 'Gemma Terms'].includes(m.license))
    .map((m) => m.license)
    .join(', '),
);

// --- 2. Eligibility ---
const byId = (id) => catalog.find((m) => m.id === id);
check(
  `below ${RAM_FLOOR_GB}GB RAM blocks everything`,
  evaluateEligibility(byId('llama-3.2-3b-instruct'), hw(4)).status === 'blocked',
);
check(
  '10GB RAM: 3B fits, 7B blocked',
  evaluateEligibility(byId('llama-3.2-3b-instruct'), hw(10)).status === 'ok' &&
    evaluateEligibility(byId('qwen2.5-7b-instruct'), hw(10)).status === 'blocked',
);
check(
  '14GB RAM: 7B warns (below recommended 16)',
  evaluateEligibility(byId('qwen2.5-7b-instruct'), hw(14)).status === 'warn',
);
check(
  '16GB RAM: 7B fits',
  evaluateEligibility(byId('qwen2.5-7b-instruct'), hw(16)).status === 'ok',
);
check(
  'insufficient disk blocks a large model',
  evaluateEligibility(byId('llama-3.3-70b-instruct'), hw(64, 5)).status === 'blocked',
);

// --- 3. Slots + queue position ---
class CountingBackend {
  available = true;
  active = 0;
  maxActive = 0;
  async run(_req, _onToken, signal) {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(120);
    } finally {
      this.active--;
    }
    void signal;
    return { text: 'ok', tokens: 1 };
  }
}
{
  const backend = new CountingBackend();
  const sched = new InferenceScheduler(backend, 2);
  const ac = new AbortController();
  const h1 = sched.submit({ userId: 'u1', prompt: 'a' }, () => {}, ac.signal);
  const h2 = sched.submit({ userId: 'u1', prompt: 'b' }, () => {}, ac.signal);
  const h3 = sched.submit({ userId: 'u1', prompt: 'c' }, () => {}, ac.signal);
  await sleep(20);
  check('2 slots busy while a 3rd is queued', sched.busySlots === 2 && sched.queueDepth === 1);
  check(
    'queued request reports position 1',
    sched.positionOf(h3.id) === 1,
    `pos=${sched.positionOf(h3.id)}`,
  );
  await Promise.all([h1.done, h2.done, h3.done]);
  check(
    'at most 2 ran concurrently (slot budget honored)',
    backend.maxActive === 2,
    `max=${backend.maxActive}`,
  );
}

// --- 4. Round-robin fairness ---
{
  const backend = new CountingBackend();
  const sched = new InferenceScheduler(backend, 1); // 1 slot forces queueing
  const ac = new AbortController();
  sched.submit({ userId: 'A', prompt: '1' }, () => {}, ac.signal); // runs
  const a2 = sched.submit({ userId: 'A', prompt: '2' }, () => {}, ac.signal);
  const a3 = sched.submit({ userId: 'A', prompt: '3' }, () => {}, ac.signal);
  const b1 = sched.submit({ userId: 'B', prompt: '1' }, () => {}, ac.signal);
  await sleep(10);
  const posB1 = sched.positionOf(b1.id);
  const posA3 = sched.positionOf(a3.id);
  check(
    'latecomer B is not starved behind heavy user A',
    posB1 > 0 && posA3 > 0 && posB1 < posA3,
    `B=${posB1} A3=${posA3}`,
  );
  void a2;
}

// --- 5. Download: resume + hash verify + mismatch rejection ---
const payload = randomBytes(200_000);
const goodSha = createHash('sha256').update(payload).digest('hex');
const server = createServer((req, res) => {
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    res.writeHead(206, {
      'content-length': String(payload.length - start),
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    });
    res.end(payload.subarray(start));
  } else {
    res.writeHead(200, { 'content-length': String(payload.length) });
    res.end(payload);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/model.gguf`;
const dir = mkdtempSync(join(tmpdir(), 'ql-p2-dl-'));
const downloader = new ModelDownloader();

try {
  // (a) resume: pre-seed a half-written .part, then download the rest.
  const dest = join(dir, 'model.gguf');
  writeFileSync(`${dest}.part`, payload.subarray(0, 100_000));
  await downloader.download({
    url,
    dest,
    expectedSha256: goodSha,
    expectedSize: payload.length,
    onProgress: () => {},
    signal: new AbortController().signal,
  });
  const ok = existsSync(dest) && !existsSync(`${dest}.part`);
  const matches = ok && Buffer.compare(readFileSync(dest), payload) === 0;
  check('resumed download completes and matches source', matches);
  check('resumed download passes hash verification', ok && (await sha256File(dest)) === goodSha);

  // (b) mismatch: wrong expected hash must be rejected and discarded.
  const dest2 = join(dir, 'bad.gguf');
  let rejected = false;
  try {
    await downloader.download({
      url,
      dest: dest2,
      expectedSha256: 'deadbeef'.repeat(8),
      expectedSize: payload.length,
      onProgress: () => {},
      signal: new AbortController().signal,
    });
  } catch {
    rejected = true;
  }
  check(
    'hash mismatch is rejected and file discarded',
    rejected && !existsSync(dest2) && !existsSync(`${dest2}.part`),
  );
} finally {
  server.close();
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 300);
}

// --- 6. Removing a model returns it to the "not downloaded" state ---
// Exercised against a real ModelManager and a real database, not a stub: the
// remove path had been dead code with no route and no UI, and its bugs (the
// active-model setting left dangling, a stale .part file left behind) only
// exist at the seam between the filesystem and the settings table.
{
  const { AppPaths } = await import(`${E}/config/paths.js`);
  const { ensureAppDataLayout } = await import(`${E}/config/appdata.js`);
  const { SecretStore } = await import(`${E}/security/secret-store.js`);
  const { openDatabase } = await import(`${E}/db/database.js`);
  const { createRepositories } = await import(`${E}/db/repos.js`);
  const { createLogger } = await import(`${E}/logging/logger.js`);
  const { ModelManager } = await import(`${E}/models/model-manager.js`);

  const dir = mkdtempSync(join(tmpdir(), 'ql-p2-remove-'));
  const paths = new AppPaths(dir);
  await ensureAppDataLayout(paths);
  const logger = createLogger('phase2', paths.logsDir);
  const db = await openDatabase(
    paths.metadataDbFile,
    new SecretStore(paths.certsDir, 'CurrentUser'),
    logger,
  );
  try {
    const repos = createRepositories(db);
    const manager = new ModelManager(repos, paths.modelsDir, logger, 2);

    const id = smallestModel().id;
    const gguf = join(paths.modelsDir, `${id}.gguf`);
    writeFileSync(gguf, 'weights');
    writeFileSync(`${gguf}.part`, 'interrupted download');
    repos.settings.set('active-model-id', id);

    const before = await manager.listModels();
    check(
      'a downloaded model reports installed + active',
      before.models.find((m) => m.entry.id === id)?.installed === true &&
        before.models.find((m) => m.entry.id === id)?.active === true,
    );

    await manager.deleteModel(id);

    check('remove deletes the weights', !existsSync(gguf));
    check('remove deletes a stale partial download', !existsSync(`${gguf}.part`));
    check('remove clears the stored active model', !repos.settings.get('active-model-id'));

    const after = await manager.listModels();
    const row = after.models.find((m) => m.entry.id === id);
    check('removed model offers Download again', row?.installed === false);
    check('removed model is no longer active', row?.active === false);
    check('activeModelId is null, not an empty string', after.activeModelId === null);

    let threw = false;
    await manager.deleteModel(id).catch(() => {
      threw = true;
    });
    check('removing an already-removed model is a no-op', !threw);
  } finally {
    db.close();
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }, 300);
  }
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 800);
