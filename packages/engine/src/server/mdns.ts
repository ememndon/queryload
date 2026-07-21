import { Bonjour } from 'bonjour-service';
import type { Logger } from '../logging/logger.js';

const SERVICE_TYPE = 'queryload';

export interface DiscoveredServer {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
}

/**
 * mDNS advertisement + discovery for LAN auto-discovery (D25). The server
 * advertises `_queryload._tcp` with its cert fingerprint in the TXT record; a
 * client browses the LAN to find servers to join. All multicast is link-local —
 * it never leaves the building.
 */
export class MdnsAdvertiser {
  private bonjour: InstanceType<typeof Bonjour> | null = null;

  constructor(private readonly logger: Logger) {}

  advertise(name: string, port: number, fingerprint: string): void {
    this.stop();
    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name,
      type: SERVICE_TYPE,
      port,
      txt: { fp: fingerprint, v: '1' },
    });
    this.logger.info({ name, port }, 'mDNS advertisement started');
  }

  stop(): void {
    this.bonjour?.unpublishAll(() => undefined);
    this.bonjour?.destroy();
    this.bonjour = null;
  }
}

/** Browse the LAN for QueryLoad servers for `timeoutMs`, then resolve the list. */
export function discoverServers(timeoutMs = 3000): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map<string, DiscoveredServer>();
    const browser = bonjour.find({ type: SERVICE_TYPE }, (svc) => {
      const service = svc as {
        name: string;
        host?: string;
        port: number;
        txt?: Record<string, unknown>;
        referer?: { address?: string };
      };
      const host = service.referer?.address ?? service.host;
      const fp = typeof service.txt?.fp === 'string' ? service.txt.fp : '';
      if (host) {
        found.set(`${host}:${service.port}`, {
          name: service.name,
          host,
          port: service.port,
          fingerprint: fp,
        });
      }
    });
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
