import type { RetentionPolicy, RetentionScope } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';
import type { Repositories } from '../db/repos.js';
import type { VectorStore } from '../index/vector-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * ONE retention scheduler serving three consumers (D57/D58): documents, chat
 * history, and the audit log. A single sweep applies every policy; purged
 * content is removed from BOTH the encrypted SQLite (rows cascade) and LanceDB
 * (vectors), so it is unrecoverable from the index.
 */
export class RetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly vectors: VectorStore,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.runOnce().catch((err) => this.logger.error({ err: describe(err) }, 'retention sweep failed'));
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        this.logger.error({ err: describe(err) }, 'retention sweep failed'),
      );
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getPolicies(): RetentionPolicy[] {
    const scopes: RetentionScope[] = ['documents', 'chats', 'audit'];
    return scopes.map((scope) => ({ scope, days: this.repos.retention.get(scope) }));
  }

  setPolicy(scope: RetentionScope, days: number | null): void {
    this.repos.retention.set(scope, days);
  }

  /** Apply all policies once. Returns what was purged (for logging/tests). */
  async runOnce(now = Date.now()): Promise<{ documents: number; chats: number; audit: number }> {
    const result = { documents: 0, chats: 0, audit: 0 };

    const chatDays = this.repos.retention.get('chats');
    if (chatDays != null) {
      result.chats = this.repos.chats.deleteOlderThan(now - chatDays * DAY_MS);
    }

    const auditDays = this.repos.retention.get('audit');
    if (auditDays != null) {
      result.audit = this.repos.audit.deleteOlderThan(now - auditDays * DAY_MS);
    }

    const docDays = this.repos.retention.get('documents');
    if (docDays != null) {
      const rows = this.repos.files.rowsUpdatedBefore(now - docDays * DAY_MS);
      for (const row of rows) {
        try {
          await this.vectors.deleteFile(row.id); // LanceDB (delete first)
          this.repos.files.deleteById(row.id); // SQLite (chunks cascade)
          // Tombstone the purged bytes so the next scan does NOT re-ingest the
          // same on-disk file and defeat the retention guarantee (H9).
          this.repos.tombstones.add(row.path, row.hash, now);
          result.documents++;
        } catch (err) {
          // One failing file must not abort the whole sweep or leak an
          // unhandled rejection; log and continue with the rest.
          this.logger.warn({ id: row.id, err: describe(err) }, 'retention: failed to purge a document');
        }
      }
    }

    if (result.documents || result.chats || result.audit) {
      this.logger.info(result, 'retention sweep purged content');
    }
    return result;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
