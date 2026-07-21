import { createHash } from 'node:crypto';
import type { ExtractedDocument } from '../extraction/types.js';
import { classifyDocument, presetFor, type ChunkPreset } from './doc-type.js';

/**
 * A chunk ready to embed + persist. Records everything needed for a page-level
 * citation that opens the source at the right place (non-negotiable): the page
 * (for paginated docs) and global character offsets (for preview positioning).
 */
export interface Chunk {
  readonly ordinal: number;
  readonly page: number | null;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly hash: string;
  readonly tokenCount: number;
}

const PAGE_SEP = '\n\n';

/**
 * Chunk an extracted document using its hidden, type-appropriate preset.
 *
 * Chunks are produced WITHIN page boundaries so every chunk maps to exactly one
 * source page — the foundation of exact page-level citations (non-negotiable).
 * Character offsets are global (into the virtual concatenation of pages joined
 * by PAGE_SEP) so a citation can also position a preview precisely.
 */
export function chunkDocument(doc: ExtractedDocument): Chunk[] {
  const sampleText = doc.pages.map((p) => p.text).join(' ');
  const preset = presetFor(classifyDocument(doc.type, sampleText));

  const chunks: Chunk[] = [];
  let globalOffset = 0;
  let ordinal = 0;
  for (const page of doc.pages) {
    const text = page.text;
    if (text.trim().length > 0) {
      for (const w of splitIntoWindows(text, preset)) {
        chunks.push({
          ordinal: ordinal++,
          page: page.page,
          charStart: globalOffset + w.start,
          charEnd: globalOffset + w.end,
          text: w.text,
          hash: sha256(w.text),
          tokenCount: estimateTokens(w.text),
        });
      }
    }
    globalOffset += text.length + PAGE_SEP.length;
  }
  return chunks;
}

interface Window {
  start: number;
  end: number;
  text: string;
}

/**
 * Paragraph- and sentence-aware windowing with overlap. Never splits a word;
 * prefers paragraph boundaries, falls back to sentence boundaries, and hard-
 * wraps only when a single unit exceeds the target size.
 */
function splitIntoWindows(text: string, preset: ChunkPreset): Window[] {
  const units = hardWrap(segment(text), preset.targetChars);
  const windows: Window[] = [];
  let curStart = units.length > 0 ? units[0]!.start : 0;
  let curEnd = curStart;
  let curText = '';

  const flush = (): void => {
    const trimmed = curText.trim();
    if (trimmed.length > 0) windows.push({ start: curStart, end: curEnd, text: trimmed });
  };

  for (const u of units) {
    if (curText.length > 0 && curText.length + u.text.length > preset.targetChars) {
      flush();
      // Start the next window with a tail overlap from the just-flushed text.
      const overlap = Math.min(preset.overlapChars, curText.length);
      curStart = curEnd - overlap;
      curText = text.slice(curStart, curEnd);
    }
    if (curText.length === 0) curStart = u.start;
    curText = text.slice(curStart, u.end);
    curEnd = u.end;
  }
  flush();
  return windows;
}

interface Unit {
  start: number;
  end: number;
  text: string;
}

/**
 * Split any unit longer than `maxChars` into character-bounded pieces, breaking
 * at the last whitespace before the limit where possible. Without this a
 * degenerate input with no paragraph/sentence breaks (a CSV row, a minified
 * line, a giant table) becomes ONE unit and then one mega-chunk that overflows
 * the embedding context. Offsets are preserved so citations stay exact.
 */
function hardWrap(units: Unit[], maxChars: number): Unit[] {
  const out: Unit[] = [];
  for (const u of units) {
    if (u.text.length <= maxChars) {
      out.push(u);
      continue;
    }
    let pos = 0;
    while (pos < u.text.length) {
      let end = Math.min(pos + maxChars, u.text.length);
      if (end < u.text.length) {
        const ws = u.text.lastIndexOf(' ', end);
        if (ws > pos + maxChars * 0.5) end = ws + 1; // break on a space, not mid-word
      }
      out.push({ start: u.start + pos, end: u.start + end, text: u.text.slice(pos, end) });
      pos = end;
    }
  }
  return out;
}

/** Segment text into paragraph/sentence units with source offsets. */
function segment(text: string): Unit[] {
  const units: Unit[] = [];
  const paraRe = /[^\n]+(?:\n(?!\n)[^\n]*)*/g; // paragraphs (runs between blank lines)
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(text)) !== null) {
    const paraStart = m.index;
    const para = m[0];
    // Split long paragraphs on sentence boundaries.
    const sentRe = /[^.!?]*[.!?]+[)"']*\s*|\S[^.!?]*$/g;
    let s: RegExpExecArray | null;
    let any = false;
    while ((s = sentRe.exec(para)) !== null) {
      if (s[0].length === 0) {
        sentRe.lastIndex++;
        continue;
      }
      any = true;
      units.push({
        start: paraStart + s.index,
        end: paraStart + s.index + s[0].length,
        text: s[0],
      });
    }
    if (!any) units.push({ start: paraStart, end: paraStart + para.length, text: para });
  }
  return units;
}

function estimateTokens(text: string): number {
  // ≈4 chars/token; replaced by the real BGE-M3 tokenizer count in Phase 2.
  return Math.max(1, Math.round(text.length / 4));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
