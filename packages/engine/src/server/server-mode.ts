import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { Logger } from '../logging/logger.js';
import type { Repositories } from '../db/repos.js';
import { MdnsAdvertiser } from './mdns.js';
import { encodeJoinCode } from './join-code.js';

const ENABLED_KEY = 'server-mode-enabled';
const JOIN_SECRET_KEY = 'server-join-secret';

export interface ServerModeInfo {
  readonly enabled: boolean;
  readonly listening: 'loopback' | 'lan';
  readonly host: string;
  readonly port: number;
  readonly joinCode: string | null;
  /** True when the flag is on but the engine is still loopback-bound. */
  readonly restartRequired: boolean;
}

/**
 * Organization mode (Pattern B, D25): the admin turns the engine into an office
 * server. Enabling sets the LAN bind (takes effect on the next engine start —
 * a deliberate, explicit action) and starts mDNS advertising once the engine is
 * LAN-bound. It also owns the join secret and produces the join code that
 * bootstraps client trust (cert pinning) + authorization.
 */
export class ServerModeManager {
  private readonly advertiser: MdnsAdvertiser;
  private bound: { host: string; port: number; fingerprint: string } | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {
    this.advertiser = new MdnsAdvertiser(logger);
  }

  isEnabled(): boolean {
    return this.repos.settings.get(ENABLED_KEY) === '1';
  }

  /** Called after the engine is listening, with the actual bind details. */
  attach(host: string, port: number, fingerprint: string): void {
    this.bound = { host, port, fingerprint };
    if (this.isEnabled() && host !== '127.0.0.1') {
      this.advertiser.advertise('QueryLoad Server', port, fingerprint);
    }
  }

  enable(): ServerModeInfo {
    this.repos.settings.set(ENABLED_KEY, '1');
    this.joinSecret(); // ensure one exists
    if (this.bound && this.bound.host !== '127.0.0.1') {
      this.advertiser.advertise('QueryLoad Server', this.bound.port, this.bound.fingerprint);
    }
    this.logger.info('server mode enabled');
    return this.status();
  }

  disable(): ServerModeInfo {
    this.repos.settings.set(ENABLED_KEY, '0');
    this.advertiser.stop();
    return this.status();
  }

  private joinSecret(): string {
    let secret = this.repos.settings.get(JOIN_SECRET_KEY);
    if (!secret) {
      secret = randomBytes(9).toString('base64url');
      this.repos.settings.set(JOIN_SECRET_KEY, secret);
    }
    return secret;
  }

  rotateJoinSecret(): void {
    this.repos.settings.set(JOIN_SECRET_KEY, randomBytes(9).toString('base64url'));
  }

  /** Validate a device's presented join secret (constant-time). */
  validateJoin(secret: string): boolean {
    const expected = Buffer.from(this.joinSecret());
    const got = Buffer.from(secret);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  joinCode(): string | null {
    if (!this.bound) return null;
    return encodeJoinCode({
      v: 1,
      host: this.bound.host === '0.0.0.0' ? firstLanAddress() : this.bound.host,
      port: this.bound.port,
      fingerprint: this.bound.fingerprint,
      secret: this.joinSecret(),
    });
  }

  status(): ServerModeInfo {
    const enabled = this.isEnabled();
    const listening = this.bound?.host === '127.0.0.1' || !this.bound ? 'loopback' : 'lan';
    return {
      enabled,
      listening,
      host: this.bound?.host ?? '127.0.0.1',
      port: this.bound?.port ?? 0,
      joinCode: enabled ? this.joinCode() : null,
      restartRequired: enabled && listening === 'loopback',
    };
  }

  stop(): void {
    this.advertiser.stop();
  }
}

/** Best-effort first non-internal IPv4 LAN address for the join code. */
function firstLanAddress(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}
