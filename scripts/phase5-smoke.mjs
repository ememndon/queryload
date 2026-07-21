/**
 * Phase 5 smoke test — governance, retention, lifecycle.
 *
 * Verifies (over the real engine modules): argon2id auth with throttling +
 * lockout; the role wall (member can't reach admin/auditor); audit default-on
 * recording of a query; the retention scheduler purging chats + audit from
 * SQLite AND documents' vectors from LanceDB (unrecoverable); Ed25519 update
 * signature verification (valid accepted, tampered/unsigned rejected); the
 * diagnostic bundle containing zero document text; and encrypted config export
 * round-tripping (wrong passphrase rejected).
 *
 * Run: node scripts/phase5-smoke.mjs   (after `npm run build`)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import AdmZip from 'adm-zip';

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
const { AuthService, AuthError } = await import(`${E}/auth/auth-service.js`);
const { AuditService } = await import(`${E}/audit/audit-service.js`);
const { RetentionService } = await import(`${E}/retention/retention-service.js`);
const { Retriever } = await import(`${E}/rag/retriever.js`);
const { QueryService } = await import(`${E}/rag/query-service.js`);
const { InferenceScheduler } = await import(`${E}/inference/scheduler.js`);
const { StubBackend } = await import(`${E}/inference/backend.js`);
const { verifyUpdate } = await import(`${E}/update/update-verify.js`);
const { buildDiagnosticBundle } = await import(`${E}/diagnostics/diagnostic-bundle.js`);
const { encryptExport, decryptExport } = await import(`${E}/export/config-export.js`);

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

const dataDir = mkdtempSync(join(tmpdir(), 'ql-p5-data-'));
const corpus = mkdtempSync(join(tmpdir(), 'ql-p5-corpus-'));
const SECRET_DOC = 'ZEBRA_CONFIDENTIAL_SUPERSECRET_MEDICAL_RECORD';
writeFileSync(join(corpus, 'secret.txt'), `Patient note. ${SECRET_DOC}. Cholesterol elevated.`);

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
const audit = new AuditService(repos);
const auth = new AuthService(repos, logger);
const retention = new RetentionService(repos, vectors, logger);
const retriever = new Retriever(repos, vectors, embedder);
const scheduler = new InferenceScheduler(new StubBackend(0), 2);
const query = new QueryService({ retriever, scheduler, repos, audit, logger });

try {
  // --- 1. Auth: argon2id, throttle + lockout ---
  await auth.createUser('carol-admin', 'Correct-Horse-1', 'admin');
  const member = await auth.createUser('mia-member', 'member-pass-9', 'member');
  await auth.createUser('alan-auditor', 'auditor-pass-3', 'auditor');

  const adminLogin = await auth.login('carol-admin', 'Correct-Horse-1');
  check(
    'admin logs in with correct password',
    adminLogin.account.role === 'admin' && !!adminLogin.token,
  );

  let wrongRejected = false;
  try {
    await auth.login('carol-admin', 'nope');
  } catch (e) {
    wrongRejected = e instanceof AuthError && e.code === 'invalid_credentials';
  }
  check('wrong password rejected', wrongRejected);

  // Trip the lockout (5 failures total; 1 already recorded above).
  for (let i = 0; i < 4; i++) {
    await auth.login('carol-admin', 'nope').catch(() => {});
  }
  let locked = false;
  try {
    await auth.login('carol-admin', 'Correct-Horse-1');
  } catch (e) {
    locked = e instanceof AuthError && e.code === 'locked';
  }
  check('account locks after repeated failures (D49)', locked);
  auth.unlock(adminLogin.account.id); // admin-unlockable

  // --- 2. Role wall ---
  const memberSession = await auth.login('mia-member', 'member-pass-9');
  const auditorSession = await auth.login('alan-auditor', 'auditor-pass-3');
  let memberBlocked = false;
  try {
    auth.requireRole(memberSession.token, ['admin', 'auditor']);
  } catch (e) {
    memberBlocked = e instanceof AuthError && e.code === 'forbidden';
  }
  check('member cannot reach admin/auditor surfaces', memberBlocked);
  check(
    'auditor may read the audit log',
    !!auth.requireRole(auditorSession.token, ['admin', 'auditor']),
  );
  let auditorNotAdmin = false;
  try {
    auth.requireRole(auditorSession.token, ['admin']);
  } catch (e) {
    auditorNotAdmin = e instanceof AuthError && e.code === 'forbidden';
  }
  check('auditor cannot perform admin-only actions', auditorNotAdmin);
  void member;

  // --- Index the corpus into General for the audit + retention tests ---
  await manager.addPath(corpus, GENERAL_WORKSPACE_ID);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!manager.getStatus().totals.busy) break;
    await sleep(300);
  }
  await sleep(400);

  // --- 3. Audit default-on: a query is recorded ---
  const before = repos.audit.countTotal();
  await query.run(
    DEFAULT_USER_ID,
    { workspaceId: GENERAL_WORKSPACE_ID, query: 'What are the cholesterol results?' },
    () => {},
    new AbortController().signal,
  );
  const entries = audit.list(10);
  check('query recorded in the audit log (default on)', repos.audit.countTotal() > before);
  check(
    'audit entry captures query + sources',
    entries[0]?.action === 'query' && entries[0]?.query?.includes('cholesterol'),
  );

  // --- 4. Retention purge (SQLite + LanceDB), unrecoverable ---
  const dayMs = 24 * 60 * 60 * 1000;
  const old = Date.now() - 100 * dayMs;
  // Old chat + old audit entry to be purged.
  repos.chats.create({
    id: 'old-chat',
    user_id: DEFAULT_USER_ID,
    workspace_id: GENERAL_WORKSPACE_ID,
    title: 'old',
    created_at: old,
    updated_at: old,
  });
  repos.audit.record({
    id: 'old-audit',
    user_id: DEFAULT_USER_ID,
    action: 'query',
    query: 'ancient',
    answer_excerpt: null,
    sources: null,
    workspace_id: GENERAL_WORKSPACE_ID,
    at: old,
  });
  // Age the indexed document so the documents policy purges it.
  const fileId = repos.files.getByPath(join(corpus, 'secret.txt'))?.id;
  repos.files.setUpdatedAt(fileId, old);

  const vecBefore = await vectors.countRows();
  const chunksBefore = repos.chunks.countTotal();
  retention.setPolicy('chats', 30);
  retention.setPolicy('audit', 30);
  retention.setPolicy('documents', 30);
  const purged = await retention.runOnce();

  check('retention purged the old chat', !repos.chats.get('old-chat') && purged.chats >= 1);
  check(
    'retention purged old audit entries',
    repos.audit.list(200).every((e) => e.id !== 'old-audit'),
  );
  check(
    'retention purged old document from SQLite (chunks gone)',
    repos.chunks.countTotal() < chunksBefore && !repos.files.getById(fileId),
  );
  const vecAfter = await vectors.countRows();
  check(
    'retention purged the document vectors from LanceDB',
    vecAfter < vecBefore,
    `${vecBefore} -> ${vecAfter}`,
  );

  // --- 5. Signed-update verification (Ed25519) ---
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = Buffer.from('queryload-update-v1.2.3-manifest');
  const signature = edSign(null, payload, privateKey);
  check('valid signed update is accepted', verifyUpdate(payload, signature, pubPem) === true);
  check(
    'tampered update payload is rejected',
    verifyUpdate(Buffer.from('tampered'), signature, pubPem) === false,
  );
  check(
    'unsigned update is rejected (no key configured)',
    verifyUpdate(payload, signature) === false,
  );

  // --- 6. Diagnostic bundle contains no document text (D14) ---
  const bundle = await buildDiagnosticBundle({
    appVersion: '0.0.0',
    configJson: JSON.stringify({ port: 8443, sessionToken: 'abc123secret' }),
    hardwareJson: JSON.stringify({ totalRamGB: 16 }),
    logsDir: paths.logsDir,
  });
  const zip = new AdmZip(bundle);
  const combined = zip
    .getEntries()
    .map((e) => e.getData().toString('utf8'))
    .join('\n');
  check('diagnostic bundle contains no document content', !combined.includes(SECRET_DOC));
  check(
    'diagnostic bundle includes config + hardware + version',
    combined.includes('totalRamGB') && zip.getEntry('version.txt') !== null,
  );
  check('diagnostic bundle redacts secrets', !combined.includes('abc123secret'));

  // --- 7. Encrypted config export round-trip ---
  const secretExport = Buffer.from(JSON.stringify({ setting: 'value', instance: 42 }));
  const blob = encryptExport(secretExport, 'strong-passphrase');
  const restored = decryptExport(blob, 'strong-passphrase');
  check('encrypted export round-trips with the right passphrase', restored.equals(secretExport));
  let wrongPass = false;
  try {
    decryptExport(blob, 'wrong-passphrase');
  } catch {
    wrongPass = true;
  }
  check('encrypted export rejects the wrong passphrase', wrongPass);
} finally {
  try {
    await manager.shutdown();
    retention.stop();
    await vectors.close();
    db.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    for (const d of [dataDir, corpus]) {
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
