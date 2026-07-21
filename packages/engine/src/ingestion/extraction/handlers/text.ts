import { readFile } from 'node:fs/promises';
import type { ExtractedDocument, FormatHandler } from '../types.js';

/**
 * Decode a text buffer, honoring a byte-order mark and stripping it. Windows
 * editors frequently save .txt/.csv/.log as UTF-16LE ("Unicode") or UTF-8-with-
 * BOM; decoding those as plain UTF-8 yields mojibake (interleaved NULs, a stray
 * U+FEFF, or replacement chars) that then corrupts chunks, embeddings, and the
 * stored citation text. BOM-less files default to UTF-8 (the common case).
 */
function decodeText(buf: Buffer): string {
  // UTF-16LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  // UTF-16BE BOM: FE FF — Node has no utf16be, so byte-swap to LE then decode.
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
    const swapped = Buffer.from(even);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM: EF BB BF
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

/** Plain text and Markdown. The simplest handler — one page, verbatim text. */
export const textHandler: FormatHandler = {
  id: 'text',
  extensions: ['.txt', '.md', '.markdown', '.text', '.log', '.csv'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const buf = await readFile(filePath);
    return { type: 'text', pages: [{ page: null, text: decodeText(buf) }] };
  },
};
