/**
 * BUILD-TIME fetch of the llama.cpp inference runtime (D18).
 *
 * This runs on a developer or CI machine, never on a user's machine. The
 * runtime is bundled into the installer via electron-builder `extraResources`,
 * so the shipped app performs NO network call to obtain it — which is why
 * `verify:no-runtime-network` stays clean and why QueryLoad works offline from
 * first launch.
 *
 *   npm run fetch:runtime          # populate vendor/llama for packaging
 *   npm run fetch:runtime -- --force
 *
 * The release is PINNED by tag and verified by SHA-256. Do not bump the tag
 * without re-pinning the hash — an unpinned build downloads and then ships
 * whatever the internet handed back.
 *
 * Only the files llama-server needs are kept. The upstream archive also carries
 * ~20 CLI tools we never invoke; shipping them would put extra executables in
 * the user's install directory for no benefit.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Pinned llama.cpp release. The CPU build is deliberate: it runs on every x64
 * machine with no driver dependency, and at 17MB compressed it costs almost
 * nothing in the installer. GPU-accelerated variants are a later, optional
 * download — see D18a.
 */
const RELEASE = {
  tag: 'b10069',
  targets: {
    'win32-x64': {
      asset: 'llama-b10069-bin-win-cpu-x64.zip',
      sha256: '6c6b235900f2264c9033ede3f0b0f2faac6ba363bd4c885ef672d55309e19662',
      server: 'llama-server.exe',
    },
  },
};

/** Files llama-server actually loads. Verified by running --version on the pruned set. */
const KEEP_EXACT = new Set([
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama-common.dll',
  'llama.dll',
  'mtmd.dll',
  'libomp140.x86_64.dll',
]);
/** The ggml compute backends — one per CPU capability level, selected at runtime. */
const KEEP_PREFIX = ['ggml'];

function url(tag, asset) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset}`;
}

function targetKey() {
  return `${process.platform}-${process.arch}`;
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function download(from, to) {
  const res = await fetch(from, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${from}`);
  if (!res.body) throw new Error('empty response body');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(to));
}

async function unzip(zip, into) {
  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`],
      { maxBuffer: 1024 * 1024 * 32 },
    );
    return;
  }
  await execFileAsync('unzip', ['-o', '-q', zip, '-d', into]);
}

/** The archive may nest everything under a build/ or bin/ folder; find the server. */
async function findServerDir(dir, serverName) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === serverName)) return dir;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findServerDir(join(dir, e.name), serverName);
    if (found) return found;
  }
  return null;
}

async function main() {
  const force = process.argv.includes('--force');
  const key = targetKey();
  const target = RELEASE.targets[key];
  if (!target) {
    console.error(
      `No pinned llama.cpp runtime for ${key}. Supported: ${Object.keys(RELEASE.targets).join(', ')}.`,
    );
    process.exit(1);
  }

  const destDir = join(root, 'vendor', 'llama', key);
  const manifestPath = join(destDir, 'manifest.json');

  if (!force && existsSync(manifestPath)) {
    const current = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (current.tag === RELEASE.tag && current.sha256 === target.sha256) {
      console.log(`llama.cpp ${RELEASE.tag} already present for ${key} — nothing to do.`);
      return;
    }
    console.log(`Replacing llama.cpp ${current.tag} with ${RELEASE.tag}.`);
  }

  const work = join(tmpdir(), `ql-llama-${RELEASE.tag}-${process.pid}`);
  await mkdir(work, { recursive: true });
  const zipPath = join(work, target.asset);

  try {
    console.log(`Downloading ${target.asset} (${RELEASE.tag})…`);
    await download(url(RELEASE.tag, target.asset), zipPath);

    const actual = await sha256(zipPath);
    if (actual !== target.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${target.asset}.\n  expected ${target.sha256}\n  actual   ${actual}\n` +
          'Refusing to bundle an unverified binary.',
      );
    }
    console.log('SHA-256 verified.');

    const extractDir = join(work, 'x');
    await unzip(zipPath, extractDir);

    const srcDir = await findServerDir(extractDir, target.server);
    if (!srcDir) throw new Error(`${target.server} not found in the archive.`);

    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });

    let kept = 0;
    let bytes = 0;
    for (const e of await readdir(srcDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const keep = KEEP_EXACT.has(e.name) || KEEP_PREFIX.some((p) => e.name.startsWith(p));
      if (!keep) continue;
      const to = join(destDir, e.name);
      await copyFile(join(srcDir, e.name), to);
      bytes += (await stat(to)).size;
      kept++;
    }

    if (!existsSync(join(destDir, target.server))) {
      throw new Error(`${target.server} was not among the kept files — check KEEP_EXACT.`);
    }

    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          tag: RELEASE.tag,
          asset: target.asset,
          sha256: target.sha256,
          server: target.server,
          files: kept,
          fetchedFor: key,
        },
        null,
        2,
      )}\n`,
    );

    console.log(
      `llama.cpp ${RELEASE.tag} staged at vendor/llama/${key} — ${kept} files, ${(bytes / 1024 ** 2).toFixed(1)} MB.`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
