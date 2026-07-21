import { spawnSync } from 'node:child_process';

/**
 * Windows DPAPI wrapper (D43: keys protected by DPAPI / Credential Manager).
 *
 * Rather than pull in a native addon (which would complicate the build and the
 * SBOM), this calls Windows' built-in `ProtectedData` via Windows PowerShell.
 * DPAPI ties the ciphertext to the current user (desktop) or the machine
 * (service), so the encrypted key file is worthless if copied to another box.
 *
 * This is deliberately Windows-only. On other platforms it throws — the app's
 * supported target is Windows (D23), and we fail closed rather than silently
 * storing a private key in the clear.
 */

export type DpapiScope = 'CurrentUser' | 'LocalMachine';

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function runPowerShell(script: string, inputBase64: string): string {
  if (process.platform !== 'win32') {
    throw new Error(
      'DPAPI is only available on Windows. QueryLoad protects secrets with Windows DPAPI; ' +
        'run the engine on a supported Windows target.',
    );
  }
  const result = spawnSync('powershell.exe', [...POWERSHELL_ARGS, script], {
    input: inputBase64,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`DPAPI: failed to invoke PowerShell: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`DPAPI operation failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

const PROTECT_SCRIPT = (scope: DpapiScope): string =>
  [
    'Add-Type -AssemblyName System.Security;',
    '$in = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($in.Trim());',
    `$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::${scope});`,
    '[Console]::Out.Write([Convert]::ToBase64String($enc));',
  ].join(' ');

const UNPROTECT_SCRIPT = (scope: DpapiScope): string =>
  [
    'Add-Type -AssemblyName System.Security;',
    '$in = [Console]::In.ReadToEnd();',
    '$bytes = [Convert]::FromBase64String($in.Trim());',
    `$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::${scope});`,
    '[Console]::Out.Write([Convert]::ToBase64String($dec));',
  ].join(' ');

/** Encrypt bytes with DPAPI; returns ciphertext bytes. */
export function dpapiProtect(plaintext: Buffer, scope: DpapiScope = 'CurrentUser'): Buffer {
  const out = runPowerShell(PROTECT_SCRIPT(scope), plaintext.toString('base64'));
  return Buffer.from(out, 'base64');
}

/** Decrypt DPAPI ciphertext produced by {@link dpapiProtect}. */
export function dpapiUnprotect(ciphertext: Buffer, scope: DpapiScope = 'CurrentUser'): Buffer {
  const out = runPowerShell(UNPROTECT_SCRIPT(scope), ciphertext.toString('base64'));
  return Buffer.from(out, 'base64');
}

/** Cheap probe used at startup to confirm DPAPI is actually usable. */
export function dpapiAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const probe = Buffer.from('queryload-dpapi-probe');
    const round = dpapiUnprotect(dpapiProtect(probe));
    return round.equals(probe);
  } catch {
    return false;
  }
}
