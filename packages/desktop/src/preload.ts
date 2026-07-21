import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { RendererConnection } from './ipc.js';

/**
 * The preload bridge — the ENTIRE surface the renderer may touch (D45,
 * non-negotiable rule #2). Everything is funnelled through `window.queryload`;
 * the renderer has no Node, no `require`, no direct IPC. Adding a capability
 * here is a deliberate, reviewable act.
 *
 * A SANDBOXED preload cannot require relative modules, so the IPC channel names
 * are inlined here (they must match ./ipc.ts). The only runtime import is
 * `electron`, which sandboxed preloads are permitted to use.
 */
const CH = {
  getConnection: 'queryload:get-connection',
  engineChanged: 'queryload:engine-changed',
  pickFolder: 'queryload:pick-folder',
  pickFile: 'queryload:pick-file',
  openSource: 'queryload:open-source',
} as const;

const api = {
  /** Fetch the current engine connection descriptor (base URL + session token). */
  getConnection(): Promise<RendererConnection> {
    return ipcRenderer.invoke(CH.getConnection) as Promise<RendererConnection>;
  },

  /**
   * Subscribe to engine-restart notifications. Returns an unsubscribe fn.
   * The renderer should refetch the connection when this fires.
   */
  onEngineChanged(listener: () => void): () => void {
    const handler = (): void => listener();
    ipcRenderer.on(CH.engineChanged, handler);
    return () => ipcRenderer.removeListener(CH.engineChanged, handler);
  },

  /** Open the native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke(CH.pickFolder) as Promise<string | null>;
  },

  /** Open the native file picker to attach one document; path or null. */
  pickFile(): Promise<string | null> {
    return ipcRenderer.invoke(CH.pickFile) as Promise<string | null>;
  },

  /** Open a source document at a page (PDF) or in its default app (otherwise). */
  openSource(filePath: string, page: number | null): Promise<boolean> {
    return ipcRenderer.invoke(CH.openSource, { filePath, page }) as Promise<boolean>;
  },

  /**
   * Resolve the absolute filesystem path of a dragged-in File. Electron removed
   * `File.path` in v32; `webUtils.getPathForFile` is the supported replacement
   * and runs here in the preload (it has no equivalent in the sandboxed renderer).
   */
  getDroppedFilePath(file: File): string {
    return webUtils.getPathForFile(file);
  },
} as const;

export type QueryLoadApi = typeof api;

contextBridge.exposeInMainWorld('queryload', api);
