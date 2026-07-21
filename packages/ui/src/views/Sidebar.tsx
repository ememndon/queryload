import { useMemo, useState } from 'react';
import type { ChatSummary, Workspace } from '@queryload/shared';
import { Dropdown } from '../Dropdown';
import { Modal } from '../Modal';
import { LOGO_DATA_URI } from '../logo';

interface Props {
  workspaces: readonly Workspace[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
  chats: readonly ChatSummary[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
}

/**
 * Left sidebar (D78/D80): serif wordmark, + NEW CHAT, search, workspace
 * selector, chat history grouped by recency, and Settings + Account pinned at
 * the bottom. Carries both navigation layers because access control is
 * workspace-based (D54/D80). The quiet "all local" status lives here (D70).
 */
export function Sidebar(props: Props): React.JSX.Element {
  const [search, setSearch] = useState('');
  /** Conversation awaiting delete confirmation — deletion is permanent (D58). */
  const [confirmDelete, setConfirmDelete] = useState<ChatSummary | null>(null);
  const filtered = useMemo(
    () => props.chats.filter((c) => c.title.toLowerCase().includes(search.trim().toLowerCase())),
    [props.chats, search],
  );
  const groups = useMemo(() => groupByRecency(filtered), [filtered]);

  return (
    <nav className="sidebar">
      <div className="sidebar-word">
        <img className="sidebar-mark" src={LOGO_DATA_URI} alt="" width={42} height={42} />
        QueryLoad
      </div>

      <div className="sidebar-actions">
        <button className="new-chat" onClick={props.onNewChat}>
          + New Chat
        </button>
        <span className="icon-btn" aria-hidden>
          ⌕
        </span>
      </div>

      <div className="sidebar-search">
        <input
          placeholder="Search chats…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      {props.workspaces.length > 1 && (
        <Dropdown
          className="workspace-select"
          value={props.workspaceId}
          onChange={props.onWorkspace}
          ariaLabel="Workspace"
          options={props.workspaces.map((w) => ({ value: w.id, label: w.name }))}
        />
      )}

      <div className="chat-history">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="history-group-label label">{g.label}</div>
            {g.items.map((c) => (
              <div
                key={c.id}
                className={`history-row ${c.id === props.activeChatId ? 'active' : ''}`}
              >
                <button
                  className="history-item"
                  onClick={() => props.onSelectChat(c.id)}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  className="history-delete"
                  onClick={() => setConfirmDelete(c)}
                  title={`Delete "${c.title}"`}
                  aria-label={`Delete conversation: ${c.title}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
        {props.chats.length === 0 && <div className="history-group-label label">No chats yet</div>}
      </div>

      <div className="sidebar-footer">
        <span className="net-quiet" title="This app makes no network calls at runtime.">
          <span className="live-dot" />
          All local
        </span>
        <button className="footer-item" onClick={props.onOpenSettings}>
          <span className="glyph">⚙</span> Settings
        </button>
        <button className="footer-item" onClick={props.onOpenAccount}>
          <span className="glyph">◐</span> Account
        </button>
      </div>

      {confirmDelete && (
        <Modal
          titleId="delete-chat-title"
          onClose={() => setConfirmDelete(null)}
          overlayClassName="drop-modal"
          cardClassName="drop-card"
        >
          <div className="drop-title" id="delete-chat-title">
            Delete this conversation?
          </div>
          <p className="settings-hint">
            “{confirmDelete.title}” and its answers will be permanently removed from this computer.
            This cannot be undone. Your documents are not affected.
          </p>
          <div className="drop-actions">
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                props.onDeleteChat(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </nav>
  );
}

interface RecencyGroup {
  label: string;
  items: ChatSummary[];
}

/** Group chats into TODAY / PREVIOUS 7 DAYS / OLDER by updatedAt (D78). */
function groupByRecency(chats: readonly ChatSummary[]): RecencyGroup[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const today: ChatSummary[] = [];
  const week: ChatSummary[] = [];
  const older: ChatSummary[] = [];
  for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const age = now - c.updatedAt;
    if (age < dayMs) today.push(c);
    else if (age < 7 * dayMs) week.push(c);
    else older.push(c);
  }
  const out: RecencyGroup[] = [];
  if (today.length) out.push({ label: 'Today', items: today });
  if (week.length) out.push({ label: 'Previous 7 Days', items: week });
  if (older.length) out.push({ label: 'Older', items: older });
  return out;
}
