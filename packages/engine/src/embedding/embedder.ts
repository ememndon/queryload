import { createHash } from 'node:crypto';

/**
 * Embedding dimensionality. Fixed to BGE-M3's 1024 so the vector schema and
 * LanceDB table are correct now and the real model drops in without a reindex
 * of the *schema* (D19: embedder is fixed and never user-selectable).
 */
export const EMBEDDING_DIM = 1024;

export interface Embedder {
  readonly dim: number;
  /** Identifier persisted so we can detect an embedder change and reindex. */
  readonly id: string;
  /**
   * True for a real semantic model (BGE-M3), false for the provisional hashed
   * stand-in. Retrieval only applies a relevance threshold when this is true:
   * the provisional embedder's geometry makes even orthogonal vectors score
   * ~0.41, so a threshold there is meaningless — it's a dev stopgap only.
   */
  readonly semantic: boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Provisional deterministic embedder used until the BGE-M3 runtime lands in
 * Phase 2. It is NOT a semantic model — it is a hashed bag-of-tokens projected
 * into 1024 dims and L2-normalized, so the full ingest → embed → index → search
 * pipeline is exercisable end-to-end today (identical text embeds identically;
 * shared tokens raise cosine similarity). Phase 2 replaces this class with a
 * BGE-M3-backed embedder behind the same interface — nothing else changes.
 *
 * Its `id` differs from the real model's, so when BGE-M3 arrives the engine can
 * detect the embedder change and rebuild the vector index (D19 rationale).
 */
export class ProvisionalEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  readonly id = 'provisional-hash-v1';
  readonly semantic = false;

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dim);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const token of tokens) {
      // Two hashed features per token (sign + bucket) — a compact, stable,
      // network-free stand-in for a learned embedding.
      const h = createHash('sha1').update(token).digest();
      const bucket = h.readUInt32BE(0) % this.dim;
      const sign = (h[4] ?? 0) & 1 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
      const bucket2 = h.readUInt32BE(5) % this.dim;
      vec[bucket2] = (vec[bucket2] ?? 0) + sign * 0.5;
    }
    // L2 normalize so cosine similarity is meaningful.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec, (v) => v / norm);
  }
}
