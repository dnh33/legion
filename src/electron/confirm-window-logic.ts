/**
 * The rules of Legion's confirm card, free of electron so they are tested: what a confirm may ask (checked once, strictly), the model the
 * page draws, how an answer is read, and how the card is laid over the Legion window. The overlay itself is confirm-window.ts; the page is assets/confirm-window.html.
 *
 * The page draws only what the explicit fields say. Nothing here, and nothing in the page, turns "Key: value" or "- " lines of a text into rows or
 * bullets: a text from the core can carry words from a repository, and a repository must not be able to lay out the question it is asked about.
 */
export type ConfirmTone = 'default' | 'danger' | 'money';
export interface ConfirmFact { label: string; value: string }

/** What a confirm adds to Electron's message box options. Every field is optional; a caller that sets none gets the plain look. */
export interface ConfirmExtras {
  /** default: mint confirm button. danger: red, for a change that stops running work. money: gold, for BSV. */
  tone?: ConfirmTone;
  /** A short caps tag in the title for danger and money (the whitelist is TONE_TAGS). */
  toneTag?: string;
  /** Which screen asked, shown top right ("asked by Settings > Gates"). */
  who?: string;
  /** Rows of a label and a value (the value in mono). */
  facts?: ConfirmFact[];
  /** Lines of a list, each its own bullet. */
  items?: string[];
  /** Money: the big amount and the line next to it. */
  amount?: string;
  amountNote?: string;
  /** Money: the full address, its first 4 and last ADDRESS_TAIL characters marked. */
  address?: string;
  /** The button that gets the tone colour; -1 for none. Default: the button that is not the cancel button, when there are two. */
  confirmAt?: number;
  /** What the window shows instead of `message` / `detail` when a caller moved part of them into the fields above. The native box (the fallback) keeps message and detail whole. */
  windowMessage?: string;
  windowDetail?: string;
}

/** The options of Electron's showMessageBox, plus the extras. */
export interface ConfirmOptions extends ConfirmExtras {
  type?: string; title: string; message?: string; detail?: string;
  buttons: string[]; defaultId?: number; cancelId?: number; noLink?: boolean;
}

/** What the page is given: all of it checked, nothing left to decide there. */
export interface ConfirmModel {
  nonce: string; theme: 'dark' | 'light'; tone: ConfirmTone; toneTag: string; who: string;
  title: string; message: string; detail: string; facts: ConfirmFact[]; items: string[];
  amount: string; amountNote: string; address: string; addressTail: number;
  buttons: string[]; defaultIndex: number; cancelIndex: number; confirmAt: number;
}

export const TONE_TAGS: Record<'danger' | 'money', readonly string[]> = {
  danger: ['RESTARTS CORE'],
  money: ['LIVE FUNDS', 'TESTNET', 'LAST CHECK', 'BSV'],
};
export const LIMITS = { buttons: 4, button: 48, title: 200, message: 800, detail: 60_000, who: 160, fact: 200, factValue: 2_000, facts: 40, item: 2_000, items: 200, amount: 60, amountNote: 200, address: 64 } as const;
/** How many characters at the end of an address the last-check button names, and the address marks: one number, so the two can never differ. */
export const ADDRESS_TAIL = 8;
export const ADDRESS_RE = /^[A-Za-z0-9]{20,64}$/;
export const THEME_BG = { dark: '#0b0d10', light: '#f6f4ee' } as const;
export const ANSWER_PREFIX = 'legion-confirm:';

/** Control characters, bidi marks and zero-width marks out; a newline stays only where the text is allowed several lines. */
const BAD = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u061c\\ufeff\\u202a-\\u202e\\u2066-\\u2069]', 'g');
function clean(v: unknown, max: number, what: string, multiline = false): string {
  if (typeof v !== 'string') throw new Error(`${what} is not a text`);
  const s = (multiline ? v.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : v.replace(/[\r\n\t]+/g, ' ')).replace(BAD, ' ');
  if (s.length > max) throw new Error(`${what} is longer than ${max} characters`);
  return s;
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The ids Electron would use: the default button 0, the cancel button the first one labelled cancel or no, else 0. Clamped, so a bad id never indexes outside the buttons. */
export function resolveIds(o: Pick<ConfirmOptions, 'buttons' | 'defaultId' | 'cancelId'>): { defaultIndex: number; cancelIndex: number } {
  const n = Array.isArray(o.buttons) ? o.buttons.length : 0;
  const fit = (v: unknown, dflt: number): number => (isInt(v) && v >= 0 && v < n ? v : dflt);
  const named = Array.isArray(o.buttons) ? o.buttons.findIndex((b) => typeof b === 'string' && /^(cancel|no)$/i.test(b.trim())) : -1;
  return { defaultIndex: fit(o.defaultId, 0), cancelIndex: fit(o.cancelId, named >= 0 ? named : 0) };
}

/** "LIVE FUNDS: approve a payment?" under the tag LIVE FUNDS reads "Approve a payment?": the tag already says it. */
function untagged(title: string, tag: string): string {
  if (!tag || !title.startsWith(`${tag}: `)) return title;
  const rest = title.slice(tag.length + 2);
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : title;
}

export function pickTheme(raw: unknown, systemDark: boolean): 'dark' | 'light' {
  return raw === 'light' || raw === 'dark' ? raw : systemDark ? 'dark' : 'light';
}

export type BuiltModel = { ok: true; model: ConfirmModel } | { ok: false; reason: string };

/** Checks a confirm once. Anything that does not fit is refused with a reason, and the caller then uses the system dialog: a question is never cut or guessed. */
export function buildModel(o: ConfirmOptions, ctx: { nonce: string; theme: 'dark' | 'light' }): BuiltModel {
  try {
    if (!o || typeof o !== 'object') throw new Error('no options');
    if (!Array.isArray(o.buttons) || o.buttons.length < 1 || o.buttons.length > LIMITS.buttons) throw new Error(`needs 1 to ${LIMITS.buttons} buttons`);
    const buttons = o.buttons.map((b, i) => { const s = clean(b, LIMITS.button, `button ${i}`).trim(); if (!s) throw new Error(`button ${i} is empty`); return s; });
    if (o.defaultId !== undefined && !(isInt(o.defaultId) && o.defaultId >= 0 && o.defaultId < buttons.length)) throw new Error('defaultId is not a button');
    if (o.cancelId !== undefined && !(isInt(o.cancelId) && o.cancelId >= 0 && o.cancelId < buttons.length)) throw new Error('cancelId is not a button');
    const { defaultIndex, cancelIndex } = resolveIds({ buttons, defaultId: o.defaultId, cancelId: o.cancelId });
    const tone = o.tone ?? 'default';
    if (tone !== 'default' && tone !== 'danger' && tone !== 'money') throw new Error('unknown tone');
    let toneTag = '';
    if (o.toneTag !== undefined) {
      if (tone === 'default' || !TONE_TAGS[tone].includes(o.toneTag)) throw new Error('tag not allowed for this tone');
      toneTag = o.toneTag;
    } else if (tone === 'money') toneTag = 'BSV';
    let confirmAt = -1;
    if (o.confirmAt !== undefined) {
      if (!(isInt(o.confirmAt) && o.confirmAt >= -1 && o.confirmAt < buttons.length)) throw new Error('confirmAt is not a button');
      confirmAt = o.confirmAt;
    } else if (buttons.length === 2) confirmAt = cancelIndex === 0 ? 1 : 0;
    const facts = o.facts ?? [];
    if (!Array.isArray(facts) || facts.length > LIMITS.facts) throw new Error('too many facts');
    const items = o.items ?? [];
    if (!Array.isArray(items) || items.length > LIMITS.items) throw new Error('too many items');
    let address = '';
    if (o.address !== undefined) { if (typeof o.address !== 'string' || !ADDRESS_RE.test(o.address)) throw new Error('address is not a plain address'); address = o.address; }
    const title = untagged(clean(o.title, LIMITS.title, 'title').trim(), toneTag);
    if (!title) throw new Error('no title');
    return {
      ok: true,
      model: {
        nonce: ctx.nonce, theme: ctx.theme, tone, toneTag,
        who: o.who === undefined ? '' : clean(o.who, LIMITS.who, 'who').trim(),
        title,
        message: clean(o.windowMessage ?? o.message ?? '', LIMITS.message, 'message', true).trim(),
        detail: clean(o.windowDetail ?? o.detail ?? '', LIMITS.detail, 'detail', true).trim(),
        facts: facts.map((f, i) => {
          if (!f || typeof f !== 'object') throw new Error(`fact ${i} is not a row`);
          return { label: clean(f.label, LIMITS.fact, `fact ${i} label`).trim(), value: clean(f.value, LIMITS.factValue, `fact ${i} value`, true).trim() };
        }),
        items: items.map((t, i) => clean(t, LIMITS.item, `item ${i}`, true).trim()),
        amount: o.amount === undefined ? '' : clean(o.amount, LIMITS.amount, 'amount').trim(),
        amountNote: o.amountNote === undefined ? '' : clean(o.amountNote, LIMITS.amountNote, 'amountNote').trim(),
        address, addressTail: ADDRESS_TAIL, buttons, defaultIndex, cancelIndex, confirmAt,
      },
    };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}

/** The system dialog's options for the same confirm: the fields Electron knows, message and detail whole. Used when the Legion window cannot be shown. */
export function nativeOptions(o: ConfirmOptions): { type: string; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true } {
  const { defaultIndex, cancelIndex } = resolveIds(o);
  return { type: o.type ?? 'question', title: String(o.title ?? ''), message: String(o.message ?? ''), detail: String(o.detail ?? ''), buttons: [...o.buttons], defaultId: defaultIndex, cancelId: cancelIndex, noLink: true };
}

/**
 * The page answers by setting its title to `legion-confirm:<nonce>:<button index>`. This reads one title: a different nonce, a stale one (the confirm
 * is already answered), an index that is not a button, or anything else is refused. Titles that do not start with the prefix are not answers at all.
 */
export type AnswerRead = { kind: 'answer'; index: number } | { kind: 'refused'; reason: string } | { kind: 'other' };
export function createAnswerGate(nonce: string, buttonCount: number): { read(title: unknown): AnswerRead } {
  let done = false;
  return {
    read(title: unknown): AnswerRead {
      if (typeof title !== 'string' || !title.startsWith(ANSWER_PREFIX)) return { kind: 'other' };
      if (done) return { kind: 'refused', reason: 'an answer was already taken' };
      const m = /^legion-confirm:([0-9a-f]{32}):(\d{1,2})$/.exec(title);
      if (!m) return { kind: 'refused', reason: 'the answer is not in the expected form' };
      if (m[1] !== nonce) return { kind: 'refused', reason: 'the answer carries a different one-time id' };
      const index = Number(m[2]);
      if (!(index >= 0 && index < buttonCount)) return { kind: 'refused', reason: 'the answer names no button' };
      done = true;
      return { kind: 'answer', index };
    },
  };
}

// ---------------------------------------------------------------- the overlay inside the Legion window

export interface Rect { x: number; y: number; width: number; height: number }
const MIN_ZOOM = 0.5, MAX_ZOOM = 3;

/** The overlay covers the whole content area of the Legion window: from its top left corner, as large as the content (rounded up, so no strip of the app stays uncovered). */
export function overlayBounds(content: ArrayLike<number>): Rect {
  const edge = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(1, Math.ceil(v)) : 1);
  return { x: 0, y: 0, width: edge(content[0]), height: edge(content[1]) };
}
/** The card's zoom is the Legion window's, clamped; anything that is not a number is 1. */
export function overlayZoom(z: unknown): number {
  return typeof z === 'number' && Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1;
}

/** The slice of the Legion window the overlay follows. */
export interface OverlayMain { isDestroyed(): boolean; getContentSize(): ArrayLike<number>; getZoom(): number }
/** The slice of the overlay view that is kept in step with it. */
export interface OverlayView { getBounds(): Rect; setBounds(r: Rect): void; getZoom(): number; setZoom(z: number): void }
/** Puts the overlay over the whole content area at the window's zoom. Called on every resize, maximize, restore and zoom; false when nothing changed. */
export function syncOverlay(main: OverlayMain, view: OverlayView): boolean {
  if (main.isDestroyed()) return false;
  let changed = false;
  const want = overlayBounds(main.getContentSize());
  const b = view.getBounds();
  if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) { view.setBounds(want); changed = true; }
  const z = overlayZoom(main.getZoom());
  if (view.getZoom() !== z) { view.setZoom(z); changed = true; }
  return changed;
}

/** The slice of a window `bringForward` needs. */
export interface ShowTarget { isDestroyed(): boolean; isMinimized(): boolean; isVisible(): boolean; restore(): void; show(): void; focus(): void }
/**
 * A question has to be asked inside the Legion window, so a hidden (tray) or minimized window is restored and focused first. False when there is no
 * window or it cannot be shown: the question then goes to the system dialog. Nothing is ever asked in a window the person cannot see.
 */
export function bringForward(w: ShowTarget | null | undefined): boolean {
  try {
    if (!w || w.isDestroyed()) return false;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
    return !w.isDestroyed() && w.isVisible() && !w.isMinimized();
  } catch { return false; }
}

// ---------------------------------------------------------------- one question at a time

/** What a flow says when its question lost to another one that is open. It is not an answer: nothing was shown, so nobody cancelled. */
export const CONFIRM_BUSY = 'A confirmation is already open. Answer it first.';
export class ConfirmBusyError extends Error {
  constructor() { super(CONFIRM_BUSY); this.name = 'ConfirmBusyError'; }
}
/** Runs a flow that asks a question. When that question lost to an open one, the flow ends with `busy`; every other result and failure passes through. */
export async function orBusy<T>(flow: Promise<T>, busy: T): Promise<T> {
  try { return await flow; } catch (e) { if (e instanceof ConfirmBusyError) return busy; throw e; }
}

// ---------------------------------------------------------------- opening the window

export interface PrepareSteps {
  load(): Promise<unknown>; render(): Promise<unknown>;
  /** Rejects when the page dies before it is shown (the main side wires it to the renderer-gone event). */
  died: Promise<never>;
  /** The most any one step may take, and the most the whole opening may take. */
  stepMs: number; totalMs: number;
}
/**
 * Loads the page and draws the question, and fails (so the system dialog takes over) when a step is too slow, the page dies, or
 * the whole opening runs long. A window that is being opened holds the one confirm lock; nothing here may wait for ever, whatever the page does.
 */
export async function prepareConfirm(s: PrepareSteps): Promise<void> {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let finished = false; // once the opening has ended (done, failed or died), no step starts and no timer is made
  const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    finished ? p : Promise.race([p, new Promise<never>((_, reject) => { timers.push(setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)); })]);
  try {
    const work = (async () => {
      await within(s.load(), s.stepMs, 'loading the page');
      if (finished) return;
      await within(s.render(), s.stepMs, 'drawing the question');
    })();
    await within(Promise.race([work, s.died]), s.totalMs, 'opening the window');
  } finally { finished = true; for (const t of timers) clearTimeout(t); }
}
