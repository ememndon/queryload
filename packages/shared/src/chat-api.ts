/**
 * Phase 3 API contract — RAG chat, citations, grounding, task library.
 */

/** A citation resolving an answer claim to an exact source location. */
export interface Citation {
  /** The [n] marker used inline in the answer. */
  readonly marker: number;
  readonly chunkId: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly docType: string;
  /** 1-based page for paginated docs; null for DOCX/email/text. */
  readonly page: number | null;
  /** Character range in the document (for opening a preview at the location). */
  readonly charStart: number;
  readonly charEnd: number;
  /** Excerpt shown in the hover preview card before opening the source. */
  readonly excerpt: string;
}

export type ChatRole = 'user' | 'assistant';

export interface StoredMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly citations: readonly Citation[];
  readonly createdAt: number;
}

export interface ChatSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Per-drop disposition when a file is dragged into a chat (D65). */
export type DropDisposition = 'workspace-index' | 'session-only';

export interface QueryRequest {
  readonly workspaceId: string;
  readonly query: string;
  /** Continue an existing chat, or omit to start a new one. */
  readonly chatId?: string;
  /** Files pinned into context, bypassing retrieval (D61). */
  readonly pinnedFileIds?: readonly string[];
  /** Apply a saved task-library prompt (D64). */
  readonly taskId?: string;
}

/** Server-sent events emitted by the streaming query endpoint. */
export type QueryStreamEvent =
  | { readonly type: 'meta'; readonly chatId: string; readonly citations: readonly Citation[] }
  | { readonly type: 'token'; readonly token: string }
  | { readonly type: 'done'; readonly messageId: string }
  | { readonly type: 'error'; readonly message: string };

/** A saved professional prompt (D64). Timeline/contradiction/template flows. */
export type TaskKind =
  | 'summary'
  | 'obligations'
  | 'timeline'
  | 'contradictions'
  | 'template'
  | 'custom';

export interface TaskDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: TaskKind;
}

export interface ResolveFileResponse {
  readonly fileId: string;
  readonly fileName: string;
  readonly workspaceId: string;
}

export const ChatRoutes = {
  chats: '/v1/chats',
  chat: (id: string): string => `/v1/chats/${encodeURIComponent(id)}`,
  messages: (id: string): string => `/v1/chats/${encodeURIComponent(id)}/messages`,
  query: '/v1/chat/query',
  tasks: '/v1/tasks',
  /** Resolve a dropped file's path to its indexed file id (for pinning, D65). */
  resolveFile: '/v1/files/resolve',
} as const;
