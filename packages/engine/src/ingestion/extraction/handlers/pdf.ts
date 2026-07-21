import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';
import type { ExtractedDocument, ExtractedPage, FormatHandler } from '../types.js';
import { ocr } from '../ocr.js';

/**
 * PDF handler (MuPDF — primary text + true page structure).
 *
 * Emits one {@link ExtractedPage} per PDF page with a real 1-based page number,
 * which is what makes page-level citations exact (non-negotiable). Pages with
 * no extractable text are treated as scanned: OCR is attempted, and if the OCR
 * asset is not yet provisioned the page is flagged `ocrDeferred` rather than
 * lost. MuPDF runs as WASM — no native binary, no network.
 */
export const pdfHandler: FormatHandler = {
  id: 'pdf',
  extensions: ['.pdf'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const buf = await readFile(filePath);
    const doc = mupdf.Document.openDocument(buf, 'application/pdf');
    try {
      const count = doc.countPages();
      const pages: ExtractedPage[] = [];
      let ocrDeferred = false;

      for (let i = 0; i < count; i++) {
        // MuPDF objects hold WASM heap memory that is NOT garbage-collected —
        // each must be destroyed or the heap grows unbounded across pages/docs.
        const page = doc.loadPage(i);
        try {
          const st = page.toStructuredText();
          let text: string;
          try {
            text = st.asText();
          } finally {
            st.destroy();
          }
          if (text.trim().length > 0) {
            pages.push({ page: i + 1, text });
          } else if (ocr.isAvailable()) {
            const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
            let png: Buffer;
            try {
              png = Buffer.from(pix.asPNG());
            } finally {
              pix.destroy();
            }
            pages.push({ page: i + 1, text: await ocr.recognize(png) });
          } else {
            // Scanned page, OCR not installed — keep the page slot, flag deferral.
            pages.push({ page: i + 1, text: '' });
            ocrDeferred = true;
          }
        } finally {
          page.destroy();
        }
      }

      const meta = readMeta(doc);
      return {
        type: 'pdf',
        pages,
        ...(meta ? { meta } : {}),
        ...(ocrDeferred ? { ocrDeferred } : {}),
      };
    } finally {
      doc.destroy();
    }
  },
};

function readMeta(doc: mupdf.Document): { title?: string; author?: string } | undefined {
  try {
    const title = doc.getMetaData('info:Title');
    const author = doc.getMetaData('info:Author');
    const meta: { title?: string; author?: string } = {};
    if (title) meta.title = title;
    if (author) meta.author = author;
    return Object.keys(meta).length > 0 ? meta : undefined;
  } catch {
    return undefined;
  }
}
