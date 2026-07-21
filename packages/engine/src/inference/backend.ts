import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The inference backend abstraction. The scheduler (slots + fair queue) runs
 * jobs against whatever backend is active:
 *   - LlamaServerBackend — the real hidden llama.cpp sidecar (Phase 3 uses it).
 *   - NotProvisionedBackend — before a model is installed; rejects clearly.
 *   - StubBackend — deterministic fake streaming, for tests of the scheduler.
 *
 * Phase 2 delivers the management layer; Phase 3 sends real RAG prompts through
 * this same interface.
 */
export interface InferenceRequest {
  /** Identity for per-user round-robin fairness (D42). Single-user in MVP. */
  readonly userId: string;
  readonly prompt: string;
  /**
   * System instruction, sent as a separate chat message so the model's own
   * template frames it as system rather than as more user text.
   */
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * Sequences that end generation. We prompt through the raw completion
   * endpoint, so without these the model runs straight past its answer and
   * invents further turns of the conversation.
   */
  readonly stop?: readonly string[];
}

export interface InferenceResult {
  readonly text: string;
  readonly tokens: number;
}

export interface InferenceBackend {
  readonly available: boolean;
  run(
    req: InferenceRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<InferenceResult>;
}

/** Used when no model is installed yet. */
export class NotProvisionedBackend implements InferenceBackend {
  readonly available = false;
  run(): Promise<InferenceResult> {
    return Promise.reject(
      new Error('No model is installed yet. Choose and download a model to start answering.'),
    );
  }
}

/** Deterministic fake backend for scheduler tests (never shipped as active). */
export class StubBackend implements InferenceBackend {
  readonly available = true;
  constructor(private readonly perTokenMs = 15) {}

  async run(
    req: InferenceRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<InferenceResult> {
    const words = (req.prompt || 'ok').split(/\s+/).slice(0, req.maxTokens ?? 8);
    let text = '';
    for (const w of words) {
      if (signal.aborted) break;
      await sleep(this.perTokenMs);
      const tok = `${w} `;
      text += tok;
      onToken(tok);
    }
    return { text: text.trim(), tokens: words.length };
  }
}

/**
 * The real backend: talks to a llama.cpp server sidecar over loopback HTTP.
 *
 * Uses `/v1/chat/completions`, NOT `/completion`. The raw completion endpoint
 * applies no chat template, so an instruct model receives a wall of text and
 * does what a text model does — continues the pattern. In practice a small
 * model would start reproducing our own excerpt headers ("[1] Source: …")
 * instead of answering. The chat endpoint applies the template baked into the
 * GGUF, so the model sees a real system/user exchange and behaves as an
 * assistant. Instantiated by the runtime once the binary + model are present.
 */
export class LlamaServerBackend implements InferenceBackend {
  readonly available = true;
  constructor(private readonly baseUrl: string) {}

  async run(
    req: InferenceRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<InferenceResult> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: req.maxTokens ?? 512,
        temperature: req.temperature ?? 0.2,
        stream: true,
        ...(req.stop && req.stop.length > 0 ? { stop: [...req.stop] } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Inference server error: HTTP ${res.status}`);

    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let tokens = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          // OpenAI-compatible streaming shape: choices[].delta.content.
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = json.choices?.[0]?.delta?.content;
          if (piece) {
            text += piece;
            tokens++;
            onToken(piece);
          }
        } catch {
          /* ignore keep-alive / partial lines */
        }
      }
    }
    return { text, tokens };
  }
}
