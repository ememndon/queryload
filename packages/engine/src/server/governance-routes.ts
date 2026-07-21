import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GovernanceRoutes,
  type EngineApiStatus,
  type LoginRequest,
  type RetentionPolicy,
  type RetentionScope,
  type RoleName,
  type UpdateCheckResult,
} from '@queryload/shared';
import type { Repositories } from '../db/repos.js';
import { AuthError, type AuthService } from '../auth/auth-service.js';
import type { AuditService } from '../audit/audit-service.js';
import type { RetentionService } from '../retention/retention-service.js';
import type { IngestionManager } from '../ingestion/ingestion-manager.js';
import type { ModelManager } from '../models/model-manager.js';
import { buildDiagnosticBundle } from '../diagnostics/diagnostic-bundle.js';
import { ENGINE_VERSION } from '../version.js';
import { resolveActor, type Actor } from './actor.js';
import { sendOk, sendError } from './respond.js';
import { readJsonBody } from './body.js';

const ENGINE_API_ENABLED_KEY = 'engine-api-enabled';

export interface GovernanceContext {
  readonly repos: Repositories;
  readonly auth: AuthService;
  readonly audit: AuditService;
  readonly retention: RetentionService;
  readonly ingestion: IngestionManager;
  readonly models: ModelManager;
  readonly configFile: string;
  readonly logsDir: string;
  readonly serverMode: boolean;
}

/**
 * Governance routes (D48–D58). The acting user is resolved per request; role
 * checks enforce that a member can never reach admin or auditor surfaces —
 * across users in server mode, and for the local admin in desktop mode.
 */
export async function dispatchGovernance(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GovernanceContext,
): Promise<boolean> {
  const path = url.pathname;
  const actor = resolveActor(req, ctx.auth, ctx.serverMode);

  if (method === 'POST' && path === GovernanceRoutes.login) {
    await login(req, res, ctx);
    return true;
  }

  if (method === 'GET' && path === GovernanceRoutes.audit) {
    if (!allow(actor, ['admin', 'auditor'], res)) return true;
    sendOk(res, ctx.audit.list(200));
    return true;
  }

  if (method === 'GET' && path === GovernanceRoutes.auditExport) {
    if (!allow(actor, ['admin', 'auditor'], res)) return true;
    sendOk(res, { json: ctx.audit.exportJson() });
    return true;
  }

  if (path === GovernanceRoutes.retention) {
    if (!allow(actor, ['admin'], res)) return true;
    if (method === 'GET') {
      sendOk(res, ctx.retention.getPolicies());
      return true;
    }
    if (method === 'PUT') {
      const body = (await readJsonBody(req)) as RetentionPolicy | undefined;
      if (!body || !isScope(body.scope)) {
        sendError(res, 'bad_request', 'A retention scope and days are required.');
        return true;
      }
      ctx.retention.setPolicy(body.scope, body.days);
      ctx.audit.record('retention-changed', actor.userId, `${body.scope}=${String(body.days)}`);
      sendOk(res, ctx.retention.getPolicies());
      return true;
    }
  }

  if (path === GovernanceRoutes.engineApi) {
    if (!allow(actor, ['admin'], res)) return true;
    if (method === 'GET') {
      sendOk(res, engineApiStatus(ctx));
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as { enabled?: boolean } | undefined;
      ctx.repos.settings.set(ENGINE_API_ENABLED_KEY, body?.enabled ? '1' : '0');
      ctx.audit.record('engine-api-toggled', actor.userId, body?.enabled ? 'enabled' : 'disabled');
      sendOk(res, engineApiStatus(ctx));
      return true;
    }
  }

  if (method === 'POST' && path === GovernanceRoutes.rebuildIndex) {
    if (!allow(actor, ['admin'], res)) return true;
    void ctx.ingestion.rebuildAll();
    ctx.audit.record('index-rebuild', actor.userId);
    sendOk(res, { started: true });
    return true;
  }

  if (method === 'GET' && path === GovernanceRoutes.update) {
    if (!allow(actor, ['admin'], res)) return true;
    const result: UpdateCheckResult = {
      currentVersion: ENGINE_VERSION,
      available: false,
      latestVersion: null,
      note: 'Updates are manual and signature-verified. No update package is staged.',
    };
    sendOk(res, result);
    return true;
  }

  if (method === 'POST' && path === GovernanceRoutes.diagnosticBundle) {
    if (!allow(actor, ['admin'], res)) return true;
    const configJson = await readFile(ctx.configFile, 'utf8').catch(() => '{}');
    const hardware = await ctx.models.hardwareProfile();
    const bundle = await buildDiagnosticBundle({
      appVersion: ENGINE_VERSION,
      configJson,
      hardwareJson: JSON.stringify(hardware, null, 2),
      logsDir: ctx.logsDir,
    });
    ctx.audit.record('diagnostic-bundle', actor.userId);
    sendOk(res, { filename: 'queryload-diagnostics.zip', base64: bundle.toString('base64') });
    return true;
  }

  return false;
}

/**
 * Per-source sliding-window limiter for the public login endpoint. Login is
 * unauthenticated by necessity, so without this a LAN attacker could spam failed
 * attempts for a known username to trip its lockout and lock the real user out
 * (a DoS). Capping attempts per source IP bounds both brute-force and that DoS.
 * In-memory, per engine run.
 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginHits = new Map<string, number[]>();

function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const recent = (loginHits.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    loginHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginHits.set(ip, recent);
  return true;
}

async function login(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GovernanceContext,
): Promise<void> {
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!loginAllowed(ip)) {
    sendError(res, 'rate_limited', 'Too many sign-in attempts. Please wait a minute and try again.');
    return;
  }
  const body = (await readJsonBody(req)) as LoginRequest | undefined;
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    sendError(res, 'bad_request', 'Username and password are required.');
    return;
  }
  try {
    const result = await ctx.auth.login(body.username, body.password);
    ctx.audit.record('login', result.account.id);
    sendOk(res, result);
  } catch (err) {
    if (err instanceof AuthError) {
      sendError(res, err.code === 'locked' ? 'rate_limited' : 'unauthorized', err.message);
      return;
    }
    sendError(res, 'internal', 'Sign-in failed.');
  }
}

function allow(actor: Actor, roles: readonly RoleName[], res: ServerResponse): boolean {
  if (actor.anonymous) {
    sendError(res, 'unauthorized', 'Please sign in.');
    return false;
  }
  if (roles.includes(actor.role)) return true;
  sendError(res, 'forbidden', 'Your role does not have access to this.');
  return false;
}

function engineApiStatus(ctx: GovernanceContext): EngineApiStatus {
  return {
    enabled: ctx.repos.settings.get(ENGINE_API_ENABLED_KEY) === '1',
    tokenCount: 0,
  };
}

function isScope(s: unknown): s is RetentionScope {
  return s === 'documents' || s === 'chats' || s === 'audit';
}
