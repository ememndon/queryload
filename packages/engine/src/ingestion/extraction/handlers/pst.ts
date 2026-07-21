import { readFile } from 'node:fs/promises';
import type { PSTFolder } from 'pst-extractor';
import { PSTFile, PSTMessage } from 'pst-extractor';
import type { ExtractedDocument, ExtractedPage, FormatHandler } from '../types.js';

/**
 * PST handler (pst-extractor). A PST is a whole mailbox, so it is flattened to
 * one page per message — each message becomes an independently citable unit.
 * Email is MVP (D31). Large archives can produce many pages; the pipeline
 * chunks and embeds them incrementally.
 */
export const pstHandler: FormatHandler = {
  id: 'pst',
  extensions: ['.pst'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const buf = await readFile(filePath);
    const pst = new PSTFile(buf);
    const pages: ExtractedPage[] = [];
    walkFolder(pst.getRootFolder(), pages);
    if (pages.length === 0) pages.push({ page: null, text: '' });
    return { type: 'email', pages };
  },
};

function walkFolder(folder: PSTFolder, pages: ExtractedPage[]): void {
  if (folder.hasSubfolders) {
    for (const sub of folder.getSubFolders()) walkFolder(sub, pages);
  }
  let child: unknown = folder.getNextChild();
  while (child) {
    if (child instanceof PSTMessage) {
      const from = [child.senderName, child.emailAddress].filter(Boolean).join(' ');
      const header = [from && `From: ${from}`, child.subject && `Subject: ${child.subject}`]
        .filter(Boolean)
        .join('\n');
      const body = child.body ?? '';
      pages.push({ page: null, text: header ? `${header}\n\n${body}` : body });
    }
    child = folder.getNextChild();
  }
}
