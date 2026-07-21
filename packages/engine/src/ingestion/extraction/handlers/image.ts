import { readFile } from 'node:fs/promises';
import type { ExtractedDocument, FormatHandler } from '../types.js';
import { ocr } from '../ocr.js';

/**
 * Image handler (OCR). When the OCR asset is provisioned this returns the
 * recognized text; until then it returns an empty page flagged `ocrDeferred`
 * so the file is tracked (not lost) and can be re-processed once OCR is
 * installed — rather than being quarantined as unreadable.
 */
export const imageHandler: FormatHandler = {
  id: 'image',
  extensions: ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const buf = await readFile(filePath);
    if (!ocr.isAvailable()) {
      return { type: 'image', pages: [{ page: 1, text: '' }], ocrDeferred: true };
    }
    const text = await ocr.recognize(buf);
    return { type: 'image', pages: [{ page: 1, text }] };
  },
};
