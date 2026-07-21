/**
 * Reasoning models (Qwen 3, DeepSeek R1 distills) work a question out inside a
 * <think>…</think> block before giving the answer. We stream raw completions
 * straight to the UI, so without this that scratchpad would appear as the
 * answer — and would then be persisted and audited as one.
 *
 * The filter is applied unconditionally: models that never emit <think> pass
 * through byte-for-byte, so nothing has to know which model is loaded.
 */
const OPEN = '<think>';
const CLOSE = '</think>';

/** Longest tag prefix we may be holding mid-stream, so a split tag isn't missed. */
const MAX_PARTIAL = CLOSE.length - 1;

/**
 * Streaming filter. Tokens arrive in arbitrary pieces — a tag can be split
 * across them — so text that could still turn out to be the start of a tag is
 * held back until the next token resolves it.
 */
export class ThinkingFilter {
  private buf = '';
  private inThink = false;
  private emittedAny = false;

  /** Feed one streamed token; returns the text safe to show (often ''). */
  push(token: string): string {
    this.buf += token;
    let out = '';

    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf(CLOSE);
        if (end === -1) {
          // Still thinking. Discard all but a possible partial closing tag.
          if (this.buf.length > MAX_PARTIAL) this.buf = this.buf.slice(-MAX_PARTIAL);
          break;
        }
        this.buf = this.buf.slice(end + CLOSE.length);
        this.inThink = false;
        continue;
      }

      const start = this.buf.indexOf(OPEN);
      if (start !== -1) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + OPEN.length);
        this.inThink = true;
        continue;
      }

      // No tag in sight — release everything except a possible partial one.
      const hold = Math.min(MAX_PARTIAL, this.buf.length);
      out += this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
      break;
    }

    return this.clean(out);
  }

  /** Release anything still held once the stream ends. */
  flush(): string {
    if (this.inThink) {
      // Unterminated <think> — the model ran out of tokens mid-thought. Drop it
      // rather than exposing a half-finished scratchpad.
      this.buf = '';
      return '';
    }
    const rest = this.buf;
    this.buf = '';
    return this.clean(rest);
  }

  /** Strip the blank lines a reasoning model leaves after its </think>. */
  private clean(text: string): string {
    if (this.emittedAny) return text;
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.length > 0) this.emittedAny = true;
    return trimmed;
  }
}

/** Same rule applied to a complete string (the non-streamed final text). */
export function stripThinking(text: string): string {
  const f = new ThinkingFilter();
  return (f.push(text) + f.flush()).trim();
}
