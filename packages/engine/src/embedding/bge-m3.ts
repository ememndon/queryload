import { EMBEDDING_DIM, type Embedder } from './embedder.js';

/**
 * BGE-M3 embedder (D19) — the fixed, hidden embedding model. It calls the
 * loopback BGE-M3 llama.cpp sidecar's OpenAI-compatible `/v1/embeddings`
 * endpoint. Its `id` differs from the provisional embedder, so when it becomes
 * available the engine detects the change and the index is rebuilt (changing
 * embedders invalidates vectors).
 */
export class BgeM3Embedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  readonly id = 'bge-m3';
  readonly semantic = true;

  constructor(private readonly getBaseUrl: () => Promise<string | null>) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const baseUrl = await this.getBaseUrl();
    if (!baseUrl) throw new Error('The embedding runtime is not available.');

    // Batch so a large file (thousands of chunks) doesn't become one enormous
    // request that can blow the sidecar's request-size / batch limits.
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      out.push(...(await this.embedBatch(baseUrl, texts.slice(i, i + EMBED_BATCH))));
    }
    return out;
  }

  private async embedBatch(baseUrl: string, batch: readonly string[]): Promise<number[][]> {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: batch, model: 'bge-m3' }),
    });
    if (!res.ok) throw new Error(`Embedding server error: HTTP ${res.status}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    // Preserve input order (the API returns an `index` per item).
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    // L2-normalize so vector distance ranks as cosine similarity, matching the
    // ProvisionalEmbedder (which emits unit vectors). Without this, query and
    // passage magnitudes vary and the default L2 metric mis-ranks results.
    return ordered.map((d) => l2normalize(d.embedding));
  }
}

/** Chunks per embedding request. */
const EMBED_BATCH = 64;

/** Return the unit vector; leaves an all-zero vector unchanged. */
function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((x) => x / norm);
}
