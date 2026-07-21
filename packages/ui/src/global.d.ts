/**
 * Ambient typing for the preload bridge. Mirrors the surface exposed by
 * packages/desktop/src/preload.ts. The renderer imports nothing from the
 * desktop package (engine/UI separation) — it only knows this contract.
 */
export interface RendererConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly appVersion: string;
}

export interface QueryLoadBridge {
  getConnection(): Promise<RendererConnection>;
  onEngineChanged(listener: () => void): () => void;
  pickFolder(): Promise<string | null>;
  pickFile(): Promise<string | null>;
  openSource(filePath: string, page: number | null): Promise<boolean>;
  /** Resolve a dragged-in File's absolute path (Electron webUtils; File.path was removed in v32). */
  getDroppedFilePath(file: File): string;
}

declare global {
  interface Window {
    readonly queryload: QueryLoadBridge;
  }
}

export {};
