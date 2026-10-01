/** Electron main process. */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adminForRenderer, coreAction, coreIsBusy, type CoreHealth } from './admin-logic.js';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let coreProc: ChildProcess | null = null;
let quitting = false;
let booting = true;
let splash: BrowserWindow | null = null;
/** Per-launch admin secret of the core child we spawned (memory only: stdin pipe to the child, IPC to our own renderer; never env, argv or disk). */
let adminSecret: string | undefined;
/** What `legion:bootstrap` hands to the renderer: set only after /health proved the core on the port is our child and holds the secret. */
let rendererAdmin: string | undefined;
/**
 * The port and MCP token this window talks to, fixed when we start (or adopt) the core. config.json is NOT read again after that:
 * a bot can edit that file, and an edited `port` must never point the window (and the admin secret) at its own listener.
 */
let pinned: { port: number; token: string } | null = null;

const isHttp = (u: string) => {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
};
const openExternal = (u: string) => { if (isHttp(u)) void shell.openExternal(u); };

/** /health body of whatever answers on the port, or null. With a nonce, a core that holds the admin secret also answers the HMAC proof. */
async function getHealth(port: number, timeoutMs = 1500, nonce?: string): Promise<CoreHealth | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health${nonce ? `?nonce=${nonce}` : ''}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => ({}))) as CoreHealth;
    return { ...j, ok: true };
  } catch { return null; }
}
const healthy = async (port: number, timeoutMs?: number): Promise<boolean> => !!(await getHealth(port, timeoutMs));

/** Challenge the core on the port: the secret is given out only if it answers HMAC(secret, fresh nonce). Pid and `admin:true` prove nothing. */
async function ownCoreSecret(port: number): Promise<string | undefined> {
  const nonce = randomBytes(16).toString('hex');
  return adminForRenderer(await getHealth(port, 1500, nonce), adminSecret, nonce);
}

/** Whether the core on the port has running tasks or pending approvals (read with the MCP-class token; unreadable counts as busy). */
async function foreignCoreBusy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${readConfig().token}` }, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return true;
    return coreIsBusy(await r.json());
  } catch { return true; }
}

function stopPid(pid: number): void {
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

async function waitPortFree(port: number, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await healthy(port, 500))) return true; await sleep(250); }
  return false;
}

/** Returns null on success, or a human-readable error. */
async function spawnCore(port: number): Promise<string | null> {
  const nodeBin = process.env.LEGION_NODE || 'node';
  let out: number | 'ignore' = 'ignore';
  try { out = openSync(join(dataDir(), 'core.log'), 'a'); } catch { /* ignore */ }
  try {
    let failure: string | null = null;
    // A fresh secret for every core we start (a tray restart rotates it). It goes over the stdin pipe only.
    const secret = randomBytes(24).toString('hex');
    const child = spawn(nodeBin, [coreEntry], {
      cwd: root,
      stdio: ['pipe', out, out],
      windowsHide: true,
      detached: false,
      // LEGION_PORT pins the port we just chose: the core listens exactly there even if config.json is edited meanwhile.
      env: { ...process.env, LEGION_ADMIN_STDIN: '1', LEGION_PORT: String(port) },
    });
    coreProc = child;
    adminSecret = secret;
    rendererAdmin = undefined;
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(secret + '\n');
    child.on('error', (err: NodeJS.ErrnoException) => {
      coreProc = null;
      failure = err.code === 'ENOENT'
        ? 'Node.js 20+ not found on PATH. Install: winget install OpenJS.NodeJS.LTS (or set LEGION_NODE).'
        : `Could not start core: ${err.message || err}`;
    });
    child.on('exit', (code) => {
      if (coreProc === child) { coreProc = null; adminSecret = undefined; rendererAdmin = undefined; }
      if (!failure) failure = `Core exited (code ${code}). See core.log.`;
    });
    await new Promise((r) => setTimeout(r, 200));
    return failure;
  } finally {
    if (typeof out === 'number') { try { closeSync(out); } catch { /* ignore */ } }
  }
}

/** Asks what to do with a foreign core that is busy. true = restart it now. */
async function askRestartForeignCore(): Promise<boolean> {
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart now', 'Later'],
    defaultId: 1, cancelId: 1,
    message: 'Legion Core was started outside this app and is busy.',
    detail: 'Approvals and settings stay locked until Legion restarts it, because only a core started by this app holds the admin key. '
      + 'Restarting now cuts off its running tasks and pending approvals. Later keeps it running; use Restart core in the tray menu when it is idle.',
  });
  return r.response === 0;
}

/** Returns null when a core we can use is up, else an error message. */
async function ensureCore(): Promise<string | null> {
  const first = pinned ?? readConfig();
  const port = first.port;
  const health = await getHealth(port);
  if (health) {
    const mine = await ownCoreSecret(port);
    const busy = mine ? false : await foreignCoreBusy(port);
    const action = coreAction({ health, ownProof: !!mine, busy, selfPid: process.pid });
    if (action === 'use') { pinned = { port, token: readConfig().token }; rendererAdmin = mine; return null; }
    if (action === 'blocked') {
      dialog.showMessageBox({ type: 'info', message: 'Legion Core was started outside this app.', detail: 'Approvals and settings are locked. Stop it from its own terminal and restart Legion.' }).catch(() => {});
      pinned = readConfig(); rendererAdmin = undefined;
      return null;
    }
    if (action === 'ask' && !(await askRestartForeignCore())) { pinned = readConfig(); rendererAdmin = undefined; return null; }
    // 'replace' (idle) or 'ask' answered yes: stop the foreign core by pid, then start our own.
    stopPid(health.pid as number);
    if (!(await waitPortFree(port))) return 'The core on the port did not stop. Stop it manually (see core.log) and try again.';
  }
  pinned = { port, token: '' };
  const err = await spawnCore(port);
  if (err) return err;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    // up AND proved to hold our secret (a rogue that grabbed the port first never does)
    const mine = await ownCoreSecret(port);
    if (mine) { pinned = { port, token: readConfig().token }; rendererAdmin = mine; return null; }
    if (!coreProc) return 'Core exited before becoming ready. See core.log.';
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'Core did not become ready within 15s. See core.log.';
}

/** Stops our own core child and waits for its exit event (not a fixed sleep), so a dying core is never mistaken for a foreign one. */
async function killCore(): Promise<void> {
  rendererAdmin = undefined;
  adminSecret = undefined;
  const c = coreProc;
  coreProc = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>((r) => c.once('exit', () => r()));
  try { c.kill(); } catch { /* ignore */ }
  await Promise.race([exited, sleep(5000)]);
  if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
}

/** Tray "Restart core": rotates the admin secret. The window reload re-runs the preload, so the renderer picks up the new secret. */
async function restartCore(): Promise<void> {
  if (coreProc) {
    await killCore();
    await waitPortFree((pinned ?? readConfig()).port);
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
    // Port and token are the ones pinned when the core was started or adopted (config.json is not re-read: a bot can edit it).
    const { port, token } = pinned ?? readConfig();
    // `admin` is the per-launch secret, only while our own child is alive and has proved (HMAC challenge) that it holds it.
    const live = !!coreProc && coreProc.exitCode === null;
    e.returnValue = { baseUrl: `http://127.0.0.1:${port}`, token, admin: live ? rendererAdmin ?? '' : '', platform: process.platform };
  });
  ipcMain.handle('legion:open-external', (_e, url: unknown) => {
    if (typeof url === 'string' && isHttp(url)) { void shell.openExternal(url); return true; }
    return false;
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { void killCore(); });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showWindow());

  void app.whenReady().then(async () => {
    await boot();
  });
}
