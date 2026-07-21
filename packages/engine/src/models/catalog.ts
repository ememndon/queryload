import { createRequire } from 'node:module';
import type { ModelCatalogEntry } from '@queryload/shared';

/**
 * Loads the curated catalog (D37) from catalog.json — "the catalog is data, not
 * code." The original cap of 8 was lifted by owner ruling on 2026-07-20: the
 * list is now as broad as the freely-licensed GGUF field allows, still curated
 * (no user-added GGUFs). The embedder (BGE-M3) is fixed and lives alongside but
 * is never user-selectable (D19/D41).
 */
const require = createRequire(import.meta.url);

interface EmbedderSpec {
  id: string;
  name: string;
  quant: string;
  sizeBytes: number;
  url: string;
  sha256: string | null;
  dim: number;
  contextLength: number;
  license: string;
}

interface CatalogFile {
  schema: number;
  models: ModelCatalogEntry[];
  embedder: EmbedderSpec;
}

const catalog = require('./catalog.json') as CatalogFile;

export function listCatalog(): readonly ModelCatalogEntry[] {
  return catalog.models;
}

export function findCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

/** The fixed embedding model. Hidden from users; never selectable. */
export function embedderSpec(): EmbedderSpec {
  return catalog.embedder;
}

/** The smallest model by on-disk size — the only one offered below-minimum (D39). */
export function smallestModel(): ModelCatalogEntry {
  return [...catalog.models].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;
}
