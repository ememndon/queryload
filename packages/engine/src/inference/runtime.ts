import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENGINE_LOOPBACK_HOST } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import { LlamaServerBackend, NotProvisionedBackend, type InferenceBackend } from './backend.js';

/**
 * Manages the hidden llama.cpp server sidecars (D18): one for the active chat
 * model, one for BGE-M3 embeddings. Both bind loopback and are never exposed to
 * the user ("no install Ollama first"). This class is provisioning-aware: until
 * the binary + a model GGUF are present, it reports not-ready and hands back a
 * NotProvisionedBackend.
 *
 * Model WEIGHTS are downloaded on demand into `%APPDATA%/QueryLoad/models`. The
 * RUNTIME BINARY is not downloaded at all — it ships inside the installer
 * (D18a), which is why the app can answer offline from first launch and why the
 * runtime performs no network call to obtain it.
 */
export class InferenceRuntime {
  private chatProc: ChildProcess | null = null;
  private chatBackend: InferenceBackend = new NotProvisionedBackend();
  private currentModelId: string | null = null;
  private currentContextLength = 0;
  private chatRestarts = 0;
  private stoppingChat = false;
  private chatRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private onBackendChange: ((backend: InferenceBackend) => void) | null = null;
  private embedProc: ChildProcess | null = null;
  private embedBaseUrl: string | null = null;

  constructor(
    private readonly modelsDir: string,
    private readonly slots: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Register a callback fired whenever the chat backend changes — activation,
   * a crash-reset to NotProvisioned, or a successful auto-restart. The
   * ModelManager wires this to `scheduler.setBackend` so the scheduler never
   * keeps dispatching to a dead sidecar (H2).
   */
  setOnBackendChange(cb: (backend: InferenceBackend) => void): void {
    this.onBackendChange = cb;
  }

  /**
   * Where the llama.cpp server binary lives, in priority order:
   *
   *   1. `resources/runtime` — the packaged app (electron-builder extraResources).
   *   2. `vendor/llama/<platform>-<arch>` — a dev checkout after `npm run fetch:runtime`.
   *   3. `<modelsDir>/runtime` — an operator-placed binary, kept as an escape
   *      hatch for air-gapped installs that stage the runtime by hand.
   *
   * Returns the first that exists; if none do, returns candidate 1 so error
   * messages and logs name the location the app actually expects.
   */
  get binaryPath(): string {
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const found = this.binaryCandidates().find((c) => existsSync(join(c, exe)));
    return join(found ?? this.binaryCandidates()[0]!, exe);
  }

  private binaryCandidates(): string[] {
    const out: string[] = [];
    // Added by Electron in a packaged app; not typed by @types/node.
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) out.push(join(resourcesPath, 'runtime'));
    const here = dirname(fileURLToPath(import.meta.url)); // dist/inference
    out.push(
      join(here, '..', '..', '..', '..', 'vendor', 'llama', `${process.platform}-${process.arch}`),
    );
    out.push(join(this.modelsDir, 'runtime'));
    return out;
  }
  modelPath(id: string): string {
    return join(this.modelsDir, `${id}.gguf`);
  }
  get embedderPath(): string {
    return join(this.modelsDir, 'bge-m3.gguf');
  }

  isRuntimeProvisioned(): boolean {
    return existsSync(this.binaryPath);
  }
  isModelInstalled(id: string): boolean {
    return existsSync(this.modelPath(id));
  }

  get backend(): InferenceBackend {
    return this.chatBackend;
  }
  get activeModelId(): string | null {
    return this.currentModelId;
  }

  /** (Re)start the chat sidecar with the given model and continuous batching. */
  async activateChatModel(id: string, contextLength: number): Promise<void> {
    if (!this.isRuntimeProvisioned())
      throw new Error('The local inference runtime is not installed yet.');
    if (!this.isModelInstalled(id)) throw new Error('That model is not installed yet.');
    await this.stopChat();
    this.currentContextLength = contextLength;
    this.chatRestarts = 0; // fresh manual activation resets the crash budget
    await this.spawnChat(id, contextLength);
  }

  /** Spawn the chat sidecar process and, once healthy, publish its backend. */
  private async spawnChat(id: string, contextLength: number): Promise<void> {
    const port = await freePort();
    const args = [
      '--model',
      this.modelPath(id),
      '--host',
      ENGINE_LOOPBACK_HOST,
      '--port',
      String(port),
      '--parallel',
      String(this.slots), // parallel slots
      '--cont-batching', // continuous batching (D42)
      '--ctx-size',
      String(contextLength * this.slots),
      // Current llama.cpp requires a value here; passing it bare is an argument
      // error that kills the server before it ever binds. 'auto' enables Flash
      // Attention where the build and hardware support it.
      '--flash-attn',
      'auto',
    ];
    const proc = spawn(this.binaryPath, args, { env: { ...process.env }, windowsHide: true });
    this.chatProc = proc;
    proc.on('exit', (code) => this.handleChatExit(proc, code));

    // Keep the sidecar's own diagnostics. Without this a bad argument or a
    // corrupt GGUF surfaces only as "did not become ready in time", which says
    // nothing about the cause.
    const startupLog: string[] = [];
    const capture = (buf: Buffer): void => {
      const line = buf.toString().trim();
      if (line.length === 0) return;
      if (startupLog.length < 40) startupLog.push(line);
      this.logger.debug({ sidecar: id }, line);
    };
    proc.stderr?.on('data', capture);
    proc.stdout?.on('data', capture);

    const baseUrl = `http://${ENGINE_LOOPBACK_HOST}:${port}`;
    try {
      await waitForHealth(baseUrl);
    } catch {
      const detail = startupLog.slice(-8).join(' | ');
      this.logger.error({ id, detail }, 'chat sidecar failed to start');
      throw new Error(
        detail
          ? `The model could not be started. The inference runtime reported: ${detail}`
          : 'The model could not be started.',
      );
    }
    this.chatBackend = new LlamaServerBackend(baseUrl);
    this.currentModelId = id;
    this.onBackendChange?.(this.chatBackend);
    this.logger.info({ id, port, slots: this.slots }, 'chat model active');
  }

  /**
   * Handle an unexpected sidecar exit (OOM, crash, killed). Ignored for a
   * superseded process or an intentional stop. Otherwise resets the backend to
   * NotProvisioned (so the scheduler stops dispatching to the dead port) and
   * attempts a bounded auto-restart with backoff (H2). Without this, a crash
   * left `available` true and every subsequent query failed silently.
   */
  private handleChatExit(proc: ChildProcess, code: number | null): void {
    if (proc !== this.chatProc || this.stoppingChat) return;
    this.logger.warn({ code }, 'chat sidecar exited unexpectedly');
    const modelId = this.currentModelId;
    const contextLength = this.currentContextLength;
    this.chatProc = null;
    this.chatBackend = new NotProvisionedBackend();
    this.currentModelId = null;
    this.onBackendChange?.(this.chatBackend);
    if (!modelId) return;
    this.chatRestarts += 1;
    if (this.chatRestarts > 5) {
      this.logger.error('chat sidecar crash-looping — giving up auto-restart');
      return;
    }
    const delay = Math.min(500 * this.chatRestarts, 5000);
    this.chatRestartTimer = setTimeout(() => {
      this.chatRestartTimer = null;
      if (this.stoppingChat) return;
      void this.spawnChat(modelId, contextLength).catch((err: unknown) =>
        this.logger.error({ err: String(err) }, 'chat sidecar auto-restart failed'),
      );
    }, delay);
  }

  /** Ensure the BGE-M3 embedding sidecar is up; returns its base URL or null. */
  async ensureEmbedServer(): Promise<string | null> {
    if (this.embedBaseUrl) return this.embedBaseUrl;
    if (!this.isRuntimeProvisioned() || !existsSync(this.embedderPath)) return null;
    const port = await freePort();
    const args = [
      '--model',
      this.embedderPath,
      '--host',
      ENGINE_LOOPBACK_HOST,
      '--port',
      String(port),
      '--embedding',
      '--pooling',
      'cls',
      '--ctx-size',
      '8192',
    ];
    this.embedProc = spawn(this.binaryPath, args, { env: { ...process.env }, windowsHide: true });
    this.embedProc.on('exit', (code) => {
      this.logger.warn({ code }, 'embed sidecar exited');
      this.embedBaseUrl = null;
    });
    const baseUrl = `http://${ENGINE_LOOPBACK_HOST}:${port}`;
    await waitForHealth(baseUrl);
    this.embedBaseUrl = baseUrl;
    this.logger.info({ port }, 'embedding sidecar active');
    return baseUrl;
  }

  /**
   * Stop the running chat model and report not-ready. Used when the active
   * model's weights are removed — without this the sidecar would keep serving
   * from a file that no longer exists.
   */
  async deactivateChat(): Promise<void> {
    await this.stopChat();
    this.onBackendChange?.(this.chatBackend);
  }

  private async stopChat(): Promise<void> {
    // Cancel any pending crash auto-restart so it can't respawn after a
    // deliberate stop (model switch or shutdown).
    if (this.chatRestartTimer) {
      clearTimeout(this.chatRestartTimer);
      this.chatRestartTimer = null;
    }
    if (!this.chatProc) {
      this.chatBackend = new NotProvisionedBackend();
      this.currentModelId = null;
      return;
    }
    this.stoppingChat = true;
    const proc = this.chatProc;
    this.chatProc = null;
    this.chatBackend = new NotProvisionedBackend();
    this.currentModelId = null;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    });
    this.stoppingChat = false;
  }

  async stop(): Promise<void> {
    await this.stopChat();
    this.embedProc?.kill();
    this.embedProc = null;
    this.embedBaseUrl = null;
  }
}

/** Ask the OS for a free ephemeral loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, ENGINE_LOOPBACK_HOST, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll a llama.cpp server's /health until ready (or time out). */
async function waitForHealth(baseUrl: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Inference server did not become ready in time.');
}
