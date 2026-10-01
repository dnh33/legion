/** Electron main process. */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // <root>/dist/src/electron
const root = resolve(here, '..', '..', '..');
const coreEntry = resolve(here, '..', 'bin', 'legion-core.js');
const uiIndex = join(root, 'dist-ui', 'index.html');
const uiUrl = pathToFileURL(uiIndex).toString();
const assetPath = (n: string) => join(root, 'assets', n);

const dataDir = () => {
  const d = process.env.LEGION_HOME || join(homedir(), '.legion');
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
};

function readConfig(): { port: number; token: string } {
  let port = 4747;
  let token = '';
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'));
    if (typeof cfg.port === 'number') port = cfg.port;
    if (typeof cfg.authToken === 'string') token = cfg.authToken;
  } catch { /* core creates it on first run */ }
  if (process.env.LEGION_PORT) port = Number(process.env.LEGION_PORT) || port;
  return { port, token };
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let coreProc: ChildProcess | null = null;
let quitting = false;
let booting = true;
let splash: BrowserWindow | null = null;

const isHttp = (u: string) => {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
};
const openExternal = (u: string) => { if (isHttp(u)) void shell.openExternal(u); };

async function healthy(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

/** Returns null on success, or a human-readable error. */
async function spawnCore(): Promise<string | null> {
  const nodeBin = process.env.LEGION_NODE || 'node';
  let out: number | 'ignore' = 'ignore';
  try { out = openSync(join(dataDir(), 'core.log'), 'a'); } catch { /* ignore */ }
  try {
    let failure: string | null = null;
    const child = spawn(nodeBin, [coreEntry], {
      cwd: root,
      stdio: ['ignore', out, out],
      windowsHide: true,
      detached: false,
      env: process.env,
    });
    coreProc = child;
    child.on('error', (err: NodeJS.ErrnoException) => {
      coreProc = null;
      failure = err.code === 'ENOENT'
        ? 'Node.js 20+ not found on PATH. Install: winget install OpenJS.NodeJS.LTS (or set LEGION_NODE).'
        : `Could not start core: ${err.message || err}`;
    });
    child.on('exit', (code) => {
      if (coreProc === child) coreProc = null;
      if (!failure) failure = `Core exited (code ${code}). See core.log.`;
    });
    await new Promise((r) => setTimeout(r, 200));
    return failure;
  } finally {
    if (typeof out === 'number') { try { closeSync(out); } catch { /* ignore */ } }
  }
}

/** Returns null when the core is healthy, else an error message. */
async function ensureCore(): Promise<string | null> {
  if (await healthy(readConfig().port)) return null;
  const err = await spawnCore();
  if (err) return err;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await healthy(readConfig().port)) return null;
    if (!coreProc) return 'Core exited before becoming ready. See core.log.';
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'Core did not become ready within 15s. See core.log.';
}

function killCore(): void {
  if (coreProc) {
    try { coreProc.kill(); } catch { /* ignore */ }
    coreProc = null;
  }
}

async function restartCore(): Promise<void> {
  const wasOurs = !!coreProc;
  if (wasOurs) {
    killCore();
    await new Promise((r) => setTimeout(r, 500));
  } else {
    const { port } = readConfig();
    if (await healthy(port)) {
      dialog.showMessageBox({ type: 'info', message: 'Legion Core was started outside this app.', detail: 'Stop it from its own terminal and restart it there.' }).catch(() => {});
      return;
    }
  }
  const err = await ensureCore();
  if (err) dialog.showErrorBox('Could not restart Legion Core', err);
  win?.webContents.reload();
}

function showWindow(): void {
  if (booting) { splash?.focus(); return; }
  if (!win) { createWindow(true); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(showOnReady: boolean): void {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Legion',
    icon: existsSync(assetPath('icon.png')) ? assetPath('icon.png') : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isWin ? { titleBarOverlay: { color: '#0b0d10', symbolColor: '#e6e9ef', height: 40 } } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  if (showOnReady) win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === uiUrl || url.startsWith(uiUrl + '#') || url.startsWith(uiUrl + '?')) return;
    e.preventDefault();
    openExternal(url);
  });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win?.hide(); }
  });
  win.on('closed', () => { win = null; });

  if (existsSync(uiIndex)) {
    void win.loadFile(uiIndex);
  } else {
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#0b0d10;color:#e6e9ef;font:14px system-ui;padding:40px"><h2>Legion UI not built</h2><p>Run <code>npm run build</code> in the project folder, then restart Legion.</p></body>'));
  }
}

const splashJs = (fn: string, arg?: string) => {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(`window.splash && window.splash.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`).catch(() => {});
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createSplash(): void {
  splash = new BrowserWindow({
    width: 560,
    height: 360,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0d10',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Legion',
    icon: existsSync(assetPath('icon.png')) ? assetPath('icon.png') : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.once('ready-to-show', () => splash?.show());
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  // The page signals button clicks through document.title (no preload needed).
  splash.webContents.on('page-title-updated', (_e, title) => {
    const m = /^legion-splash:(retry|log):/.exec(title);
    if (m?.[1] === 'retry') void boot();
    else if (m?.[1] === 'log') void shell.openPath(join(dataDir(), 'core.log'));
  });
  splash.on('closed', () => {
    splash = null;
    if (booting && !quitting) { quitting = true; app.quit(); }
  });
  if (existsSync(assetPath('splash.html'))) void splash.loadFile(assetPath('splash.html'));
}

async function boot(): Promise<void> {
  const t0 = Date.now();
  booting = true;
  if (!splash) createSplash();
  else splashJs('reset');
  await sleep(250);
  splashJs('line', 'waking the core\u2026');
  const err = await ensureCore();
  if (err) { splashJs('error', err); return; }
  splashJs('line', 'checking Claude sign-in\u2026');

  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  createWindow(false);
  const w = win as BrowserWindow | null;
  await new Promise<void>((resolveReady) => {
    if (!w) return resolveReady();
    w.once('ready-to-show', () => resolveReady());
    setTimeout(resolveReady, 8000); // never hang on the splash
  });
  splashJs('line', 'agents assembled.');
  await sleep(Math.max(300, 1200 - (Date.now() - t0)));
  splashJs('fade');
  await sleep(450);
  booting = false;
  if (splash && !splash.isDestroyed()) { splash.removeAllListeners('closed'); splash.destroy(); }
  splash = null;
  if (!tray) createTray();
  const mainWin = win as BrowserWindow | null;
  mainWin?.show();
  mainWin?.focus();
}

function createTray(): void {
  let img = nativeImage.createEmpty();
  try {
    if (existsSync(assetPath('tray.png'))) img = nativeImage.createFromPath(assetPath('tray.png'));
  } catch { /* fall back to empty */ }
  tray = new Tray(img);
  tray.setToolTip('Legion');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Legion', click: showWindow },
    { label: 'Restart core', click: () => void restartCore() },
    { label: 'Open data folder', click: () => void shell.openPath(dataDir()) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

if (process.platform === 'win32') app.setAppUserModelId('dev.legion.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  ipcMain.on('legion:bootstrap', (e) => {
    const { port, token } = readConfig();
    e.returnValue = { baseUrl: `http://127.0.0.1:${port}`, token, platform: process.platform };
  });
  ipcMain.handle('legion:open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && isHttp(url)) { void shell.openExternal(url); return true; }
    return false;
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => killCore());
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showWindow());

  void app.whenReady().then(async () => {
    await boot();
  });
}
