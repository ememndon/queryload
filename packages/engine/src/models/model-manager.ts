import { rm } from 'node:fs/promises';
import type {
  InferenceStatus,
  ModelDownloadStatus,
  ModelInfo,
  ModelsResponse,
} from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import type { Repositories } from '../db/repos.js';
import { listCatalog, findCatalogEntry, embedderSpec } from './catalog.js';
import { HardwareProbe } from './hardware.js';
import { evaluateEligibility } from './eligibility.js';
import { ModelDownloader } from './download.js';
import { InferenceRuntime } from '../inference/runtime.js';
import { InferenceScheduler } from '../inference/scheduler.js';

const ACTIVE_MODEL_KEY = 'active-model-id';

interface ActiveDownload {
  status: ModelDownloadStatus;
  abort: AbortController;
  /** Set when the user cancelled, so the abort is not reported as a failure. */
  cancelled?: boolean;
}

/**
 * Orchestrates the model lifecycle (Phase 2): catalog + hardware eligibility,
 * downloads (resumable, hash-verified, user-initiated), activation of the chat
 * sidecar, and the inference scheduler that fronts it. One active model
 * system-wide (D41); switching is an admin action that unloads/reloads cleanly.
 */
export class ModelManager {
  private readonly hardware: HardwareProbe;
  private readonly downloader = new ModelDownloader();
  private readonly downloads = new Map<string, ActiveDownload>();
  readonly runtime: InferenceRuntime;
  readonly scheduler: InferenceScheduler;

  constructor(
    private readonly repos: Repositories,
    modelsDir: string,
    private readonly logger: Logger,
    slots: number,
  ) {
    this.hardware = new HardwareProbe(modelsDir, logger);
    this.runtime = new InferenceRuntime(modelsDir, slots, logger);
    this.scheduler = new InferenceScheduler(this.runtime.backend, slots);
    // Keep the scheduler bound to the live backend across crash-resets and
    // auto-restarts, not just explicit activations (H2).
    this.runtime.setOnBackendChange((backend) => this.scheduler.setBackend(backend));
  }

  /** Re-activate a previously chosen model on boot, if it is still installed. */
  async init(): Promise<void> {
    const id = this.repos.settings.get(ACTIVE_MODEL_KEY);
    if (id && this.runtime.isRuntimeProvisioned() && this.runtime.isModelInstalled(id)) {
      const entry = findCatalogEntry(id);
      if (entry) {
        try {
          await this.runtime.activateChatModel(id, entry.contextLength);
          this.scheduler.setBackend(this.runtime.backend);
        } catch (err) {
          this.logger.warn({ id, err: describe(err) }, 'could not reactivate model on boot');
        }
      }
    }
  }

  hardwareProfile(): ReturnType<HardwareProbe['profile']> {
    return this.hardware.profile();
  }

  async listModels(): Promise<ModelsResponse> {
    const hardware = await this.hardware.profile();
    // `|| null` matters: the stored key is blanked (not deleted) when the active
    // model is removed, and '' must not be reported as an active model id.
    const activeModelId =
      this.runtime.activeModelId ?? (this.repos.settings.get(ACTIVE_MODEL_KEY) || null);
    const models: ModelInfo[] = listCatalog().map((entry) => ({
      entry,
      eligibility: evaluateEligibility(entry, hardware),
      installed: this.runtime.isModelInstalled(entry.id),
      active: entry.id === activeModelId,
      download: this.downloads.get(entry.id)?.status ?? null,
    }));
    return {
      hardware,
      models,
      activeModelId: activeModelId ?? null,
      runtimeReady: this.runtime.isRuntimeProvisioned(),
    };
  }

  /** Begin (or resume) a download. Returns immediately; progress via status. */
  startDownload(modelId: string): ModelDownloadStatus {
    const entry = modelId === 'bge-m3' ? asEntry(embedderSpec()) : findCatalogEntry(modelId);
    if (!entry) throw new Error('Unknown model.');
    const existing = this.downloads.get(modelId);
    if (existing && existing.status.state === 'downloading') return existing.status;

    const abort = new AbortController();
    const status: ModelDownloadStatus = {
      modelId,
      state: 'downloading',
      receivedBytes: 0,
      totalBytes: entry.sizeBytes,
      error: null,
    };
    const record: ActiveDownload = { status, abort };
    this.downloads.set(modelId, record);

    void this.downloader
      .download({
        url: entry.url,
        dest: this.runtime.modelPath(modelId),
        expectedSha256: entry.sha256,
        expectedSize: entry.sizeBytes,
        signal: abort.signal,
        onProgress: (received, total) => {
          record.status = { ...record.status, receivedBytes: received, totalBytes: total };
          this.downloads.set(modelId, record);
        },
      })
      .then(() => {
        record.status = { ...record.status, state: 'installed' };
        this.downloads.set(modelId, record);
        this.logger.info({ modelId }, 'model download complete');
      })
      .catch((err: unknown) => {
        if (record.cancelled) {
          // A cancel the user asked for is not a failure. Return to idle so the
          // row offers Download again; the .part file is deliberately kept so
          // pressing Download resumes instead of starting over.
          record.status = { ...record.status, state: 'idle', error: null };
          this.downloads.set(modelId, record);
          this.logger.info({ modelId }, 'model download cancelled by the user');
          return;
        }
        record.status = { ...record.status, state: 'error', error: describe(err) };
        this.downloads.set(modelId, record);
        this.logger.warn({ modelId, err: describe(err) }, 'model download failed');
      });

    return status;
  }

  /** Stop an in-flight download. The partial file is kept so it can resume. */
  cancelDownload(modelId: string): void {
    const record = this.downloads.get(modelId);
    if (!record) return;
    record.cancelled = true;
    record.abort.abort();
  }

  downloadStatus(modelId: string): ModelDownloadStatus | null {
    return this.downloads.get(modelId)?.status ?? null;
  }

  /** Activate a model as the single system-wide model (D41). */
  async activate(modelId: string): Promise<void> {
    const entry = findCatalogEntry(modelId);
    if (!entry) throw new Error('Unknown model.');
    await this.runtime.activateChatModel(modelId, entry.contextLength);
    this.scheduler.setBackend(this.runtime.backend);
    this.repos.settings.set(ACTIVE_MODEL_KEY, modelId);
    this.logger.info({ modelId }, 'model activated');
  }

  /**
   * Remove a model's weights and return it to the "not downloaded" state.
   *
   * Removing the model that is currently running is allowed — refusing would
   * strand a user whose only installed model is the one they want gone. The
   * sidecar is stopped first, and the stored choice cleared, so the model does
   * not come back as active on the next listing or on the next boot.
   */
  async deleteModel(modelId: string): Promise<void> {
    // Cancel an in-flight download first, or it would keep writing the file we
    // are about to remove.
    this.cancelDownload(modelId);

    if (this.runtime.activeModelId === modelId) {
      await this.runtime.deactivateChat();
      this.scheduler.setBackend(this.runtime.backend);
    }
    if (this.repos.settings.get(ACTIVE_MODEL_KEY) === modelId) {
      this.repos.settings.set(ACTIVE_MODEL_KEY, '');
    }

    const path = this.runtime.modelPath(modelId);
    await rm(path, { force: true });
    // Also drop a half-finished download, so "remove" reclaims the disk space
    // and a later re-download starts clean rather than resuming a stale part.
    await rm(`${path}.part`, { force: true });
    this.downloads.delete(modelId);
    this.logger.info({ modelId }, 'model removed');
  }

  inferenceStatus(): InferenceStatus {
    return {
      runtimeReady: this.runtime.isRuntimeProvisioned(),
      activeModelId: this.runtime.activeModelId,
      totalSlots: this.scheduler.totalSlots,
      busySlots: this.scheduler.busySlots,
      queueDepth: this.scheduler.queueDepth,
    };
  }

  async shutdown(): Promise<void> {
    for (const d of this.downloads.values()) d.abort.abort();
    await this.runtime.stop();
  }
}

/** Adapt the embedder spec to the catalog-entry shape for downloads. */
function asEntry(spec: ReturnType<typeof embedderSpec>): {
  id: string;
  url: string;
  sha256: string | null;
  sizeBytes: number;
} {
  return { id: spec.id, url: spec.url, sha256: spec.sha256, sizeBytes: spec.sizeBytes };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Recommend a parallel-slot count from hardware (auto; admin override later). */
export function recommendedSlots(cpuThreads: number, hasGpu: boolean): number {
  if (hasGpu) return Math.max(2, Math.min(8, Math.floor(cpuThreads / 2)));
  return Math.max(1, Math.min(4, Math.floor(cpuThreads / 4)));
}
