/**
 * Electron side of the updater. It never downloads or verifies anything (the core does); it asks the core whether an approved update is
 * ready and idle, takes the commit answer, copies the apply helper out of the folders it will swap, starts it detached, and quits.
 * The only child process it starts is that helper, run by the installed Electron binary in node mode. Plan: claude/plan-updater.md.
 */
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { VERSION } from '../shared/config.js';
import { cleanStaleApplyCopies, cleanupRuntimeCopy, confirmWhenHealthy, readOutcome, recoverAfterLiveSwap, UPDATE_DIR } from '../core/updater/apply.js';
import { buildJob, commitMatches, restartNowText, windowSwitches } from '../core/updater/main-logic.js';
import { planApplySpawn, prepareRuntimeCopy, shouldPrepare } from '../core/updater/runtime-copy.js';
import { holdStartForUpdate } from '../core/updater/start-gate.js';
import { isUpdateInProgress, MARKER_FILE_NAME } from '../core/updater/update-marker.js';
import { logOutcome, outcomeNotice, runNoticeChoice, writeAppLog } from '../core/updater/outcome-notice.js';
import { noteDoneAtStart, readLastJourney, recordStep } from '../core/updater/journey-io.js';
import { gateModel, noticeAfterWindow, settleFit } from '../core/updater/update-window-logic.js';
import { normalizeSettings } from '../core/updater/state.js';
import { copyWindowFiles, windowDir } from '../core/updater/window-files.js';
import { trustedSender } from './admin-logic.js';

type CoreCall = (method: 'GET' | 'POST', route: string, body?: unknown, native?: boolean) => Promise<{ status: number; json: any } | undefined>;
export interface UpdaterHost {
  installDir: string;
  dataDir: string;
  ownCoreCall: CoreCall;
  getWin(): BrowserWindow | null;
  uiUrl: string;
  pinnedPort(): number;
  stopCore(): Promise<void>;
  beginQuit(): void;
}

const here = dirname(fileURLToPath(import.meta.url)); // <root>/dist/src/electron
const helperSource = join(here, '..', 'core', 'updater', 'apply.js');

/** The plain text window of H1: used when the owner turned the update window off in Settings, or when the shared page is missing. */
const updateWindowHtml = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<body style="margin:0;background:#0b0d10;color:#e6e9ef;font:15px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;user-select:none">'
  + '<div><div style="font-size:18px;font-weight:600;margin-bottom:8px">Legion is finishing an update.</div><div style="opacity:.75">It opens by itself.</div></div></body>');
const sharedPage = join(here, '..', '..', '..', 'assets', 'update-window.html');

/**
 * The small window a start shows while an update finishes. Same look as the helper's "Updating Legion" window (one page, assets/update-window.html),
 * driven from the step log. Off in Settings (updateWindow) it is H1's plain text window. Returns what the caller must stop when the wait ends.
 */
function showGateWindow(installDir: string, dataDirPath: string, toVersion: string | undefined): { win: BrowserWindow | null; stop(): void } {
  let win: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    let on = true;
    try { on = normalizeSettings(JSON.parse(readFileSync(join(dataDirPath, 'updater', 'settings.json'), 'utf8'))).updateWindow; } catch { /* no settings file: the default is on */ }
    const shared = on && existsSync(sharedPage);
    win = new BrowserWindow({ width: shared ? 480 : 460, height: shared ? 470 : 200, frame: false, resizable: false, maximizable: false, minimizable: true, fullscreenable: false, center: true, backgroundColor: '#0b0d10', title: 'Legion', show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    if (shared) {
      const w = win;
      void w.loadFile(sharedPage).then(() => {
        let busy = false;
        // the same fit as the update window: the page's height at its zoom, never taller than the screen's usable area
        const paint = (): void => {
          if (w.isDestroyed() || busy) return;
          busy = true;
          const m = gateModel(readLastJourney(installDir), toVersion);
          void w.webContents.executeJavaScript(`window.updateWindow.render(${JSON.stringify(m)})`)
            .then(() => settleFit(w, () => w.webContents.executeJavaScript('window.updateWindow.height()') as Promise<number>, () => screen.getDisplayMatching(w.getBounds()).workArea))
            .catch(() => undefined).finally(() => { busy = false; });
        };
        paint(); timer = setInterval(paint, 500);
      }).catch(() => undefined);
    } else void win.loadURL(updateWindowHtml);
  } catch { /* no window: the wait still holds the start */ }
  return { win, stop: () => { if (timer) clearInterval(timer); if (win && !win.isDestroyed()) win.destroy(); } };
}

/**
 * Before anything else at start: when an update is swapping files (a live marker), do not start a core. Show a small window and wait until the
 * marker clears or goes stale (a hard cap ends the wait). The single-instance lock is released while waiting, so the helper's own relaunch of the
 * new build can take it; afterwards this process asks for it again and quits if the new build already owns it.
 * Returns 'exit' when this process must end now, 'go' to carry on starting.
 */
export async function holdStartIfUpdating(installDir: string, dataDirPath: string, handoff = false): Promise<'go' | 'exit'> {
  const markerPath = join(installDir, UPDATE_DIR, MARKER_FILE_NAME);
  let gate: { stop(): void } | null = null;
  const log = (line: string): void => { writeAppLog(dataDirPath, 'info', 'start-gate', { note: line }); };
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  const markerDeps = {
    markerPath, now: () => Date.now(), isPidAlive: alive, getPidStartTime: () => null,
    createExclusive: () => { throw new Error('read-only here'); },
    read: (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    remove: (p: string) => { rmSync(p, { force: true }); }, log,
  };
  let r;
  try {
    r = await holdStartForUpdate({
      check: () => isUpdateInProgress(markerDeps),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)), now: () => Date.now(),
      clearStale: () => { try { rmSync(markerPath, { force: true }); } catch { /* a later start tries again */ } },
      log, handoff,
      onWait: (info) => {
        try { app.releaseSingleInstanceLock(); } catch { /* none held */ }
        gate = showGateWindow(installDir, dataDirPath, info.toVersion);
      },
    });
  } catch { return 'go'; } // a gate that breaks must never stop Legion from opening
  (gate as { stop(): void } | null)?.stop();
  if (!r.waited) return 'go';
  if (!app.requestSingleInstanceLock()) { log('the new build owns the single-instance lock: this process ends'); return 'exit'; }
  let onDisk = VERSION;
  try { onDisk = (JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')) as { version?: string }).version ?? VERSION; } catch { /* keep VERSION */ }
  if (onDisk !== VERSION) { log(`the install is now ${onDisk} but this process still runs ${VERSION} code: restarting`); app.relaunch(); return 'exit'; }
  return 'go';
}

/** Logs the outcome the last update left, once per start, to app.log (a failure was invisible in the logs before). */
export function logStartOutcome(installDir: string, dataDirPath: string): void {
  try { logOutcome(dataDirPath, readOutcome(installDir)); } catch { /* logging never blocks the start */ }
}

let noticeShown = false;
/**
 * After the window is up and the core answers: if the last update did not finish and nobody has acknowledged it, say so once, in a dialog on
 * the Legion window. Retry downloads and installs again; Dismiss (or Esc) clears the record.
 */
export async function showOutcomeNotice(h: Pick<UpdaterHost, 'installDir' | 'ownCoreCall' | 'getWin'>, dataDirPath: string): Promise<void> {
  if (noticeShown) return;
  const n = outcomeNotice(readOutcome(h.installDir));
  if (!n) return;
  noticeShown = true;
  try {
    const log0 = (line: string): void => { writeAppLog(dataDirPath, 'info', 'outcome-notice', { note: line }); };
    // The "Updating Legion" window already showed this failure with Retry and Close. Wait for its answer instead of asking twice.
    const jid = readLastJourney(h.installDir)?.id;
    const readState = (): { pid?: number } => { try { return JSON.parse(readFileSync(join(windowDir(h.installDir), 'state.json'), 'utf8')) as { pid?: number }; } catch { return {}; } };
    const alive = (pid?: number): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
    const readResult = (): { id?: string; choice?: string } | null => { try { return JSON.parse(readFileSync(join(h.installDir, UPDATE_DIR, 'window-result.json'), 'utf8')) as { id?: string; choice?: string }; } catch { return null; } };
    const end = Date.now() + 6 * 60_000;
    let verdict = noticeAfterWindow({ open: alive(readState().pid), result: readResult() }, jid);
    while (verdict === 'wait' && Date.now() < end) { await new Promise((r) => setTimeout(r, 1000)); verdict = noticeAfterWindow({ open: alive(readState().pid), result: readResult() }, jid); }
    if (verdict === 'wait') verdict = 'ask';
    if (verdict === 'quiet') { log0('the update window showed the failure and the person closed it: no second dialog'); return; }
    if (verdict === 'retry') {
      log0('the update window showed the failure and the person chose Retry: retrying');
      const res = await runNoticeChoice(n, 0, (m, route, body) => h.ownCoreCall(m, route, body), log0);
      if (res.kind === 'later') log0(res.line);
      return;
    }
    const w = h.getWin();
    const opts = { type: 'warning' as const, title: n.title, message: n.message, buttons: [...n.buttons], defaultId: 0, cancelId: 1, noLink: true };
    const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    const log = (line: string): void => { writeAppLog(dataDirPath, 'info', 'outcome-notice', { note: line }); };
    const res = await runNoticeChoice(n, r.response, (m, route, body) => h.ownCoreCall(m, route, body), log);
    if (res.kind === 'later') {
      const o2 = { type: 'info' as const, title: n.title, message: res.line, buttons: ['OK'], defaultId: 0, noLink: true };
      if (w && !w.isDestroyed()) await dialog.showMessageBox(w, o2); else await dialog.showMessageBox(o2);
    }
  } catch (e) { writeAppLog(dataDirPath, 'warn', 'outcome-notice', { note: `the notice failed: ${e instanceof Error ? e.message : String(e)}` }); /* the Settings panel still shows the record */ }
}

/** Before the core starts: finish or undo an update that was cut off (waiting out a swap whose helper is still beating). */
export async function recoverAtStart(installDir: string, dataDirPath: string): Promise<void> {
  // A swap still in progress (for example by an older helper that keeps no marker) can hold this wait for minutes: show the same
  // "finishing an update" window after a moment, so a start never looks like a dead app.
  let gate: { stop(): void } | null = null;
  const t = setTimeout(() => { gate = showGateWindow(installDir, dataDirPath, undefined); }, 1500);
  try { await recoverAfterLiveSwap(installDir, { runningVersion: VERSION }); } catch { /* never blocks the start */ }
  clearTimeout(t);
  (gate as { stop(): void } | null)?.stop();
  // A full update leaves a copy of the Electron folder in the temp folder (the helper cannot delete the folder it ran from).
  try { cleanStaleApplyCopies(tmpdir(), { maxAgeMs: 24 * 3600_000, nowMs: Date.now() }); } catch { /* best effort */ }
}

let applying = false;
let dialogOpen = false;

async function applyNow(h: UpdaterHost, force: boolean): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  if (applying) return { ok: false, error: 'An update is already being applied.' };
  applying = true;
  try {
    const st = await h.ownCoreCall('GET', '/api/update/status');
    if (!st || st.status !== 200) return { ok: false, error: 'Legion could not reach its own core.' };
    if (!st.json.staged || !st.json.consent) return { ok: false, error: 'No approved update is ready.' };
    if (force) {
      if (dialogOpen) return { ok: false, error: 'A confirmation is already open.' };
      dialogOpen = true;
      try {
        const t = restartNowText(st.json.busy?.reasons ?? [], st.json.staged.version);
        const w = h.getWin();
        const opts = { type: 'warning' as const, title: 'Restart Legion', message: t.message, detail: t.detail, buttons: [...t.buttons], defaultId: 0, cancelId: 0, noLink: true };
        const r = w && !w.isDestroyed() && w.isVisible() ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
        if (r.response !== 1) return { ok: false, cancelled: true };
      } finally { dialogOpen = false; }
      const d = await h.ownCoreCall('POST', '/api/update/drain', {}, true);
      if (!d || d.status !== 200) return { ok: false, error: 'Legion could not stop the running work cleanly.' };
    } else if (!st.json.readyToApply) return { ok: false, error: 'Legion is not idle yet.' };
    const c = await h.ownCoreCall('POST', '/api/update/commit', { force }, true);
    if (!c || c.status !== 200) return { ok: false, error: typeof c?.json?.error === 'string' ? c.json.error : 'The core refused to start the update.' };
    if (!commitMatches(c.json, h.installDir)) { await h.ownCoreCall('POST', '/api/update/abort-commit', {}, true); return { ok: false, error: 'The update did not match this install.' }; }
    try {
      const run = join(h.installDir, UPDATE_DIR, 'run');
      mkdirSync(run, { recursive: true });
      copyFileSync(helperSource, join(run, 'apply.mjs'));
      // The "Updating Legion" window runs from files outside the install, so they are copied out now, before this app quits and the swap begins.
      const showWindow = st.json.settings?.updateWindow !== false;
      let windowCopied = false;
      if (showWindow) {
        const wc = copyWindowFiles(h.installDir);
        windowCopied = wc.ok;
        if (!wc.ok) { try { appendFileSync(join(h.installDir, UPDATE_DIR, 'apply.log'), `[${new Date().toISOString()}] the update window files could not be copied (${wc.missing.join(', ')}): updating without the window\n`); } catch { /* ignore */ } }
      }
      const jobFile = join(run, 'job.json');
      writeFileSync(jobFile, JSON.stringify(buildJob(c.json, { parentPid: process.pid, port: h.pinnedPort(), execPath: process.execPath, dataDir: h.dataDir, window: { enabled: windowCopied, userData: app.getPath('userData'), args: windowSwitches(process.argv) } })));
      // A full package swap renames the runtime this process runs from. When a verified copy of it was made ahead of time, start the helper from
      // that copy (no 36 s copy while the app is gone); otherwise the helper re-runs itself from a fresh copy, as before.
      const full = process.platform === 'win32' && !!c.json.names?.includes('node_modules');
      const plan = full ? planApplySpawn({ installDir: h.installDir, srcDir: dirname(process.execPath), exeName: basename(process.execPath) }) : { cmd: process.execPath, fromCopy: false, env: {} as Record<string, string> };
      if (full) { try { appendFileSync(join(h.installDir, UPDATE_DIR, 'apply.log'), `[${new Date().toISOString()}] ${plan.fromCopy ? 'starting the swap helper from the prepared runtime copy' : 'no verified runtime copy: the helper will make one itself'}\n`); } catch { /* ignore */ } }
      const child = spawn(plan.cmd, [join(run, 'apply.mjs'), jobFile], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...plan.env, ELECTRON_RUN_AS_NODE: '1' } });
      child.on('error', () => undefined);
      child.unref();
      if (!child.pid) throw new Error('the helper did not start');
      // step 5 starts here, from the app: the helper finishes it once the old app and core are gone
      if (c.json.updateId) recordStep({ installDir: h.installDir, dataDir: h.dataDir, id: c.json.updateId, from: c.json.from, to: c.json.to, proc: 'app', kind: full ? 'full' : 'code' }, 'closing', 'start', { note: 'Legion is closing so the update can be installed' });
    } catch (e) {
      await h.ownCoreCall('POST', '/api/update/abort-commit', {}, true);
      return { ok: false, error: `Could not start the update helper: ${e instanceof Error ? e.message : String(e)}` };
    }
    h.beginQuit(); // main kills the core (taskkill by PID tree) in will-quit; the helper waits for this process to exit
    return { ok: true };
  } finally { applying = false; }
}

/**
 * A freshly swapped-in build confirms itself, so a dead helper cannot leave it unconfirmed, but ONLY once its core answers
 * /health with this version. Call it after a boot whose core came up; a slow or failed core start leaves the decision (and the
 * previous copy, which is the rollback) to the helper.
 */
export async function confirmAfterBoot(installDir: string, dataDirPath: string, getHealth: () => Promise<{ ok?: boolean; version?: string } | null>): Promise<void> {
  try { if (await confirmWhenHealthy(installDir, VERSION, getHealth)) noteDoneAtStart(installDir, dataDirPath, VERSION); } catch { /* ignore */ }
}

const prepareGate = { preparing: false, retryAt: 0, lowDiskVersion: null as string | null };
/** While a full package waits in .update/staging, make the out-of-install runtime copy in the background so the apply does not have to. */
async function keepRuntimeCopyReady(h: UpdaterHost, stagedVersion: string | undefined): Promise<void> {
  if (!shouldPrepare(prepareGate, Date.now(), stagedVersion)) return;
  prepareGate.preparing = true;
  const note = (t: string): void => { try { appendFileSync(join(h.installDir, UPDATE_DIR, 'apply.log'), `[${new Date().toISOString()}] ${t}
`); } catch { /* ignore */ } };
  try {
    const r = await prepareRuntimeCopy({ installDir: h.installDir, srcDir: dirname(process.execPath), exeName: basename(process.execPath) });
    if (r.ok && !r.reused) note('prepared the runtime copy for the update helper');
    if (!r.ok && r.lowDisk) { prepareGate.lowDiskVersion = stagedVersion ?? ''; note(`no runtime copy made: ${r.error}; the helper will make one itself when it applies the update`); }
    else if (!r.ok) { note(`could not prepare the runtime copy (${r.error}); the helper will make one itself`); prepareGate.retryAt = Date.now() + 10 * 60_000; }
  } finally { prepareGate.preparing = false; }
}

export function initUpdater(h: UpdaterHost): void {
  ipcMain.handle('legion:update-restart-now', async (e): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> => {
    const win = h.getWin();
    const frameUrl = (e as { senderFrame?: { url?: string } }).senderFrame?.url;
    if (!win || win.isDestroyed() || (e as { sender?: unknown }).sender !== win.webContents || !trustedSender(frameUrl, h.uiUrl)) return { ok: false, error: 'Refused: not the Legion window.' };
    try { return await applyNow(h, true); } catch { return { ok: false, error: 'The update failed to start.' }; }
  });
  // An approved update (or the opt-in auto setting) installs by itself only when the core says it is ready AND idle.
  const timer = setInterval(() => { void (async () => {
    if (applying || dialogOpen) return;
    const st = await h.ownCoreCall('GET', '/api/update/status').catch(() => undefined);
    if (st?.status === 200 && process.platform === 'win32' && st.json.staged?.kind === 'full') void keepRuntimeCopyReady(h, st.json.staged?.version).catch(() => undefined);
    else if (st?.status === 200) void cleanupRuntimeCopy(h.installDir).catch(() => undefined); // an update landed: the copy has done its job
    if (st?.status === 200 && st.json.readyToApply === true && app.isReady()) await applyNow(h, false);
  })().catch(() => undefined); }, 20_000);
  timer.unref();
}
