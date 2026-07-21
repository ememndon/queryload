/**
 * Phase 6 API contract — organization/server mode: admin console (users,
 * workspace assignment, slots, device sessions) and LAN server mode.
 */
import type { Account, RoleName } from './governance-api.js';

export interface CreateUserRequest {
  readonly username: string;
  readonly password: string;
  readonly role: RoleName;
}

export interface DeviceSession {
  readonly tokenHash: string;
  readonly userId: string;
  readonly deviceName: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

export interface WorkspaceAssignment {
  readonly workspaceId: string;
  readonly userId: string;
}

/** Live server-mode status (admin view). */
export interface ServerModeStatus {
  readonly enabled: boolean;
  readonly listening: 'loopback' | 'lan';
  readonly host: string;
  readonly port: number;
  readonly joinCode: string | null;
  readonly restartRequired: boolean;
}

export interface AdminUsersResponse {
  readonly users: readonly Account[];
}

export interface SlotConfig {
  readonly slots: number;
}

export const ServerRoutes = {
  users: '/v1/admin/users',
  user: (id: string): string => `/v1/admin/users/${encodeURIComponent(id)}`,
  createWorkspace: '/v1/admin/workspaces',
  memberships: '/v1/admin/memberships',
  sessions: '/v1/admin/sessions',
  slots: '/v1/admin/slots',
  serverMode: '/v1/admin/server-mode',
  join: '/v1/join',
} as const;
