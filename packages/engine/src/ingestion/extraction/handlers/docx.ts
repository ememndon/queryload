import mammoth from 'mammoth';
import type { ExtractedDocument, FormatHandler } from '../types.js';

/**
 * DOCX handler (mammoth — raw text). Word documents have no intrinsic page
 * boundaries, so this yields a single logical page (`page: null`); Phase 3
 * opens DOCX citations at the matched character offset in a rendered preview.
 */
export const docxHandler: FormatHandler = {
  id: 'docx',
  extensions: ['.docx'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const result = await mammoth.extractRawText({ path: filePath });
    return { type: 'docx', pages: [{ page: null, text: result.value }] };
  },
};
