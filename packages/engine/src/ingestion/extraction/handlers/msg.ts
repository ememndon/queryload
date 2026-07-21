import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ExtractedDocument, ExtractedMeta, FormatHandler } from '../types.js';

/**
 * @kenjiuno/msgreader is a CommonJS module exporting a default class. Under
 * NodeNext ESM interop the class is reachable cleanly via createRequire, which
 * avoids the ambiguous synthetic-default typing of `import`.
 */
const require = createRequire(import.meta.url);

interface MsgRecipient {
  name?: string;
  email?: string;
}
interface MsgFieldsData {
  subject?: string;
  body?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: MsgRecipient[];
}
interface MsgReaderCtor {
  new (input: ArrayBuffer | DataView): { getFileData(): MsgFieldsData };
}
const MsgReader = (require('@kenjiuno/msgreader') as { default: MsgReaderCtor }).default;

/** Outlook .msg handler (@kenjiuno/msgreader). Email is MVP (D31). */
export const msgHandler: FormatHandler = {
  id: 'msg',
  extensions: ['.msg'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const buf = await readFile(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const reader = new MsgReader(ab);
    const d = reader.getFileData();

    const from = [d.senderName, d.senderEmail].filter(Boolean).join(' ');
    const recipients = d.recipients ?? [];
    const to = recipients.map((r) => [r.name, r.email].filter(Boolean).join(' ')).join(', ');
    const subject = d.subject ?? '';
    const body = d.body ?? '';

    const header = [from && `From: ${from}`, to && `To: ${to}`, subject && `Subject: ${subject}`]
      .filter(Boolean)
      .join('\n');
    const text = header ? `${header}\n\n${body}` : body;
    const meta: ExtractedMeta = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(subject ? { subject } : {}),
    };
    return { type: 'email', pages: [{ page: null, text }], meta };
  },
};
