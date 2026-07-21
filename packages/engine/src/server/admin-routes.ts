import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ServerRoutes,
  type CreateUserRequest,
  type DeviceSession,
  type RoleName,
  type SlotConfig,
  type Workspace,
  type WorkspaceAssignment,
} from '@queryload/shared';
import type { Repositories, SessionRow } from '../db/repos.js';
import { AuthError, type AuthService } from '../auth/auth-service.js';
import type { AuditService } from '../audit/audit-service.js';
import type { ServerModeManager } from './server-mode.js';
import { resolveActor } from './actor.js';
import { sendOk, sendError } from './respond.js';
import { readJsonBody } from './body.js';

export interface AdminRouteContext {
  readonly repos: Repositories;
  readonly auth: AuthService;
  readonly audit: AuditService;
  readonly serverMode: ServerModeManager;
  readonly serverModeFlag: boolean;
}

/**
 * Admin console (D25/D52–D55): users + roles, workspace assignment, device
 * sessions, parallel-slot config, and LAN server mode. Every route is
 * admin-only except `/v1/join`, the device-authorization bootstrap.
 */
export async function dispatchAdmin(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminRouteContext,
): Promise<boolean> {
  const path = url.pathname;

  // /v1/join — a device presents the join secret to be admitted (pre-login).
  if (method === 'POST' && path === ServerRoutes.join) {
    const body = (await readJsonBody(req)) as { secret?: string } | undefined;
    const ok = typeof body?.secret === 'string' && ctx.serverMode.validateJoin(body.secret);
    if (!ok) {
      sendError(res, 'forbidden', 'Invalid join code.');
      return true;
    }
    sendOk(res, { joined: true });
    return true;
  }

  if (!path.startsWith('/v1/admin/')) return false;

  const actor = resolveActor(req, ctx.auth, ctx.serverModeFlag);
  if (actor.anonymous || actor.role !== 'admin') {
    sendError(
      res,
      actor.anonymous ? 'unauthorized' : 'forbidden',
      'Administrator access required.',
    );
    return true;
  }

  // Users
  if (path === ServerRoutes.users) {
    if (method === 'GET') {
      sendOk(res, { users: ctx.repos.users.list().map((u) => ctx.auth.toAccount(u)) });
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as CreateUserRequest | undefined;
      if (!body || !body.username || !body.password || !isRole(body.role)) {
        sendError(res, 'bad_request', 'A username, password, and role are required.');
        return true;
      }
      try {
        const account = await ctx.auth.createUser(body.username, body.password, body.role);
        ctx.audit.record('user-created', actor.userId, `${body.username} (${body.role})`);
        sendOk(res, account, 201);
      } catch (err) {
        sendError(
          res,
          err instanceof AuthError && err.code === 'conflict' ? 'conflict' : 'bad_request',
          err instanceof Error ? err.message : 'Could not create the user.',
        );
      }
      return true;
    }
  }

  // Workspaces (create)
  if (method === 'POST' && path === ServerRoutes.createWorkspace) {
    const body = (await readJsonBody(req)) as
      | { name?: string; kind?: Workspace['kind'] }
      | undefined;
    if (!body?.name) {
      sendError(res, 'bad_request', 'A workspace name is required.');
      return true;
    }
    const id = `ws-${randomUUID()}`;
    ctx.repos.workspaces.create(id, body.name, body.kind ?? 'matter');
    ctx.audit.record('workspace-created', actor.userId, body.name);
    sendOk(res, { id, name: body.name, kind: body.kind ?? 'matter', createdAt: Date.now() }, 201);
    return true;
  }

  // Membership assignment (ethical-wall administration, D54)
  if (path === ServerRoutes.memberships) {
    const body = (await readJsonBody(req)) as WorkspaceAssignment | undefined;
    if (!body?.userId || !body.workspaceId) {
      sendError(res, 'bad_request', 'A user and workspace are required.');
      return true;
    }
    if (method === 'POST') {
      ctx.repos.memberships.add(body.userId, body.workspaceId);
      ctx.audit.record('membership-added', actor.userId, `${body.userId} -> ${body.workspaceId}`);
      sendOk(res, { assigned: true });
      return true;
    }
    if (method === 'DELETE') {
      ctx.repos.memberships.remove(body.userId, body.workspaceId);
      ctx.audit.record('membership-removed', actor.userId, `${body.userId} -> ${body.workspaceId}`);
      sendOk(res, { removed: true });
      return true;
    }
  }

  // Device sessions (list + revoke, D55)
  if (method === 'GET' && path === ServerRoutes.sessions) {
    sendOk(res, ctx.auth.listSessions().map(toDeviceSession));
    return true;
  }
  if (method === 'DELETE' && path === ServerRoutes.sessions) {
    const body = (await readJsonBody(req)) as { tokenHash?: string } | undefined;
    if (body?.tokenHash) {
      ctx.auth.revokeSession(body.tokenHash);
      ctx.audit.record('session-revoked', actor.userId);
    }
    sendOk(res, { revoked: true });
    return true;
  }

  // Parallel-slot config (D42)
  if (path === ServerRoutes.slots) {
    if (method === 'GET') {
      const slots = Number(ctx.repos.settings.get('inference-slots') ?? '0');
      sendOk(res, { slots } satisfies SlotConfig);
      return true;
    }
    if (method === 'PUT') {
      const body = (await readJsonBody(req)) as SlotConfig | undefined;
      if (!body || !Number.isInteger(body.slots) || body.slots < 1) {
        sendError(res, 'bad_request', 'Slots must be a positive integer.');
        return true;
      }
      ctx.repos.settings.set('inference-slots', String(body.slots));
      ctx.audit.record('slots-changed', actor.userId, String(body.slots));
      sendOk(res, { slots: body.slots } satisfies SlotConfig);
      return true;
    }
  }

  // Server mode (LAN)
  if (path === ServerRoutes.serverMode) {
    if (method === 'GET') {
      sendOk(res, ctx.serverMode.status());
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req)) as { enabled?: boolean } | undefined;
      const status = body?.enabled ? ctx.serverMode.enable() : ctx.serverMode.disable();
      ctx.audit.record('server-mode', actor.userId, body?.enabled ? 'enabled' : 'disabled');
      sendOk(res, status);
      return true;
    }
  }

  return false;
}

function toDeviceSession(r: SessionRow): DeviceSession {
  return {
    tokenHash: r.token_hash,
    userId: r.user_id,
    deviceName: r.device_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
  };
}

function isRole(r: unknown): r is RoleName {
  return r === 'admin' || r === 'member' || r === 'auditor';
}
