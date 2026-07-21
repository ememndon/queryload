import { extname } from 'node:path';
import type { FormatHandler } from './types.js';
import { textHandler } from './handlers/text.js';
import { pdfHandler } from './handlers/pdf.js';
import { docxHandler } from './handlers/docx.js';
import { emlHandler } from './handlers/eml.js';
import { msgHandler } from './handlers/msg.js';
import { pstHandler } from './handlers/pst.js';
import { imageHandler } from './handlers/image.js';

/**
 * The format-handler registry — ONE registration point per file type (the
 * plugin interface, D31/D21). Future formats are added here, not by surgery
 * elsewhere. Unknown extensions resolve to null and are skipped + logged.
 */
export class FormatHandlerRegistry {
  private readonly byExt = new Map<string, FormatHandler>();

  register(handler: FormatHandler): void {
    for (const ext of handler.extensions) {
      this.byExt.set(ext.toLowerCase(), handler);
    }
  }

  resolve(filePath: string): FormatHandler | null {
    return this.byExt.get(extname(filePath).toLowerCase()) ?? null;
  }

  /** True if some handler claims this file's extension. */
  supports(filePath: string): boolean {
    return this.byExt.has(extname(filePath).toLowerCase());
  }

  supportedExtensions(): string[] {
    return [...this.byExt.keys()].sort();
  }
}

/** The default registry with every built-in handler wired up. */
export function createDefaultRegistry(): FormatHandlerRegistry {
  const registry = new FormatHandlerRegistry();
  for (const handler of [
    textHandler,
    pdfHandler,
    docxHandler,
    emlHandler,
    msgHandler,
    pstHandler,
    imageHandler,
  ]) {
    registry.register(handler);
  }
  return registry;
}
