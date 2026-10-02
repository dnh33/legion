/**
 * Electron side of the updater. It never downloads or verifies anything (the core does); it asks the core whether an approved update is
 * ready and idle, takes the commit answer, copies the apply helper out of the folders it will swap, starts it detached, and quits.
 * The only child process it starts is that helper, run by the installed Electron binary in node mode. Plan: claude/plan-updater.md.
 */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../shared/config.js';
import { markCommitted, readJournal, recoverInterrupted, UPDATE_DIR } from '../core/updater/apply.js';
import { buildJob, commitMatches, restartNowText } from '../core/updater/main-logic.js';
import { trustedSender } from './admin-logic.js';

type CoreCall = (method: 'GET' | 'POST', route: string, body?: unknown, native?: boolean) => Promise<{ status: number; json: any } | undefined>;
export interface UpdaterHost {
  installDir: string;
  ownCoreCall: CoreCall;
  getWin(): BrowserWindow | null;
  uiUrl: string;
  pinnedPort(): number;
  stopCore(): Promise<void>;
  beginQuit(): void;
}

const here = dirname(fileURLToPath(import.meta.url)); // <root>/dist/src/electron
const helperSource = join(here, '..', 'core', 'updater', 'apply.js');

/** Before the core starts: finish or undo an update that was cut off. */
export async function recoverAtStart(installDir: string): Promise<void> {
  try { await recoverInterrupted(installDir, { runningVersion: VERSION }); } catch { /* never blocks the start */ }
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
      const jobFile = join(run, 'job.json');
      writeFileSync(jobFile, JSON.stringify(buildJob(c.json, { parentPid: process.pid, port: h.pinnedPort(), execPath: process.execPath })));
      const child = spawn(process.execPath, [join(run, 'apply.mjs'), jobFile], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      child.on('error', () => undefined);
      child.unref();
      if (!child.pid) throw new Error('the helper did not start');
    } catch (e) {
      await h.ownCoreCall('POST', '/api/update/abort-commit', {}, true);
      return { ok: false, error: `Could not start the update helper: ${e instanceof Error ? e.message : String(e)}` };
    }
    h.beginQuit(); // main kills the core (taskkill by PID tree) in will-quit; the helper waits for this process to exit
    return { ok: true };
  } finally { applying = false; }
}

/** After the core proved healthy: a freshly swapped-in build confirms itself, so a dead helper cannot leave it unconfirmed. */
function confirmIfNew(installDir: string): void {
  try { const j = readJournal(installDir); if (j && j.state === 'awaiting-health' && j.to === VERSION) markCommitted(installDir); } catch { /* ignore */ }
}

export function initUpdater(h: UpdaterHost): void {
  confirmIfNew(h.installDir);
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
    if (st?.status === 200 && st.json.readyToApply === true && app.isReady()) await applyNow(h, false);
  })().catch(() => undefined); }, 20_000);
  timer.unref();
}
