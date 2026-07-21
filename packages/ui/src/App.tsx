import { useCallback, useEffect, useState } from 'react';
import type { ChatSummary, Workspace } from '@queryload/shared';
import { EngineClient } from './api/client';
import { Sidebar } from './views/Sidebar';
import { Chat } from './views/Chat';
import { SettingsSurface } from './views/SettingsSurface';
import { Wizard } from './views/Wizard';

type Conn =
  | { phase: 'connecting' }
  | { phase: 'ready'; client: EngineClient }
  | { phase: 'error'; message: string };

type Surface = 'chat' | 'settings';

/**
 * The QueryLoad shell (D78/D80): a three-region grid — sidebar, center column,
 * References rail — rendered in the sole dark editorial theme. The composer
 * lives inside the center column track (D79). The first-run wizard overlays on
 * a fresh install.
 */
export function App(): React.JSX.Element {
  const [conn, setConn] = useState<Conn>({ phase: 'connecting' });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('chat');
  const [settingsTab, setSettingsTab] = useState<'documents' | 'model' | 'account'>('documents');
  const [chatsVersion, setChatsVersion] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const client = await EngineClient.connect();
        await client.health();
        const ws = await client.listWorkspaces();
        if (cancelled) return;
        setWorkspaces(ws);
        setWorkspaceId(ws[0]?.id ?? '');
        setConn({ phase: 'ready', client });
        try {
          setWizardOpen(window.localStorage.getItem('queryload.wizardComplete') !== '1');
        } catch {
          setWizardOpen(false);
        }
      } catch (err) {
        if (!cancelled) {
          setConn({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    void load();
    const unsub = window.queryload.onEngineChanged(() => void load());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Refresh the sidebar chat list.
  useEffect(() => {
    if (conn.phase !== 'ready' || !workspaceId) return;
    void conn.client
      .listChats(workspaceId)
      .then(setChats)
      .catch(() => undefined);
  }, [conn, workspaceId, chatsVersion]);

  const onChatChanged = useCallback((id: string) => {
    setActiveChatId(id);
    setChatsVersion((v) => v + 1);
  }, []);

  /** Delete one conversation. Its messages go with it (ON DELETE CASCADE). */
  const onDeleteChat = useCallback(
    async (id: string) => {
      if (conn.phase !== 'ready') return;
      await conn.client.deleteChat(id);
      // Clear the view if the open conversation is the one just removed.
      setActiveChatId((current) => (current === id ? null : current));
      setChatsVersion((v) => v + 1);
    },
    [conn],
  );

  if (conn.phase === 'connecting') {
    return (
      <div className="label" style={{ padding: 48 }}>
        Connecting to the local engine…
      </div>
    );
  }
  if (conn.phase === 'error') {
    return (
      <div className="banner-warn" style={{ margin: 48 }}>
        Could not reach the local engine.
        <br />
        {conn.message}
      </div>
    );
  }

  const client = conn.client;
  return (
    <div className="shell">
      <Sidebar
        workspaces={workspaces}
        workspaceId={workspaceId}
        onWorkspace={setWorkspaceId}
        chats={chats}
        activeChatId={activeChatId}
        onDeleteChat={(id) => void onDeleteChat(id)}
        onSelectChat={(id) => {
          setActiveChatId(id);
          setSurface('chat');
        }}
        onNewChat={() => {
          setActiveChatId(null);
          setSurface('chat');
        }}
        onOpenSettings={() => {
          setSettingsTab('documents');
          setSurface('settings');
        }}
        onOpenAccount={() => {
          setSettingsTab('account');
          setSurface('settings');
        }}
      />

      {surface === 'chat' ? (
        <Chat
          client={client}
          workspaceId={workspaceId}
          chatId={activeChatId}
          onChatChanged={onChatChanged}
        />
      ) : (
        <SettingsSurface
          client={client}
          initialTab={settingsTab}
          onClose={() => setSurface('chat')}
        />
      )}

      {wizardOpen && <Wizard client={client} onDone={() => setWizardOpen(false)} />}
    </div>
  );
}
