/**
 * Phase 1 smoke test — the ingestion pipeline & encrypted index, end to end.
 *
 * White-box: it drives the real, built engine modules (no HTTP) so it can
 * inspect the encrypted index directly and assert:
 *   1. A mixed corpus (txt, md, eml, 2-page PDF) is indexed into chunks.
 *   2. PDF page mapping is correct (page-1 text → page 1, page-2 → page 2).
 *   3. Overlap detection refuses identical + nested paths (never double-index).
 *   4. Modifying one file re-indexes only that file (content-hash deltas).
 *   5. An unparseable file is quarantined (parser isolation) and not retried forever.
 *   6. metadata.db is unreadable without the DPAPI-sealed key.
 *
 * Run: node scripts/phase1-smoke.mjs   (after `npm run build`)
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const E = '../packages/engine/dist';
const { AppPaths } = await import(`${E}/config/paths.js`);
const { ensureAppDataLayout } = await import(`${E}/config/appdata.js`);
const { SecretStore } = await import(`${E}/security/secret-store.js`);
const { openDatabase } = await import(`${E}/db/database.js`);
const { createRepositories } = await import(`${E}/db/repos.js`);
const { VectorStore } = await import(`${E}/index/vector-store.js`);
const { ProvisionalEmbedder } = await import(`${E}/embedding/embedder.js`);
const { IngestionManager, PathOverlapError } = await import(`${E}/ingestion/ingestion-manager.js`);
const { createLogger } = await import(`${E}/logging/logger.js`);
const { default: Database } = await import('better-sqlite3-multiple-ciphers');

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

/** Build a minimal valid multi-page PDF, one text string per page. */
function buildPdf(pageTexts) {
  const n = pageTexts.length;
  const fontNum = 3 + n * 2;
  const objs = [{ num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }];
  const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push({ num: 2, body: `<</Type/Pages/Kids[${kids}]/Count ${n}>>` });
  pageTexts.forEach((t, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = 4 + i * 2;
    objs.push({
      num: pageNum,
      body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNum} 0 R/Resources<</Font<</F1 ${fontNum} 0 R>>>>>>`,
    });
    const stream = `BT /F1 24 Tf 72 700 Td (${t}) Tj ET`;
    objs.push({
      num: contentNum,
      body: `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`,
    });
  });
  objs.push({ num: fontNum, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' });
  objs.sort((a, b) => a.num - b.num);

  let pdf = '%PDF-1.4\n';
  const offsets = {};
  for (const o of objs) {
    offsets[o.num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${o.num} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const count = objs.length + 1;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const dataDir = mkdtempSync(join(tmpdir(), 'ql-p1-data-'));
const corpus = mkdtempSync(join(tmpdir(), 'ql-p1-corpus-'));
const sub = join(corpus, 'sub');
mkdirSync(sub);

// --- author the corpus ---
writeFileSync(
  join(corpus, 'apples.txt'),
  'Hello world. This document discusses apples and orchards in detail.',
);
writeFileSync(
  join(corpus, 'notes.md'),
  '# Notes\n\nThe quick brown fox jumps over the lazy dog. Foxes are clever.',
);
writeFileSync(
  join(corpus, 'memo.eml'),
  'From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Quarterly numbers\r\n\r\nThe quarterly revenue exceeded projections by twelve percent.\r\n',
);
writeFileSync(
  join(corpus, 'two-page.pdf'),
  buildPdf(['ALPHAPAGEONE apples on page one', 'BRAVOPAGETWO oranges on page two']),
);
// Unparseable DOCX (random bytes, not a zip) -> should be quarantined.
writeFileSync(
  join(sub, 'broken.docx'),
  Buffer.from([0x00, 0x01, 0x02, 0x03, 0x99, 0xff, 0x10, 0x20]),
);

const paths = new AppPaths(dataDir);
await ensureAppDataLayout(paths);
const logger = createLogger('desktop', paths.logsDir);
const keyStore = new SecretStore(paths.certsDir, 'CurrentUser');
const db = await openDatabase(paths.metadataDbFile, keyStore, logger);
const repos = createRepositories(db);
const vectors = new VectorStore(paths.indexDir, logger);
await vectors.open();
const manager = new IngestionManager(repos, vectors, new ProvisionalEmbedder(), logger);

try {
  // --- add path + wait for scan ---
  await manager.addPath(corpus);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (!manager.getStatus().totals.busy) break;
    await sleep(300);
  }
  await sleep(500);

  const status = manager.getStatus();
  check(
    'indexed 4 supported files',
    status.totals.filesIndexed === 4,
    `got ${status.totals.filesIndexed}`,
  );
  check('produced chunks', status.totals.chunks > 0, `got ${status.totals.chunks}`);

  // --- PDF page mapping ---
  const pdfChunks = db
    .prepare(
      `SELECT c.page AS page, c.text AS text FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path LIKE '%two-page.pdf'`,
    )
    .all();
  const p1 = pdfChunks.find((c) => c.text.includes('ALPHAPAGEONE'));
  const p2 = pdfChunks.find((c) => c.text.includes('BRAVOPAGETWO'));
  check('PDF page 1 text maps to page 1', p1?.page === 1, `page=${p1?.page}`);
  check('PDF page 2 text maps to page 2', p2?.page === 2, `page=${p2?.page}`);

  // --- vectors present and countable ---
  const vecCount = await vectors.countRows();
  check(
    'vector index populated',
    vecCount === status.totals.chunks,
    `vec=${vecCount} chunks=${status.totals.chunks}`,
  );

  // --- overlap detection ---
  let identicalRejected = false;
  try {
    await manager.addPath(corpus);
  } catch (e) {
    identicalRejected = e instanceof PathOverlapError && e.conflict.relationship === 'identical';
  }
  check('identical path rejected', identicalRejected);

  let nestedRejected = false;
  try {
    await manager.addPath(sub);
  } catch (e) {
    nestedRejected = e instanceof PathOverlapError && e.conflict.relationship === 'nested-inside';
  }
  check('nested path rejected', nestedRejected);

  // --- quarantine (unparseable docx) ---
  const q = manager.getStatus().quarantine.find((x) => x.path.endsWith('broken.docx'));
  check(
    'unparseable file quarantined',
    !!q && q.attempts >= 1,
    q ? `attempts=${q.attempts}` : 'not found',
  );

  // --- incremental re-index: modify one file, only it changes ---
  const before = new Map(
    db
      .prepare('SELECT path, updated_at FROM files')
      .all()
      .map((r) => [r.path, r.updated_at]),
  );
  await sleep(1100); // ensure a distinct mtime + let awaitWriteFinish settle
  writeFileSync(
    join(corpus, 'apples.txt'),
    'UPDATED CONTENT: now this document is about bananas and mangoes.',
  );
  let reindexed = false;
  const rdl = Date.now() + 15000;
  while (Date.now() < rdl) {
    const row = db
      .prepare(
        `SELECT text FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path LIKE '%apples.txt'`,
      )
      .get();
    if (row && row.text.includes('bananas')) {
      reindexed = true;
      break;
    }
    await sleep(400);
  }
  check('modified file re-indexed (watcher)', reindexed);
  if (reindexed) {
    const after = new Map(
      db
        .prepare('SELECT path, updated_at FROM files')
        .all()
        .map((r) => [r.path, r.updated_at]),
    );
    const changed = [...after.entries()].filter(([p, t]) => before.get(p) !== t).map(([p]) => p);
    const onlyApples = changed.length === 1 && changed[0].endsWith('apples.txt');
    check(
      'only the modified file re-indexed',
      onlyApples,
      `changed: ${changed.map((p) => p.split(/[\\/]/).pop()).join(', ')}`,
    );
  }

  // --- encryption at rest ---
  await manager.shutdown();
  await vectors.close();
  db.close();
  let wrongKeyFails = false;
  try {
    const bad = new Database(paths.metadataDbFile);
    bad.pragma("cipher='sqlcipher'");
    bad.pragma("key='wrong-key'");
    bad.prepare('SELECT count(*) FROM files').get();
    bad.close();
  } catch {
    wrongKeyFails = true;
  }
  check('metadata.db unreadable without key', wrongKeyFails);
} finally {
  try {
    await manager.shutdown();
  } catch {
    /* already shut down */
  }
  setTimeout(() => {
    for (const d of [dataDir, corpus]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows file locks — best effort */
      }
    }
  }, 800);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 1500);
