import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../logging/logger.js';
import type { Repositories } from '../db/repos.js';
import type { IngestionManager } from '../ingestion/ingestion-manager.js';
import { DEFAULT_USER_ID } from '../db/schema.js';

const DEMO_LOADED_KEY = 'demo-corpus-loaded';

interface DemoWorkspaceSpec {
  readonly id: string;
  readonly name: string;
  readonly subdir: string;
}

const DEMO_WORKSPACES: readonly DemoWorkspaceSpec[] = [
  { id: 'ws-demo-law', name: 'Demo — Acme v. Globex', subdir: 'law-firm' },
  { id: 'ws-demo-clinic', name: 'Demo — Patient: Jordan Rivera', subdir: 'clinic' },
];

export interface DemoCorpusDeps {
  readonly repos: Repositories;
  readonly ingestion: IngestionManager;
  readonly logger: Logger;
}

/**
 * On first run, ships the synthetic demo corpus (D72) as two try-it-instantly
 * workspaces — a fictional law-firm matter and a fictional clinic patient file.
 * The corpus is bundled with the app (never downloaded) and indexed through the
 * normal pipeline, so the demo answers cited questions the moment a model is
 * ready. Idempotent: a settings flag prevents re-loading.
 */
export async function loadDemoCorpus(deps: DemoCorpusDeps): Promise<void> {
  const { repos, ingestion, logger } = deps;
  if (repos.settings.get(DEMO_LOADED_KEY) === '1') return;

  const corpusDir = resolveCorpusDir();
  if (!corpusDir) {
    logger.warn('demo corpus not found; skipping (will retry next start)');
    return;
  }

  for (const ws of DEMO_WORKSPACES) {
    const path = join(corpusDir, ws.subdir);
    if (!existsSync(path)) continue;
    if (!repos.workspaces.exists(ws.id)) repos.workspaces.create(ws.id, ws.name, 'demo');
    repos.memberships.add(DEFAULT_USER_ID, ws.id);
    try {
      await ingestion.addPath(path, ws.id);
    } catch (err) {
      // Overlap/already-added is fine; anything else is logged, not fatal.
      logger.warn({ ws: ws.id, err: describe(err) }, 'demo workspace add skipped');
    }
  }

  repos.settings.set(DEMO_LOADED_KEY, '1');
  logger.info('demo corpus loaded (2 workspaces)');
}

/** Locate the bundled corpus: packaged resources first, then the dev repo. */
function resolveCorpusDir(): string | null {
  const candidates: string[] = [];
  // `resourcesPath` is added by Electron at runtime (packaged app); not typed
  // by @types/node, so read it defensively.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(join(resourcesPath, 'corpus'));
  const here = dirname(fileURLToPath(import.meta.url)); // dist/demo
  candidates.push(join(here, '..', '..', '..', '..', 'corpus')); // repo/corpus (dev)
  return candidates.find((c) => existsSync(c)) ?? null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
