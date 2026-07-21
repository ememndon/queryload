import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Streaming SHA-256 of a file's bytes — the basis for content-hash change
 * detection (D29). Streaming keeps memory flat for large archives.
 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
