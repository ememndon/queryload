/**
 * BUILD-TIME: assemble build/icon.ico from the PNG renditions in build/icons/.
 *
 * Windows will not use a .png for a window or taskbar icon — BrowserWindow
 * accepts the path without error and then silently keeps Electron's default,
 * which is why the app kept showing the Electron atom while the in-app mark was
 * correct. A real multi-resolution .ico is required.
 *
 * The container holds PNG-compressed entries, which Windows Vista and later
 * read at every size. Regenerate the renditions with scripts/render-icons.ps1
 * when the source artwork changes.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'build', 'icons');
const out = join(root, 'build', 'icon.ico');

/** Sizes Windows actually asks for: list, taskbar, alt-tab, and jumbo. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => {
  const file = join(srcDir, `${size}.png`);
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run: powershell -File scripts/render-icons.ps1`);
    process.exit(1);
  }
  return { size, data: readFileSync(file) };
});

const HEADER = 6;
const ENTRY = 16;
const header = Buffer.alloc(HEADER);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = HEADER + ENTRY * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(ENTRY);
  // 256 is encoded as 0 — the field is a single byte.
  e.writeUInt8(size === 256 ? 0 : size, 0);
  e.writeUInt8(size === 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // palette size (0 = truecolour)
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});

writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(
  `build/icon.ico — ${images.length} sizes (${SIZES.join(', ')}), ${(offset / 1024).toFixed(1)} KB`,
);
