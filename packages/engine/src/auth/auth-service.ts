import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { Account, LoginResponse, RoleName } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import type { Repositories, SessionRow, UserRow } from '../db/repos.js';
import { ROLE_IDS } from '../db/schema.js';
import { hashPassword, verifyPassword } from './passwords.js';

const MAX_FAILED_ATTEMPTS = 5; // D49
const LOCK_MS = 15 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

export type AuthErrorCode = 'invalid_credentials' | 'locked' | 'forbidden' | 'conflict';
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface Session {
  userId: string;
  role: RoleName;
  expiresAt: number;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ROLE_BY_ID: Record<string, RoleName> = {
  [ROLE_IDS.admin]: 'admin',
  [ROLE_IDS.member]: 'member',
  [ROLE_IDS.auditor]: 'auditor',
};
const ID_BY_ROLE: Record<RoleName, string> = {
  admin: ROLE_IDS.admin,
  member: ROLE_IDS.member,
  auditor: ROLE_IDS.auditor,
};

/**
 * Local accounts, roles, sessions, and abuse controls (D49/D52/D53).
 *
 * Sessions are in-memory for the desktop MVP (a token maps to a user + role
 * until it expires); persistent, revocable device sessions land with server
 * mode (Phase 6). Role checks here are the governance wall: a member can never
 * reach admin or auditor surfaces.
 */
export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {}

  toAccount(u: UserRow): Account {
    return {
      id: u.id,
      username: u.username,
      role: ROLE_BY_ID[u.role_id] ?? 'member',
      disabled: u.disabled === 1,
      lockedUntil: u.locked_until,
      createdAt: u.created_at,
    };
  }

  /** True once a real (password-bearing) admin exists (first-run gate). */
  hasRealAdmin(): boolean {
    return this.repos.users.countAdmins(ROLE_IDS.admin) > 0;
  }

  async createUser(username: string, password: string, role: RoleName): Promise<Account> {
    if (this.repos.users.getByUsername(username)) {
      throw new AuthError('conflict', 'That username is already taken.');
    }
    const id = randomUUID();
    const hash = await hashPassword(password);
    this.repos.users.create(id, username, hash, ID_BY_ROLE[role]);
    const u = this.repos.users.getById(id)!;
    this.logger.info({ username, role }, 'account created');
    return this.toAccount(u);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    this.repos.users.setPasswordHash(userId, await hashPassword(password));
  }

  async login(username: string, password: string, deviceName?: string): Promise<LoginResponse> {
    const u = this.repos.users.getByUsername(username);
    const now = Date.now();
    if (!u || u.disabled === 1) {
      throw new AuthError('invalid_credentials', 'Incorrect username or password.');
    }
    if (u.locked_until && now < u.locked_until) {
      throw new AuthError('locked', 'This account is temporarily locked. Try again later.');
    }
    const ok = await verifyPassword(u.password_hash, password);
    if (!ok) {
      const failed = this.repos.users.recordFailedAttempt(u.id);
      if (failed >= MAX_FAILED_ATTEMPTS) {
        this.repos.users.lock(u.id, now + LOCK_MS);
        this.logger.warn({ username }, 'account locked after repeated failures');
      }
      throw new AuthError('invalid_credentials', 'Incorrect username or password.');
    }
    this.repos.users.clearLock(u.id);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_MS;
    // Persist a REVOCABLE session, storing only the token's hash (a DB leak
    // never yields a usable session token).
    this.repos.sessions.create({
      token_hash: tokenHash(token),
      user_id: u.id,
      device_name: deviceName ?? null,
      created_at: now,
      expires_at: expiresAt,
      revoked: 0,
    });
    return { token, account: this.toAccount(u), expiresAt };
  }

  authenticate(token: string): Session | null {
    const row = this.repos.sessions.getByHash(tokenHash(token));
    if (!row || row.revoked === 1 || Date.now() > row.expires_at) return null;
    const u = this.repos.users.getById(row.user_id);
    if (!u || u.disabled === 1) return null;
    return { userId: u.id, role: ROLE_BY_ID[u.role_id] ?? 'member', expiresAt: row.expires_at };
  }

  /** Assert a session holds one of the allowed roles (governance wall). */
  requireRole(token: string, roles: readonly RoleName[]): Session {
    const s = this.authenticate(token);
    if (!s) throw new AuthError('invalid_credentials', 'Please sign in.');
    if (!roles.includes(s.role)) {
      throw new AuthError('forbidden', 'Your role does not have access to this.');
    }
    return s;
  }

  /** Admin action: clear a lockout (D49). */
  unlock(userId: string): void {
    this.repos.users.clearLock(userId);
  }

  logout(token: string): void {
    this.repos.sessions.revoke(tokenHash(token));
  }

  /** Admin: revoke a device session (D55). */
  revokeSession(tokenHashValue: string): void {
    this.repos.sessions.revoke(tokenHashValue);
  }

  listSessions(): SessionRow[] {
    return this.repos.sessions.listAll();
  }

  /** Role of the current local (desktop) identity, for single-user route checks. */
  roleOf(userId: string): RoleName {
    const u = this.repos.users.getById(userId);
    return u ? (ROLE_BY_ID[u.role_id] ?? 'member') : 'member';
  }
}
