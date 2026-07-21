/**
 * Phase 4 smoke test — first-run demo corpus (D72).
 *
 * Verifies the two synthetic mini-corpora load into their own workspaces, index
 * through the real pipeline, and are queryable with resolved citations — so the
 * demo "answers cited questions immediately after install". Also checks
 * idempotency (the demo loads once). The dark-editorial layout + D79 composer
 * rule are verified separately by the UI test (`npm run test -w @queryload/ui`)
 * and the Browser-pane geometry check.
 *
 * Run: node scripts/phase4-smoke.mjs   (after `npm run build`)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const E = '../packages/engine/dist';
const { AppPaths } = await import(`${E}/config/paths.js`);
const { ensureAppDataLayout } = await import(`${E}/config/appdata.js`);
const { SecretStore } = await import(`${E}/security/secret-store.js`);
const { openDatabase } = await import(`${E}/db/database.js`);
const { createRepositories } = await import(`${E}/db/repos.js`);
const { DEFAULT_USER_ID } = await import(`${E}/db/schema.js`);
const { VectorStore } = await import(`${E}/index/vector-store.js`);
const { ProvisionalEmbedder } = await import(`${E}/embedding/embedder.js`);
const { IngestionManager } = await import(`${E}/ingestion/ingestion-manager.js`);
const { createLogger } = await import(`${E}/logging/logger.js`);
const { Retriever } = await import(`${E}/rag/retriever.js`);
const { loadDemoCorpus } = await import(`${E}/demo/demo-corpus.js`);

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

const dataDir = mkdtempSync(join(tmpdir(), 'ql-p4-'));
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

try {
  await loadDemoCorpus({ repos, ingestion: manager, logger });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (!manager.getStatus().totals.busy) break;
    await sleep(300);
  }
  await sleep(600);

  const workspaces = repos.workspaces.list();
  check(
    'two demo workspaces created',
    workspaces.some((w) => w.id === 'ws-demo-law') &&
      workspaces.some((w) => w.id === 'ws-demo-clinic'),
  );
  check('demo workspaces are kind=demo', workspaces.filter((w) => w.kind === 'demo').length === 2);

  const indexed = repos.files.countTotalIndexed();
  check('demo documents indexed', indexed >= 6, `indexed ${indexed}`);

  // The demo user is a member of both demo workspaces and can query them.
  const law = await retriever.retrieve(
    DEFAULT_USER_ID,
    'ws-demo-law',
    'cover costs and damages for breach',
    5,
  );
  check(
    'law-firm demo retrieval returns cited context',
    law.length > 0 && law[0].fileName.length > 0,
  );
  check(
    'law citation resolves to a demo file',
    law.some((c) => c.filePath.includes('law-firm')),
  );

  const clinic = await retriever.retrieve(
    DEFAULT_USER_ID,
    'ws-demo-clinic',
    'cholesterol LDL lipid results',
    5,
  );
  check('clinic demo retrieval returns cited context', clinic.length > 0);
  check(
    'clinic citation resolves to a demo file',
    clinic.some((c) => c.filePath.includes('clinic')),
  );

  // Idempotency: a second load is a no-op (flag set), no duplicate workspaces.
  await loadDemoCorpus({ repos, ingestion: manager, logger });
  const demoCount = repos.workspaces.list().filter((w) => w.kind === 'demo').length;
  check('demo load is idempotent (still 2 workspaces)', demoCount === 2, `got ${demoCount}`);
  check('demo-loaded flag set', repos.settings.get('demo-corpus-loaded') === '1');
} finally {
  try {
    await manager.shutdown();
    await vectors.close();
    db.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }, 800);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 1500);
