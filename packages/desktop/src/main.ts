import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, dialog, ipcMain, session, shell, BrowserWindow } from 'electron';
import type { OpenDialogOptions } from 'electron';
import type { EngineReady } from '@queryload/shared';
import { EngineSupervisor } from './engine-supervisor.js';
import { applySessionHardening } from './security/session-hardening.js';
import { createMainWindow, resolveAppIcon } from './window.js';
import { IPC, type RendererConnection } from './ipc.js';

/**
 * QueryLoad desktop main process.
 *
 * Responsibilities: enforce a single instance, launch and supervise the engine
 * child process, harden the session (TLS pinning, CSP, permissions), expose the
 * narrow preload bridge, and present one hardened window. It never touches the
 * index, inference, or documents — that is the engine's job, reached only over
 * the pinned loopback HTTPS API.
 */

// Force sandboxing for every renderer, before anything else.
app.enableSandbox();

// Windows groups taskbar buttons and resolves their icon by AppUserModelID.
// Without this the taskbar falls back to the host executable's identity, which
// in development is electron.exe — complete with Electron's own logo.
if (process.platform === 'win32') app.setAppUserModelId('ai.tenslor.queryload');

const isDev = !app.isPackaged;
let supervisor: EngineSupervisor | null = null;
let latest: EngineReady | null = null;

function resolveEngineEntry(): string {
  // Packaged: the staged engine bundle lives at resources/engine/{dist,node_modules}
  // (see scripts/stage-engine.mjs + electron-builder.yml), so the entry is under dist/.
  return isDev
    ? join(__dirname, '..', '..', 'engine', 'dist', 'index.js')
    : join(process.resourcesPath, 'engine', 'dist', 'index.js');
}

function resolveDevDataDir(): string | undefined {
  // Keep dev state out of the user's real %APPDATA%/QueryLoad.
  return isDev ? join(__dirname, '..', '..', '..', '.devdata') : undefined;
}

function buildConnection(): RendererConnection {
  if (!latest) throw new Error('Engine is not ready.');
  return {
    baseUrl: `https://${latest.host}:${latest.port}`,
    token: latest.sessionToken,
    appVersion: app.getVersion(),
  };
}

async function bootstrap(): Promise<void> {
  const sup = new EngineSupervisor({
    engineEntry: resolveEngineEntry(),
    // In dev, spawn the engine with the SYSTEM node so its native modules
    // (compiled against the system Node ABI) load. Packaged builds use the
    // Electron binary as Node with modules rebuilt for Electron's ABI.
    nodeBinary: isDev ? 'node' : process.execPath,
    ...(resolveDevDataDir() ? { dataDir: resolveDevDataDir()! } : {}),
    log: (line) => console.log(line),
  });
  supervisor = sup;

  sup.on('engine-changed', (ready: EngineReady) => {
    latest = ready;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.engineChanged);
    }
  });
  sup.on('engine-failed', () => {
    dialog.showErrorBox(
      'QueryLoad',
      'The QueryLoad engine stopped unexpectedly and could not be restarted. ' +
        'Please restart the application.',
    );
  });

  latest = await sup.start();

  // Harden the session now that we know the cert fingerprint to pin.
  applySessionHardening(session.defaultSession, {
    getEngineFingerprint: () => latest?.certFingerprintSha256 ?? null,
    isDev,
  });

  ipcMain.handle(IPC.getConnection, () => buildConnection());

  ipcMain.handle(IPC.pickFolder, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose a folder to index',
      properties: ['openDirectory'],
    };
    const result = await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.pickFile, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose a document to attach',
      properties: ['openFile'],
      filters: [
        {
          name: 'Documents',
          extensions: [
            'pdf',
            'docx',
            'txt',
            'md',
            'markdown',
            'text',
            'log',
            'csv',
            'eml',
            'msg',
            'pst',
            'png',
            'jpg',
            'jpeg',
            'tif',
            'tiff',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.openSource, async (_e, arg: { filePath: string; page: number | null }) => {
    const { filePath, page } = arg;
    if (!filePath) return false;
    // PDFs: open in a plain viewer window at the cited page (Chromium's PDF
    // viewer honours #page=N). Other formats: hand to the OS default app.
    if (/\.pdf$/i.test(filePath)) {
      const viewer = new BrowserWindow({
        width: 900,
        height: 1000,
        title: 'QueryLoad — source',
        icon: resolveAppIcon(isDev),
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const url = pathToFileURL(filePath).href + (page ? `#page=${String(page)}` : '');
      void viewer.loadURL(url);
      return true;
    }
    const err = await shell.openPath(filePath);
    return err === '';
  });

  createMainWindow(isDev);
}

// --- Single-instance lock: one engine, one window. ---
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox('QueryLoad failed to start', message);
      app.quit();
    });
}

// Belt-and-braces navigation hardening for any web contents created.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  // On Windows/Linux, quitting when the window closes is expected.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', (event) => {
  if (!supervisor) return;
  event.preventDefault();
  const sup = supervisor;
  supervisor = null;
  void sup.stop().finally(() => app.quit());
});
