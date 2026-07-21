import type { IncomingMessage, ServerResponse } from 'node:http';
import { IngestionRoutes, ApiRoutes, ModelRoutes } from '@queryload/shared';
import type { AddPathRequest, AddPathResponse } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import { sendOk, sendError } from './respond.js';
import { readJsonBody } from './body.js';
import { handleEngineInfo, type EngineInfoContext } from './routes/engine-info.js';
import type { IngestionManager } from '../ingestion/ingestion-manager.js';
import { PathOverlapError, PathNotFoundError } from '../ingestion/ingestion-manager.js';
import type { ModelManager } from '../models/model-manager.js';
import type { Repositories } from '../db/repos.js';
import type { QueryService } from '../rag/query-service.js';
import type { AuthService } from '../auth/auth-service.js';
import type { AuditService } from '../audit/audit-service.js';
import type { RetentionService } from '../retention/retention-service.js';
import { dispatchChat } from './chat-routes.js';
import { dispatchGovernance } from './governance-routes.js';
import { dispatchAdmin } from './admin-routes.js';
import { resolveActor } from './actor.js';
import type { ServerModeManager } from './server-mode.js';

/** Everything a data route needs. Passed by the engine; server stays thin. */
export interface RouteContext {
  readonly logger: Logger;
  readonly engineInfo: () => EngineInfoContext;
  readonly ingestion: IngestionManager;
  readonly models: ModelManager;
  readonly repos: Repositories;
  readonly query: QueryService;
  readonly auth: AuthService;
  readonly audit: AuditService;
  readonly retention: RetentionService;
  readonly serverMode: ServerModeManager;
  readonly configFile: string;
  readonly logsDir: string;
}

/**
 * Dispatches the authenticated `/v1` data routes. Returns true if it handled the
 * request. Kept explicit and framework-free so the full authorized surface is
 * auditable at a glance (no dynamic route magic).
 */
export async function dispatchApi(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;

  // Per-request identity + authorization. In SERVER (LAN) mode, managing the
  // index/models and reading global indexing status is admin-only, and the
  // workspace list is scoped to the caller's memberships — otherwise any
  // authenticated member could enumerate confidential workspace names, read the
  // server's file paths, or index an arbitrary server directory to exfiltrate
  // files, all straight through the ethical wall (H4/H5). In DESKTOP mode there
  // is a single local admin, so every check below is a no-op.
  const serverMode = ctx.engineInfo().bind === 'lan';
  const actor = resolveActor(req, ctx.auth, serverMode);
  const mayManage = !serverMode || (!actor.anonymous && actor.role === 'admin');
  const denyManage = (): boolean => {
    sendError(
      res,
      actor.anonymous ? 'unauthorized' : 'forbidden',
      'Administrator access is required to manage indexing and models.',
    );
    return true;
  };

  if (method === 'GET' && path === ApiRoutes.engineInfo) {
    handleEngineInfo(res, ctx.engineInfo());
    return true;
  }

  if (method === 'GET' && path === IngestionRoutes.workspaces) {
    const all = ctx.ingestion.listWorkspaces();
    const scoped = serverMode
      ? all.filter((w) => ctx.repos.memberships.isMember(actor.userId, w.id))
      : all;
    sendOk(res, scoped);
    return true;
  }

  if (method === 'GET' && path === IngestionRoutes.ingestionStatus) {
    if (!mayManage) return denyManage();
    sendOk(res, ctx.ingestion.getStatus());
    return true;
  }

  if (method === 'GET' && path === IngestionRoutes.paths) {
    if (!mayManage) return denyManage();
    sendOk(res, ctx.ingestion.getStatus().paths);
    return true;
  }

  if (method === 'POST' && path === IngestionRoutes.paths) {
    if (!mayManage) return denyManage();
    await addPath(req, res, ctx);
    return true;
  }

  // DELETE /v1/paths/:id
  if (method === 'DELETE' && path.startsWith(`${IngestionRoutes.paths}/`)) {
    if (!mayManage) return denyManage();
    const id = decodeURIComponent(path.slice(IngestionRoutes.paths.length + 1));
    await ctx.ingestion.removePath(id);
    sendOk(res, { removed: true });
    return true;
  }

  if (method === 'POST' && path === ModelRoutes.estimate) {
    if (!mayManage) return denyManage();
    await estimate(req, res, ctx);
    return true;
  }

  if (method === 'GET' && path === ModelRoutes.models) {
    sendOk(res, await ctx.models.listModels());
    return true;
  }

  if (method === 'GET' && path === ModelRoutes.hardware) {
    sendOk(res, await ctx.models.hardwareProfile());
    return true;
  }

  if (method === 'GET' && path === ModelRoutes.inferenceStatus) {
    sendOk(res, ctx.models.inferenceStatus());
    return true;
  }

  // Parameterized model routes: /v1/models/:id/{download|activate}
  if (path.startsWith(`${ModelRoutes.models}/`)) {
    const rest = path.slice(ModelRoutes.models.length + 1).split('/');
    const id = decodeURIComponent(rest[0] ?? '');
    const action = rest[1];
    if (action === 'download' && method === 'POST') {
      if (!mayManage) return denyManage();
      sendOk(res, ctx.models.startDownload(id), 202);
      return true;
    }
    // DELETE /v1/models/:id/download — stop an in-flight download. The partial
    // file is kept, so a later download resumes rather than restarting.
    if (action === 'download' && method === 'DELETE') {
      if (!mayManage) return denyManage();
      ctx.models.cancelDownload(id);
      sendOk(res, { cancelled: true });
      return true;
    }
    if (action === 'download' && method === 'GET') {
      if (!mayManage) return denyManage();
      sendOk(res, ctx.models.downloadStatus(id));
      return true;
    }
    if (action === 'activate' && method === 'POST') {
      if (!mayManage) return denyManage();
      try {
        await ctx.models.activate(id);
        sendOk(res, { activated: true });
      } catch (err) {
        sendError(res, 'bad_request', err instanceof Error ? err.message : 'Could not activate.');
      }
      return true;
    }
    // DELETE /v1/models/:id — remove the weights (no action segment).
    if (action === undefined && method === 'DELETE') {
      if (!mayManage) return denyManage();
      try {
        await ctx.models.deleteModel(id);
        sendOk(res, { removed: true });
      } catch (err) {
        sendError(res, 'bad_request', err instanceof Error ? err.message : 'Could not remove.');
      }
      return true;
    }
  }

  // Chat + RAG routes (delegated).
  if (
    await dispatchChat(method, url, req, res, {
      repos: ctx.repos,
      query: ctx.query,
      auth: ctx.auth,
      serverMode,
    })
  ) {
    return true;
  }

  // Governance routes (accounts, audit, retention, engine-API, updates, diagnostics).
  if (
    await dispatchGovernance(method, url, req, res, {
      repos: ctx.repos,
      auth: ctx.auth,
      audit: ctx.audit,
      retention: ctx.retention,
      ingestion: ctx.ingestion,
      models: ctx.models,
      configFile: ctx.configFile,
      logsDir: ctx.logsDir,
      serverMode,
    })
  ) {
    return true;
  }

  // Admin console + server mode + device-join.
  if (
    await dispatchAdmin(method, url, req, res, {
      repos: ctx.repos,
      auth: ctx.auth,
      audit: ctx.audit,
      serverMode: ctx.serverMode,
      serverModeFlag: serverMode,
    })
  ) {
    return true;
  }

  return false;
}

async function estimate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 'bad_request', err instanceof Error ? err.message : 'invalid body');
    return;
  }
  const request = body as { path?: string } | undefined;
  if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
    sendError(res, 'bad_request', 'A folder path is required.');
    return;
  }
  sendOk(res, await ctx.ingestion.estimate(request.path.trim()));
}

async function addPath(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 'bad_request', err instanceof Error ? err.message : 'invalid body');
    return;
  }
  const request = body as AddPathRequest | undefined;
  if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
    sendError(res, 'bad_request', 'A folder path is required.');
    return;
  }

  try {
    const status = await ctx.ingestion.addPath(request.path.trim(), request.workspaceId);
    const response: AddPathResponse = { path: status };
    sendOk(res, response, 201);
  } catch (err) {
    if (err instanceof PathOverlapError) {
      const { relationship, conflictsWith } = err.conflict;
      const detail =
        relationship === 'identical'
          ? 'this folder is already indexed'
          : relationship === 'nested-inside'
            ? `it is inside an already-indexed folder: ${conflictsWith}`
            : `it contains an already-indexed folder: ${conflictsWith}`;
      sendError(res, 'conflict', `QueryLoad won't index this folder because ${detail}.`);
      return;
    }
    if (err instanceof PathNotFoundError) {
      sendError(res, 'bad_request', err.message);
      return;
    }
    ctx.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'addPath failed');
    sendError(res, 'internal', 'Could not add the folder.');
  }
}
