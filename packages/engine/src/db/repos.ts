import type { IndexedPathState, Workspace } from '@queryload/shared';
import type { Db } from './sqlite.js';

/**
 * Typed repositories over the encrypted metadata DB. Each wraps prepared
 * statements; SQL lives here and nowhere else, so the schema surface is
 * auditable in one place. Rows are cast to explicit interfaces at the boundary.
 */

export interface IndexedPathRow {
  id: string;
  path: string;
  workspace_id: string;
  state: IndexedPathState;
  added_at: number;
  last_activity_at: number;
  message: string | null;
}

export interface FileRow {
  id: string;
  path: string;
  indexed_path_id: string;
  workspace_id: string;
  hash: string;
  mtime: number;
  size: number;
  type: string;
  status: string;
  page_count: number;
  updated_at: number;
}

export interface ChunkRow {
  id: string;
  file_id: string;
  workspace_id: string;
  ordinal: number;
  page: number | null;
  char_start: number;
  char_end: number;
  hash: string;
  token_count: number;
  text: string;
}

export interface QuarantineRow {
  id: string;
  path: string;
  indexed_path_id: string | null;
  reason: string;
  attempts: number;
  at: number;
}

export class WorkspacesRepo {
  constructor(private readonly db: Db) {}
  list(): Workspace[] {
    return this.db
      .prepare('SELECT id, name, kind, created_at AS createdAt FROM workspaces ORDER BY created_at')
      .all() as Workspace[];
  }
  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id);
  }
  create(id: string, name: string, kind: Workspace['kind']): void {
    this.db
      .prepare('INSERT INTO workspaces(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, kind, Date.now());
  }
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role_id: string;
  created_at: number;
  disabled: number;
  failed_attempts: number;
  locked_until: number | null;
}

export class UsersRepo {
  constructor(private readonly db: Db) {}
  create(id: string, username: string, passwordHash: string, roleId: string): void {
    this.db
      .prepare(
        'INSERT INTO users(id, username, password_hash, role_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, username, passwordHash, roleId, Date.now());
  }
  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
  }
  getById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  getByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
  }
  list(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
  }
  setPasswordHash(id: string, hash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  setDisabled(id: string, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  }
  recordFailedAttempt(id: string): number {
    this.db.prepare('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(id);
    return (
      this.db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(id) as {
        failed_attempts: number;
      }
    ).failed_attempts;
  }
  lock(id: string, until: number): void {
    this.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(until, id);
  }
  clearLock(id: string): void {
    this.db
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(id);
  }
  countAdmins(adminRoleId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND password_hash != ''")
        .get(adminRoleId) as { n: number }
    ).n;
  }
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  query: string | null;
  answer_excerpt: string | null;
  sources: string | null;
  workspace_id: string | null;
  at: number;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}
  record(row: AuditRow): void {
    this.db
      .prepare(
        `INSERT INTO audit_log(id, user_id, action, query, answer_excerpt, sources, workspace_id, at)
         VALUES (@id, @user_id, @action, @query, @answer_excerpt, @sources, @workspace_id, @at)`,
      )
      .run(row);
  }
  list(limit = 200): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?')
      .all(limit) as AuditRow[];
  }
  all(): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY at').all() as AuditRow[];
  }
  deleteOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes;
  }
  countTotal(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  }
}

export class MembershipsRepo {
  constructor(private readonly db: Db) {}
  add(userId: string, workspaceId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO memberships(user_id, workspace_id) VALUES (?, ?)')
      .run(userId, workspaceId);
  }
  remove(userId: string, workspaceId: string): void {
    this.db
      .prepare('DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?')
      .run(userId, workspaceId);
  }
  isMember(userId: string, workspaceId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?')
      .get(userId, workspaceId);
  }
  workspaceIdsFor(userId: string): string[] {
    return (
      this.db.prepare('SELECT workspace_id FROM memberships WHERE user_id = ?').all(userId) as {
        workspace_id: string;
      }[]
    ).map((r) => r.workspace_id);
  }
}

export class PathsRepo {
  constructor(private readonly db: Db) {}
  list(): IndexedPathRow[] {
    return this.db
      .prepare('SELECT * FROM indexed_paths ORDER BY added_at')
      .all() as IndexedPathRow[];
  }
  getById(id: string): IndexedPathRow | undefined {
    return this.db.prepare('SELECT * FROM indexed_paths WHERE id = ?').get(id) as
      | IndexedPathRow
      | undefined;
  }
  allPaths(): string[] {
    return (this.db.prepare('SELECT path FROM indexed_paths').all() as { path: string }[]).map(
      (r) => r.path,
    );
  }
  insert(row: IndexedPathRow): void {
    this.db
      .prepare(
        `INSERT INTO indexed_paths(id, path, workspace_id, state, added_at, last_activity_at, message)
         VALUES (@id, @path, @workspace_id, @state, @added_at, @last_activity_at, @message)`,
      )
      .run(row);
  }
  updateState(id: string, state: IndexedPathState, message: string | null, at: number): void {
    this.db
      .prepare('UPDATE indexed_paths SET state = ?, message = ?, last_activity_at = ? WHERE id = ?')
      .run(state, message, at, id);
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM indexed_paths WHERE id = ?').run(id);
  }
}

export class FilesRepo {
  constructor(private readonly db: Db) {}
  getByPath(path: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
  }
  getById(id: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
  }
  /** Batch fetch file rows by id (avoids an N+1 getById-per-hit in retrieval). */
  getByIds(ids: readonly string[]): FileRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM files WHERE id IN (${placeholders})`)
      .all(...ids) as FileRow[];
  }
  upsert(row: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files(id, path, indexed_path_id, workspace_id, hash, mtime, size, type, status, page_count, updated_at)
         VALUES (@id, @path, @indexed_path_id, @workspace_id, @hash, @mtime, @size, @type, @status, @page_count, @updated_at)
         ON CONFLICT(path) DO UPDATE SET
           hash=excluded.hash, mtime=excluded.mtime, size=excluded.size, type=excluded.type,
           status=excluded.status, page_count=excluded.page_count, updated_at=excluded.updated_at`,
      )
      .run(row);
  }
  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE files SET status = ? WHERE id = ?').run(status, id);
  }
  deleteByPath(path: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
  idsUpdatedBefore(cutoff: number): string[] {
    return (
      this.db.prepare('SELECT id FROM files WHERE updated_at < ?').all(cutoff) as { id: string }[]
    ).map((r) => r.id);
  }
  /** Rows (id + path + hash) eligible for document retention — path/hash needed
   * to tombstone the purged bytes so they aren't silently re-ingested. */
  rowsUpdatedBefore(cutoff: number): Array<{ id: string; path: string; hash: string }> {
    return this.db
      .prepare('SELECT id, path, hash FROM files WHERE updated_at < ?')
      .all(cutoff) as Array<{ id: string; path: string; hash: string }>;
  }
  /** Test/verify helper: age a file's updated_at (retention testing). */
  setUpdatedAt(id: string, updatedAt: number): void {
    this.db.prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  }
  listPathsForIndexedPath(indexedPathId: string): string[] {
    return (
      this.db.prepare('SELECT path FROM files WHERE indexed_path_id = ?').all(indexedPathId) as {
        path: string;
      }[]
    ).map((r) => r.path);
  }
  idsByIndexedPath(indexedPathId: string): string[] {
    return (
      this.db.prepare('SELECT id FROM files WHERE indexed_path_id = ?').all(indexedPathId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }
  countIndexed(indexedPathId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM files WHERE indexed_path_id = ? AND status = 'indexed'")
        .get(indexedPathId) as { n: number }
    ).n;
  }
  countTotalIndexed(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'indexed'").get() as {
        n: number;
      }
    ).n;
  }
}

export class ChunksRepo {
  constructor(private readonly db: Db) {}
  deleteByFile(fileId: string): void {
    this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
  }
  insertMany(rows: readonly ChunkRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO chunks(id, file_id, workspace_id, ordinal, page, char_start, char_end, hash, token_count, text)
       VALUES (@id, @file_id, @workspace_id, @ordinal, @page, @char_start, @char_end, @hash, @token_count, @text)`,
    );
    const tx = this.db.transaction((items: readonly ChunkRow[]) => {
      for (const r of items) stmt.run(r);
    });
    tx(rows);
  }
  countTotal(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }
  getByIds(ids: readonly string[]): ChunkRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as ChunkRow[];
  }
  /** All chunks for a file, ordered — used for pinned files (always-in-context). */
  listByFile(fileId: string): ChunkRow[] {
    return this.db
      .prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY ordinal')
      .all(fileId) as ChunkRow[];
  }
}

export interface ChatRow {
  id: string;
  user_id: string | null;
  workspace_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  citations: string | null;
  created_at: number;
}

export class ChatsRepo {
  constructor(private readonly db: Db) {}
  create(row: ChatRow): void {
    this.db
      .prepare(
        `INSERT INTO chats(id, user_id, workspace_id, title, created_at, updated_at)
         VALUES (@id, @user_id, @workspace_id, @title, @created_at, @updated_at)`,
      )
      .run(row);
  }
  get(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  }
  listFor(userId: string, workspaceId: string): ChatRow[] {
    return this.db
      .prepare(
        'SELECT * FROM chats WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC',
      )
      .all(userId, workspaceId) as ChatRow[];
  }
  touch(id: string): void {
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
  deleteOlderThan(cutoff: number): number {
    return this.db.prepare('DELETE FROM chats WHERE updated_at < ?').run(cutoff).changes;
  }
  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }
}

export class MessagesRepo {
  constructor(private readonly db: Db) {}
  add(row: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages(id, chat_id, role, content, citations, created_at)
         VALUES (@id, @chat_id, @role, @content, @citations, @created_at)`,
      )
      .run(row);
  }
  listByChat(chatId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at')
      .all(chatId) as MessageRow[];
  }
}

export class QuarantineRepo {
  constructor(private readonly db: Db) {}
  record(id: string, path: string, indexedPathId: string | null, reason: string, at: number): void {
    // Increment attempts if we have seen this path before; else insert.
    const existing = this.db
      .prepare('SELECT id, attempts FROM quarantine WHERE path = ?')
      .get(path) as { id: string; attempts: number } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE quarantine SET reason = ?, attempts = attempts + 1, at = ? WHERE path = ?')
        .run(reason, at, path);
    } else {
      this.db
        .prepare(
          'INSERT INTO quarantine(id, path, indexed_path_id, reason, attempts, at) VALUES (?, ?, ?, ?, 1, ?)',
        )
        .run(id, path, indexedPathId, reason, at);
    }
  }
  attemptsFor(path: string): number {
    const row = this.db.prepare('SELECT attempts FROM quarantine WHERE path = ?').get(path) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }
  removeByPath(path: string): void {
    this.db.prepare('DELETE FROM quarantine WHERE path = ?').run(path);
  }
  list(): QuarantineRow[] {
    return this.db.prepare('SELECT * FROM quarantine ORDER BY at DESC').all() as QuarantineRow[];
  }
  countForIndexedPath(indexedPathId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM quarantine WHERE indexed_path_id = ?')
        .get(indexedPathId) as { n: number }
    ).n;
  }
  countTotal(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM quarantine').get() as { n: number }).n;
  }
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}
  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  device_name: string | null;
  created_at: number;
  expires_at: number;
  revoked: number;
}

export class SessionsRepo {
  constructor(private readonly db: Db) {}
  create(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, device_name, created_at, expires_at, revoked)
         VALUES (@token_hash, @user_id, @device_name, @created_at, @expires_at, @revoked)`,
      )
      .run(row);
  }
  getByHash(tokenHash: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | SessionRow
      | undefined;
  }
  listForUser(userId: string): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as SessionRow[];
  }
  listAll(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
  }
  revoke(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
  }
  deleteExpired(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }
}

export class RetentionRepo {
  constructor(private readonly db: Db) {}
  get(scope: string): number | null {
    const row = this.db
      .prepare('SELECT days FROM retention_policies WHERE scope = ?')
      .get(scope) as { days: number | null } | undefined;
    return row?.days ?? null;
  }
  set(scope: string, days: number | null): void {
    this.db
      .prepare(
        `INSERT INTO retention_policies(id, scope, days, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at`,
      )
      .run(`ret-${scope}`, scope, days, Date.now());
  }
  all(): Array<{ scope: string; days: number | null }> {
    return this.db.prepare('SELECT scope, days FROM retention_policies').all() as Array<{
      scope: string;
      days: number | null;
    }>;
  }
}

/**
 * Records documents purged by the retention policy (by path + content hash) so a
 * subsequent scan doesn't silently re-ingest the same on-disk file — cleared
 * automatically once the file's bytes change.
 */
export class TombstoneRepo {
  constructor(private readonly db: Db) {}
  add(path: string, hash: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO retention_tombstones(path, hash, at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, at = excluded.at`,
      )
      .run(path, hash, at);
  }
  get(path: string): { hash: string } | undefined {
    return this.db.prepare('SELECT hash FROM retention_tombstones WHERE path = ?').get(path) as
      | { hash: string }
      | undefined;
  }
  remove(path: string): void {
    this.db.prepare('DELETE FROM retention_tombstones WHERE path = ?').run(path);
  }
}

/** All repositories, constructed once and shared across the engine. */
export interface Repositories {
  readonly workspaces: WorkspacesRepo;
  readonly users: UsersRepo;
  readonly memberships: MembershipsRepo;
  readonly paths: PathsRepo;
  readonly files: FilesRepo;
  readonly chunks: ChunksRepo;
  readonly quarantine: QuarantineRepo;
  readonly settings: SettingsRepo;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly audit: AuditRepo;
  readonly retention: RetentionRepo;
  readonly sessions: SessionsRepo;
  readonly tombstones: TombstoneRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    workspaces: new WorkspacesRepo(db),
    users: new UsersRepo(db),
    memberships: new MembershipsRepo(db),
    paths: new PathsRepo(db),
    files: new FilesRepo(db),
    chunks: new ChunksRepo(db),
    quarantine: new QuarantineRepo(db),
    settings: new SettingsRepo(db),
    chats: new ChatsRepo(db),
    messages: new MessagesRepo(db),
    audit: new AuditRepo(db),
    retention: new RetentionRepo(db),
    sessions: new SessionsRepo(db),
    tombstones: new TombstoneRepo(db),
  };
}
