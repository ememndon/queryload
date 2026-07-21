import type { Repositories } from '../db/repos.js';
import type { VectorStore } from '../index/vector-store.js';
import type { Embedder } from '../embedding/embedder.js';

/** A retrieved chunk with everything needed to ground + cite an answer. */
export interface RetrievedContext {
  readonly chunkId: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly docType: string;
  readonly page: number | null;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly score: number;
}

/** Raised when a user tries to reach a workspace they don't belong to. */
export class ForbiddenWorkspaceError extends Error {
  constructor() {
    super('You do not have access to that workspace.');
    this.name = 'ForbiddenWorkspaceError';
  }
}

const PINNED_CHUNK_CAP = 40;

/**
 * Minimum relevance score (score = 1/(1+distance) on unit vectors, so ~cosine)
 * for a retrieved chunk to count as "about" the query. Below this, hits are
 * dropped; if nothing survives, the caller gets an empty result and falls
 * through to the deterministic "not in your documents" refusal (D59). Only
 * applied for a real semantic embedder — see {@link Embedder.semantic}.
 * Conservative default; tune against the observed BGE-M3 distance distribution.
 */
const MIN_RELEVANCE_SCORE = 0.45;

/**
 * Retrieval with the ethical wall enforced IN THE QUERY (D47/D54), not in the
 * UI. Two independent guards:
 *   1. Membership check — the user must belong to the workspace, or nothing is
 *      retrieved (ForbiddenWorkspaceError).
 *   2. The vector search is hard-filtered by workspace_id as a pre-filter, so
 *      vectors from other workspaces are never even ranked.
 */
export class Retriever {
  constructor(
    private readonly repos: Repositories,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  private assertAccess(userId: string, workspaceId: string): void {
    if (!this.repos.memberships.isMember(userId, workspaceId)) {
      throw new ForbiddenWorkspaceError();
    }
  }

  async retrieve(
    userId: string,
    workspaceId: string,
    query: string,
    k = 8,
  ): Promise<RetrievedContext[]> {
    this.assertAccess(userId, workspaceId);
    const [vector] = await this.embedder.embed([query]);
    if (!vector) return [];
    const hits = await this.vectors.search(vector, workspaceId, k);
    const chunkRows = this.repos.chunks.getByIds(hits.map((h) => h.id));
    const byId = new Map(chunkRows.map((c) => [c.id, c]));
    // Batch the file lookups (one query) instead of getById per hit (N+1).
    const fileById = new Map(
      this.repos.files
        .getByIds([...new Set(chunkRows.map((c) => c.file_id))])
        .map((f) => [f.id, f]),
    );

    const contexts: RetrievedContext[] = [];
    for (const hit of hits) {
      const chunk = byId.get(hit.id);
      if (!chunk) continue;
      // Defence in depth: never surface a chunk from another workspace.
      if (chunk.workspace_id !== workspaceId) continue;
      const score = 1 / (1 + hit.distance);
      // Relevance gate: for a real semantic embedder, drop off-topic hits so an
      // unrelated question yields nothing and the grounded refusal fires (D59).
      // Skipped for the provisional embedder (its scores aren't meaningful).
      if (this.embedder.semantic && score < MIN_RELEVANCE_SCORE) continue;
      const file = fileById.get(chunk.file_id);
      contexts.push({
        chunkId: chunk.id,
        fileId: chunk.file_id,
        fileName: file ? baseName(file.path) : 'document',
        filePath: file?.path ?? '',
        docType: file?.type ?? 'text',
        page: chunk.page,
        charStart: chunk.char_start,
        charEnd: chunk.char_end,
        text: chunk.text,
        score,
      });
    }
    return contexts;
  }

  /** Pinned files: their chunks are always in context, bypassing retrieval (D61). */
  pinnedContext(
    userId: string,
    workspaceId: string,
    fileIds: readonly string[],
  ): RetrievedContext[] {
    this.assertAccess(userId, workspaceId);
    const contexts: RetrievedContext[] = [];
    for (const fileId of fileIds) {
      const file = this.repos.files.getById(fileId);
      if (!file || file.workspace_id !== workspaceId) continue; // ethical wall
      for (const chunk of this.repos.chunks.listByFile(fileId).slice(0, PINNED_CHUNK_CAP)) {
        contexts.push({
          chunkId: chunk.id,
          fileId,
          fileName: baseName(file.path),
          filePath: file.path,
          docType: file.type,
          page: chunk.page,
          charStart: chunk.char_start,
          charEnd: chunk.char_end,
          text: chunk.text,
          score: 1,
        });
      }
    }
    return contexts;
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
