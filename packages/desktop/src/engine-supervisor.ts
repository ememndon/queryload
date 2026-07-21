import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { EngineReady } from '@queryload/shared';

/**
 * Mirror of ENGINE_READY_MARKER from @queryload/shared. Duplicated as a literal
 * so the desktop package (CommonJS) imports no runtime value from the ESM-only
 * shared package — it stays a pure client that speaks only the API contract.
 */
const ENGINE_READY_MARKER = 'QUERYLOAD_ENGINE_READY';

export interface SupervisorOptions {
  /** Absolute path to the engine entry (dist/index.js). */
  readonly engineEntry: string;
  /** The binary to run it with (Electron-as-node via ELECTRON_RUN_AS_NODE). */
  readonly nodeBinary: string;
  /** Override the engine's app-data root (dev uses a repo-local folder). */
  readonly dataDir?: string;
  readonly log: (line: string) => void;
}

/**
 * Owns the engine child process: launches it, parses its ready handshake, and
 * restarts it with backoff if it dies. The engine and the supervisor share no
 * code — only the stdout ready line and the API contract.
 */
export class EngineSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private current: EngineReady | null = null;
  private stopping = false;
  private restarts = 0;
  /** True once the FIRST engine process has reported ready. Tracked at class
   * level (not per-spawn) so restarts emit `engine-changed` instead of silently
   * resolving an orphan promise — the renderer must rebind to the new port/token. */
  private started = false;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  /** Launch the engine and resolve once it reports ready. */
  start(): Promise<EngineReady> {
    return this.spawnOnce();
  }

  get connection(): EngineReady | null {
    return this.current;
  }

  private spawnOnce(): Promise<EngineReady> {
    return new Promise<EngineReady>((resolve, reject) => {
      const args = [this.options.engineEntry, '--mode', 'desktop'];
      if (this.options.dataDir) args.push('--data-dir', this.options.dataDir);

      const child = spawn(this.options.nodeBinary, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      let settled = false;

      const stdout = createInterface({ input: child.stdout });
      stdout.on('line', (line) => {
        if (line.startsWith(ENGINE_READY_MARKER)) {
          try {
            const json = line.slice(ENGINE_READY_MARKER.length).trim();
            const ready = JSON.parse(json) as EngineReady;
            this.current = ready;
            this.restarts = 0;
            if (!this.started) {
              // First-ever ready line: resolve the start() promise.
              this.started = true;
              settled = true;
              resolve(ready);
            } else {
              // A restart produced a new descriptor (new ephemeral port + session
              // token) — notify the renderer so it rebinds. `settled` stays false
              // for this restart promise, which is fired-and-forgotten by design.
              this.emit('engine-changed', ready);
            }
          } catch (err) {
            this.options.log(`supervisor: bad ready line: ${String(err)}`);
          }
        } else {
          this.options.log(`[engine] ${line}`);
        }
      });

      const stderr = createInterface({ input: child.stderr });
      stderr.on('line', (line) => this.options.log(`[engine:err] ${line}`));

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on('exit', (code, signal) => {
        this.options.log(
          `supervisor: engine exited (code=${String(code)}, signal=${String(signal)})`,
        );
        this.child = null;
        this.current = null;
        if (this.stopping) return;
        // Unexpected death — restart with capped backoff so a crash-loop can't
        // spin the CPU. Data on disk is untouched; the index survives restarts.
        this.restarts += 1;
        if (this.restarts > 20) {
          this.options.log('supervisor: too many restarts, giving up');
          this.emit('engine-failed');
          return;
        }
        const delay = Math.min(200 * this.restarts, 5000);
        setTimeout(() => {
          if (this.stopping) return;
          void this.spawnOnce().catch((err: unknown) =>
            this.options.log(`supervisor: restart failed: ${String(err)}`),
          );
        }, delay);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      // Hard stop if it ignores SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 3000);
    });
    this.child = null;
  }
}
