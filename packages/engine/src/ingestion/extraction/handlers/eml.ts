import { readFile } from 'node:fs/promises';
import { simpleParser } from 'mailparser';
import type { ExtractedDocument, ExtractedMeta, FormatHandler } from '../types.js';

/**
 * EML handler (mailparser). Email is MVP (D31). Header fields are surfaced both
 * as searchable body text (so "who emailed about X" retrieves) and as structured
 * metadata. HTML-only mail falls back to a text rendering.
 */
export const emlHandler: FormatHandler = {
  id: 'eml',
  extensions: ['.eml'],
  async extract(filePath: string): Promise<ExtractedDocument> {
    const raw = await readFile(filePath);
    const mail = await simpleParser(raw);

    const from = mail.from?.text ?? '';
    const to = Array.isArray(mail.to)
      ? mail.to.map((a) => a.text).join(', ')
      : (mail.to?.text ?? '');
    const subject = mail.subject ?? '';
    const date = mail.date ? mail.date.getTime() : undefined;
    const body = mail.text ?? stripHtml(mail.html || '') ?? '';

    const header = [
      from && `From: ${from}`,
      to && `To: ${to}`,
      subject && `Subject: ${subject}`,
      mail.date && `Date: ${mail.date.toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');

    const text = header ? `${header}\n\n${body}` : body;
    const meta: ExtractedMeta = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(subject ? { subject } : {}),
      ...(date ? { date } : {}),
    };
    return { type: 'email', pages: [{ page: null, text }], meta };
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
