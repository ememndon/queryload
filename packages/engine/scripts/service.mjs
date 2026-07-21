/**
 * Install / manage the QueryLoad engine as a Windows Service.
 *
 *   npm run engine:service            # build (if needed) + install + start
 *   npm run engine:service uninstall  # stop + remove the service
 *
 * The service runs `dist/index.js --service`: headless, file logging, DPAPI at
 * LocalMachine scope, auto-restart. Requires an elevated (Administrator)
 * shell — Windows will refuse service registration otherwise.
 *
 * `node-windows` is an OPTIONAL dependency so a normal desktop install never
 * needs it; this script fails with a clear message if it is missing.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');
const entry = join(engineRoot, 'dist', 'index.js');

const SERVICE_NAME = 'QueryLoad Engine';
const SERVICE_DESC =
  'QueryLoad local RAG engine — indexing, encrypted index, and the local query API. ' +
  'Operates entirely offline.';

if (process.platform !== 'win32') {
  console.error('The QueryLoad engine service is Windows-only.');
  process.exit(1);
}

if (!existsSync(entry)) {
  console.error(
    `Engine build not found at ${entry}.\n` + 'Run "npm run build:engine" first, then retry.',
  );
  process.exit(1);
}

let Service;
try {
  ({ Service } = await import('node-windows'));
} catch {
  console.error(
    'node-windows is not installed (it is an optional dependency).\n' +
      'Install it with:  npm install -w @queryload/engine node-windows\n' +
      'Then run this command again from an elevated (Administrator) shell.',
  );
  process.exit(1);
}

const svc = new Service({
  name: SERVICE_NAME,
  description: SERVICE_DESC,
  script: entry,
  scriptOptions: '--service',
  // Restart with backoff if the process exits unexpectedly.
  wait: 2,
  grow: 0.5,
  maxRetries: 40,
});

const command = process.argv[2] ?? 'install';

if (command === 'uninstall') {
  svc.on('uninstall', () => console.log(`${SERVICE_NAME}: uninstalled.`));
  svc.uninstall();
} else {
  svc.on('install', () => {
    console.log(`${SERVICE_NAME}: installed. Starting…`);
    svc.start();
  });
  svc.on('alreadyinstalled', () => console.log(`${SERVICE_NAME}: already installed.`));
  svc.on('start', () => console.log(`${SERVICE_NAME}: started (headless, --service).`));
  svc.on('error', (err) => {
    console.error(`${SERVICE_NAME}: service error:`, err);
    process.exit(1);
  });
  svc.install();
}
