import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

export interface DiagnosticInputs {
  readonly appVersion: string;
  readonly configJson: string;
  readonly hardwareJson: string;
  readonly logsDir: string;
}

/**
 * One-click diagnostic bundle (D14): logs + config + hardware profile, zipped.
 * NEVER document content. A redaction pass strips anything token/key-shaped
 * before it is written, so the bundle is safe to email manually.
 */
export async function buildDiagnosticBundle(inputs: DiagnosticInputs): Promise<Buffer> {
  const zip = new AdmZip();
  zip.addFile('version.txt', Buffer.from(inputs.appVersion, 'utf8'));
  zip.addFile('config.json', Buffer.from(redact(inputs.configJson), 'utf8'));
  zip.addFile('hardware.json', Buffer.from(redact(inputs.hardwareJson), 'utf8'));

  const files = await readdir(inputs.logsDir).catch(() => [] as string[]);
  for (const name of files) {
    if (!name.endsWith('.log')) continue;
    const text = await readFile(join(inputs.logsDir, name), 'utf8').catch(() => '');
    zip.addFile(`logs/${name}`, Buffer.from(redact(text), 'utf8'));
  }
  return zip.toBuffer();
}

/** Redact secret-shaped values. Logs already exclude document content by design. */
function redact(text: string): string {
  return text
    .replace(
      /("?(?:sessionToken|token|key|password|password_hash)"?\s*[:=]\s*)"?[^",}\s]+"?/gi,
      '$1"[redacted]"',
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}
