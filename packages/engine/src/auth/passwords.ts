import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Password hashing with argon2id (D52 — argon2id is @node-rs/argon2's default).
 * Parameters follow OWASP guidance (19 MiB memory, 2 iterations). Verification
 * never throws — a malformed or empty hash simply returns false, so an account
 * with no usable password (e.g. the pre-auth local identity) can never be
 * logged into.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}
