import {
  ApiRoutes,
  IngestionRoutes,
  ModelRoutes,
  ChatRoutes,
  GovernanceRoutes,
  ServerRoutes,
} from '@queryload/shared';
import type {
  AddPathResponse,
  ApiError,
  ApiResult,
  ChatSummary,
  EngineInfoResponse,
  HealthResponse,
  IndexedPathStatus,
  IndexingEstimate,
  IngestionStatusResponse,
  InferenceStatus,
  ModelDownloadStatus,
  ModelsResponse,
  QueryRequest,
  QueryStreamEvent,
  ResolveFileResponse,
  StoredMessage,
  TaskDefinition,
  Workspace,
  AuditEntry,
  EngineApiStatus,
  RetentionPolicy,
  RetentionScope,
  UpdateCheckResult,
  Account,
  AdminUsersResponse,
  RoleName,
  ServerModeStatus,
} from '@queryload/shared';
import type { RendererConnection } from '../global';

/** Thrown with the engine's structured error so the UI can show clean copy. */
export class ApiRequestError extends Error {
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
    this.name = 'ApiRequestError';
  }
}

/**
 * The renderer's client for the engine API. It is a PURE client (rule #2): it
 * obtains the connection descriptor from the preload bridge and speaks HTTPS to
 * the loopback engine. The engine's self-signed cert is pinned by the Electron
 * session, so `fetch` here trusts exactly one certificate and nothing remote.
 */
export class EngineClient {
  private constructor(private readonly conn: RendererConnection) {}

  static async connect(): Promise<EngineClient> {
    const conn = await window.queryload.getConnection();
    return new EngineClient(conn);
  }

  get version(): string {
    return this.conn.appVersion;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; authed?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.authed !== false) headers.authorization = `Bearer ${this.conn.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    const requestInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
      credentials: 'omit',
      cache: 'no-store',
    };
    if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);

    const res = await fetch(`${this.conn.baseUrl}${path}`, requestInit);
    const body = (await res.json()) as ApiResult<T>;
    if (!body.ok) throw new ApiRequestError(body.error);
    return body.data;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>(ApiRoutes.health, { authed: false });
  }

  engineInfo(): Promise<EngineInfoResponse> {
    return this.request<EngineInfoResponse>(ApiRoutes.engineInfo);
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>(IngestionRoutes.workspaces);
  }

  ingestionStatus(): Promise<IngestionStatusResponse> {
    return this.request<IngestionStatusResponse>(IngestionRoutes.ingestionStatus);
  }

  addPath(path: string, workspaceId?: string): Promise<AddPathResponse> {
    return this.request<AddPathResponse>(IngestionRoutes.paths, {
      method: 'POST',
      body: { path, ...(workspaceId ? { workspaceId } : {}) },
    });
  }

  removePath(id: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>(IngestionRoutes.path(id), { method: 'DELETE' });
  }

  estimate(path: string): Promise<IndexingEstimate> {
    return this.request<IndexingEstimate>(ModelRoutes.estimate, { method: 'POST', body: { path } });
  }

  listModels(): Promise<ModelsResponse> {
    return this.request<ModelsResponse>(ModelRoutes.models);
  }

  inferenceStatus(): Promise<InferenceStatus> {
    return this.request<InferenceStatus>(ModelRoutes.inferenceStatus);
  }

  startDownload(id: string): Promise<ModelDownloadStatus> {
    return this.request<ModelDownloadStatus>(ModelRoutes.download(id), { method: 'POST' });
  }

  activateModel(id: string): Promise<{ activated: boolean }> {
    return this.request<{ activated: boolean }>(ModelRoutes.activate(id), { method: 'POST' });
  }

  cancelDownload(id: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(ModelRoutes.download(id), { method: 'DELETE' });
  }

  removeModel(id: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>(ModelRoutes.remove(id), { method: 'DELETE' });
  }

  listTasks(): Promise<TaskDefinition[]> {
    return this.request<TaskDefinition[]>(ChatRoutes.tasks);
  }

  resolveFile(path: string): Promise<ResolveFileResponse> {
    return this.request<ResolveFileResponse>(
      `${ChatRoutes.resolveFile}?path=${encodeURIComponent(path)}`,
    );
  }

  listChats(workspaceId: string): Promise<ChatSummary[]> {
    return this.request<ChatSummary[]>(
      `${ChatRoutes.chats}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  chatMessages(chatId: string): Promise<StoredMessage[]> {
    return this.request<StoredMessage[]>(ChatRoutes.messages(chatId));
  }

  deleteChat(chatId: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(ChatRoutes.chat(chatId), { method: 'DELETE' });
  }

  /**
   * Stream a grounded answer. Reads the SSE frames from the POST response and
   * relays each {@link QueryStreamEvent}. Returns when the stream ends.
   */
  async streamQuery(
    req: QueryRequest,
    onEvent: (event: QueryStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.conn.baseUrl}${ChatRoutes.query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.conn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
      credentials: 'omit',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = (await res.json()) as ApiResult<never>;
      throw new ApiRequestError(body.ok ? { code: 'internal', message: 'error' } : body.error);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as QueryStreamEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }

  // --- Governance (admin) ---
  listAudit(): Promise<AuditEntry[]> {
    return this.request<AuditEntry[]>(GovernanceRoutes.audit);
  }
  exportAudit(): Promise<{ json: string }> {
    return this.request<{ json: string }>(GovernanceRoutes.auditExport);
  }
  getRetention(): Promise<RetentionPolicy[]> {
    return this.request<RetentionPolicy[]>(GovernanceRoutes.retention);
  }
  setRetention(scope: RetentionScope, days: number | null): Promise<RetentionPolicy[]> {
    return this.request<RetentionPolicy[]>(GovernanceRoutes.retention, {
      method: 'PUT',
      body: { scope, days },
    });
  }
  getEngineApi(): Promise<EngineApiStatus> {
    return this.request<EngineApiStatus>(GovernanceRoutes.engineApi);
  }
  setEngineApi(enabled: boolean): Promise<EngineApiStatus> {
    return this.request<EngineApiStatus>(GovernanceRoutes.engineApi, {
      method: 'POST',
      body: { enabled },
    });
  }
  rebuildIndex(): Promise<{ started: boolean }> {
    return this.request<{ started: boolean }>(GovernanceRoutes.rebuildIndex, { method: 'POST' });
  }
  checkUpdate(): Promise<UpdateCheckResult> {
    return this.request<UpdateCheckResult>(GovernanceRoutes.update);
  }
  diagnosticBundle(): Promise<{ filename: string; base64: string }> {
    return this.request<{ filename: string; base64: string }>(GovernanceRoutes.diagnosticBundle, {
      method: 'POST',
    });
  }

  // --- Server mode / admin console (Phase 6) ---
  listUsers(): Promise<AdminUsersResponse> {
    return this.request<AdminUsersResponse>(ServerRoutes.users);
  }
  createUser(username: string, password: string, role: RoleName): Promise<Account> {
    return this.request<Account>(ServerRoutes.users, {
      method: 'POST',
      body: { username, password, role },
    });
  }
  createWorkspace(name: string): Promise<Workspace> {
    return this.request<Workspace>(ServerRoutes.createWorkspace, {
      method: 'POST',
      body: { name },
    });
  }
  assignMembership(userId: string, workspaceId: string): Promise<{ assigned: boolean }> {
    return this.request<{ assigned: boolean }>(ServerRoutes.memberships, {
      method: 'POST',
      body: { userId, workspaceId },
    });
  }
  getServerMode(): Promise<ServerModeStatus> {
    return this.request<ServerModeStatus>(ServerRoutes.serverMode);
  }
  setServerMode(enabled: boolean): Promise<ServerModeStatus> {
    return this.request<ServerModeStatus>(ServerRoutes.serverMode, {
      method: 'POST',
      body: { enabled },
    });
  }

  /** Re-exported for convenience where a single path status is needed. */
  static isTerminalState(p: IndexedPathStatus): boolean {
    return p.state === 'watching' || p.state === 'error';
  }
}
