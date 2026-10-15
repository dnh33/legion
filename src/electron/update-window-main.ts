/**
 * The "Updating Legion" window. A tiny Electron app the swap helper starts from a runtime outside the install, running from the files in
 * <install>/.update/run/window (copied there by the app before it quit; window-files.ts). It shows every step from "Closing Legion" to "Done",
 * holds Legion's single-instance lock while it waits (so a reopen lands here, not in a second core), hands the lock over before the new build starts,
 * and closes itself when the helper says so, when the helper has gone, or at a hard cap.
 *
 * It imports only electron, node: and the two pure files copied beside it. It never touches the install, the data folder or the core.
 * Its own files (cache, logs) go to a temp folder, so it cannot hold a lock on anything the new build's window needs.
 */
import { app, BrowserWindow } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldJourney, parseJourneyJsonl } from '../core/updater/journey.js';
import { lockAction, pendingCommands, windowDecision, windowModel, type WindowFinish } from '../core/updater/update-window-logic.js';

const winDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
interface WindowJob { installDir: string; updateId: string; helperPid: number; appPid?: number; userData: string; from: string; to: string; kind: 'code' | 'full'; startedAt: number }
const job = JSON.parse(readFileSync(join(winDir, 'window-job.json'), 'utf8')) as WindowJob;
const up = join(job.installDir, '.update');
const stamp = (): string => new Date().toISOString();
const log = (msg: string): void => { try { appendFileSync(join(up, 'apply.log'), `[${stamp()}] window pid=${process.pid} id=${job.updateId} ${msg}\n`); } catch { /* ignore */ } };
const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const readText = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// Legion's identity for the single-instance lock is its user-data folder, not its name (verified on this PC: another app name with the same
// folder is refused; the same name with another folder is not). Everything else this process writes goes to a temp folder of its own.
app.setPath('userData', job.userData);
const own = join(tmpdir(), `legion-update-window-${process.pid}`);
// A window cannot delete its own cache folder while it runs (Chromium re-creates files at exit), so each window removes the leftovers of earlier ones.
try {
  for (const n of readdirSync(tmpdir())) {
    if (!/^legion-update-window-\d+$/.test(n) || join(tmpdir(), n) === own) continue;
    try { if (Date.now() - statSync(join(tmpdir(), n)).mtimeMs > 10 * 60_000) rmSync(join(tmpdir(), n), { recursive: true, force: true }); } catch { /* in use: the next window tries again */ }
  }
} catch { /* ignore */ }
try { mkdirSync(own, { recursive: true }); } catch { /* ignore */ }
app.setPath('sessionData', own);
app.setPath('logs', own);
app.disableHardwareAcceleration();

let held = false; let released = false;
let win: BrowserWindow | null = null;
let finish: WindowFinish | undefined;
let choice: 'retry' | 'close' | undefined;
let handled = 0; let helperGoneAt = 0; let lastModel = '';
const openedAt = Date.now();
const setLock = (v: string): void => { try { writeFileSync(join(winDir, 'state.json'), JSON.stringify({ lock: v, pid: process.pid, at: stamp() })); } catch { /* ignore */ } };

function leave(reason: string): void {
  log(`closing reason=${reason}`);
  try { writeFileSync(join(up, 'window-result.json'), JSON.stringify({ id: job.updateId, choice: choice ?? (reason === 'done' ? 'done' : 'timeout'), reason, at: stamp() })); } catch { /* ignore */ }
  try { rmSync(own, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(0);
}

/** Paints the model, then sizes the window to what it needs (a long reason, a larger text size): never cut off, never taller than the screen can use. */
async function fit(w: BrowserWindow, json: string): Promise<void> {
  try {
    const h = await w.webContents.executeJavaScript(`(window.updateWindow.render(${json}), window.updateWindow.height())`) as number;
    if (!w.isDestroyed() && Number.isFinite(h)) w.setContentSize(480, Math.max(420, Math.min(780, Math.ceil(h) + 2)));
  } catch { /* the next change paints again */ }
}

function tick(): void {
  const now = Date.now();
  for (const c of pendingCommands(readText(join(winDir, 'commands.jsonl')), handled)) {
    handled = c.seq;
    if (c.cmd === 'finish' && c.result) { finish = { result: c.result, at: now, ...(c.message ? { message: c.message } : {}) }; log(`told the result: ${c.result}`); }
    if (c.cmd === 'release-lock') releaseRequested = true;
  }
  const act = lockAction({ held, released }, { releaseRequested, finished: !!finish, appGone: !alive(job.appPid) });
  if (act === 'request') { held = app.requestSingleInstanceLock(); if (held) { setLock('held'); log('holds the single-instance lock: a reopen of Legion lands here'); } }
  else if (act === 'release') { try { app.releaseSingleInstanceLock(); } catch { /* none held */ } held = false; released = true; setLock('released'); log('handed the single-instance lock over to the new build'); }
  else if (releaseRequested && !held && !released) { released = true; setLock('released'); log('asked to hand over before the lock was taken: never taken'); }
  const events = parseJourneyJsonl(readText(join(up, 'journey.jsonl')));
  const view = foldJourney(events, job.updateId);
  if (!finish && view && view.result !== 'running' && view.result !== 'ok') finish = { result: view.result, at: now };
  if (!finish && view?.result === 'ok') finish = { result: 'ok', at: now };
  if (!alive(job.helperPid)) { if (!helperGoneAt) helperGoneAt = now; } else helperGoneAt = 0;
  const m = windowModel(view, finish);
  const j = JSON.stringify(m);
  if (j !== lastModel && win && !win.isDestroyed()) { lastModel = j; void fit(win, j); }
  const d = windowDecision({ openedAt, helperDeadForMs: helperGoneAt ? now - helperGoneAt : 0, ...(finish ? { finish } : {}), ...(choice ? { choice } : {}) }, now);
  if (d.close) leave(d.reason);
}
let releaseRequested = false;

app.on('second-instance', () => {
  log('a reopen of Legion landed here: no second core was started');
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
// a window that fails must still say something is happening, and must never outlive its helper silently
process.on('uncaughtException', (e) => { log(`error: ${e.message}`); });

void app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 480, height: 470, frame: false, resizable: false, maximizable: false, minimizable: true, fullscreenable: false, center: true,
    backgroundColor: '#0b0d10', title: 'Updating Legion', show: true, ...(existsSync(join(winDir, 'icon.png')) ? { icon: join(winDir, 'icon.png') } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // the buttons signal through the document title (no preload, no node), as the start splash does
  win.webContents.on('page-title-updated', (_e, title) => {
    const m = /^legion-update:(retry|close):/.exec(title);
    if (m) { choice = m[1] as 'retry' | 'close'; log(`the person chose ${choice}`); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(join(winDir, 'update-window.html')).then(() => { log(`opened ${job.from} to ${job.to} (${job.kind})`); tick(); });
  setInterval(tick, 250);
});
