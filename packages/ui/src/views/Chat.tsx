import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, ModelCatalogEntry, TaskDefinition } from '@queryload/shared';
import { ApiRequestError, type EngineClient } from '../api/client';
import { Modal } from '../Modal';
import { Dropdown } from '../Dropdown';

interface Props {
  client: EngineClient;
  workspaceId: string;
  chatId: string | null;
  onChatChanged: (chatId: string) => void;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  citations: readonly Citation[];
  at: number;
}

interface PinnedFile {
  readonly fileId: string;
  readonly fileName: string;
}

type DropPrompt = { path: string; fileName: string } | null;

/**
 * Center column + References rail (D78). The composer is a child of the center
 * column track and shares its max-width — never spanning under the rail (D79).
 * A runtime guard also checks this geometry live; layout.test.tsx checks it in CI.
 */
export function Chat({ client, workspaceId, chatId, onChatChanged }: Props): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [taskId, setTaskId] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState<PinnedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dropPrompt, setDropPrompt] = useState<DropPrompt>(null);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Aborts the in-flight streamed query on stop, chat-switch, or unmount. */
  const abortRef = useRef<AbortController | null>(null);
  /** The chat id currently being streamed into — so the load-messages effect
   * doesn't refetch and clobber the live turns when a brand-new chat's id
   * propagates back via onChatChanged. */
  const streamingChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    void client
      .listTasks()
      .then(setTasks)
      .catch(() => undefined);
  }, [client]);

  // Which models are installed, and which one is answering. Kept in the
  // composer so switching models never means leaving the conversation.
  const refreshModels = useCallback(async () => {
    try {
      const res = await client.listModels();
      setModels(res.models.filter((m) => m.installed).map((m) => m.entry));
      setActiveModelId(res.activeModelId);
    } catch {
      /* transient — the picker just stays as it was */
    }
  }, [client]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const onPickModel = useCallback(
    async (id: string) => {
      if (id === activeModelId) return;
      const previous = activeModelId;
      setActiveModelId(id); // optimistic, so the picker feels immediate
      try {
        await client.activateModel(id);
        setError(null);
      } catch (err) {
        setActiveModelId(previous);
        setError(
          err instanceof ApiRequestError
            ? err.apiError.message
            : 'That model could not be started.',
        );
      }
      await refreshModels();
    },
    [activeModelId, client, refreshModels],
  );

  // Load an existing chat's messages (or clear for a new chat).
  useEffect(() => {
    let cancelled = false;
    if (!chatId) {
      setTurns([]);
      setPinned([]);
      return;
    }
    // The chat we're actively streaming into: don't refetch over the live turns.
    if (chatId === streamingChatIdRef.current) return;
    // Navigated to a different chat while a stream was running — stop it first.
    abortRef.current?.abort();
    void client.chatMessages(chatId).then((msgs) => {
      if (cancelled) return;
      setTurns(
        msgs.map((m) => ({
          role: m.role,
          content: m.content,
          citations: m.citations,
          at: m.createdAt,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [client, chatId]);

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  // Abort any in-flight stream when the Chat surface unmounts (e.g. the user
  // opens Settings) so inference and the SSE reader don't keep running.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Auto-grow the composer textarea with its content (and shrink back on reset).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Runtime D79 guard: the composer must never extend past the center column.
  useEffect(() => {
    const composer = composerRef.current;
    const center = centerRef.current;
    if (!composer || !center) return;
    const cb = composer.getBoundingClientRect();
    const nb = center.getBoundingClientRect();
    if (cb.right > nb.right + 1 || cb.left < nb.left - 1) {
      console.error('D79 layout violation: composer exceeds the center column track.', { cb, nb });
    }
    // Re-check when the turn count changes (layout can shift), not on every
    // render — otherwise this forces a synchronous layout on every streamed token.
  }, [turns.length]);

  const lastAssistant = useMemo(
    () => [...turns].reverse().find((t) => t.role === 'assistant'),
    [turns],
  );
  const title = useMemo(() => {
    const firstUser = turns.find((t) => t.role === 'user');
    return firstUser ? firstUser.content.slice(0, 80) : null;
  }, [turns]);

  const send = useCallback(async () => {
    const query = input.trim();
    if (!query || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    const now = Date.now();
    setTurns((t) => [
      ...t,
      { role: 'user', content: query, citations: [], at: now },
      { role: 'assistant', content: '', citations: [], at: now },
    ]);
    const wasNew = !chatId;

    // Fresh AbortController for this stream; supersede any prior one.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    streamingChatIdRef.current = chatId;

    const updateAssistant = (fn: (t: Turn) => Turn): void =>
      setTurns((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i]!.role === 'assistant') {
            copy[i] = fn(copy[i]!);
            break;
          }
        }
        return copy;
      });

    try {
      await client.streamQuery(
        {
          workspaceId,
          query,
          ...(chatId ? { chatId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(pinned.length ? { pinnedFileIds: pinned.map((p) => p.fileId) } : {}),
        },
        (event) => {
          if (event.type === 'meta') {
            // Keep the load-messages effect from clobbering this live stream
            // once the new chat's id propagates back through onChatChanged.
            streamingChatIdRef.current = event.chatId;
            if (wasNew) onChatChanged(event.chatId);
            updateAssistant((t) => ({ ...t, citations: event.citations }));
          } else if (event.type === 'token') {
            updateAssistant((t) => ({ ...t, content: t.content + event.token }));
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        ac.signal,
      );
    } catch (err) {
      // An intentional stop / navigation abort is not an error.
      if (!ac.signal.aborted) {
        setError(err instanceof ApiRequestError ? err.apiError.message : 'The query failed.');
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        streamingChatIdRef.current = null;
      }
      setBusy(false);
    }
  }, [input, busy, workspaceId, client, chatId, taskId, pinned, onChatChanged]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  // "+" — pick a single document and route it through the same attach flow as
  // drag-and-drop. (Whole folders are added under Settings → Documents.)
  const addFiles = useCallback(async () => {
    const path = await window.queryload.pickFile();
    if (!path) return;
    const fileName = path.split(/[\\/]/).pop() || path;
    setDropPrompt({ path, fileName });
  }, []);

  const pinFromCitation = useCallback((c: Citation) => {
    setPinned((prev) =>
      prev.some((p) => p.fileId === c.fileId)
        ? prev
        : [...prev, { fileId: c.fileId, fileName: c.fileName }],
    );
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Electron removed File.path in v32; the preload bridge resolves the real
    // filesystem path via webUtils.getPathForFile (H15). Without this, the drop
    // flow silently did nothing on Electron 33.
    const path = window.queryload.getDroppedFilePath(file);
    if (path) setDropPrompt({ path, fileName: file.name });
  }, []);

  const confirmDrop = useCallback(
    async (disposition: 'workspace-index' | 'session-only') => {
      if (!dropPrompt) return;
      if (disposition === 'session-only') {
        try {
          const r = await client.resolveFile(dropPrompt.path);
          setPinned((prev) =>
            prev.some((p) => p.fileId === r.fileId)
              ? prev
              : [...prev, { fileId: r.fileId, fileName: r.fileName }],
          );
        } catch {
          setError('That file isn’t indexed yet. Add its folder under Settings → Documents.');
        }
      } else {
        setError('To index a new file, add its folder under Settings → Documents.');
      }
      setDropPrompt(null);
    },
    [dropPrompt, client],
  );

  return (
    <>
      <section className="center" ref={centerRef} data-region="center">
        <div className="center-scroll" ref={scrollRef}>
          <div className="center-inner">
            {turns.length === 0 ? (
              <div className="center-empty">
                <div className="wordmark">QueryLoad</div>
                <div className="tagline">
                  Ask a question about your documents. Every answer is traceable to its source.
                </div>
              </div>
            ) : (
              <>
                {title && <h1 className="matter-title">{title}</h1>}
                {turns.map((t, i) =>
                  t.role === 'user' ? (
                    <div className="intent-block" key={i}>
                      <span className="label">User Intent</span>
                      <div className="user-query">{t.content}</div>
                    </div>
                  ) : (
                    <div key={i}>
                      <div
                        className="answer"
                        aria-live={busy && i === turns.length - 1 ? 'polite' : undefined}
                        aria-atomic={false}
                      >
                        {renderWithMarkers(t.content, t.citations.length)}
                      </div>
                      {busy && i === turns.length - 1 ? (
                        <div className="processing">
                          <span className="live-dot" />
                          <span className="live-label live-ellipsis">Processing</span>
                        </div>
                      ) : (
                        t.content && <ActionRow text={t.content} at={t.at} />
                      )}
                    </div>
                  ),
                )}
              </>
            )}
            {error && <div className="banner-warn">{error}</div>}
          </div>
        </div>

        {/* Composer — inside the center column track (D79). */}
        <div className="composer-wrap" ref={composerRef} data-testid="composer">
          <div className="composer-inner">
            {pinned.length > 0 && (
              <div className="pins">
                {pinned.map((p) => (
                  <span className="pin-chip" key={p.fileId}>
                    📌 {p.fileName}
                    <button
                      aria-label={`Unpin ${p.fileName}`}
                      onClick={() => setPinned((prev) => prev.filter((x) => x.fileId !== p.fileId))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              className="composer"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onDrop(e)}
            >
              <textarea
                ref={inputRef}
                className="composer-input"
                placeholder="Type your intent…"
                aria-label="Ask a question about your documents"
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline (chat convention).
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                disabled={busy}
              />
              <div className="composer-bar">
                <button
                  className="composer-add"
                  onClick={() => void addFiles()}
                  title="Add documents"
                  aria-label="Add documents"
                >
                  +
                </button>
                <Dropdown
                  value={taskId}
                  onChange={setTaskId}
                  ariaLabel="Task library"
                  placement="top"
                  options={[
                    { value: '', label: 'Ask…' },
                    ...tasks.map((t) => ({ value: t.id, label: t.name })),
                  ]}
                />
                <Dropdown
                  className="model-picker"
                  value={activeModelId ?? ''}
                  onChange={(id) => void onPickModel(id)}
                  ariaLabel="Model answering this question"
                  placement="top"
                  options={
                    models.length > 0
                      ? models.map((m) => ({ value: m.id, label: m.name }))
                      : [{ value: '', label: 'No model installed' }]
                  }
                />
                {busy ? (
                  <button
                    className="composer-send"
                    onClick={stop}
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    ■
                  </button>
                ) : (
                  <button
                    className="composer-send composer-send-arrow"
                    onClick={() => void send()}
                    title="Send"
                    aria-label="Send"
                  >
                    ↑
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside className="references" data-region="references" aria-label="References">
        <span className="label">References</span>
        {!lastAssistant?.citations.length && <div className="muted small">No sources yet.</div>}
        {lastAssistant?.citations.map((c) => (
          <div className="ref-entry" key={c.chunkId} title={c.excerpt}>
            <button
              className="ref-open"
              onClick={() => void window.queryload.openSource(c.filePath, c.page)}
            >
              <span className="ref-doc" aria-hidden>
                ▤
              </span>
              <span className="ref-name">
                {c.fileName}
                {c.page !== null ? ` · p.${c.page}` : ''}
              </span>
            </button>
            <button className="ref-pin" title="Pin to context" onClick={() => pinFromCitation(c)}>
              pin
            </button>
            <div className="ref-card">{c.excerpt}</div>
          </div>
        ))}
      </aside>

      {dropPrompt && (
        <Modal
          titleId="drop-title"
          onClose={() => setDropPrompt(null)}
          overlayClassName="drop-modal"
          cardClassName="drop-card"
        >
          <div className="drop-title" id="drop-title">
            Add “{dropPrompt.fileName}” to this chat
          </div>
          <div className="drop-actions">
            <button className="btn" onClick={() => void confirmDrop('session-only')}>
              This session only
            </button>
            <button className="btn btn-primary" onClick={() => void confirmDrop('workspace-index')}>
              Add to workspace index
            </button>
            <button className="btn btn-ghost" onClick={() => setDropPrompt(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ActionRow({ text, at }: { text: string; at: number }): React.JSX.Element {
  return (
    <div className="action-row">
      <button
        className="action"
        title="Copy"
        aria-label="Copy answer"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        ⧉
      </button>
      <button className="action" title="Good answer" aria-label="Good answer">
        ▲
      </button>
      <button className="action" title="Poor answer" aria-label="Poor answer">
        ▽
      </button>
      <button
        className="action"
        title="Share"
        aria-label="Copy answer to share"
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        ↗
      </button>
      <span className="timestamp">{formatStamp(at)}</span>
    </div>
  );
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${hh}:${mm} UTC`;
}

/**
 * Render answer text, styling [n] citation markers in the accent colour — but
 * ONLY when n refers to a real source (1..citationCount). An out-of-range marker
 * (e.g. [7] when there are 3 sources) is left as plain text so a hallucinated
 * citation isn't surfaced as if it were authoritative.
 */
function renderWithMarkers(text: string, citationCount: number): React.ReactNode {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    const n = m ? Number(m[1]) : NaN;
    return m && n >= 1 && n <= citationCount ? (
      <span className="cite-marker" key={i}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    );
  });
}
