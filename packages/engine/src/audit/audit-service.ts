import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '@queryload/shared';
import type { AuditRow, Repositories } from '../db/repos.js';

/**
 * Audit log — default ON (D56). Records every query with its answer excerpt,
 * cited sources, user, workspace, and timestamp. Stored inside the encrypted
 * metadata DB; the excerpt is why the audit log itself has retention (D57).
 */
export class AuditService {
  constructor(private readonly repos: Repositories) {}

  recordQuery(input: {
    userId: string | null;
    workspaceId: string;
    query: string;
    answer: string;
    sources: readonly { fileName: string; page: number | null }[];
    viaEngineApi?: boolean;
  }): void {
    this.repos.audit.record({
      id: randomUUID(),
      user_id: input.userId,
      action: input.viaEngineApi ? 'engine-api-query' : 'query',
      query: input.query,
      answer_excerpt: input.answer.slice(0, 500),
      sources: JSON.stringify(input.sources),
      workspace_id: input.workspaceId,
      at: Date.now(),
    });
  }

  record(action: string, userId: string | null, detail?: string): void {
    this.repos.audit.record({
      id: randomUUID(),
      user_id: userId,
      action,
      query: null,
      answer_excerpt: detail ?? null,
      sources: null,
      workspace_id: null,
      at: Date.now(),
    });
  }

  list(limit = 200): AuditEntry[] {
    return this.repos.audit.list(limit).map(toEntry);
  }

  exportJson(): string {
    return JSON.stringify(this.repos.audit.all().map(toEntry), null, 2);
  }
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    userId: r.user_id,
    action: r.action,
    query: r.query,
    answerExcerpt: r.answer_excerpt,
    sources: r.sources,
    workspaceId: r.workspace_id,
    at: r.at,
  };
}
