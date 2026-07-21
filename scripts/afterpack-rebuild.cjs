// electron-builder afterPack hook: rebuild the engine's native modules for the
// packed Electron's ABI.
//
// The engine runs under ELECTRON_RUN_AS_NODE, so its native addons must match
// Electron's Node ABI — not the ABI they were compiled against when
// stage-engine.mjs installed them. Only better-sqlite3-multiple-ciphers is a
// node-gyp addon that needs this; @node-rs/argon2 and @lancedb ship ABI-stable
// N-API prebuilds and mupdf is WASM, so they are left as-is.
const { join } = require('node:path');

/** @type {(context: import('electron-builder').AfterPackContext) => Promise<void>} */
exports.default = async function afterPack(context) {
  const enginePath = join(context.appOutDir, 'resources', 'engine');
  const { rebuild } = require('@electron/rebuild');
  console.log(
    `[afterpack] rebuilding native modules in ${enginePath} for Electron ${context.electronVersion}`,
  );
  await rebuild({
    buildPath: enginePath,
    electronVersion: context.electronVersion,
    arch: process.arch,
    onlyModules: ['better-sqlite3-multiple-ciphers'],
  });
  console.log('[afterpack] native module rebuild complete');
};
