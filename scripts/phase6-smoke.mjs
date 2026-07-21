/**
 * Phase 6 smoke test — organization / server mode.
 *
 * Verifies the pieces that don't require a second physical machine: the
 * per-request multi-user ethical wall (a member can only reach workspaces they
 * are assigned to, resolved from their session); persistent, revocable device
 * sessions; the join-code cert-pinning bootstrap; server-mode enable + join
 * code; mDNS advertise/discover on the local host; and admin-driven workspace
 * assignment governing access.
 *
 * (Two-machine discovery, service auto-recovery on reboot, and no-cached-content
 * disk inspection are verified by design — see the phase notes.)
 *
 * Run: node scripts/phase6-smoke.mjs   (after `npm run build`)
 */
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
const { VectorStore } = await import(`${E}/index/vector-store.js`);
const { ProvisionalEmbedder } = await import(`${E}/embedding/embedder.js`);
const { IngestionManager } = await import(`${E}/ingestion/ingestion-manager.js`);
const { createLogger } = await import(`${E}/logging/logger.js`);
const { AuthService } = await import(`${E}/auth/auth-service.js`);
const { Retriever, ForbiddenWorkspaceError } = await import(`${E}/rag/retriever.js`);
const { resolveActor } = await import(`${E}/server/actor.js`);
const { ServerModeManager } = await import(`${E}/server/server-mode.js`);
const { encodeJoinCode, decodeJoinCode, certMatchesPin } = await import(`${E}/server/join-code.js`);
const { MdnsAdvertiser, discoverServers } = await import(`${E}/server/mdns.js`);
const { DEFAULT_USER_ID } = await import(`${E}/db/schema.js`);

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
const reqWith = (token) => ({ headers: token ? { 'x-queryload-session': token } : {} });

const dataDir = mkdtempSync(join(tmpdir(), 'ql-p6-data-'));
const corpusA = mkdtempSync(join(tmpdir(), 'ql-p6-A-'));
const corpusB = mkdtempSync(join(tmpdir(), 'ql-p6-B-'));
writeFileSync(
  join(corpusA, 'a.txt'),
  'The Apollo matter concerns a merger between Acme and Zenith.',
);
writeFileSync(join(corpusB, 'b.txt'), 'The Boreas matter concerns a patent dispute over turbines.');

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
const auth = new AuthService(repos, logger);
const retriever = new Retriever(repos, vectors, embedder);
const serverMode = new ServerModeManager(repos, logger);

try {
  // Admin creates two workspaces, two users, and assigns each to one workspace.
  repos.workspaces.create('ws-apollo', 'Apollo', 'matter');
  repos.workspaces.create('ws-boreas', 'Boreas', 'matter');
  const alice = await auth.createUser('alice', 'alice-pass-1', 'member');
  const bob = await auth.createUser('bob', 'bob-pass-22', 'member');
  repos.memberships.add(alice.id, 'ws-apollo');
  repos.memberships.add(bob.id, 'ws-boreas');

  await manager.addPath(corpusA, 'ws-apollo');
  await manager.addPath(corpusB, 'ws-boreas');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!manager.getStatus().totals.busy) break;
    await sleep(300);
  }
  await sleep(400);

  // --- 1. Persistent, revocable sessions ---
  const aliceLogin = await auth.login('alice', 'alice-pass-1', 'Alice-Laptop');
  check('login issues a session token', !!aliceLogin.token && aliceLogin.account.id === alice.id);
  check('session authenticates', auth.authenticate(aliceLogin.token)?.userId === alice.id);

  // --- 2. Per-request actor resolution (the multi-user identity) ---
  const actor = resolveActor(reqWith(aliceLogin.token), auth, true);
  check('actor resolves to the logged-in user', actor.userId === alice.id && !actor.anonymous);
  const anon = resolveActor(reqWith('bogus-token'), auth, true);
  check('invalid session is anonymous in server mode', anon.anonymous === true);
  const local = resolveActor(reqWith(null), auth, false);
  check('desktop mode falls back to the local identity', local.userId === DEFAULT_USER_ID);

  // --- 3. The ethical wall ACROSS USERS ---
  const inA = await retriever.retrieve(actor.userId, 'ws-apollo', 'merger', 5);
  check('Alice retrieves from her assigned workspace', inA.length > 0);
  let aliceBlocked = false;
  try {
    await retriever.retrieve(actor.userId, 'ws-boreas', 'patent', 5);
  } catch (e) {
    aliceBlocked = e instanceof ForbiddenWorkspaceError;
  }
  check('Alice cannot reach Bob’s workspace (multi-user wall)', aliceBlocked);

  // Bob, resolved from HIS session, can reach Boreas but not Apollo.
  const bobLogin = await auth.login('bob', 'bob-pass-22');
  const bobActor = resolveActor(reqWith(bobLogin.token), auth, true);
  const bobInB = await retriever.retrieve(bobActor.userId, 'ws-boreas', 'turbines', 5);
  let bobBlocked = false;
  try {
    await retriever.retrieve(bobActor.userId, 'ws-apollo', 'merger', 5);
  } catch (e) {
    bobBlocked = e instanceof ForbiddenWorkspaceError;
  }
  check('Bob reaches his workspace but not Alice’s', bobInB.length > 0 && bobBlocked);

  // --- 4. Session revocation (admin device revoke) ---
  const { createHash } = await import('node:crypto');
  const aliceHash = createHash('sha256').update(aliceLogin.token).digest('hex');
  auth.revokeSession(aliceHash);
  check('revoked session no longer authenticates', auth.authenticate(aliceLogin.token) === null);

  // --- 5. Join code: cert-pinning bootstrap ---
  const info = {
    v: 1,
    host: '192.168.1.50',
    port: 8443,
    fingerprint: 'ab12cd34',
    secret: 's3cr3t',
  };
  const decoded = decodeJoinCode(encodeJoinCode(info));
  check(
    'join code round-trips',
    decoded?.fingerprint === 'ab12cd34' && decoded?.host === '192.168.1.50',
  );
  check('cert pin matches the advertised fingerprint', certMatchesPin('AB12CD34', 'ab12cd34'));
  check('cert pin rejects a different fingerprint', !certMatchesPin('ab12cd34', 'ffffffff'));
  check('bad join code decodes to null', decodeJoinCode('not-a-code!!') === null);

  // --- 6. Server mode manager ---
  serverMode.attach('192.168.1.50', 8443, 'ab12cd34'); // simulate a LAN bind
  const status = serverMode.enable();
  check('server mode enables and produces a join code', status.enabled && !!status.joinCode);
  const sm = decodeJoinCode(status.joinCode);
  check('server join code validates the shared secret', serverMode.validateJoin(sm.secret));
  check('server rejects a wrong join secret', !serverMode.validateJoin('wrong-secret'));
  serverMode.disable();

  // --- 7. mDNS advertise + discover (local host) ---
  const advertiser = new MdnsAdvertiser(logger);
  advertiser.advertise('QueryLoad Test Server', 8443, 'ab12cd34');
  const found = await discoverServers(3500);
  const self = found.find((s) => s.fingerprint === 'ab12cd34');
  check(
    'mDNS discovery finds the advertised server on the LAN',
    !!self,
    `found ${found.length} service(s)`,
  );
  advertiser.stop();
} finally {
  try {
    await manager.shutdown();
    serverMode.stop();
    await vectors.close();
    db.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    for (const d of [dataDir, corpusA, corpusB]) {
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
