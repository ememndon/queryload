import { createWriteStream, createReadStream } from 'node:fs';
import { stat, rm, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  readonly url: string;
  readonly dest: string;
  readonly expectedSha256: string | null;
  readonly expectedSize: number;
  readonly onProgress: (received: number, total: number) => void;
  readonly signal: AbortSignal;
}

/**
 * Resumable, hash-verified model download.
 *
 * This is the ONE place in the engine that touches a remote host, and only for
 * the explicitly user-initiated first-run model download (non-negotiable rule
 * #1 exception (a)). It resumes an interrupted transfer via HTTP Range, then
 * verifies the SHA-256 before the file is accepted. A hash mismatch deletes the
 * download rather than trusting it.
 */
export class ModelDownloader {
  async download(opts: DownloadOptions): Promise<void> {
    const part = `${opts.dest}.part`;
    await mkdir(dirname(opts.dest), { recursive: true });

    let start = 0;
    try {
      start = (await stat(part)).size;
    } catch {
      start = 0;
    }

    const headers: Record<string, string> = {};
    if (start > 0) headers.Range = `bytes=${start}-`;

    // @network-allowed:model-download — user-initiated first-run download only.
    const res = await fetch(opts.url, { headers, signal: opts.signal, redirect: 'follow' });

    let appending = false;
    if (start > 0 && res.status === 206) {
      appending = true;
    } else if (start > 0 && res.ok) {
      // Server ignored the range; restart cleanly.
      await rm(part, { force: true });
      start = 0;
    } else if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    }
    if (!res.body) throw new Error('Download failed: empty response body.');

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    const total = opts.expectedSize || contentLength + start || 0;

    let received = start;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      opts.onProgress(received, total);
    });
    const out = createWriteStream(part, { flags: appending ? 'a' : 'w' });
    await pipeline(source, out);

    // Verify integrity before accepting the file.
    const actual = await sha256File(part);
    if (opts.expectedSha256 && actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new Error('Downloaded file failed integrity check (SHA-256 mismatch).');
    }

    await rename(part, opts.dest);
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
