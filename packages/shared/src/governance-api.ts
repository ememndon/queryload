/**
 * Phase 5 API contract — accounts/roles, audit log, retention, engine API,
 * updates, diagnostics.
 */

export type RoleName = 'admin' | 'member' | 'auditor';

export interface Account {
  readonly id: string;
  readonly username: string;
  readonly role: RoleName;
  readonly disabled: boolean;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly token: string;
  readonly account: Account;
  readonly expiresAt: number;
}

/** An audit entry — every query, answer, sources, user, timestamp (D56). */
export interface AuditEntry {
  readonly id: string;
  readonly userId: string | null;
  readonly action: string;
  readonly query: string | null;
  readonly answerExcerpt: string | null;
  readonly sources: string | null;
  readonly workspaceId: string | null;
  readonly at: number;
}

/** Retention scope — one scheduler, three consumers (D57/D58). */
export type RetentionScope = 'documents' | 'chats' | 'audit';

export interface RetentionPolicy {
  readonly scope: RetentionScope;
  /** null = keep forever / off. Otherwise days. Chats accept 30/90/365. */
  readonly days: number | null;
}

/** External Engine API status (disabled by default, D48). */
export interface EngineApiStatus {
  readonly enabled: boolean;
  /** Number of issued API tokens (never the tokens themselves). */
  readonly tokenCount: number;
}

export interface UpdateCheckResult {
  readonly currentVersion: string;
  readonly available: boolean;
  readonly latestVersion: string | null;
  readonly note: string;
}

export const GovernanceRoutes = {
  login: '/v1/auth/login',
  me: '/v1/auth/me',
  accounts: '/v1/admin/accounts',
  audit: '/v1/admin/audit',
  auditExport: '/v1/admin/audit/export',
  retention: '/v1/admin/retention',
  engineApi: '/v1/admin/engine-api',
  rebuildIndex: '/v1/admin/rebuild-index',
  diagnosticBundle: '/v1/admin/diagnostic-bundle',
  update: '/v1/admin/update',
} as const;
