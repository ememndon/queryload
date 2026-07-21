import { useCallback, useEffect, useRef, useState } from 'react';
import type { IngestionStatusResponse, Workspace } from '@queryload/shared';
import type { EngineClient } from '../api/client';
import { ApiRequestError } from '../api/client';

interface Props {
  client: EngineClient;
}

/**
 * Phase 1 Settings — document sources. Paste-first path entry with a small
 * Browse fallback (D27), overlap warnings (D28), and live ingestion progress
 * with per-path status, counts, ETA, NAS-offline banners, and quarantine.
 * (Phase 4 restyles this into the final dark-editorial layout.)
 */
export function Settings({ client }: Props): React.JSX.Element {
  const [status, setStatus] = useState<IngestionStatusResponse | null>(null);
  const [, setWorkspaces] = useState<Workspace[]>([]);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await client.ingestionStatus();
      setStatus(s);
    } catch {
      /* transient — keep last snapshot */
    }
  }, [client]);

  useEffect(() => {
    void client
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => undefined);
    void refresh();
    timer.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [client, refresh]);

  const onAdd = useCallback(async () => {
    const path = input.trim();
    if (!path || adding) return;
    setAdding(true);
    setWarning(null);
    setError(null);
    try {
      await client.addPath(path);
      setInput('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiRequestError && err.apiError.code === 'conflict') {
        setWarning(err.apiError.message);
      } else if (err instanceof ApiRequestError) {
        setError(err.apiError.message);
      } else {
        setError('Could not add the folder.');
      }
    } finally {
      setAdding(false);
    }
  }, [input, adding, client, refresh]);

  const onBrowse = useCallback(async () => {
    const picked = await window.queryload.pickFolder();
    if (picked) setInput(picked);
  }, []);

  const onRemove = useCallback(
    async (id: string) => {
      await client.removePath(id).catch(() => undefined);
      await refresh();
    },
    [client, refresh],
  );

  return (
    <div className="settings">
      <div className="label">Document Sources</div>
      <p className="settings-hint">
        Add folders for QueryLoad to index. Everything is processed and stored on this machine —
        nothing leaves the building.
      </p>

      <div className="path-input-row">
        <input
          className="path-input"
          type="text"
          placeholder="Paste a folder path…  e.g. C:\Matters\Acme"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onAdd();
          }}
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={() => void onAdd()} disabled={adding}>
          {adding ? 'Adding…' : 'Add Path'}
        </button>
        <button className="btn btn-ghost" onClick={() => void onBrowse()} title="Browse…">
          Browse…
        </button>
      </div>

      {warning && <div className="banner banner-warn">{warning}</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <div className="path-list">
        {status?.paths.length === 0 && (
          <div className="empty">No folders indexed yet. Add one above to begin.</div>
        )}
        {status?.paths.map((p) => (
          <div className="path-card" key={p.id}>
            <div className="path-card-main">
              <div className="path-name">{p.path}</div>
              <div className="path-meta">
                <StateChip state={p.state} />
                <span className="muted">
                  {p.filesIndexed}
                  {p.filesDiscovered > 0 ? ` / ${p.filesDiscovered}` : ''} indexed
                </span>
                {p.filesQuarantined > 0 && (
                  <span className="muted">· {p.filesQuarantined} quarantined</span>
                )}
                {p.filesSkipped > 0 && <span className="muted">· {p.filesSkipped} skipped</span>}
                {p.etaSeconds !== null && (
                  <span className="muted">· ~{formatEta(p.etaSeconds)} remaining</span>
                )}
              </div>
              {p.message && <div className="path-banner">{p.message}</div>}
            </div>
            <button className="btn btn-ghost" onClick={() => void onRemove(p.id)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      {status && status.quarantine.length > 0 && (
        <div className="quarantine">
          <div className="label">Quarantined ({status.quarantine.length})</div>
          <p className="settings-hint">
            These files could not be read (corrupt, password-protected, or unsupported content) and
            were set aside. They are never retried endlessly.
          </p>
          {status.quarantine.slice(0, 25).map((q) => (
            <div className="quarantine-row" key={q.id}>
              <span className="q-path">{q.path}</span>
              <span className="muted">
                {q.reason} · {q.attempts} attempt{q.attempts === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}

      {status && (
        <div className="totals">
          {status.totals.filesIndexed} files · {status.totals.chunks} passages indexed
          {status.totals.busy ? ' · indexing…' : ''}
        </div>
      )}
    </div>
  );
}

function StateChip({ state }: { state: string }): React.JSX.Element {
  const label =
    state === 'scanning'
      ? 'Indexing'
      : state === 'watching'
        ? 'Up to date'
        : state === 'offline'
          ? 'Offline'
          : 'Error';
  return <span className={`chip chip-${state}`}>{label}</span>;
}

function formatEta(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}
