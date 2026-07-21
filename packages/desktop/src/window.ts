import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';

/**
 * Canvas colour (D77 `COLORS.canvas`), inlined as a literal because the desktop
 * package imports no runtime values from the ESM-only shared package.
 */
const CANVAS_COLOR = '#0F0F0E';

/**
 * Window/taskbar icon.
 *
 * Windows requires an .ico here. Given a .png, BrowserWindow accepts the path
 * without error and then silently keeps Electron's default atom — which is
 * exactly what happened: the in-app mark was correct while the title bar and
 * taskbar stayed Electron's. Other platforms take the PNG.
 *
 * Packaged: assets/ sits beside the compiled main in resources/app.
 * Dev:      packages/desktop/assets, one level up from dist/.
 */
export function resolveAppIcon(isDev: boolean): string {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return isDev ? join(__dirname, '..', 'assets', file) : join(__dirname, 'assets', file);
}

/**
 * Creates the single hardened application window.
 *
 * webPreferences enforce the Electron hardening baseline (D45):
 * context isolation ON, node integration OFF, sandbox ON, web security ON,
 * and a preload that is the only bridge to privileged code. Navigation to any
 * off-app location is blocked, and window-open requests are handed to the OS
 * browser rather than opened in-app (defence against injected links).
 */
export function createMainWindow(isDev: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: CANVAS_COLOR,
    show: false,
    autoHideMenuBar: true,
    title: 'QueryLoad',
    icon: resolveAppIcon(isDev),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Block in-app navigation away from the app shell. Nothing should ever
  // navigate the top frame to a remote origin.
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith('http://localhost:5173') : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  // Never open remote content in-app. If some future affordance yields a URL,
  // it goes to the OS browser, and only for http/https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Defence in depth: forbid attaching webviews.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (isDev) {
    // Surface renderer console + load failures to the terminal, and open the
    // devtools, so a blank/errored renderer is diagnosable.
    // Electron 35+ delivers console-message as a single event object (was
    // positional args level/message/line/sourceId before).
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[renderer] did-fail-load ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[renderer] process gone: ${JSON.stringify(details)}`);
    });
    win.webContents.openDevTools({ mode: 'detach' });
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  return win;
}
