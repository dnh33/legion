/**
 * Legion's confirm card, shown inside Legion: the one place Legion asks you before it changes a setting or moves money. It is a view of its own (a
 * WebContentsView) that this (the main) process lays over the whole content area of the Legion window, on top of the app, which the page dims. It is not a
 * window: no taskbar entry, nothing outside Legion. The Legion page cannot ask it anything (the words come from main), cannot press its buttons, and cannot
 * give the answer: the card answers by changing ITS OWN title to `legion-confirm:<one-time id>:<button>`, and main reads that only from this view's web
 * contents. There is no preload, no node and no network (the page's policy allows none). Its web contents live in a session of their own.
 *
 * While the card is open the app behind it gets no mouse down, up or move (the card covers it, and main drops what reaches the page anyway) and no keyboard
 * (main drops every key for the Legion page), and the card is repainted and focused whenever the Legion window is shown, restored or focused, or its page gains the focus (for the page, on the next turn): a card that opened while Legion was covered is drawn as soon as Legion is uncovered. A
 * wheel over the card goes to the card, because it is the topmost view; the mouse hook carries no wheel, so a wheel sent to the page by other means is not
 * dropped. No system dialog opens over the card, and no card under one: main shows them under the confirm lock (`underLock` in the logic file). Closing the Legion window, quitting, a crash and a timeout all end as "no", and the view is removed every time.
 *
 * It takes the place of dialog.showMessageBox for those questions: `confirmWindow.showMessageBox([parent,] options)` gives `{ response }` like Electron's,
 * honouring buttons, defaultId and cancelId. The parent argument is accepted for the same call shape and ignored: the question is always shown in the
 * Legion window, which is restored and focused first when it is hidden or minimized. Only one question is open at a time. If the card cannot be shown (there
 * is no Legion window, the file is missing, it fails to load or draw, a field is out of bounds) the same question goes to the system dialog: an answer is
 * never made up, and a failure is never a yes. Pure rules (checking a question, reading an answer, the overlay's bounds) are in confirm-window-logic.ts.
 */
import { app, BrowserWindow, dialog, nativeTheme, session, WebContentsView } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bringForward, buildModel, ConfirmBusyError, createAnswerGate, deferFocus, nativeOptions, overlayZoom, pickTheme, prepareConfirm, repaintCard, syncOverlay, type ConfirmOptions, type OverlayMain, type OverlayView } from './confirm-window-logic.js';

const here = dirname(fileURLToPath(import.meta.url)); // <root>/dist/src/electron
const root = resolve(here, '..', '..', '..');
export const CONFIRM_PAGE = join(root, 'assets', 'confirm-window.html');
/** No "persist:" prefix: an in-memory session of its own, so the card shares no cookies, zoom or permission rules with the Legion page. */
export const CONFIRM_PARTITION = 'legion-confirm';
const LOAD_MS = 8000;

export interface ConfirmHost {
  /** The main Legion window: the card is shown inside it, and takes its zoom and theme. */
  getMainWin(): BrowserWindow | null | undefined;
  log?(line: string): void;
}
let host: ConfirmHost = { getMainWin: () => null };
export function configureConfirmWindow(h: ConfirmHost): void { host = h; }
const log = (line: string): void => { try { host.log?.(`confirm card: ${line}`); } catch { /* logging must never change an answer */ } };

/** True while a question is open (the card in the Legion window, or the system dialog). */
let busy = false;
/**
 * A hold on the whole confirm lock, for a spend review: from the moment it is taken until it is released only the holder's own questions are asked
 * (`showHeldMessageBox`); every other question is answered Cancel at once. Without it a settings question could open in the gaps between the review's
 * own questions, and the review would read that as "no" and deny a request the person never saw.
 */
let held = false;
export const confirmWindowBusy = (): boolean => busy || held;
export function holdConfirmWindow(): boolean { if (busy || held) return false; held = true; return true; }
export function releaseConfirmWindow(): void { held = false; }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
const zoomOf = (w: BrowserWindow | null | undefined): number => { try { return overlayZoom(w && !w.isDestroyed() ? w.webContents.getZoomFactor() : 1); } catch { return 1; } };
/** The Legion window as the parent of the system dialog: only when the person can see it. */
const nativeParent = (w: BrowserWindow | null | undefined): BrowserWindow | undefined => (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() ? w : undefined);

/** The system dialog with the same question. */
async function native(parent: BrowserWindow | undefined, opts: ConfirmOptions, why: string): Promise<number> {
  log(`${why}; asking with the system dialog`);
  const o = nativeOptions(opts) as unknown as Electron.MessageBoxOptions;
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, o) : await dialog.showMessageBox(o);
  return r.response;
}

async function ask(opts: ConfirmOptions): Promise<number> {
  const mainIn = host.getMainWin();
  const main = mainIn && !mainIn.isDestroyed() ? mainIn : undefined;
  const theme = await readTheme(main);
  const nonce = randomBytes(16).toString('hex');
  const built = buildModel(opts, { nonce, theme });
  if (!built.ok) return native(nativeParent(main), opts, `the question was not accepted (${built.reason})`);
  const model = built.model;
  if (!existsSync(CONFIRM_PAGE)) return native(nativeParent(main), opts, 'the page file is missing');
  // Never a window of its own: with no Legion window, or one that cannot be shown, the system dialog asks.
  if (!main) return native(undefined, opts, 'there is no Legion window to show the question in');
  if (!bringForward(main)) return native(undefined, opts, 'the Legion window could not be shown');
  const mainWc = main.webContents;

  const zoom = zoomOf(main);
  let view: WebContentsView;
  try {
    lockDownSession();
    view = new WebContentsView({
      // no preload, no node, no dev tools; its own in-memory session
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, spellcheck: false, partition: CONFIRM_PARTITION, zoomFactor: zoom, backgroundThrottling: false },
    });
    view.setBackgroundColor('#00000000'); // transparent: the page draws the dim and the card
  } catch (e) { return native(nativeParent(main), opts, `the card could not be made (${e instanceof Error ? e.message : String(e)})`); }

  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // a reload would empty the page, and the question would be left with no buttons
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || input.key === 'F12' || ((input.control || input.meta) && /^[rR=+\-0]$/.test(input.key))) e.preventDefault();
  });
  const overlayMain: OverlayMain = { isDestroyed: () => main.isDestroyed(), getContentSize: () => main.getContentSize(), getZoom: () => mainWc.getZoomFactor() };
  const overlayView: OverlayView = { getBounds: () => view.getBounds(), setBounds: (r) => view.setBounds(r), getZoom: () => wc.getZoomFactor(), setZoom: (z) => wc.setZoomFactor(z) };
  const sync = (): void => { try { if (!wc.isDestroyed()) syncOverlay(overlayMain, overlayView); } catch { /* the next event syncs again */ } };
  const takeFocus = (): void => { try { if (!wc.isDestroyed()) wc.focus(); } catch { /* gone */ } };
  // Legion shown, restored or focused: a card that opened while Legion was covered is drawn now, and has the keyboard
  const refresh = (): void => { sync(); if (!wc.isDestroyed()) repaintCard(wc); };
  /** Removes the view from the Legion window and closes its web contents: nothing of the card is left, whichever way it ended. */
  const dispose = (): void => {
    try { if (!main.isDestroyed()) main.contentView.removeChildView(view); } catch { /* not attached, or gone */ }
    try { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); } catch { /* gone */ }
  };

  return new Promise<number>((resolveAnswer) => {
    let phase: 'loading' | 'shown' | 'done' = 'loading';
    const gate = createAnswerGate(nonce, model.buttons.length);
    const cancel = model.cancelIndex;
    // While the card is open the app behind it hears nothing: every key (the reload shortcuts too) is dropped before the Legion page sees it, and the mouse is
    // covered by the card itself (mouse down, up and move that reach the page anyway are dropped here; the hook carries no wheel, and a real wheel over the
    // card goes to the card, the topmost view). The card gets the focus back whenever the Legion window or its page gains it; for the page it is deferred a turn.
    const pageFocus = deferFocus(takeFocus);
    const dropInput = (e: Electron.Event): void => e.preventDefault();
    const onMainClosed = (): void => finish(cancel, 'the Legion window was closed: cancelled');
    const onMainHidden = (): void => finish(cancel, 'the Legion window was hidden: cancelled');
    const SYNC_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const;
    const FRONT_EVENTS = ['show', 'restore', 'focus'] as const;
    const onQuit = (): void => finish(cancel, 'the app is closing: cancelled');
    const guardMain = (): void => {
      mainWc.on('before-input-event', dropInput);
      mainWc.on('before-mouse-event', dropInput);
      mainWc.on('focus', pageFocus.onFocus);
      mainWc.on('zoom-changed', sync);
      for (const ev of SYNC_EVENTS) main.on(ev as 'resize', sync);
      for (const ev of FRONT_EVENTS) main.on(ev as 'show', refresh);
      main.contentView.on('bounds-changed', sync);
      main.once('closed', onMainClosed);
      main.on('hide', onMainHidden);
    };
    const unguardMain = (): void => {
      try {
        pageFocus.cancel();
        mainWc.removeListener('before-input-event', dropInput);
        mainWc.removeListener('before-mouse-event', dropInput);
        mainWc.removeListener('focus', pageFocus.onFocus);
        mainWc.removeListener('zoom-changed', sync);
        for (const ev of SYNC_EVENTS) main.removeListener(ev as 'resize', sync);
        for (const ev of FRONT_EVENTS) main.removeListener(ev as 'show', refresh);
        main.contentView.removeListener('bounds-changed', sync);
        main.removeListener('closed', onMainClosed);
        main.removeListener('hide', onMainHidden);
      } catch { /* the window is gone, and its listeners with it */ }
    };
    const finish = (n: number, why?: string): void => {
      if (phase === 'done') return;
      phase = 'done';
      app.removeListener('before-quit', onQuit);
      unguardMain();
      if (why) log(why);
      dispose();
      try { if (!main.isDestroyed()) mainWc.focus(); } catch { /* gone */ }
      resolveAnswer(n);
    };
    app.once('before-quit', onQuit);
    guardMain(); // from the first moment: a Legion window that is closed while the card loads ends the question too

    // The only reader of an answer: this view's own web contents.
    wc.on('page-title-updated', (_e, title) => {
      const read = gate.read(title);
      if (read.kind === 'answer') finish(read.index);
      else if (read.kind === 'refused') log(`an answer was refused (${read.reason})`);
    });
    // Once the card has been shown, any other way it ends is "no".
    wc.once('destroyed', () => { if (phase === 'shown') finish(cancel, 'the card was closed: cancelled'); else if (phase === 'loading') finish(cancel, 'the card was closed before it was shown: cancelled'); });
    // A page that dies while it is being drawn would leave every step below waiting for ever (and the lock held): it goes to the same fallback as a slow one.
    let pageDied!: (e: Error) => void;
    const died = new Promise<never>((_, reject) => { pageDied = reject; });
    died.catch(() => undefined);
    wc.on('render-process-gone', (_e, d) => {
      if (phase === 'shown') finish(cancel, `the page stopped (${d.reason}): cancelled`);
      else if (phase === 'loading') pageDied(new Error(`the page stopped while it was being drawn (${d.reason})`));
    });

    void (async () => {
      try {
        await prepareConfirm({
          load: () => wc.loadFile(CONFIRM_PAGE),
          render: () => { wc.setZoomFactor(zoom); return wc.executeJavaScript(`window.confirmWindow.render(${js(model)})`); },
          died, stepMs: LOAD_MS, totalMs: 2 * LOAD_MS,
        });
        if (phase !== 'loading') return;
        // Drawn: now it goes on top of the app, over the whole content area, and takes the keyboard.
        sync();
        main.contentView.addChildView(view); // the last view added is the topmost
        sync();
      } catch (e) {
        if (phase !== 'loading') return;
        phase = 'done'; // the view's own 'destroyed' must not answer for the fallback
        app.removeListener('before-quit', onQuit);
        unguardMain();
        dispose();
        resolveAnswer(await native(nativeParent(main), opts, `the card failed (${e instanceof Error ? e.message : String(e)})`).catch(() => cancel));
        return;
      }
      phase = 'shown';
      takeFocus();
      void wc.executeJavaScript('window.confirmWindow.arm()').catch(() => finish(cancel, 'the page did not arm: cancelled'));
    })();
  });
}

async function run(a: BrowserWindow | ConfirmOptions | null | undefined, b: ConfirmOptions | undefined, holder: boolean): Promise<{ response: number; checkboxChecked: boolean }> {
  const opts = (b === undefined ? a : b) as ConfirmOptions;
  if (busy || (held && !holder)) {
    // Not an answer: nothing was shown, so nobody cancelled. The flow ends with "a confirmation is already open" (orBusy), and a spend review reads it as a refusal.
    log('a question is already open: this one was not asked');
    throw new ConfirmBusyError();
  }
  busy = true;
  try { return { response: await ask(opts), checkboxChecked: false }; } finally { busy = false; }
}

/** Electron's `dialog.showMessageBox([window, ]options)`, for the questions that move into Legion's confirm card. The window argument is accepted and ignored. */
export const showMessageBox = (a: BrowserWindow | ConfirmOptions | null | undefined, b?: ConfirmOptions): Promise<{ response: number; checkboxChecked: boolean }> => run(a, b, false);
/** The same, for the holder of the confirm lock (`holdConfirmWindow`): the one question that may run while it is held. */
export const showHeldMessageBox = (a: BrowserWindow | ConfirmOptions | null | undefined, b?: ConfirmOptions): Promise<{ response: number; checkboxChecked: boolean }> => run(a, b, true);

export const confirmWindow = { showMessageBox, showHeldMessageBox };
