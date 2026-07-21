import { OcrUnavailableError } from './types.js';

/**
 * OCR provider seam.
 *
 * OCR (Tesseract) needs a WASM core + language traineddata (~15MB). Per the
 * owner's ruling, heavyweight assets are provisioned by the app's own download
 * flow (like the model), NOT bundled or fetched from a CDN at runtime — that
 * would violate the zero-network rule. Until the OCR asset is installed, this
 * provider reports unavailable, and scanned pages / image files are marked
 * "OCR deferred" rather than silently dropped or errored.
 *
 * Phase 2's asset-download flow provisions the OCR data into the app-data
 * `models/` area; this provider then loads it locally and performs real OCR
 * behind this same interface — no other code changes.
 */
export interface OcrProvider {
  isAvailable(): boolean;
  /** Recognize text from raw image bytes. Throws OcrUnavailableError if not installed. */
  recognize(image: Buffer): Promise<string>;
}

export class DeferredOcrProvider implements OcrProvider {
  isAvailable(): boolean {
    return false;
  }
  recognize(_image: Buffer): Promise<string> {
    return Promise.reject(new OcrUnavailableError());
  }
}

/** The active provider. Swapped for a Tesseract-backed one once provisioned. */
export const ocr: OcrProvider = new DeferredOcrProvider();
