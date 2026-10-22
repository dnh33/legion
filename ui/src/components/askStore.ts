/**
 * The app's own yes/no question. It takes the place of the page's confirm box: Electron switches those boxes off for the Legion window (they would sit over
 * the confirm card), so a question the UI needs answered is asked here and shown by AskDialog, built from the app's Modal. One question shows at a time;
 * the rest wait their turn. Closing the dialog any way other than Yes is a No, so a question that is dismissed never changes anything.
 */
import { useSyncExternalStore } from 'react';

export interface AskOptions {
  title: string;
  message: string;
  /** The button that does it. */
  yes: string;
  /** The button that does not. Default: Cancel. */
  no?: string;
  /** Draw the Yes button as a warning (it stops or removes something). */
  danger?: boolean;
}
export interface AskView { id: number; title: string; message: string; yes: string; no: string; danger: boolean }
interface Pending extends AskView { resolve(yes: boolean): void }

let queue: Pending[] = [];
let nextId = 1;
let snap: AskView | null = null;
const subs = new Set<() => void>();

function publish(): void {
  const h = queue[0];
  snap = h ? { id: h.id, title: h.title, message: h.message, yes: h.yes, no: h.no, danger: h.danger } : null;
  for (const f of [...subs]) f();
}

/** Asks. Resolves true only when the person presses Yes. */
export function askApp(o: AskOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ id: nextId++, title: o.title, message: o.message, yes: o.yes, no: o.no ?? 'Cancel', danger: o.danger === true, resolve });
    if (queue.length === 1) publish();
  });
}

/** The answer to the question that is showing. An answer for any other question (a stale one) is ignored. */
export function answerAsk(id: number, yes: boolean): void {
  const h = queue[0];
  if (!h || h.id !== id) return;
  queue = queue.slice(1);
  h.resolve(yes);
  publish();
}

export const currentAsk = (): AskView | null => snap;
export function useAsk(): AskView | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => snap, () => null);
}
/** Tests only: drops every question, answering each No. */
export function resetAskForTests(): void { const q = queue; queue = []; for (const h of q) h.resolve(false); publish(); }
