import { useCallback, useEffect, useState } from 'react';
import type {
  Account,
  AuditEntry,
  EngineApiStatus,
  RetentionPolicy,
  RetentionScope,
  RoleName,
  ServerModeStatus,
  Workspace,
} from '@queryload/shared';
import type { EngineClient } from '../api/client';
import { Dropdown } from '../Dropdown';

interface Props {
  client: EngineClient;
}

const RETENTION_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: 'Keep forever', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '365 days', days: 365 },
];

/**
 * Phase 5 admin surface: retention (one scheduler, three scopes), the audit log
 * viewer, the Engine API toggle (off by default), rebuild index, diagnostic
 * bundle, and update check. Plain, dense — the fuller admin console lands with
 * organization mode (Phase 6).
 */
export function Admin({ client }: Props): React.JSX.Element {
  const [retention, setRetention] = useState<RetentionPolicy[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [engineApi, setEngineApi] = useState<EngineApiStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await Promise.all([
      client
        .getRetention()
        .then(setRetention)
        .catch(() => undefined),
      client
        .listAudit()
        .then(setAudit)
        .catch(() => undefined),
      client
        .getEngineApi()
        .then(setEngineApi)
        .catch(() => undefined),
    ]);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRetention = useCallback(
    async (scope: RetentionScope, days: number | null) => {
      setRetention(await client.setRetention(scope, days));
    },
    [client],
  );

  const onToggleApi = useCallback(
    async (enabled: boolean) => {
      setEngineApi(await client.setEngineApi(enabled));
    },
    [client],
  );

  const onDiagnostics = useCallback(async () => {
    const b = await client.diagnosticBundle();
    const bytes = Uint8Array.from(atob(b.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = b.filename;
    a.click();
    URL.revokeObjectURL(url);
    setNote(
      'Diagnostic bundle saved. It contains logs, config, and hardware — never document content.',
    );
  }, [client]);

  return (
    <div>
      <OrganizationPanel client={client} />

      <div className="label" style={{ marginTop: 28 }}>
        Retention
      </div>
      <p className="settings-hint">
        One schedule governs how long documents, chat history, and the audit log are kept. Purged
        content is removed from the index and is unrecoverable.
      </p>
      {(['documents', 'chats', 'audit'] as RetentionScope[]).map((scope) => {
        const current = retention.find((r) => r.scope === scope)?.days ?? null;
        return (
          <div className="path-card" key={scope} style={{ alignItems: 'center' }}>
            <div className="path-card-main">
              <div className="path-name" style={{ textTransform: 'capitalize' }}>
                {scope}
              </div>
            </div>
            <Dropdown
              value={String(current)}
              ariaLabel={`Retention for ${scope}`}
              onChange={(v) => void onRetention(scope, v === 'null' ? null : Number(v))}
              options={RETENTION_CHOICES.map((c) => ({ value: String(c.days), label: c.label }))}
            />
          </div>
        );
      })}

      <div className="label" style={{ marginTop: 28 }}>
        Engine API
      </div>
      <p className="settings-hint">
        A local bearer-token API mirroring the query interface. Off by default; every API call is
        audited.
      </p>
      <div className="path-card" style={{ alignItems: 'center' }}>
        <div className="path-card-main">
          <div className="path-name">{engineApi?.enabled ? 'Enabled' : 'Disabled'}</div>
        </div>
        <button className="btn" onClick={() => void onToggleApi(!engineApi?.enabled)}>
          {engineApi?.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      <div className="label" style={{ marginTop: 28 }}>
        Maintenance
      </div>
      <div className="path-input-row">
        <button
          className="btn"
          onClick={() => void client.rebuildIndex().then(() => setNote('Index rebuild started.'))}
        >
          Rebuild index
        </button>
        <button className="btn" onClick={() => void onDiagnostics()}>
          Diagnostic bundle
        </button>
        <button
          className="btn"
          onClick={() => void client.checkUpdate().then((u) => setNote(u.note))}
        >
          Check for updates
        </button>
      </div>
      {note && <div className="banner banner-warn">{note}</div>}

      <div className="label" style={{ marginTop: 28 }}>
        Audit Log
      </div>
      <p className="settings-hint">
        Every query, its cited sources, and the user — timestamped and stored locally (default on).
      </p>
      <div className="path-list">
        {audit.length === 0 && <div className="empty">No activity recorded yet.</div>}
        {audit.slice(0, 40).map((e) => (
          <div className="quarantine-row" key={e.id}>
            <span className="q-path">
              {e.action}
              {e.query ? ` · ${e.query}` : ''}
            </span>
            <span className="muted">{new Date(e.at).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Organization mode (Phase 6): turn this machine into an office server, share
 * the join code with client machines, and manage users + workspace assignment
 * (the ethical wall, D54). Membership is what a member can reach.
 */
function OrganizationPanel({ client }: { client: EngineClient }): React.JSX.Element {
  const [server, setServer] = useState<ServerModeStatus | null>(null);
  const [users, setUsers] = useState<Account[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [uname, setUname] = useState('');
  const [pass, setPass] = useState('');
  const [role, setRole] = useState<RoleName>('member');
  const [wsName, setWsName] = useState('');
  const [assignUser, setAssignUser] = useState('');
  const [assignWs, setAssignWs] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await Promise.all([
      client
        .getServerMode()
        .then(setServer)
        .catch(() => undefined),
      client
        .listUsers()
        .then((r) => setUsers([...r.users]))
        .catch(() => undefined),
      client
        .listWorkspaces()
        .then(setWorkspaces)
        .catch(() => undefined),
    ]);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="label">Organization Mode</div>
      <p className="settings-hint">
        Run QueryLoad as an office server. Client machines discover it on the network and connect
        with the join code. Turning this on takes effect after the engine restarts.
      </p>
      <div className="path-card" style={{ alignItems: 'center' }}>
        <div className="path-card-main">
          <div className="path-name">
            {server?.enabled ? 'Enabled' : 'Disabled'}
            {server?.restartRequired ? ' · restart to bind the LAN' : ''}
          </div>
          {server?.joinCode && (
            <div className="model-reason" style={{ wordBreak: 'break-all' }}>
              Join code: {server.joinCode}
            </div>
          )}
        </div>
        <button
          className="btn"
          onClick={() => void client.setServerMode(!server?.enabled).then(setServer)}
        >
          {server?.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      <div className="label" style={{ marginTop: 24 }}>
        Users &amp; Access
      </div>
      <div className="path-input-row">
        <input
          className="path-input"
          placeholder="Username"
          value={uname}
          onChange={(e) => setUname(e.target.value)}
        />
        <input
          className="path-input"
          type="password"
          placeholder="Password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <Dropdown
          value={role}
          ariaLabel="Role"
          onChange={(v) => setRole(v as RoleName)}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'auditor', label: 'Auditor' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
        <button
          className="btn btn-primary"
          disabled={!uname.trim() || !pass.trim()}
          onClick={() =>
            void client
              .createUser(uname.trim(), pass, role)
              .then(() => {
                setUname('');
                setPass('');
                setMsg('User created.');
                void refresh();
              })
              .catch(() => setMsg('Could not create the user.'))
          }
        >
          Add user
        </button>
      </div>

      <div className="path-input-row">
        <input
          className="path-input"
          placeholder="New workspace name (matter / patient / client)"
          value={wsName}
          onChange={(e) => setWsName(e.target.value)}
        />
        <button
          className="btn"
          disabled={!wsName.trim()}
          onClick={() =>
            void client.createWorkspace(wsName.trim()).then(() => {
              setWsName('');
              void refresh();
            })
          }
        >
          Add workspace
        </button>
      </div>

      <div className="path-input-row">
        <Dropdown
          value={assignUser}
          ariaLabel="Assign user"
          onChange={setAssignUser}
          options={[
            { value: '', label: 'Assign user…' },
            ...users.map((u) => ({ value: u.id, label: `${u.username} (${u.role})` })),
          ]}
        />
        <Dropdown
          value={assignWs}
          ariaLabel="To workspace"
          onChange={setAssignWs}
          options={[
            { value: '', label: 'to workspace…' },
            ...workspaces.map((w) => ({ value: w.id, label: w.name })),
          ]}
        />
        <button
          className="btn"
          disabled={!assignUser || !assignWs}
          onClick={() =>
            void client
              .assignMembership(assignUser, assignWs)
              .then(() => setMsg('Access assigned.'))
          }
        >
          Assign access
        </button>
      </div>
      {msg && <div className="banner banner-warn">{msg}</div>}
    </div>
  );
}
