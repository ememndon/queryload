import type { ServerResponse } from 'node:http';

/**
 * Minimal Server-Sent-Events writer for the streaming query endpoint. Each
 * event is one JSON `data:` frame. Defensive headers match the JSON responses
 * (the renderer is untrusted): no caching, nosniff, and a data-only CSP.
 */
export interface SseChannel {
  send(event: unknown): void;
  close(): void;
}

export function startSse(res: ServerResponse): SseChannel {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  return {
    send: (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    close: () => res.end(),
  };
}
