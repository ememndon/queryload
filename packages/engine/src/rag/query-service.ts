import { randomUUID } from 'node:crypto';
import type { Citation, QueryRequest, QueryStreamEvent } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import type { Repositories } from '../db/repos.js';
import type { InferenceScheduler } from '../inference/scheduler.js';
import type { Retriever } from './retriever.js';
import { ForbiddenWorkspaceError, type RetrievedContext } from './retriever.js';
import { assemblePrompt, ANSWER_STOP_SEQUENCES, NO_CONTEXT_ANSWER } from './prompt.js';
import { ThinkingFilter, stripThinking } from './thinking.js';
import { findTask } from './tasks.js';
import type { AuditService } from '../audit/audit-service.js';

const MAX_CONTEXTS = 16;
/**
 * Approximate token ceiling for the whole context block, leaving headroom for
 * the system prompt + generated answer within a typical ~8k window. Chunks
 * beyond this are dropped rather than silently overflowing the model and
 * truncating cited excerpts. (~4 chars/token until the real tokenizer lands.)
 */
const CONTEXT_TOKEN_BUDGET = 6000;

export interface QueryServiceDeps {
  readonly retriever: Retriever;
  readonly scheduler: InferenceScheduler;
  readonly repos: Repositories;
  readonly audit: AuditService;
  readonly logger: Logger;
}

/** Raised when a chat id doesn't belong to the requesting user/workspace. */
export class ChatAccessError extends Error {
  constructor() {
    super('That conversation is not available.');
    this.name = 'ChatAccessError';
  }
}

/**
 * The RAG query orchestrator: retrieve (ethical wall) → assemble a grounded,
 * injection-resistant prompt → stream the answer → persist the exchange with
 * page-level citations. Emits {@link QueryStreamEvent}s the API relays as SSE.
 */
export class QueryService {
  constructor(private readonly deps: QueryServiceDeps) {}

  /** The ethical wall, checkable before any work (used by the route pre-stream). */
  assertAccess(userId: string, workspaceId: string): void {
    if (!this.deps.repos.memberships.isMember(userId, workspaceId)) {
      throw new ForbiddenWorkspaceError();
    }
  }

  async run(
    userId: string,
    req: QueryRequest,
    emit: (event: QueryStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { repos, retriever, scheduler } = this.deps;
    this.assertAccess(userId, req.workspaceId); // no orphan chat on a forbidden request
    const chatId = this.resolveChat(userId, req);

    // Gather context: pinned files (always in) + retrieval. Retrieval throws if
    // the user isn't a member of the workspace (the ethical wall).
    const task = req.taskId ? findTask(req.taskId) : undefined;
    const pinned = req.pinnedFileIds?.length
      ? retriever.pinnedContext(userId, req.workspaceId, req.pinnedFileIds)
      : [];
    const retrieved = await retriever.retrieve(userId, req.workspaceId, req.query, task?.k ?? 8);
    const contexts = assembleContexts(pinned, retrieved);

    // Persist the user's message and title the chat on first turn.
    repos.messages.add({
      id: randomUUID(),
      chat_id: chatId,
      role: 'user',
      content: req.query,
      citations: null,
      created_at: Date.now(),
    });
    this.maybeTitle(chatId, req.query);
    repos.chats.touch(chatId);

    // Grounding guard: no context → deterministic, honest refusal (D59). This
    // guarantees the "your documents don't contain this" behaviour even before
    // a model is installed.
    if (contexts.length === 0) {
      emit({ type: 'meta', chatId, citations: [] });
      for (const tok of chunkText(NO_CONTEXT_ANSWER)) emit({ type: 'token', token: tok });
      const messageId = this.persistAssistant(chatId, NO_CONTEXT_ANSWER, []);
      this.deps.audit.recordQuery({
        userId,
        workspaceId: req.workspaceId,
        query: req.query,
        answer: NO_CONTEXT_ANSWER,
        sources: [],
      });
      emit({ type: 'done', messageId });
      return;
    }

    const { prompt, system, citations } = assemblePrompt(req.query, contexts, task?.instruction);
    emit({ type: 'meta', chatId, citations });

    if (!scheduler.available) {
      emit({
        type: 'error',
        message: 'No model is installed yet. Choose a model under Model to start answering.',
      });
      return;
    }

    let answer = '';
    // Reasoning models emit a <think> scratchpad before the answer; strip it so
    // it is never shown, stored, or audited. A no-op for every other model.
    const thinking = new ThinkingFilter();
    try {
      const handle = scheduler.submit(
        { userId, prompt, system, maxTokens: 900, temperature: 0.2, stop: ANSWER_STOP_SEQUENCES },
        (token) => {
          const visible = thinking.push(token);
          if (visible.length === 0) return;
          answer += visible;
          emit({ type: 'token', token: visible });
        },
        signal,
      );
      const result = await handle.done;
      const tail = thinking.flush();
      if (tail.length > 0) {
        answer += tail;
        emit({ type: 'token', token: tail });
      }
      answer = stripThinking(result.text) || answer;
      const messageId = this.persistAssistant(chatId, answer, citations);
      this.deps.audit.recordQuery({
        userId,
        workspaceId: req.workspaceId,
        query: req.query,
        answer,
        sources: citations.map((c) => ({ fileName: c.fileName, page: c.page })),
      });
      emit({ type: 'done', messageId });
    } catch (err) {
      // A stop the user asked for is not a failure. Persist whatever was
      // already streamed and close cleanly, rather than replacing a part-written
      // answer with an error banner.
      if (signal.aborted) {
        this.deps.logger.info({ chatId }, 'query cancelled by the user');
        const messageId = this.persistAssistant(chatId, answer.trim(), citations);
        emit({ type: 'done', messageId });
        return;
      }
      this.deps.logger.error({ err: describe(err) }, 'query generation failed');
      emit({ type: 'error', message: 'The answer could not be generated. Please try again.' });
    }
  }

  private resolveChat(userId: string, req: QueryRequest): string {
    if (req.chatId) {
      const chat = this.deps.repos.chats.get(req.chatId);
      if (!chat || chat.user_id !== userId || chat.workspace_id !== req.workspaceId) {
        throw new ChatAccessError();
      }
      return chat.id;
    }
    const id = randomUUID();
    const now = Date.now();
    this.deps.repos.chats.create({
      id,
      user_id: userId,
      workspace_id: req.workspaceId,
      title: 'New chat',
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  private maybeTitle(chatId: string, query: string): void {
    const chat = this.deps.repos.chats.get(chatId);
    if (chat && chat.title === 'New chat') {
      this.deps.repos.chats.setTitle(chatId, query.slice(0, 60).trim() || 'New chat');
    }
  }

  private persistAssistant(
    chatId: string,
    content: string,
    citations: readonly Citation[],
  ): string {
    const id = randomUUID();
    this.deps.repos.messages.add({
      id,
      chat_id: chatId,
      role: 'assistant',
      content,
      citations: JSON.stringify(citations),
      created_at: Date.now(),
    });
    this.deps.repos.chats.touch(chatId);
    return id;
  }
}

/**
 * Merge pinned + retrieved context. Reserve at least half the slots for
 * RETRIEVAL so a large pinned file can't crowd the user's actual question out
 * entirely (H7), then trim to an approximate token budget so a few big chunks
 * can't overflow the model's context window.
 */
function assembleContexts(
  pinned: readonly RetrievedContext[],
  retrieved: readonly RetrievedContext[],
): RetrievedContext[] {
  const half = Math.floor(MAX_CONTEXTS / 2);
  const keepRetrieved = retrieved.slice(0, Math.max(half, MAX_CONTEXTS - pinned.length));
  const keepPinned = pinned.slice(0, Math.max(0, MAX_CONTEXTS - keepRetrieved.length));
  const merged = dedupe([...keepPinned, ...keepRetrieved]).slice(0, MAX_CONTEXTS);

  const out: RetrievedContext[] = [];
  let tokens = 0;
  for (const c of merged) {
    const t = Math.ceil(c.text.length / 4);
    if (out.length > 0 && tokens + t > CONTEXT_TOKEN_BUDGET) break;
    out.push(c);
    tokens += t;
  }
  return out;
}

function dedupe(contexts: readonly RetrievedContext[]): RetrievedContext[] {
  const seen = new Set<string>();
  const out: RetrievedContext[] = [];
  for (const c of contexts) {
    if (seen.has(c.chunkId)) continue;
    seen.add(c.chunkId);
    out.push(c);
  }
  return out;
}

/** Split canned text into word tokens so the no-context path also "streams". */
function chunkText(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0);
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
