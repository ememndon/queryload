import type { ServerResponse } from 'node:http';
import { APP_NAME } from '@queryload/shared';
import type { EngineInfoResponse, EngineMode } from '@queryload/shared';
import { sendOk } from '../respond.js';

export interface EngineInfoContext {
  readonly version: string;
  readonly mode: EngineMode;
  readonly startedAt: number;
  readonly bind: 'loopback' | 'lan';
  readonly engineApiEnabled: boolean;
}

/**
 * Authenticated engine introspection. Powers the shell's status area and the
 * diagnostic bundle. Reports the network posture so the UI can render the
 * "all local" state honestly.
 */
export function handleEngineInfo(res: ServerResponse, ctx: EngineInfoContext): void {
  const body: EngineInfoResponse = {
    appName: APP_NAME,
    version: ctx.version,
    mode: ctx.mode,
    startedAt: ctx.startedAt,
    network: {
      bind: ctx.bind,
      engineApiEnabled: ctx.engineApiEnabled,
    },
  };
  sendOk(res, body);
}
