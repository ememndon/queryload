import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:https';
import { ENGINE_LOOPBACK_HOST, ENGINE_READY_MARKER, engineBaseUrl } from '@queryload/shared';
import type { EngineMode, EngineReady } from '@queryload/shared';
import { AppPaths } from './config/paths.js';
import { ensureAppDataLayout } from './config/appdata.js';
import { loadOrCreateConfig, resolvePort, type EngineConfig } from './config/config.js';
import { createLogger, type Logger } from './logging/logger.js';
import { dpapiAvailable } from './security/dpapi.js';
import { SecretStore } from './security/secret-store.js';
import { loadOrCreateCertificate } from './security/cert.js';
import { createHttpsServer } from './server/https-server.js';
import { openDatabase } from './db/database.js';
import { createRepositories } from './db/repos.js';
import type { Db } from './db/sqlite.js';
import { VectorStore } from './index/vector-store.js';
import { ProvisionalEmbedder, type Embedder } from './embedding/embedder.js';
import { BgeM3Embedder } from './embedding/bge-m3.js';
import { IngestionManager } from './ingestion/ingestion-manager.js';
import { ModelManager, recommendedSlots } from './models/model-manager.js';
import { Retriever } from './rag/retriever.js';
import { QueryService } from './rag/query-service.js';
import { AuthService } from './auth/auth-service.js';
import { AuditService } from './audit/audit-service.js';
import { RetentionService } from './retention/retention-service.js';
import { ServerModeManager } from './server/server-mode.js';
import { loadDemoCorpus } from './demo/demo-corpus.js';
import { ENGINE_VERSION } from './version.js';

export interface EngineOptions {
  readonly mode: EngineMode;
  /** Override the app-data root (tests, --data-dir). */
  readonly dataDir?: string;
  /** Override the bind port; otherwise resolved from mode + config. */
  readonly port?: number;
}

/**
 * The QueryLoad engine: a standalone Node process that owns the encrypted
 * index, ingestion, inference, and the query API, exposed as a loopback HTTPS
 * server. It shares no code with the UI beyond the @queryload/shared contract,
 * and runs identically whether launched by the desktop supervisor or as a
 * headless Windows Service.
 */
export class Engine {
  private server: Server | null = null;
  private logger: Logger | null = null;
  private config: EngineConfig | null = null;
  private db: Db | null = null;
  private vectors: VectorStore | null = null;
  private ingestion: IngestionManager | null = null;
  private models: ModelManager | null = null;
  private retention: RetentionService | null = null;
  private serverMode: ServerModeManager | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly options: EngineOptions) {}

  async start(): Promise<EngineReady> {
    const paths = new AppPaths(this.options.dataDir);
    await ensureAppDataLayout(paths);

    this.config = await loadOrCreateConfig(paths.configFile);
    const logger = createLogger(this.options.mode, paths.logsDir);
    this.logger = logger;
    logger.info({ root: paths.root, mode: this.options.mode }, 'engine starting');

    // Fail closed if secrets can't be protected — never store a key in the clear.
    if (!dpapiAvailable()) {
      throw new Error(
        'Windows DPAPI is unavailable. QueryLoad cannot protect its keys at rest and will not ' +
          'start without it. Run the engine on a supported Windows target.',
      );
    }

    const scope = this.options.mode === 'service' ? 'LocalMachine' : 'CurrentUser';
    const secretStore = new SecretStore(paths.certsDir, scope);
    const cert = await loadOrCreateCertificate(paths.certsDir, secretStore);
    logger.info({ fingerprint: cert.fingerprintSha256 }, 'TLS identity ready');

    // Encrypted metadata store + vector index.
    const db = await openDatabase(paths.metadataDbFile, secretStore, logger);
    this.db = db;
    const repos = createRepositories(db);
    const vectors = new VectorStore(paths.indexDir, logger);
    await vectors.open();
    this.vectors = vectors;

    // Model + inference management. Slots auto-derived from hardware.
    const slots = recommendedSlots(cpus().length, false);
    const models = new ModelManager(repos, paths.modelsDir, logger, slots);
    this.models = models;

    // Pick the embedder: BGE-M3 when the runtime + embedder GGUF are
    // provisioned, otherwise the provisional placeholder (D19 seam). Switching
    // embedders invalidates vectors, so a change implies a rebuild (Phase 5).
    const embedder: Embedder =
      models.runtime.isRuntimeProvisioned() && existsSync(models.runtime.embedderPath)
        ? new BgeM3Embedder(() => models.runtime.ensureEmbedServer())
        : new ProvisionalEmbedder();
    logger.info({ embedder: embedder.id }, 'embedder selected');
    const ingestion = new IngestionManager(repos, vectors, embedder, logger);
    this.ingestion = ingestion;

    // D19: the embedder id is persisted so a change (e.g. the provisional
    // placeholder → BGE-M3 once the model finishes downloading) is detected on
    // the next boot. Vectors from different embedders are numerically
    // incompatible, so a change forces a full rebuild before any retrieval —
    // otherwise queries would silently search prior content with the wrong
    // metric and return garbage. On first run the stored id is null (no rebuild).
    const storedEmbedderId = repos.settings.get('embedder-id');
    const embedderChanged = storedEmbedderId !== null && storedEmbedderId !== embedder.id;
    if (embedderChanged) {
      logger.warn(
        { from: storedEmbedderId, to: embedder.id },
        'embedder changed since last run — rebuilding the index so vectors match the new embedder',
      );
    }

    // Governance: audit (default on), auth (accounts/roles), retention scheduler.
    const audit = new AuditService(repos);
    const auth = new AuthService(repos, logger);
    const retention = new RetentionService(repos, vectors, logger);
    this.retention = retention;
    const serverMode = new ServerModeManager(repos, logger);
    this.serverMode = serverMode;

    // Bind LAN only when the admin has enabled organization mode; loopback
    // otherwise (a normal desktop install is never exposed to the network).
    const bindHost = serverMode.isEnabled() ? '0.0.0.0' : ENGINE_LOOPBACK_HOST;

    // Retrieval + RAG query orchestration (uses the same embedder + scheduler).
    const retriever = new Retriever(repos, vectors, embedder);
    const query = new QueryService({
      retriever,
      scheduler: models.scheduler,
      repos,
      audit,
      logger,
    });

    // Per-run bearer token. Rotated every start; never persisted to disk.
    const sessionToken = randomBytes(32).toString('base64url');

    const server = createHttpsServer({
      certPem: cert.certPem,
      keyPem: cert.keyPem,
      sessionToken,
      startedAt: this.startedAt,
      logger,
      routes: {
        logger,
        engineInfo: () => ({
          version: ENGINE_VERSION,
          mode: this.options.mode,
          startedAt: this.startedAt,
          bind: bindHost === ENGINE_LOOPBACK_HOST ? 'loopback' : 'lan',
          engineApiEnabled: repos.settings.get('engine-api-enabled') === '1',
        }),
        ingestion,
        models,
        repos,
        query,
        auth,
        audit,
        retention,
        serverMode,
        configFile: paths.configFile,
        logsDir: paths.logsDir,
      },
    });
    this.server = server;

    const host = bindHost;
    const port = resolvePort(this.options.mode, this.config, this.options.port);
    const actualPort = await this.listen(server, port, host);
    // Advertise on the LAN via mDNS when organization mode is active.
    serverMode.attach(host, actualPort, cert.fingerprintSha256);

    const ready: EngineReady = {
      v: 1,
      mode: this.options.mode,
      host,
      port: actualPort,
      pid: process.pid,
      certFingerprintSha256: cert.fingerprintSha256,
      sessionToken,
      startedAt: this.startedAt,
    };

    // Persist a token-free descriptor for the supervisor/service to discover.
    const { sessionToken: _omit, ...persisted } = ready;
    void _omit;
    await writeFile(paths.runtimeFile, JSON.stringify(persisted, null, 2), 'utf8');

    // Hand the full descriptor (incl. token) to the parent via stdout only.
    process.stdout.write(`${ENGINE_READY_MARKER} ${JSON.stringify(ready)}\n`);
    logger.info(
      { url: engineBaseUrl(ready), mode: ready.mode },
      'engine listening (loopback, TLS)',
    );

    // Reactivate a previously chosen model (if installed), then resume every
    // known path: reconcile (delta-only) + re-watch. Done after the server is
    // up so status queries are answerable during the scan.
    await models.init();
    // If the embedder changed, purge the stale-embedder vectors first; init()
    // then re-extracts and re-embeds every file from scratch. Persist the
    // current id only after we've committed to (re)building against it.
    if (embedderChanged) await ingestion.purgeIndex();
    repos.settings.set('embedder-id', embedder.id);
    ingestion.init();
    retention.start(); // one scheduler for documents + chats + audit (D57/D58)
    // First-run demo corpus (non-blocking; indexes in the background).
    void loadDemoCorpus({ repos, ingestion, logger });
    return ready;
  }

  private listen(server: Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    this.logger?.info('engine stopping');
    this.serverMode?.stop();
    this.retention?.stop();
    await this.ingestion?.shutdown();
    await this.models?.shutdown();
    await this.vectors?.close();
    this.db?.close();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    this.ingestion = null;
    this.models = null;
    this.retention = null;
    this.serverMode = null;
    this.vectors = null;
    this.db = null;
  }
}
