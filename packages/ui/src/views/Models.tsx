import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ModelsResponse, ModelTier } from '@queryload/shared';
import { ApiRequestError, type EngineClient } from '../api/client';
import { Modal } from '../Modal';

interface Props {
  client: EngineClient;
}

/**
 * Phase 2 Models view — the curated catalog with per-machine specs, the
 * background hardware check, and download/activate controls. The runtime binary
 * + GGUF weights are fetched by the app's own download flow (never bundled).
 * (Phase 4 restyles into the final layout.)
 */
export function Models({ client }: Props): React.JSX.Element {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The model awaiting a remove confirmation — deleting gigabytes needs a beat. */
  const [confirmRemove, setConfirmRemove] = useState<ModelInfo | null>(null);
  /** Failure reason shown inside the confirm dialog, at the point of action. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await client.listModels());
    } catch {
      /* transient */
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    timer.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [refresh]);

  const onDownload = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await client.startDownload(id);
      } catch (err) {
        setError(message(err));
      }
      await refresh();
      setBusy(null);
    },
    [client, refresh],
  );

  const onCancelDownload = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await client.cancelDownload(id);
      } catch (err) {
        setError(message(err));
      }
      await refresh();
    },
    [client, refresh],
  );

  const onRemove = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      setRemoveError(null);
      try {
        await client.removeModel(id);
        setConfirmRemove(null); // only close on success
      } catch (err) {
        // Keep the dialog open and report the reason inside it. Closing on
        // failure and posting the error to a banner further up a long,
        // scrolled page is indistinguishable from the click doing nothing.
        setRemoveError(message(err));
      }
      await refresh();
      setBusy(null);
    },
    [client, refresh],
  );

  const onActivate = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await client.activateModel(id);
      } catch (err) {
        // Previously swallowed, so a failed activation looked like a dead
        // button. The engine's own message is the useful one.
        setError(message(err));
      }
      await refresh();
      setBusy(null);
    },
    [client, refresh],
  );

  if (!data) return <div className="label center">Checking your hardware…</div>;

  return (
    <div className="models">
      <div className="label">Model</div>
      <p className="settings-hint">
        One model runs at a time, entirely on this computer. QueryLoad checked your hardware and
        marks which models fit.
      </p>

      <div className="hw-card">
        <span>{data.hardware.totalRamGB} GB RAM</span>
        <span className="muted">·</span>
        <span>{data.hardware.cpuThreads} CPU threads</span>
        <span className="muted">·</span>
        <span>
          {data.hardware.gpus.length > 0
            ? data.hardware.gpus
                .map((g) => `${g.name}${g.vramGB ? ` (${g.vramGB} GB)` : ''}`)
                .join(', ')
            : 'No dedicated GPU'}
        </span>
        <span className="muted">·</span>
        <span>{Math.floor(data.hardware.freeDiskGB)} GB free disk</span>
      </div>

      {!data.runtimeReady && (
        <div className="banner banner-warn">
          The local inference runtime isn't installed on this computer yet. Models can be downloaded
          now, but none can be started until the runtime is in place.
        </div>
      )}

      {error && <div className="banner banner-error">{error}</div>}

      {TIER_ORDER.map((tier) => {
        const rows = data.models.filter((m) => m.entry.tier === tier);
        if (rows.length === 0) return null;
        return (
          <div key={tier}>
            <div className="label model-tier-label">{TIER_LABELS[tier]}</div>
            <div className="model-list">
              {rows.map((m) => (
                <ModelRow
                  key={m.entry.id}
                  info={m}
                  busy={busy === m.entry.id}
                  runtimeReady={data.runtimeReady}
                  onDownload={() => void onDownload(m.entry.id)}
                  onActivate={() => void onActivate(m.entry.id)}
                  onRemove={() => setConfirmRemove(m)}
                  onCancelDownload={() => void onCancelDownload(m.entry.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {confirmRemove && (
        <Modal
          titleId="remove-model-title"
          onClose={() => {
            setConfirmRemove(null);
            setRemoveError(null);
          }}
          overlayClassName="drop-modal"
          cardClassName="drop-card"
        >
          <div className="drop-title" id="remove-model-title">
            {confirmRemove.installed
              ? `Remove ${confirmRemove.entry.name}?`
              : `Discard the partial download of ${confirmRemove.entry.name}?`}
          </div>
          {confirmRemove.installed ? (
            <p className="settings-hint">
              This deletes the {(confirmRemove.entry.sizeBytes / 1024 ** 3).toFixed(1)} GB model file
              from this computer and frees the disk space.
              {confirmRemove.active &&
                ' It is the model currently answering, so it will be stopped.'}{' '}
              You can download it again at any time. Your documents and chats are not affected.
            </p>
          ) : (
            <p className="settings-hint">
              This deletes the{' '}
              {((confirmRemove.download?.receivedBytes ?? 0) / 1024 ** 3).toFixed(2)} GB downloaded
              so far and frees that space. Nothing is kept, so starting this model again would
              download it from the beginning.
            </p>
          )}
          {removeError && (
            <div className="banner banner-error" role="alert">
              {removeError}
            </div>
          )}
          <div className="drop-actions">
            <button
              className="btn"
              onClick={() => {
                setConfirmRemove(null);
                setRemoveError(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void onRemove(confirmRemove.entry.id)}
              disabled={busy === confirmRemove.entry.id}
            >
              {busy === confirmRemove.entry.id
                ? confirmRemove.installed
                  ? 'Removing…'
                  : 'Discarding…'
                : confirmRemove.installed
                  ? 'Remove'
                  : 'Discard'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The catalog is long enough now that a flat list is hard to scan, so it is
 * grouped by the kind of machine each model expects. Plain phrasing — the user
 * should recognise their own computer, not a hardware tier name.
 */
const TIER_ORDER: readonly ModelTier[] = [
  'floor',
  'everyday-laptop',
  'sweet-spot',
  'small-server',
  'office-server',
];

const TIER_LABELS: Record<ModelTier, string> = {
  floor: 'Runs on almost any computer',
  'everyday-laptop': 'Everyday laptop',
  'sweet-spot': 'Desktop or workstation',
  'small-server': 'High-end workstation',
  'office-server': 'Office server',
};

function ModelRow({
  info,
  busy,
  runtimeReady,
  onDownload,
  onActivate,
  onRemove,
  onCancelDownload,
}: {
  info: ModelInfo;
  busy: boolean;
  runtimeReady: boolean;
  onDownload: () => void;
  onActivate: () => void;
  onRemove: () => void;
  onCancelDownload: () => void;
}): React.JSX.Element {
  const { entry, eligibility, installed, active, download } = info;
  const sizeGB = (entry.sizeBytes / 1024 ** 3).toFixed(1);
  const blocked = eligibility.status === 'blocked';
  // A cancelled download keeps its partial file, so the next press continues
  // from where it stopped. Say "Resume" so that is not a leap of faith.
  const partial =
    !installed && download?.state === 'idle' && download.receivedBytes > 0
      ? download.receivedBytes
      : 0;

  return (
    <div className={`model-row ${active ? 'active' : ''}`}>
      <div className="model-main">
        <div className="model-name">
          {entry.name}
          {active && <span className="chip chip-active">Active</span>}
          <EligibilityChip status={eligibility.status} />
          {entry.reasoning && (
            <span className="chip chip-elig-warn" title="Thinks before answering — slower">
              Thinks first
            </span>
          )}
        </div>
        <div className="model-meta muted">
          {sizeGB} GB · min {entry.minRamGB} GB RAM · rec {entry.recommendedRamGB} GB
          {entry.recommendedVramGB ? ` / ${entry.recommendedVramGB} GB VRAM` : ''} · {entry.license}
        </div>
        {entry.notes && <div className="model-note">{entry.notes}</div>}
        <div className="model-reason">{eligibility.reason}</div>
        {download && download.state === 'downloading' && (
          <div className="progress">
            <div
              className="progress-bar"
              style={{
                width: `${download.totalBytes ? Math.round((download.receivedBytes / download.totalBytes) * 100) : 0}%`,
              }}
            />
            <span className="progress-label">
              {(download.receivedBytes / 1024 ** 3).toFixed(2)} /{' '}
              {(download.totalBytes / 1024 ** 3).toFixed(2)} GB
            </span>
          </div>
        )}
        {partial > 0 && (
          <div className="model-note">
            Download stopped at {(partial / 1024 ** 3).toFixed(2)} GB. Resuming continues from here.
          </div>
        )}
        {download?.state === 'error' && <div className="path-banner">{download.error}</div>}
      </div>
      <div className="model-actions">
        {download?.state === 'downloading' && (
          <button className="btn btn-quiet" onClick={onCancelDownload} title="Stop this download">
            Cancel
          </button>
        )}
        {!installed && download?.state !== 'downloading' && (
          <button className="btn" onClick={onDownload} disabled={blocked || busy}>
            {partial > 0 ? 'Resume' : 'Download'}
          </button>
        )}
        {/* A stopped download still occupies disk. Offer to throw it away, or
            it can only be reclaimed by finishing a model you did not want. */}
        {partial > 0 && (
          <button
            className="btn btn-quiet"
            onClick={onRemove}
            disabled={busy}
            title="Delete the partly-downloaded file"
          >
            Discard
          </button>
        )}
        {installed && !active && (
          <button
            className="btn btn-primary"
            onClick={onActivate}
            disabled={busy || !runtimeReady}
            title={
              runtimeReady
                ? 'Start this model'
                : 'The local inference runtime is not installed on this computer yet.'
            }
          >
            Use this model
          </button>
        )}
        {installed && (
          <button
            className="btn btn-quiet"
            onClick={onRemove}
            disabled={busy}
            title={`Remove ${entry.name} from this computer`}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** The engine's own message when it has one; a plain fallback otherwise. */
function message(err: unknown): string {
  if (err instanceof ApiRequestError) {
    // "No route for X" means the running engine predates this screen — the
    // window reloaded but the engine process did not. Say that, rather than
    // showing a raw routing error the user cannot act on.
    if (err.apiError.code === 'not_found' && err.apiError.message.startsWith('No route for')) {
      return 'QueryLoad needs to be restarted before this will work — the background engine is still running an older version. Close and reopen the app, then try again.';
    }
    return err.apiError.message;
  }
  return err instanceof Error ? err.message : 'That did not work. Please try again.';
}

function EligibilityChip({ status }: { status: string }): React.JSX.Element {
  const label = status === 'ok' ? 'Fits' : status === 'warn' ? 'Tight' : 'Too large';
  return <span className={`chip chip-elig-${status}`}>{label}</span>;
}
