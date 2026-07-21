import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChatRoutes } from '@queryload/shared';
import type {
  ChatSummary,
  Citation,
  QueryRequest,
  ResolveFileResponse,
  StoredMessage,
} from '@queryload/shared';
import type { Repositories } from '../db/repos.js';
import type { QueryService } from '../rag/query-service.js';
import { ForbiddenWorkspaceError } from '../rag/retriever.js';
import { ChatAccessError } from '../rag/query-service.js';
import { listTasks } from '../rag/tasks.js';
import type { AuthService } from '../auth/auth-service.js';
import { resolveActor } from './actor.js';
import { sendOk, sendError } from './respond.js';
import { readJsonBody } from './body.js';
import { startSse } from './sse.js';

export interface ChatRouteContext {
  readonly repos: Repositories;
  readonly query: QueryService;
  readonly auth: AuthService;
  readonly serverMode: boolean;
}

/**
 * Chat + RAG routes. The acting user is resolved per request (server mode
 * requires a valid session; desktop uses the local identity). Every route
 * scopes to that user, so the ethical wall holds across users.
 */
export async function dispatchChat(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
): Promise<boolean> {
  const path = url.pathname;

  // Tasks are static, non-user data.
  if (method === 'GET' && path === ChatRoutes.tasks) {
    sendOk(res, listTasks());
    return true;
  }

  const actor = resolveActor(req, ctx.auth, ctx.serverMode);
  const userId = actor.userId;
  const isUserRoute =
    path === ChatRoutes.chats ||
    path.startsWith(`${ChatRoutes.chats}/`) ||
    path === ChatRoutes.query ||
    path === ChatRoutes.resolveFile;
  if (actor.anonymous && isUserRoute) {
    sendError(res, 'unauthorized', 'Please sign in.');
    return true;
  }

  // GET /v1/files/resolve?path=... — map a dropped file to its indexed id.
  if (method === 'GET' && path === ChatRoutes.resolveFile) {
    const filePath = url.searchParams.get('path') ?? '';
    const file = ctx.repos.files.getByPath(filePath);
    if (!file || !ctx.repos.memberships.isMember(userId, file.workspace_id)) {
      sendError(res, 'not_found', 'That file is not in the index.');
      return true;
    }
    const body: ResolveFileResponse = {
      fileId: file.id,
      fileName: file.path.split(/[\\/]/).pop() ?? file.path,
      workspaceId: file.workspace_id,
    };
    sendOk(res, body);
    return true;
  }

  if (method === 'GET' && path === ChatRoutes.chats) {
    const workspaceId = url.searchParams.get('workspaceId') ?? '';
    if (!ctx.repos.memberships.isMember(userId, workspaceId)) {
      sendError(res, 'forbidden', 'You do not have access to that workspace.');
      return true;
    }
    const chats: ChatSummary[] = ctx.repos.chats.listFor(userId, workspaceId).map((c) => ({
      id: c.id,
      workspaceId: c.workspace_id,
      title: c.title,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
    sendOk(res, chats);
    return true;
  }

  // GET /v1/chats/:id/messages
  if (method === 'GET' && path.startsWith(`${ChatRoutes.chats}/`) && path.endsWith('/messages')) {
    const id = decodeURIComponent(path.slice(ChatRoutes.chats.length + 1, -'/messages'.length));
    const chat = ctx.repos.chats.get(id);
    if (!chat || chat.user_id !== userId) {
      sendError(res, 'not_found', 'Conversation not found.');
      return true;
    }
    const messages: StoredMessage[] = ctx.repos.messages.listByChat(id).map((m) => ({
      id: m.id,
      chatId: m.chat_id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      citations: parseCitations(m.citations),
      createdAt: m.created_at,
    }));
    sendOk(res, messages);
    return true;
  }

  // DELETE /v1/chats/:id (user can delete own chats, D58)
  if (method === 'DELETE' && path.startsWith(`${ChatRoutes.chats}/`)) {
    const id = decodeURIComponent(path.slice(ChatRoutes.chats.length + 1));
    const chat = ctx.repos.chats.get(id);
    if (chat && chat.user_id === userId) ctx.repos.chats.delete(id);
    sendOk(res, { deleted: true });
    return true;
  }

  if (method === 'POST' && path === ChatRoutes.query) {
    await handleQuery(userId, req, res, ctx);
    return true;
  }

  return false;
}

async function handleQuery(
  userId: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 'bad_request', err instanceof Error ? err.message : 'invalid body');
    return;
  }
  const request = body as QueryRequest | undefined;
  if (
    !request ||
    typeof request.query !== 'string' ||
    request.query.trim().length === 0 ||
    typeof request.workspaceId !== 'string'
  ) {
    sendError(res, 'bad_request', 'A workspace and a question are required.');
    return;
  }

  // Enforce the ethical wall BEFORE opening the stream, so a forbidden request
  // gets a clean 403 (not a 200 stream).
  try {
    ctx.query.assertAccess(userId, request.workspaceId);
  } catch (err) {
    if (err instanceof ForbiddenWorkspaceError) {
      sendError(res, 'forbidden', err.message);
      return;
    }
    throw err;
  }

  const sse = startSse(res);
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  try {
    await ctx.query.run(userId, request, (event) => sse.send(event), abort.signal);
  } catch (err) {
    const message =
      err instanceof ChatAccessError || err instanceof ForbiddenWorkspaceError
        ? err.message
        : 'The query could not be completed.';
    sse.send({ type: 'error', message });
  } finally {
    sse.close();
  }
}

function parseCitations(raw: string | null): Citation[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Citation[];
  } catch {
    return [];
  }
}
