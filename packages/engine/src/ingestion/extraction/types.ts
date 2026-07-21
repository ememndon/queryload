/**
 * Extraction contract — shared by handlers, the isolation worker, and the pool.
 */

/** Canonical document type after extraction. */
export type DocType = 'pdf' | 'docx' | 'text' | 'email' | 'image';

/**
 * One logical page of extracted text. PDFs yield true pages (enabling
 * page-level citations, non-negotiable). Non-paginated formats (DOCX, email,
 * text) yield a single page with `page: null`; Phase 3 opens those at the
 * matched character offset instead of a page number.
 */
export interface ExtractedPage {
  readonly page: number | null;
  readonly text: string;
}

export interface ExtractedMeta {
  readonly title?: string;
  readonly author?: string;
  readonly date?: number;
  /** Email-specific. */
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
}

export interface ExtractedDocument {
  readonly type: DocType;
  readonly pages: readonly ExtractedPage[];
  readonly meta?: ExtractedMeta;
  /** True when OCR was required but the OCR asset was not provisioned. */
  readonly ocrDeferred?: boolean;
}

/** A format handler: one registration point per file type (plugin interface). */
export interface FormatHandler {
  readonly id: string;
  /** Lowercased extensions incl. dot, e.g. ['.pdf']. */
  readonly extensions: readonly string[];
  extract(filePath: string): Promise<ExtractedDocument>;
}

/** Job sent to an isolation worker. */
export interface ExtractionJob {
  readonly filePath: string;
  readonly ext: string;
}

/** Result returned from an isolation worker. */
export type ExtractionResult =
  | { readonly ok: true; readonly document: ExtractedDocument }
  | { readonly ok: false; readonly error: string };

/**
 * Raised by a handler when a document needs OCR but the OCR asset is not yet
 * installed. The pipeline treats this as a recoverable "deferred" state rather
 * than a corrupt-file quarantine.
 */
export class OcrUnavailableError extends Error {
  constructor(message = 'OCR engine not installed') {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}
