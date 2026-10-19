/**
 * The digest's answers in flight: a small in-memory store (module level, so a hold survives a tab switch, and nothing else).
 * Allow-type answers go through `createHold`; Deny and Reject are sent at once. Nothing is persisted: a reload loses every hold and sends
 * nothing (spec 5.2). The ticker runs only while a hold is counting, never while the window is hidden, and a long timer gap can advance
 * a countdown by at most 300 ms, so a throttled background tab never lets one run out unseen.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../../api';
import { createHold } from '../hold';
import type { Hold, HoldView } from '../hold';
import { announce } from './announce';
import { sendAnswer, doneText } from './answerActions';
import type { AskRow, RowButton } from './askLogic';

export interface Answer {
  key: string; row: AskRow; b: RowButton; projectId: string;
  kind: 'holding' | 'sent' | 'final' | 'refused';
  text: string; view?: HoldView; height: number; doneAt?: number; hold?: Hold;
  /** After "Allow all" on merged reads: the row stays until the owner answers the Confirm question (spec 3.2). */
  offer?: 'pending';
}
let answers = new Map<string, Answer>();
const holds = new Map<string, Hold>();
const subs = new Set<() => void>();
/** The rows on screen right now, by who shows them (the digest, the task sheet). An answer whose row is on no screen (other tab, view, project) is shown by the app-level chip instead. */
const shownBy = new Map<string, ReadonlySet<string>>();
let offscreen: Answer[] = [];
const isShown = (key: string): boolean => { for (const set of shownBy.values()) if (set.has(key)) return true; return false; };
const emit = (): void => {
  answers = new Map(answers);
  offscreen = [...answers.values()].filter((a) => !isShown(a.key));
  subs.forEach((f) => f());
};
export function useAnswers(): ReadonlyMap<string, Answer> { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => answers); }
export const getAnswers = (): ReadonlyMap<string, Answer> => answers;
/** Answers in flight (or just finished) whose row is not on screen: what the app-level chip lists. */
export const getOffscreen = (): Answer[] => offscreen;
export function useOffscreenAnswers(): Answer[] { return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => offscreen); }
/** A surface calls this with the keys of the rows it shows (and [] when it goes away). */
export function setVisibleRows(keys: readonly string[], source = 'digest'): void {
  const had = shownBy.get(source);
  if (had && keys.length === had.size && keys.every((k) => had.has(k))) return;
  if (!had && !keys.length) return;
  if (keys.length) shownBy.set(source, new Set(keys)); else shownBy.delete(source);
  emit();
}

let timer: number | undefined;
let last = 0;
function ensureTicker(): void {
  if (timer !== undefined) return;
  last = performance.now();
  timer = window.setInterval(() => {
    const now = performance.now();
    const dt = Math.min(300, now - last);
    last = now;
    if (!holds.size) { window.clearInterval(timer); timer = undefined; return; }
    if (document.hidden) return;
    for (const h of [...holds.values()]) h.tick(dt);
  }, 100);
}

function settle(key: string, patch: Partial<Answer>): void {
  const a = answers.get(key);
  if (!a) return;
  answers.set(key, { ...a, ...patch });
  emit();
}

export interface StartArgs {
  row: AskRow; b: RowButton; projectId: string; suggestedAssignee?: string; height: number;
  /** The project's `digest-hold` gate is off: an Allow goes out at once, with no Undo window and no wait asked of the core. */
  holdOff?: boolean;
}
export function startAnswer(o: StartArgs): void {
  const { row, b } = o;
  const key = row.key;
  if (answers.has(key) && answers.get(key)!.kind === 'holding') return; // one answer at a time per row
  const send = () => sendAnswer(row, b, { projectId: o.projectId, ...(o.suggestedAssignee ? { suggestedAssignee: o.suggestedAssignee } : {}) });
  if (!b.held) {
    answers.set(key, { key, row, b, projectId: o.projectId, kind: 'final', text: doneText(row, b), height: o.height, doneAt: Date.now() });
    emit();
    announce(doneText(row, b));
    void send().then((r) => { if (!r.ok) { settle(key, { kind: 'refused', text: r.reason ?? 'The answer was not sent.' }); announce(r.reason ?? 'The answer was not sent.'); } });
    return;
  }
  const total = row.hold;
  const holdOff = o.holdOff === true;
  const hold = createHold({
    totalMs: total, holdOff, send,
    onChange: (v) => {
      const cur = answers.get(key);
      if (!cur || cur.hold !== hold) return;
      if (v.phase === 'counting') { settle(key, { view: v }); return; }
      holds.delete(key);
      if (v.phase === 'sent') { settle(key, { kind: 'sent', view: v, text: doneText(row, b), doneAt: Date.now(), ...(row.kind === 'reads' && b.act === 'allow-all' ? { offer: 'pending' as const } : {}) }); announce(doneText(row, b)); }
      else if (v.phase === 'refused') { const t = v.reason ?? 'The answer was not sent.'; settle(key, { kind: 'refused', view: v, text: t, doneAt: Date.now() }); announce(t); }
      else if (v.phase === 'undone') { answers.delete(key); emit(); announce('Undone. Nothing was sent.'); }
    },
  });
  holds.set(key, hold);
  answers.set(key, { key, row, b, projectId: o.projectId, kind: 'holding', text: '', view: hold.view(), height: o.height, hold });
  emit();
  if (!holdOff) announce(`${row.ing} in ${Math.ceil(total / 1000)} seconds. Undo or Send now.`);
  // an approval in the last seconds of its wait: ask the core to hold off its own deny (it never answers, it only delays). No hold, no wait to ask for.
  if (!holdOff && (row.kind === 'command' || row.kind === 'reads')) for (const id of row.ids) void api.holdApproval(id, Math.min(15_000, total + 3000)).catch(() => undefined);
  ensureTicker();
}

export function undoAnswer(key: string): void { holds.get(key)?.undo(); }
export function sendNowAnswer(key: string): void { holds.get(key)?.sendNow(); }
export function holdPointer(key: string, inside: boolean): void { const h = holds.get(key); if (!h) return; if (inside) h.pointerEnter(); else h.pointerLeave(); }
export function holdFocus(key: string, visible: boolean): void { holds.get(key)?.focus(visible); }
/** The row has been shown long enough; nothing is under the pointer: it may leave. */
export function dismissAnswer(key: string): void { const a = answers.get(key); if (a && a.kind !== 'holding' && !a.offer) { answers.delete(key); emit(); } }
/** The owner answered the Confirm question (either way): the row may go. */
export function resolveOffer(key: string): void { const a = answers.get(key); if (!a) return; const { offer: _offer, ...rest } = a; answers.set(key, { ...rest, doneAt: Date.now() }); emit(); }
