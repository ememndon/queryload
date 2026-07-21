import { useState } from 'react';
import type { EngineClient } from '../api/client';
import { Settings } from './Settings';
import { Models } from './Models';
import { Admin } from './Admin';

interface Props {
  client: EngineClient;
  initialTab?: SettingsTab;
  onClose: () => void;
}

type SettingsTab = 'documents' | 'model' | 'admin' | 'account';

/**
 * The settings surface, opened from the sidebar. Occupies the center +
 * references tracks (no rail here). Tabs mirror the plain-English admin areas;
 * accounts/roles/retention/audit fill out in Phase 5.
 */
export function SettingsSurface({
  client,
  initialTab = 'documents',
  onClose,
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="settings-surface">
      <div className="settings-tabs">
        <button
          className={`settings-tab ${tab === 'documents' ? 'active' : ''}`}
          onClick={() => setTab('documents')}
        >
          Documents
        </button>
        <button
          className={`settings-tab ${tab === 'model' ? 'active' : ''}`}
          onClick={() => setTab('model')}
        >
          Model
        </button>
        <button
          className={`settings-tab ${tab === 'admin' ? 'active' : ''}`}
          onClick={() => setTab('admin')}
        >
          Admin
        </button>
        <button
          className={`settings-tab ${tab === 'account' ? 'active' : ''}`}
          onClick={() => setTab('account')}
        >
          Account
        </button>
        <button className="new-chat" style={{ marginLeft: 'auto' }} onClick={onClose}>
          ← Back to chat
        </button>
      </div>

      {tab === 'documents' && <Settings client={client} />}
      {tab === 'model' && <Models client={client} />}
      {tab === 'admin' && <Admin client={client} />}
      {tab === 'account' && <AccountPanel version={client.version} />}
    </div>
  );
}

function AccountPanel({ version }: { version: string }): React.JSX.Element {
  const feedbackHref = `mailto:?subject=${encodeURIComponent(
    `QueryLoad feedback (v${version})`,
  )}&body=${encodeURIComponent(
    `\n\n---\nApp version: ${version}\n(Please describe what happened. Never include confidential document content.)`,
  )}`;
  return (
    <div>
      <div className="label">Account</div>
      <p className="settings-hint">
        Local account, roles, retention, and the audit log arrive in a later update. QueryLoad makes
        no network calls at runtime — your documents never leave this machine.
      </p>
      <div className="hw-card">
        <span>Version {version}</span>
        <span className="muted">·</span>
        <span className="live-label">All local</span>
      </div>
      <div className="path-input-row" style={{ marginTop: 16 }}>
        <a className="btn" href={feedbackHref}>
          Send Feedback
        </a>
      </div>
    </div>
  );
}
