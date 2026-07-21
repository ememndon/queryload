import type { IncomingMessage } from 'node:http';

const MAX_BODY_BYTES = 1_000_000; // 1 MB — API bodies are tiny (a path, a flag)

/**
 * Read and JSON-parse a request body with a hard size cap. Rejects oversized
 * or malformed bodies rather than buffering unboundedly (a local process
 * should never be able to exhaust engine memory).
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
