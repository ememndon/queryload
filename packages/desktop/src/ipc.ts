/**
 * IPC channel names shared between the Electron main and the preload bridge.
 * Both run in CommonJS, so this is a plain local module (the desktop package
 * imports no runtime values from @queryload/shared — only erased types — to
 * keep engine/UI separation clean across the ESM/CJS boundary).
 */
export const IPC = {
  /** Renderer -> main: fetch the current engine connection descriptor. */
  getConnection: 'queryload:get-connection',
  /** Main -> renderer: the engine restarted; refetch the connection. */
  engineChanged: 'queryload:engine-changed',
  /** Renderer -> main: open the native folder picker (Browse fallback, D27). */
  pickFolder: 'queryload:pick-folder',
  /** Renderer -> main: open the native file picker to attach a single document. */
  pickFile: 'queryload:pick-file',
  /** Renderer -> main: open a cited source document at a page (click-to-open). */
  openSource: 'queryload:open-source',
} as const;

/** What the renderer receives to talk to the engine (never the private key). */
export interface RendererConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly appVersion: string;
}
