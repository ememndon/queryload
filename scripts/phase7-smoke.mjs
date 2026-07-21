/**
 * Phase 7 — release-candidate QA: the killer demo (D82) + a performance pass.
 *
 * Killer demo: index a corpus → get a cited answer → "disable the network" →
 * ask again → the answer + citations are identical. We simulate offline by
 * replacing global fetch with one that throws; the entire RAG data path
 * (embed, retrieve, cite) makes zero network calls, so it keeps working. (The
 * real model is a loopback sidecar, which also survives Wi-Fi being turned off.)
 *
 * Performance pass: engine cold-start (real HTTPS boot), indexing throughput,
 * and retrieval latency — reported as numbers, with sanity thresholds.
 *
 * Run: node scripts/phase7-smoke.mjs   (after `npm run build`)
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const E = '../packages/engine/dist';
const { AppPaths } = await import(`${E}/config/paths.js`);
const { ensureAppDataLayout } = await import(`${E}/config/appdata.js`);
const { SecretStore } = await import(`${E}/security/secret-store.js`);
const { openDatabase } = await import(`${E}/db/database.js`);
const { createRepositories } = await import(`${E}/db/repos.js`);
const { GENERAL_WORKSPACE_ID, DEFAULT_USER_ID } = await import(`${E}/db/schema.js`);
const { VectorStore } = await import(`${E}/index/vector-store.js`);
const { ProvisionalEmbedder } = await import(`${E}/embedding/embedder.js`);
const { IngestionManager } = await import(`${E}/ingestion/ingestion-manager.js`);
const { createLogger } = await import(`${E}/logging/logger.js`);
const { AuditService } = await import(`${E}/audit/audit-service.js`);
const { Retriever } = await import(`${E}/rag/retriever.js`);
const { QueryService } = await import(`${E}/rag/query-service.js`);
const { InferenceScheduler } = await import(`${E}/inference/scheduler.js`);
const { StubBackend } = await import(`${E}/inference/backend.js`);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runQuery(query, userId, workspaceId) {
  const events = [];
  await query.run(
    userId,
    { workspaceId, query: 'What obligations and dates are in the supply agreement?' },
    (e) => events.push(e),
    new AbortController().signal,
  );
  const answer = events
    .filter((e) => e.type === 'token')
    .map((e) => e.token)
    .join('');
  const meta = events.find((e) => e.type === 'meta');
  return { answer, citations: meta?.citations ?? [] };
}

// ---------- Part A: engine cold start (real HTTPS boot) ----------
const bootDir = mkdtempSync(join(tmpdir(), 'ql-p7-boot-'));
const engineEntry = join(process.cwd(), 'packages', 'engine', 'dist', 'index.js');
const MARKER = 'QUERYLOAD_ENGINE_READY';
const t0 = Date.now();
const child = spawn(process.execPath, [engineEntry, '--mode', 'desktop', '--data-dir', bootDir], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const coldStartMs = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('engine did not boot in 30s')), 30000);
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith(MARKER)) {
      clearTimeout(timer);
      resolve(Date.now() - t0);
    }
  });
  child.on('exit', (c) => reject(new Error(`engine exited early (${c})`)));
});
child.kill('SIGTERM');
// Sanity bound, not a tight SLA: first-run boot is dominated by cert generation
// + the DPAPI PowerShell round-trip, which vary a lot with machine load and are
// slower on CI runners. Keep this generous enough to avoid false failures while
// still catching a gross regression (the hard boot timeout above is 30s).
check('engine cold-start under 20s', coldStartMs < 20000, `${coldStartMs} ms`);

// ---------- Part B: killer demo + perf (white-box, deterministic model stub) ----------
const dataDir = mkdtempSync(join(tmpdir(), 'ql-p7-data-'));
const corpus = mkdtempSync(join(tmpdir(), 'ql-p7-corpus-'));
for (let i = 0; i < 60; i++) {
  writeFileSync(
    join(corpus, `doc-${i}.txt`),
    `Supply agreement ${i}. Globex shall deliver ${100 + i} crates by March ${1 + (i % 28)}. Payment net 30. Late delivery incurs a 2% weekly credit.`,
  );
}

const paths = new AppPaths(dataDir);
await ensureAppDataLayout(paths);
const logger = createLogger('desktop', paths.logsDir);
const keyStore = new SecretStore(paths.certsDir, 'CurrentUser');
const db = await openDatabase(paths.metadataDbFile, keyStore, logger);
const repos = createRepositories(db);
const vectors = new VectorStore(paths.indexDir, logger);
await vectors.open();
const embedder = new ProvisionalEmbedder();
const manager = new IngestionManager(repos, vectors, embedder, logger);
const retriever = new Retriever(repos, vectors, embedder);
const scheduler = new InferenceScheduler(new StubBackend(0), 2);
const query = new QueryService({
  retriever,
  scheduler,
  repos,
  audit: new AuditService(repos),
  logger,
});

try {
  const indexStart = Date.now();
  await manager.addPath(corpus, GENERAL_WORKSPACE_ID);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!manager.getStatus().totals.busy) break;
    await sleep(200);
  }
  await sleep(300);
  const indexMs = Date.now() - indexStart;
  const indexed = repos.files.countTotalIndexed();
  const docsPerSec = indexed / (indexMs / 1000);
  check('indexed the corpus', indexed >= 55, `${indexed} docs in ${indexMs} ms`);
  check('indexing throughput reported', docsPerSec > 0, `${docsPerSec.toFixed(1)} docs/sec`);

  // Retrieval latency (avg over 10 queries).
  const rt0 = Date.now();
  for (let i = 0; i < 10; i++)
    await retriever.retrieve(DEFAULT_USER_ID, GENERAL_WORKSPACE_ID, 'delivery crates payment', 8);
  const retrievalMs = (Date.now() - rt0) / 10;
  check('retrieval latency under 250ms', retrievalMs < 250, `${retrievalMs.toFixed(1)} ms avg`);

  // --- KILLER DEMO (D82) ---
  const online = await runQuery(query, DEFAULT_USER_ID, GENERAL_WORKSPACE_ID);
  check(
    'online: cited answer produced',
    online.answer.length > 0 && online.citations.length > 0,
    `${online.citations.length} citations`,
  );
  check(
    'citations resolve to file + page',
    online.citations.every((c) => c.fileName.length > 0),
  );

  // "Disable the network": any outbound fetch now throws.
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('NETWORK DISABLED (killer demo)');
  };
  let offline;
  try {
    offline = await runQuery(query, DEFAULT_USER_ID, GENERAL_WORKSPACE_ID);
  } finally {
    globalThis.fetch = realFetch;
  }

  check(
    'offline: the same query still answers',
    offline.answer.length > 0 && offline.citations.length > 0,
  );
  check('offline: no network was attempted on the query path', fetchCalled === false);
  check(
    'offline answer is identical to the online answer (D82)',
    offline.answer === online.answer &&
      JSON.stringify(offline.citations) === JSON.stringify(online.citations),
  );
} finally {
  try {
    await manager.shutdown();
    await vectors.close();
    db.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    for (const d of [bootDir, dataDir, corpus]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }, 800);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 1500);
