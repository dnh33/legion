/**
 * The "Updating Legion" window. A tiny Electron app the swap helper starts from a runtime outside the install, running from the files in
 * <install>/.update/run/window (copied there by the app before it quit; window-files.ts). It shows every step from "Closing Legion" to "Done",
 * holds Legion's single-instance lock while it waits (so a reopen lands here, not in a second core), hands the lock over before the new build starts,
 * and closes itself when the helper says so, when the helper has gone, or at a hard cap.
 *
 * It imports only electron, node: and the two pure files copied beside it. It never touches the install, the data folder or the core.
 * Its own files (cache, logs) go to a temp folder, so it cannot hold a lock on anything the new build's window needs.
 */
import { app, BrowserWindow, screen } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldJourney, parseJourneyJsonl } from '../core/updater/journey.js';
import { lockAction, pendingCommands, settleFit, shouldStartLegion, windowDecision, windowModel, type WindowFinish } from '../core/updater/update-window-logic.js';

const winDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
interface WindowJob { installDir: string; updateId: string; helperPid: number; appPid?: number; userData: string; from: string; to: string; kind: 'code' | 'full'; startedAt: number; relaunch?: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> } }
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

/**
 * A failed update the helper could not follow with Legion (the backup failed, the old app would not close): Retry, Close and the time limit all start
 * Legion here, after the lock is let go, so a person is never left with no Legion and a window that does nothing. Retry then does its work in the app.
 */
async function startLegion(): Promise<void> {
  const r = job.relaunch;
  if (!r) { log('could not start Legion: the job has no start command'); return; }
  for (let i = 0; i < 40 && alive(job.appPid); i++) await new Promise((res) => setTimeout(res, 250)); // the old app is still closing
  if (alive(job.appPid)) { log('Legion is still running: not starting a second one'); return; }
  if (held) { try { app.releaseSingleInstanceLock(); } catch { /* none held */ } held = false; released = true; setLock('released'); }
  try {
    const env: Record<string, string | undefined> = { ...process.env, ...(r.env ?? {}) };
    for (const k of ['ELECTRON_RUN_AS_NODE', 'LEGION_UPDATE_WINDOW', 'LEGION_UPDATE_HANDOFF']) delete env[k];
    const c = spawn(r.cmd, r.args, { cwd: r.cwd, detached: true, stdio: 'ignore', windowsHide: false, env });
    c.on('error', (e) => log(`could not start Legion: ${e.message}`));
    c.unref();
    log(`started Legion pid=${c.pid ?? 'none'}: the update did not finish and nothing had started it again`);
  } catch (e) { log(`could not start Legion: ${e instanceof Error ? e.message : String(e)}`); }
}

let leaving = false;
async function leave(reason: Parameters<typeof shouldStartLegion>[1]): Promise<void> {
  if (leaving) return;
  leaving = true;
  log(`closing reason=${reason}`);
  try { writeFileSync(join(up, 'window-result.json'), JSON.stringify({ id: job.updateId, choice: choice ?? (reason === 'done' ? 'done' : 'timeout'), reason, at: stamp() })); } catch { /* ignore */ }
  if (shouldStartLegion(finish, reason)) await startLegion();
  try { rmSync(own, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(0);
}

/** Paints the model, then sizes the window to what it needs at the page's zoom, never taller than the screen can use (the body scrolls, the buttons stay). */
async function fit(w: BrowserWindow, json?: string): Promise<void> {
  try {
    if (json) await w.webContents.executeJavaScript(`window.updateWindow.render(${json})`);
    await settleFit(w, () => w.webContents.executeJavaScript('window.updateWindow.height()') as Promise<number>, () => screen.getDisplayMatching(w.getBounds()).workArea);
    lastZoom = w.webContents.getZoomFactor();
  } catch { /* the next change paints again */ }
}
let lastZoom = 1;

function tick(): void {
  const now = Date.now();
  for (const c of pendingCommands(readText(join(winDir, 'commands.jsonl')), handled)) {
    handled = c.seq;
    if (c.cmd === 'finish' && c.result) { finish = { result: c.result, at: now, ...(c.message ? { message: c.message } : {}), ...(c.started !== undefined ? { started: c.started } : {}) }; log(`told the result: ${c.result}`); }
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
  if (win && !win.isDestroyed()) {
    if (j !== lastModel) { lastModel = j; void fit(win, j); }
    else if (win.webContents.getZoomFactor() !== lastZoom) { lastZoom = win.webContents.getZoomFactor(); void fit(win); } // a zoom change does not fire a resize
  }
  const d = windowDecision({ openedAt, helperDeadForMs: helperGoneAt ? now - helperGoneAt : 0, ...(finish ? { finish } : {}), ...(choice ? { choice } : {}) }, now);
  if (d.close) void leave(d.reason);
}
let releaseRequested = false;

app.on('second-instance', () => {
  log('a reopen of Legion landed here: no second core was started');
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
// a window that fails must still say something is happening, and must never outlive its helper silently
process.on('uncaughtException', (e) => { log(`error: ${e.message}`); });

// The loop starts at boot, not when the page is up: the lock can be taken before `ready`, and on a fast swap the old app is gone and the
// hand-over is asked for within a few hundred milliseconds. Taking the lock only after the page loaded meant never taking it at all.
tick();
setInterval(tick, 100);

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
  void win.loadFile(join(winDir, 'update-window.html')).then(() => { log(`opened ${job.from} to ${job.to} (${job.kind})`); lastModel = ''; tick(); });
});
