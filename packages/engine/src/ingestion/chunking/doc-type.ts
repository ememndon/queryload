import type { DocType } from '../extraction/types.js';

/**
 * Hidden chunking presets by detected document type (D32 / D63).
 *
 * The user never sees a chunk-size slider (appliance surface, rule #4).
 * Instead we classify each document and apply a preset tuned for it:
 * contracts/reports want larger, context-rich chunks; clinical notes are terse
 * and benefit from tighter chunks; correspondence sits in between. Sizes are in
 * characters (≈4 chars/token) until the real tokenizer arrives with BGE-M3.
 */
export type DocClass = 'contract' | 'report' | 'clinical' | 'correspondence' | 'general';

export interface ChunkPreset {
  readonly targetChars: number;
  readonly overlapChars: number;
}

const PRESETS: Record<DocClass, ChunkPreset> = {
  contract: { targetChars: 1200, overlapChars: 200 },
  report: { targetChars: 1100, overlapChars: 180 },
  clinical: { targetChars: 700, overlapChars: 120 },
  correspondence: { targetChars: 900, overlapChars: 150 },
  general: { targetChars: 1000, overlapChars: 150 },
};

export function presetFor(docClass: DocClass): ChunkPreset {
  return PRESETS[docClass];
}

const LEGAL =
  /\b(agreement|hereinafter|whereas|indemnif|liabilit|jurisdiction|clause|party|parties|covenant|plaintiff|defendant|deposition)\b/i;
const CLINICAL =
  /\b(patient|diagnos|dosage|\d+\s?mg\b|symptom|prescri|clinical|referral|blood pressure|mmHg|allerg)\b/i;
const REPORT = /\b(report|executive summary|findings|methodology|conclusion|appendix|figure \d)\b/i;

/**
 * Classify a document from its type + a text sample. Deterministic and cheap —
 * runs on the extracted text head, not the whole document.
 */
export function classifyDocument(type: DocType, sampleText: string): DocClass {
  if (type === 'email') return 'correspondence';
  const sample = sampleText.slice(0, 4000);
  if (LEGAL.test(sample)) return 'contract';
  if (CLINICAL.test(sample)) return 'clinical';
  if (REPORT.test(sample)) return 'report';
  return 'general';
}
