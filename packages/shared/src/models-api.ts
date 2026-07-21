/**
 * Phase 2 API contract — model catalog, hardware check, downloads, inference.
 */

/** Hardware tier, informational (drives the "which machine" filter in the wizard). */
export type ModelTier =
  | 'floor'
  | 'everyday-laptop'
  | 'sweet-spot'
  | 'small-server'
  | 'office-server';

/** A curated catalog entry (D37). The catalog is data, not code. */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tier: ModelTier;
  readonly quant: string; // e.g. Q4_K_M
  readonly sizeBytes: number; // on-disk size of the GGUF
  readonly minRamGB: number;
  readonly recommendedRamGB: number;
  readonly recommendedVramGB: number | null;
  readonly license: string;
  /**
   * Works the answer out step by step first. Slower; the scratchpad is stripped
   * before the answer is shown (see rag/thinking.ts). Shown as a chip so the
   * user knows why it is slower.
   */
  readonly reasoning?: boolean;
  /** One plain sentence: what this model is good for. */
  readonly notes?: string;
  /** Download source (user-initiated, first-run only). */
  readonly url: string;
  /** SHA-256 of the GGUF, or null until pinned at release (then verified). */
  readonly sha256: string | null;
  readonly contextLength: number;
}

export interface GpuInfo {
  readonly name: string;
  readonly vramGB: number | null;
}

/** Detected hardware profile (never transmitted; local diagnostics only). */
export interface HardwareProfile {
  readonly totalRamGB: number;
  readonly freeRamGB: number;
  readonly gpus: readonly GpuInfo[];
  /** Free disk on the volume holding the model store. */
  readonly freeDiskGB: number;
  readonly cpuThreads: number;
}

export type EligibilityStatus = 'ok' | 'warn' | 'blocked';

export interface ModelEligibility {
  readonly status: EligibilityStatus;
  /** Plain-language explanation for the UI (appliance surface). */
  readonly reason: string;
}

export type DownloadState = 'idle' | 'downloading' | 'verifying' | 'installed' | 'error';

export interface ModelDownloadStatus {
  readonly modelId: string;
  readonly state: DownloadState;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

/** A catalog entry enriched with this machine's eligibility + install/active state. */
export interface ModelInfo {
  readonly entry: ModelCatalogEntry;
  readonly eligibility: ModelEligibility;
  readonly installed: boolean;
  readonly active: boolean;
  readonly download: ModelDownloadStatus | null;
}

export interface ModelsResponse {
  readonly hardware: HardwareProfile;
  readonly models: readonly ModelInfo[];
  readonly activeModelId: string | null;
  /** True once the llama.cpp runtime binary is provisioned. */
  readonly runtimeReady: boolean;
}

/** Sample-based indexing-time estimate for a large archive (D40). */
export interface IndexingEstimate {
  readonly path: string;
  readonly fileCount: number;
  readonly estimatedSeconds: number;
  /** Human phrasing, e.g. "~40,000 documents: estimated 9 hours". */
  readonly summary: string;
}

/** Live inference runtime status: slots, active model, queue. */
export interface InferenceStatus {
  readonly runtimeReady: boolean;
  readonly activeModelId: string | null;
  readonly totalSlots: number;
  readonly busySlots: number;
  readonly queueDepth: number;
}

export const ModelRoutes = {
  models: '/v1/models',
  hardware: '/v1/hardware',
  download: (id: string): string => `/v1/models/${encodeURIComponent(id)}/download`,
  activate: (id: string): string => `/v1/models/${encodeURIComponent(id)}/activate`,
  /** DELETE — remove the weights and return the model to "not downloaded". */
  remove: (id: string): string => `/v1/models/${encodeURIComponent(id)}`,
  inferenceStatus: '/v1/inference/status',
  estimate: '/v1/ingestion/estimate',
} as const;
