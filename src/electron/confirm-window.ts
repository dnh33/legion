/**
 * The Legion confirm window: the one place Legion asks you before it changes a setting or moves money. It is a separate window, owned by this (the main)
 * process and loaded from assets/confirm-window.html. The Legion page cannot ask it anything but the question's words (those come from main too), cannot
 * press its buttons, and cannot read the answer: the page answers by changing ITS OWN title to `legion-confirm:<one-time id>:<button>`, and main reads
 * that only from this window's web contents. There is no preload, no node and no network (the page's policy allows none).
 *
 * It takes the place of dialog.showMessageBox for those questions: `confirmWindow.showMessageBox([parent,] options)` gives `{ response }` like Electron's,
 * honouring buttons, defaultId and cancelId. Only one question is open at a time. If the window cannot be shown (the file is missing, it fails to load or
 * draw, a field is out of bounds) the same question goes to the system dialog: an answer is never made up, and a failure is never a yes.
 * Pure rules (checking a question, reading an answer, the size) are in confirm-window-logic.ts.
 */
import { app, BrowserWindow, dialog, nativeTheme, screen, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, CONFIRM_WIDTH, createAnswerGate, nativeOptions, pickTheme, resolveIds, settleConfirmFit, THEME_BG, type ConfirmOptions } from './confirm-window-logic.js';

const here = dirname(fileURLToPath(import.meta.url)); // <root>/dist/src/electron
const root = resolve(here, '..', '..', '..');
export const CONFIRM_PAGE = join(root, 'assets', 'confirm-window.html');
/** No "persist:" prefix: an in-memory session of its own, so the window shares no cookies, zoom or permission rules with the Legion page. */
export const CONFIRM_PARTITION = 'legion-confirm';
const LOAD_MS = 8000;

export interface ConfirmHost {
  /** The main Legion window: its zoom and theme are the confirm window's, also when it is hidden and not the parent. */
  getMainWin(): BrowserWindow | null | undefined;
  log?(line: string): void;
}
let host: ConfirmHost = { getMainWin: () => null };
export function configureConfirmWindow(h: ConfirmHost): void { host = h; }
const log = (line: string): void => { try { host.log?.(`confirm window: ${line}`); } catch { /* logging must never change an answer */ } };

/** True while a question is open (in the Legion window or the system dialog). Spend reviews wait on this rather than lose their place. */
let busy = false;
export const confirmWindowBusy = (): boolean => busy;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took longer than ${ms} ms`); })]);
/** JSON is valid script apart from these two separators in old engines; escaping them costs nothing. */
const js = (v: unknown): string => JSON.stringify(v).replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');

let sessionReady = false;
function lockDownSession(): void {
  if (sessionReady) return;
  const ses = session.fromPartition(CONFIRM_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  sessionReady = true;
}

async function readTheme(w: BrowserWindow | null | undefined): Promise<'dark' | 'light'> {
  let raw: unknown;
  try { if (w && !w.isDestroyed()) raw = await Promise.race([w.webContents.executeJavaScript('document.documentElement.dataset.theme'), sleep(300).then(() => undefined)]); } catch { /* cosmetic only */ }
  return pickTheme(raw, nativeTheme.shouldUseDarkColors);
}
const zoomOf = (w: BrowserWindow | null | undefined): number => {
  try { const z = w && !w.isDestroyed() ? w.webContents.getZoomFactor() : 1; return Number.isFinite(z) ? Math.min(3, Math.max(0.5, z)) : 1; } catch { return 1; }
};

/** The system dialog with the same question. */
async function native(parent: BrowserWindow | null | undefined, opts: ConfirmOptions, why: string): Promise<number> {
  log(`${why}; asking with the system dialog`);
  const o = nativeOptions(opts) as unknown as Electron.MessageBoxOptions;
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, o) : await dialog.showMessageBox(o);
  return r.response;
}

async function ask(parent: BrowserWindow | null | undefined, opts: ConfirmOptions): Promise<number> {
  const source = parent && !parent.isDestroyed() ? parent : host.getMainWin();
  const theme = await readTheme(source);
  const nonce = randomBytes(16).toString('hex');
  const built = buildModel(opts, { nonce, theme });
  if (!built.ok) return native(parent, opts, `the question was not accepted (${built.reason})`);
  const model = built.model;
  if (!existsSync(CONFIRM_PAGE)) return native(parent, opts, 'the page file is missing');

  const zoom = zoomOf(source);
  const live = parent && !parent.isDestroyed() ? parent : undefined;
  // the window opens over its parent, or, with no visible Legion window (the tray), on the display the pointer is on
  const anchor = live ? live.getBounds() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const workArea = () => screen.getDisplayMatching(anchor).workArea;
  let win: BrowserWindow;
  try {
    lockDownSession();
    win = new BrowserWindow({
      width: Math.ceil(CONFIRM_WIDTH * zoom), height: Math.ceil(320 * zoom), show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: THEME_BG[theme], title: 'Legion', ...(live ? { parent: live, modal: true } : { alwaysOnTop: true }),
      ...(existsSync(join(root, 'assets', 'icon.png')) ? { icon: join(root, 'assets', 'icon.png') } : {}),
      // no preload, no node, no dev tools; its own in-memory session
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, spellcheck: false, partition: CONFIRM_PARTITION, zoomFactor: zoom },
    });
  } catch (e) { return native(parent, opts, `the window could not be made (${e instanceof Error ? e.message : String(e)})`); }

  const wc = win.webContents;
  win.removeMenu();
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // a reload would empty the page, and the question would be left with no buttons
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || input.key === 'F12' || ((input.control || input.meta) && /^[rR=+\-0]$/.test(input.key))) e.preventDefault();
  });

  return new Promise<number>((resolveAnswer) => {
    let phase: 'loading' | 'shown' | 'done' = 'loading';
    const gate = createAnswerGate(nonce, model.buttons.length);
    const finish = (n: number, why?: string): void => {
      if (phase === 'done') return;
      phase = 'done';
      app.removeListener('before-quit', onQuit);
      if (why) log(why);
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* gone */ }
      try { if (live && !live.isDestroyed()) live.focus(); } catch { /* gone */ }
      resolveAnswer(n);
    };
    const cancel = model.cancelIndex;
    const onQuit = (): void => finish(cancel, 'the app is closing: cancelled');
    app.once('before-quit', onQuit);

    // The only reader of an answer: this window's own web contents.
    wc.on('page-title-updated', (_e, title) => {
      const read = gate.read(title);
      if (read.kind === 'answer') finish(read.index);
      else if (read.kind === 'refused') log(`an answer was refused (${read.reason})`);
    });
    // Once the window has been shown, any other way it ends is "no".
    win.on('closed', () => { if (phase === 'shown') finish(cancel, 'the window was closed: cancelled'); else if (phase === 'loading') finish(cancel, 'the window was closed before it was shown: cancelled'); });
    wc.on('render-process-gone', (_e, d) => { if (phase === 'shown') finish(cancel, `the page stopped (${d.reason}): cancelled`); });

    void (async () => {
      try {
        await withTimeout(win.loadFile(CONFIRM_PAGE), LOAD_MS, 'loading the page');
        wc.setZoomFactor(zoom);
        await withTimeout(wc.executeJavaScript(`window.confirmWindow.render(${js(model)})`), LOAD_MS, 'drawing the question');
        await settleConfirmFit(
          { isDestroyed: () => win.isDestroyed(), getBounds: () => win.getBounds(), setBounds: (r) => win.setBounds(r), zoom: () => wc.getZoomFactor() },
          () => wc.executeJavaScript('window.confirmWindow.height()') as Promise<number>, () => anchor, workArea);
        if (phase !== 'loading') return;
      } catch (e) {
        if (phase !== 'loading') return;
        phase = 'done'; // the window's own 'closed' must not answer for the fallback
        app.removeListener('before-quit', onQuit);
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* gone */ }
        resolveAnswer(await native(parent, opts, `the window failed (${e instanceof Error ? e.message : String(e)})`).catch(() => cancel));
        return;
      }
      phase = 'shown';
      win.show();
      win.focus();
      void wc.executeJavaScript('window.confirmWindow.arm()').catch(() => finish(cancel, 'the page did not arm: cancelled'));
    })();
  });
}

/** Electron's `dialog.showMessageBox([window, ]options)`, for the questions that move into the Legion window. */
export async function showMessageBox(a: BrowserWindow | ConfirmOptions | null | undefined, b?: ConfirmOptions): Promise<{ response: number; checkboxChecked: boolean }> {
  const parent = b === undefined ? undefined : (a as BrowserWindow | null | undefined);
  const opts = (b === undefined ? a : b) as ConfirmOptions;
  if (busy) {
    log('a question is already open: this one is answered as cancelled');
    return { response: resolveIds(opts).cancelIndex, checkboxChecked: false };
  }
  busy = true;
  try { return { response: await ask(parent, opts), checkboxChecked: false }; } finally { busy = false; }
}

export const confirmWindow = { showMessageBox };
