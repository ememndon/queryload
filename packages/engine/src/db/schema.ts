import type { Db } from './sqlite.js';

/**
 * The complete QueryLoad metadata schema.
 *
 * The FULL multi-user schema is created now (Phase 1) even though the MVP is
 * single-user — Phase 5 (governance) and Phase 6 (server mode) depend on it,
 * and retrofitting an encrypted schema is far riskier than provisioning it up
 * front. Tables not yet exercised (users, chats, audit_log, …) are created
 * empty and documented with the phase that fills them.
 *
 * All of this lives inside the SQLCipher-encrypted database file, so every
 * column below — file paths, chunk text, chat content — is encrypted at rest.
 */

const MIGRATIONS: readonly string[] = [
  // v1 — initial schema.
  `
  -- Workspaces: unit of access control + retrieval scoping (D54).
  CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'general',
    created_at  INTEGER NOT NULL
  );

  -- Roles (D53): admin / member / auditor. Seeded below.
  CREATE TABLE roles (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE
  );

  -- Local accounts (D52). Filled in Phase 5; argon2id hashes.
  CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role_id         TEXT NOT NULL REFERENCES roles(id),
    created_at      INTEGER NOT NULL,
    disabled        INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER
  );

  -- Workspace membership (ethical walls). Filled as users are created.
  CREATE TABLE memberships (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, workspace_id)
  );

  -- Indexed folders the user added (D27).
  CREATE TABLE indexed_paths (
    id                TEXT PRIMARY KEY,
    path              TEXT NOT NULL UNIQUE,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    state             TEXT NOT NULL DEFAULT 'scanning',
    added_at          INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    message           TEXT
  );

  -- One row per source file (D29: content-hash change detection).
  CREATE TABLE files (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    indexed_path_id TEXT NOT NULL REFERENCES indexed_paths(id) ON DELETE CASCADE,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    hash            TEXT NOT NULL,
    mtime           INTEGER NOT NULL,
    size            INTEGER NOT NULL,
    type            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    page_count      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
  );

  -- Chunks. TEXT LIVES HERE (encrypted). LanceDB stores only vectors + ids.
  CREATE TABLE chunks (
    id            TEXT PRIMARY KEY,
    file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    page          INTEGER,
    char_start    INTEGER NOT NULL,
    char_end      INTEGER NOT NULL,
    hash          TEXT NOT NULL,
    token_count   INTEGER NOT NULL,
    text          TEXT NOT NULL
  );

  -- Files set aside because parsing failed/was hostile (D46).
  CREATE TABLE quarantine (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL,
    indexed_path_id TEXT REFERENCES indexed_paths(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    at              INTEGER NOT NULL
  );

  -- Chat history (D58). Filled in Phase 3.
  CREATE TABLE chats (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    citations   TEXT,
    created_at  INTEGER NOT NULL
  );

  -- Audit log, default ON (D56). Filled in Phase 5.
  CREATE TABLE audit_log (
    id              TEXT PRIMARY KEY,
    user_id         TEXT,
    action          TEXT NOT NULL,
    query           TEXT,
    answer_excerpt  TEXT,
    sources         TEXT,
    workspace_id    TEXT,
    at              INTEGER NOT NULL
  );

  -- Key/value app settings (non-secret).
  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  -- Retention clocks (D57/D58). Filled in Phase 5.
  CREATE TABLE retention_policies (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL UNIQUE, -- 'documents' | 'chats' | 'audit'
    days        INTEGER,              -- NULL = off / keep forever
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX idx_chunks_file       ON chunks(file_id);
  CREATE INDEX idx_chunks_workspace  ON chunks(workspace_id);
  CREATE INDEX idx_files_indexed_path ON files(indexed_path_id);
  CREATE INDEX idx_files_workspace   ON files(workspace_id);
  CREATE INDEX idx_files_hash        ON files(hash);
  CREATE INDEX idx_memberships_ws    ON memberships(workspace_id);
  CREATE INDEX idx_quarantine_path   ON quarantine(indexed_path_id);
  CREATE INDEX idx_messages_chat     ON messages(chat_id);
  CREATE INDEX idx_audit_at          ON audit_log(at);
  `,
  // v2 — persistent, revocable device sessions (server mode, D55).
  `
  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  `,
  // v3 — retention tombstones (D57): a document purged by the documents policy
  // is recorded here by path+hash so the next scan does NOT silently re-ingest
  // the same on-disk bytes and defeat retention. Cleared when the bytes change.
  `
  CREATE TABLE retention_tombstones (
    path  TEXT PRIMARY KEY,
    hash  TEXT NOT NULL,
    at    INTEGER NOT NULL
  );
  `,
  // v4 — indexes on retention/query hot paths that were missing: the documents
  // retention sweep filters files by updated_at, and the sidebar lists chats by
  // (user_id, workspace_id).
  `
  CREATE INDEX idx_files_updated_at ON files(updated_at);
  CREATE INDEX idx_chats_user_ws    ON chats(user_id, workspace_id);
  `,
];

/**
 * Current schema version = the number of migrations. Derived (not a hand-kept
 * constant) so it can never drift from what {@link migrate} actually applies.
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The General workspace id is stable so single-user mode has a default home. */
export const GENERAL_WORKSPACE_ID = 'ws-general';

/**
 * The pre-auth single-user identity. Membership enforcement (the ethical wall)
 * is always on; in single-user mode this local user is simply a member of the
 * General workspace. Phase 5 introduces real accounts + sessions and the query
 * API switches to the logged-in user. Its empty password hash means it cannot
 * be used to log in.
 */
export const DEFAULT_USER_ID = 'user-local';

export const ROLE_IDS = {
  admin: 'role-admin',
  member: 'role-member',
  auditor: 'role-auditor',
} as const;

/** Apply pending migrations transactionally, then seed defaults. */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    const step = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    });
    step();
  }
  seedDefaults(db);
}

function seedDefaults(db: Db): void {
  const now = Date.now();
  const insertRole = db.prepare('INSERT OR IGNORE INTO roles(id, name) VALUES (?, ?)');
  insertRole.run(ROLE_IDS.admin, 'admin');
  insertRole.run(ROLE_IDS.member, 'member');
  insertRole.run(ROLE_IDS.auditor, 'auditor');

  db.prepare(
    `INSERT OR IGNORE INTO workspaces(id, name, kind, created_at) VALUES (?, 'General', 'general', ?)`,
  ).run(GENERAL_WORKSPACE_ID, now);

  // Pre-auth single-user identity, member of General (see DEFAULT_USER_ID).
  db.prepare(
    `INSERT OR IGNORE INTO users(id, username, password_hash, role_id, created_at) VALUES (?, 'local', '', ?, ?)`,
  ).run(DEFAULT_USER_ID, ROLE_IDS.admin, now);
  db.prepare('INSERT OR IGNORE INTO memberships(user_id, workspace_id) VALUES (?, ?)').run(
    DEFAULT_USER_ID,
    GENERAL_WORKSPACE_ID,
  );

  const insertRetention = db.prepare(
    'INSERT OR IGNORE INTO retention_policies(id, scope, days, updated_at) VALUES (?, ?, ?, ?)',
  );
  insertRetention.run('ret-documents', 'documents', null, now);
  insertRetention.run('ret-chats', 'chats', null, now);
  insertRetention.run('ret-audit', 'audit', null, now);
}
