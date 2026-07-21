/**
 * Ambient declarations for dependencies that do not ship (resolvable) types.
 * Only the surface QueryLoad actually uses is declared, kept strict.
 */

declare module 'mammoth' {
  export interface MammothInput {
    path?: string;
    buffer?: Buffer;
  }
  export interface MammothMessage {
    type: string;
    message: string;
  }
  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
  const _default: {
    extractRawText: typeof extractRawText;
    convertToHtml: typeof convertToHtml;
  };
  export default _default;
}

declare module 'chokidar' {
  import type { EventEmitter } from 'node:events';
  export interface WatchOptions {
    persistent?: boolean;
    ignoreInitial?: boolean;
    awaitWriteFinish?: boolean | { stabilityThreshold?: number; pollInterval?: number };
    depth?: number;
    ignorePermissionErrors?: boolean;
    usePolling?: boolean;
    alwaysStat?: boolean;
  }
  export interface FSWatcher extends EventEmitter {
    add(paths: string | readonly string[]): FSWatcher;
    unwatch(paths: string | readonly string[]): Promise<void> | FSWatcher;
    close(): Promise<void>;
    getWatched(): Record<string, string[]>;
  }
  export function watch(paths: string | readonly string[], options?: WatchOptions): FSWatcher;
  const _default: { watch: typeof watch };
  export default _default;
}
