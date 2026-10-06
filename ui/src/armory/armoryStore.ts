/**
 * UI store for Settings → Armory. Own small external store, same pattern as houseStore.
 *
 * Talks to the admin routes under /api/armory (the UI holds the admin key) and, for Promote, /api/house/drill/promote.
 * Nothing here is reachable by an agent: every change on this screen is the owner's.
 *
 * What it keeps beyond the list: one row of state per skill while a change is in flight, the last error per row (shown on that
 * row until the next try), one Undo offer for a bulk change and one for a removed skill, a live-region message, and the
 * "effective" answer per agent. No polling: the list changes when the owner changes it here.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import { getHouse, loadHouse, revealDrill } from '../house/houseStore';
import { drillId } from '../../../src/shared/skill-ids';
import { skillDisplayTitle } from '../../../src/shared/house-view';
import {
  agentLoads, bulkConsequence, bulkDone, bulkUndone, duplicateNames, endSentence, flagsLine, groupBulkTargets, loadsLine, plural, restorePayload,
  NOT_BUILTINS, stateDone, turnAllOnTargets, uniqueName, withSkill, withState,
} from '../../../src/shared/armory-view';
import type { AgentLoadRef, ArmoryData, ArmorySkill, BulkConsequence, BulkTo, DrillRef, EditorFields, EffectiveCounts, EffectiveView, ImportReview, SentFile, SkillState } from '../../../src/shared/armory-view';

export type { ArmoryData, ArmorySkill, EffectiveView, ImportReview, SentFile, SkillState };

export interface ReadState {
  id: string;
  title: string;
  status: 'loading' | 'ready' | 'error' | 'builtin';
  text: string;
  thirdParty: boolean;
  path: string | null;
  error: string | null;
}
/** A bulk change, kept for a few seconds so it can be undone exactly (each skill goes back to the state it had). */
export interface BulkUndo {
  /** The group's key, or 'notice' for Turn all on. */
  key: string;
  message: string;
  items: { id: string; state: SkillState }[];
  total: number;
  /** Turn all on also marked the notice as seen: Undo shows it again. */
  restoreNotice?: boolean;
  error?: string;
}
/** A removed skill, kept for a few seconds so Remove can be undone by posting its text again. */
export interface RemovedOffer {
  id: string;
  name: string;
  source: 'yours' | 'imported';
  state: SkillState;
  agents: 'all' | string[];
  text: string;
  message: string;
  error?: string;
}
/** What failed on one row: the kind of change, so the row can say "Could not remove" rather than a vague "Could not save". */
export interface RowError { op: 'state' | 'agents' | 'remove' | 'promote'; message: string }
export interface PromotedNote { id: string; name: string; path: string; /** What the Armory calls it. */ from: string }
/** What the screen reads of one agent: the counts (the full lists, from /effective?agent=, also fit). */
export interface EffectiveSlot { status: 'loading' | 'ready' | 'error'; data: EffectiveCounts | null; error: string | null }
export interface ImportDone { id: string; name: string; kept: string[]; dropped: { path: string; reason: string }[]; stripped: string[] }

export interface ArmoryUiState {
  data: ArmoryData | null;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  /** "Refresh" (asking Claude Code again) in flight, and why the last one failed. */
  refreshing: boolean;
  refreshError: string | null;
  /** An older core answered 404: it has no Armory. */
  absent: boolean;
  /** Skills with a state or agents change in flight: one skill never has two writes racing. */
  switching: string[];
  /** Last failure per skill, shown on that row until the next try. */
  rowErrors: Record<string, RowError>;
  /** A bulk change or its Undo in flight (the group key), and the last failure per group. */
  resetting: string | null;
  resetErrors: Record<string, string>;
  undo: BulkUndo | null;
  removed: RemovedOffer | null;
  /** Skill ids with a Remove or a Promote in flight. */
  busyIds: string[];
  /** What each busy id is doing, so its row can say "Removing...". */
  busyOps: Record<string, 'remove' | 'promote'>;
  /** What Undo just did, kept a few seconds so it is seen and not only heard. */
  undone: { key: string; message: string } | null;
  /** A skill to scroll to, focus and mark (from the agent editor's "Open in the Armory"). */
  reveal: string | null;
  promoted: PromotedNote | null;
  /** The one-time notice: a change in flight, and why it failed. */
  noticeBusy: boolean;
  noticeError: string | null;
  shellBusy: boolean;
  shellError: string | null;
  reading: ReadState | null;
  /** The skill just added or created, drawn with a highlight for a few seconds. */
  highlight: string | null;
  effective: Record<string, EffectiveSlot>;
  /** A skill whose row should take keyboard focus once it is on screen (after Undo of a Remove). */
  focusRow: string | null;
  /** A skill just created (it starts off): its row says so, with Turn on, until the owner changes its state. */
  savedOff: string | null;
  /** One polite message for screen readers. */
  notice: string;
}

let state: ArmoryUiState = {
  data: null, loaded: false, loading: false, loadError: null, refreshing: false, refreshError: null, absent: false, switching: [], rowErrors: {}, resetting: null, resetErrors: {},
  undo: null, removed: null, busyIds: [], busyOps: {}, undone: null, reveal: null, promoted: null, noticeBusy: false, noticeError: null, shellBusy: false, shellError: null,
  reading: null, highlight: null, effective: {}, focusRow: null, savedOff: null, notice: '',
};
const listeners = new Set<() => void>();
const set = (p: Partial<ArmoryUiState>): void => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const sub = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getArmory = (): ArmoryUiState => state;
export function useArmory<T>(selector: (s: ArmoryUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }
const msg = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const skillsNow = (): ArmorySkill[] => state.data?.skills ?? [];
const findSkill = (id: string): ArmorySkill | undefined => skillsNow().find((s) => s.id === id);
const setSkills = (skills: ArmorySkill[]): void => { if (state.data) set({ data: { ...state.data, skills } }); };

/* ---- who sees what: the agents and the drills the Armory needs to say a consequence before it is done ---- */
let agentCtx: AgentLoadRef[] = [];
export const setAgentContext = (a: AgentLoadRef[]): void => { agentCtx = a; };
/** The drills as the agent editor counts them. */
export function drillRefsOf(files: readonly { category?: string; skill?: string | null; path: string; group?: string | null; on: boolean; title?: string }[] | undefined): DrillRef[] {
  return (files ?? []).filter((f) => f.category === 'skills' && !!f.skill && f.skill === f.path && f.group)
    .map((f) => {
      const folder = f.path.split('/').slice(-2, -1)[0] ?? '';
      // Your own drill is called what you typed, the same as in the Armory; a shipped one has its written title.
      return { id: drillId(f.group!, folder), name: f.group!.toLowerCase() === 'yours' ? folder : skillDisplayTitle(f as { path: string; title: string }), on: f.on };
    });
}
const drillsNow = (): DrillRef[] => drillRefsOf(getHouse().status?.files);
/** What turning a group (or the notice's skills) on would do, said before it is done. */
export function consequenceOf(key: string): BulkConsequence {
  const targets = key === 'notice' ? turnAllOnTargets(skillsNow()) : groupBulkTargets(skillsNow(), key, 'on');
  // "Turn all on" leaves the built-ins out, and the count the owner sees elsewhere ("375 skills") includes them: the confirm says so.
  return bulkConsequence(skillsNow(), targets, drillsNow(), agentCtx, undefined, key === 'notice' ? NOT_BUILTINS : '');
}
const loadsNow = (): string => loadsLine(agentLoads(skillsNow(), drillsNow(), agentCtx));
const flagsOf = (ids: readonly string[]): string => {
  const set = new Set(ids);
  const t = skillsNow().filter((s) => set.has(s.id));
  return flagsLine(t.filter((s) => s.runsCommandsOnLoad).length, t.filter((s) => s.hiddenText).length, 'Of these');
};
let dupCache: { skills: ArmorySkill[]; dups: Set<string> } | null = null;
/** The name to say aloud for a skill: "debug (built-in)" when another one is also called debug. */
export function uniqueLabel(s: ArmorySkill): string {
  const skills = skillsNow();
  if (!dupCache || dupCache.skills !== skills) dupCache = { skills, dups: duplicateNames(skills) };
  return uniqueName(s, dupCache.dups);
}

let undoneTimer: ReturnType<typeof setTimeout> | undefined;
function showUndone(key: string, message: string): void {
  if (undoneTimer) clearTimeout(undoneTimer);
  set({ undone: { key, message } });
  undoneTimer = setTimeout(() => { set({ undone: null }); }, 8000);
}
export function clearUndone(): void { if (undoneTimer) clearTimeout(undoneTimer); if (state.undone) set({ undone: null }); }

let revealTimer: ReturnType<typeof setTimeout> | undefined;
export function revealSkill(id: string): void {
  if (revealTimer) clearTimeout(revealTimer);
  set({ reveal: id });
  revealTimer = setTimeout(() => { if (state.reveal === id) set({ reveal: null }); }, 8000);
}

let flip = false;
/** A live-region message. The same words twice would not be read again, so every other one carries an invisible space. */
const announce = (text: string): void => { flip = !flip; set({ notice: flip ? `${text} ` : text }); };
export const say = announce;

/* ---- the Undo clocks: one per offer, running only while nobody holds the offer (pointer or focus: WCAG 2.2.1) ---- */

/** How long "Turned on 12 skills. Undo" stays. */
export const UNDO_MS = 10_000;
function clock(onExpire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const holds = new Set<string>();
  const stop = (): void => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    start(active: boolean): void { stop(); if (active && !holds.size) timer = setTimeout(onExpire, UNDO_MS); },
    stop,
    clear(): void { stop(); holds.clear(); },
    hold(who: string): void { holds.add(who); stop(); },
    release(who: string, active: boolean): void { holds.delete(who); this.start(active); },
  };
}
const bulkClock = clock(() => {
  if (!state.undo) return;
  bulkClock.clear();
  set({ undo: null });
  announce('Undo is no longer available.');
});
const removedClock = clock(() => {
  if (!state.removed) return;
  removedClock.clear();
  set({ removed: null });
  announce('Undo is no longer available.');
});
export function clearUndo(): void { bulkClock.clear(); if (state.undo) set({ undo: null }); }
export function clearRemoved(): void { removedClock.clear(); if (state.removed) set({ removed: null }); }
export const holdUndo = (who: string): void => bulkClock.hold(who);
export const releaseUndo = (who: string): void => bulkClock.release(who, !!state.undo);
export const holdRemoved = (who: string): void => removedClock.hold(who);
export const releaseRemoved = (who: string): void => removedClock.release(who, !!state.removed);

let highlightTimer: ReturnType<typeof setTimeout> | undefined;
function markNew(id: string): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  set({ highlight: id });
  highlightTimer = setTimeout(() => { if (state.highlight === id) set({ highlight: null }); }, 8000);
}

/** A retry shows "Trying…" at least this long, so a try that fails again does not look like nothing happened. */
export const RETRY_MIN_MS = 400;

export async function loadArmory(opts: { minBusyMs?: number } = {}): Promise<void> {
  const started = Date.now();
  set({ loading: true });
  try {
    const data = await request<ArmoryData>('GET', '/api/armory');
    set({ data, loaded: true, loadError: null, absent: false, rowErrors: {}, resetErrors: {} });
  } catch (e) {
    set({ loadError: msg(e), absent: e instanceof ApiError && e.status === 404 });
  } finally {
    const wait = (opts.minBusyMs ?? 0) - (Date.now() - started);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    set({ loading: false });
  }
}
export async function retryLoad(): Promise<boolean> {
  await loadArmory({ minBusyMs: RETRY_MIN_MS });
  const ok = !state.loadError;
  announce(ok ? 'Armory reloaded.' : 'Still could not read the Armory.');
  return ok;
}

/**
 * Ask Claude Code again what it loads (POST /api/armory/refresh: a new plugin may have been installed). The list is replaced by the
 * answer; a failure keeps the old list and says why. Stays "Refreshing" at least a moment, so a quick answer is still seen.
 */
export async function refreshDiscovery(): Promise<boolean> {
  if (state.refreshing) return false;
  const started = Date.now();
  set({ refreshing: true, refreshError: null });
  let ok = false;
  try {
    const data = await request<ArmoryData>('POST', '/api/armory/refresh');
    set({ data, loaded: true, loadError: null, absent: false, rowErrors: {}, resetErrors: {} });
    ok = true;
  } catch (e) {
    set({ refreshError: msg(e) });
  } finally {
    const wait = RETRY_MIN_MS - (Date.now() - started);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    set({ refreshing: false });
  }
  if (ok) {
    const d = state.data;
    announce(d?.inherit !== false && d?.discovery === 'disk-fallback'
      ? `Refreshed, but Claude Code could not be asked. ${plural(d.skills.length, 'skill')} listed from its folders.`
      : `Refreshed from Claude Code. ${plural(d?.skills.length ?? 0, 'skill')} listed.`);
  } else announce(endSentence(`Could not refresh: ${state.refreshError}`));
  return ok;
}

const dropKey = <T,>(o: Record<string, T>, k: string): Record<string, T> => { const { [k]: _gone, ...rest } = o; return rest; };

/** The newest state asked for while a save of the same skill is in flight. The last wish wins; it is sent right after the save. */
const queuedState = new Map<string, SkillState>();

/**
 * One skill's state. Optimistic: the row moves at once; a failure puts it back and says why on that row. A change asked for while a
 * save is in flight is not dropped: the row shows it at once (so what is focused and what is checked never differ), the newest one
 * is kept, and it is sent as soon as the save ends. If that save fails, the row goes back to the last saved state.
 */
export async function setSkillState(id: string, next: SkillState, opts: { keepUndo?: boolean; quiet?: boolean } = {}): Promise<boolean> {
  if (!state.data) return false;
  let before = findSkill(id);
  if (!before) return false;
  if (state.switching.includes(id)) {
    if (before.offReason) return false;
    queuedState.set(id, next);
    setSkills(withState(skillsNow(), id, next));
    return true;
  }
  if (!opts.keepUndo) clearUndo();
  set({ switching: [...state.switching, id], rowErrors: dropKey(state.rowErrors, id), ...(state.savedOff === id ? { savedOff: null } : {}) });
  setSkills(withState(skillsNow(), id, next));
  let ok = false;
  let want = next;
  try {
    for (;;) {
      const res = await request<ArmorySkill>('POST', '/api/armory/state', { id, state: want });
      setSkills(withSkill(skillsNow(), res));
      if (!opts.quiet) announce(stateDone(uniqueLabel(before!), res.state));
      ok = true;
      const q = queuedState.get(id);
      queuedState.delete(id);
      if (q === undefined || q === res.state) break;
      before = res; want = q;
      setSkills(withState(skillsNow(), id, q));
    }
  } catch (e) {
    queuedState.delete(id);
    setSkills(withState(skillsNow(), id, before!.state));
    set({ rowErrors: { ...state.rowErrors, [id]: { op: 'state', message: msg(e) } } });
    ok = false;
  } finally {
    set({ switching: state.switching.filter((x) => x !== id) });
  }
  return ok;
}

/**
 * Many skills, one state, one request (POST /api/armory/state-bulk, one write in the core). Optimistic like the single change: every
 * row moves at once; the core's answer puts back each row it refused, and a request that fails puts every row back. Each failed
 * row says why. Returns what changed and what did not; ids already in flight are left out and are in neither list.
 */
async function setStates(ids: string[], next: SkillState): Promise<{ done: string[]; failed: { id: string; reason: string }[] }> {
  const go = ids.filter((id) => !state.switching.includes(id) && findSkill(id));
  if (!go.length || !state.data) return { done: [], failed: [] };
  const before = new Map(go.map((id) => [id, findSkill(id)!] as const));
  let errors = state.rowErrors;
  for (const id of go) errors = dropKey(errors, id);
  set({ switching: [...state.switching, ...go], rowErrors: errors });
  setSkills(skillsNow().map((s) => (before.has(s.id) ? { ...s, state: next } : s)));
  const done: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  try {
    const res = await request<{ skills: ArmorySkill[]; refused: { id: string; reason: string }[] }>('POST', '/api/armory/state-bulk', { ids: go, state: next });
    const applied = new Map(res.skills.map((s) => [s.id, s] as const));
    const refused = new Map(res.refused.map((r) => [r.id, r.reason] as const));
    for (const id of go) {
      const got = applied.get(id);
      if (got) { done.push(id); continue; }
      failed.push({ id, reason: refused.get(id) ?? 'the change was not made' });
    }
    setSkills(skillsNow().map((s) => applied.get(s.id) ?? before.get(s.id) ?? s));
  } catch (e) {
    setSkills(skillsNow().map((s) => before.get(s.id) ?? s));
    for (const id of go) failed.push({ id, reason: msg(e) });
  } finally {
    set({ switching: state.switching.filter((x) => !before.has(x)) });
  }
  if (failed.length) {
    const next2 = { ...state.rowErrors };
    for (const f of failed) next2[f.id] = { op: 'state', message: f.reason };
    set({ rowErrors: next2 });
  }
  return { done, failed };
}

/** Which agents may use one skill: 'all' or a list of agent ids. */
export async function setSkillAgents(id: string, agents: 'all' | string[]): Promise<boolean> {
  if (state.switching.includes(id) || !state.data) return false;
  const before = findSkill(id);
  if (!before) return false;
  clearUndo();
  set({ switching: [...state.switching, id], rowErrors: dropKey(state.rowErrors, id) });
  setSkills(withSkill(skillsNow(), { ...before, agents }));
  let ok = false;
  try {
    const res = await request<ArmorySkill>('POST', '/api/armory/agents', { id, agents });
    setSkills(withSkill(skillsNow(), res));
    announce(`${uniqueLabel(before)}: ${agents === 'all' ? 'all agents' : agents.length === 0 ? 'no agents' : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}.`);
    ok = true;
  } catch (e) {
    setSkills(withSkill(skillsNow(), before));
    set({ rowErrors: { ...state.rowErrors, [id]: { op: 'agents', message: msg(e) } } });
  } finally {
    set({ switching: state.switching.filter((x) => x !== id) });
  }
  return ok;
}

/** How many skills a group change would touch, from what the screen shows now. */
export const bulkCount = (key: string, to: BulkTo): number => groupBulkTargets(skillsNow(), key, to).length;

/**
 * Turn every changeable skill of a group on or off, at once, then say what happened, with Undo. One request for the whole group
 * (the bulk route applies the same rule as a click, per skill, in one write), so it cannot do more than the owner could by hand.
 * If the core refuses one, the rest still go and the message says how many did not.
 */
export async function bulkSet(key: string, to: BulkTo): Promise<void> {
  if (state.resetting || !state.data) return;
  const targets = groupBulkTargets(skillsNow(), key, to).filter((s) => !state.switching.includes(s.id));
  if (!targets.length) return;
  clearUndo();
  clearUndone();
  set({ resetting: key, resetErrors: dropKey(state.resetErrors, key) });
  const prior = new Map(targets.map((t) => [t.id, t.state] as const));
  let res: Awaited<ReturnType<typeof setStates>>;
  try {
    res = await setStates(targets.map((t) => t.id), to);
  } finally {
    set({ resetting: null });
  }
  const done = res.done.map((id) => ({ id, state: prior.get(id)! }));
  const failed = res.failed.length;
  const why = res.failed[0]?.reason ?? '';
  if (failed) set({ resetErrors: { ...state.resetErrors, [key]: `${failed} of ${targets.length} did not change${why ? `: ${why}` : ''}` } });
  if (!done.length) return;
  const after = [loadsNow(), to === 'on' ? flagsOf(res.done) : ''].filter(Boolean).join(' ');
  const message = `${failed ? `${bulkDone(to, done.length)} ${failed} did not change.` : bulkDone(to, done.length)}${after ? ` ${after}` : ''}`;
  set({ undo: { key, message, items: done, total: done.length } });
  bulkClock.start(true);
  announce(message);
}

/**
 * Put the last bulk change back: each skill goes to the state it had. The offer stays until every skill is back; after a failure
 * it lists only what is still to put back, says why, and a second try picks up where this one stopped.
 */
export async function undoBulk(): Promise<void> {
  const u = state.undo;
  if (!u || state.resetting) return;
  bulkClock.stop();
  set({ resetting: u.key, undo: { ...u, error: undefined } });
  const left: { id: string; state: SkillState }[] = [];
  let why = '';
  try {
    // Each skill goes back to the state it had, so the items are put back in one request per old state (at most three).
    for (const to of ['on', 'manual', 'off'] as const) {
      const group = u.items.filter((it) => it.state === to);
      if (!group.length) continue;
      const r = await setStates(group.map((it) => it.id), to);
      const gone = new Set(r.done);
      for (const it of group) if (!gone.has(it.id)) left.push(it);
      if (r.failed.length) why ||= r.failed[0]!.reason;
      else if (group.some((it) => !gone.has(it.id))) why ||= 'a change did not save';
    }
  } finally {
    set({ resetting: null });
  }
  if (left.length) {
    const error = `${endSentence(`Undo failed: ${why}`)} Try again.`;
    set({ undo: { ...u, items: left, error } });
    announce(error);
    return;
  }
  let message = bulkUndone(u.total);
  if (u.restoreNotice) {
    try {
      await request('POST', '/api/armory/notice-seen', { seen: false });
      if (state.data) set({ data: { ...state.data, ccNoticeSeen: false } });
    } catch { message += ' The notice could not be shown again.'; }
  }
  clearUndo();
  showUndone(u.key, message);
  announce(message);
}

/** The one-time notice: Got it. */
export async function dismissNotice(): Promise<boolean> {
  if (state.noticeBusy) return false;
  set({ noticeBusy: true, noticeError: null });
  try {
    await request('POST', '/api/armory/notice-seen', {});
    if (state.data) set({ data: { ...state.data, ccNoticeSeen: true } });
    return true;
  } catch (e) {
    set({ noticeError: msg(e) });
    return false;
  } finally {
    set({ noticeBusy: false });
  }
}

/** The notice's Turn all on: every inherited Claude Code skill that can be on, then the notice is marked seen. Undo is offered. */
export async function turnAllOn(): Promise<void> {
  if (state.noticeBusy || state.resetting || !state.data) return;
  const targets = turnAllOnTargets(skillsNow()).filter((s) => !state.switching.includes(s.id));
  clearUndo();
  clearUndone();
  set({ noticeBusy: true, noticeError: null, resetting: 'notice' });
  const prior = new Map(targets.map((t) => [t.id, t.state] as const));
  let res: Awaited<ReturnType<typeof setStates>>;
  try {
    res = await setStates(targets.map((t) => t.id), 'on');
  } finally {
    set({ resetting: null });
  }
  const done = res.done.map((id) => ({ id, state: prior.get(id)! }));
  const failed = res.failed.length;
  const why = res.failed[0]?.reason ?? '';
  let marked = false;
  if (failed) {
    // The notice stays: not everything is on, and the owner can try again or choose by hand.
    set({ noticeBusy: false, noticeError: `${failed} of ${targets.length} did not turn on${why ? `: ${why}` : ''}` });
  } else {
    try {
      await request('POST', '/api/armory/notice-seen', {});
      if (state.data) set({ data: { ...state.data, ccNoticeSeen: true } });
      marked = true;
    } catch (e) {
      set({ noticeError: `The skills are on, but this notice could not be closed: ${msg(e)}` });
    }
    set({ noticeBusy: false });
  }
  if (done.length) {
    const after = [loadsNow(), flagsOf(res.done)].filter(Boolean).join(' ');
    const message = `${bulkDone('on', done.length)}${after ? ` ${after}` : ''}`;
    set({ undo: { key: 'notice', message, items: done, total: done.length, ...(marked ? { restoreNotice: true } : {}) } });
    bulkClock.start(true);
    announce(message);
  }
}

/** The Advanced switch. Optimistic; a failure puts it back and says why beside it. */
export async function setAllowShell(allow: boolean): Promise<void> {
  if (state.shellBusy || !state.data) return;
  const before = state.data.allowSkillShell === true;
  set({ shellBusy: true, shellError: null, data: { ...state.data, allowSkillShell: allow } });
  try {
    const res = await request<{ allowSkillShell: boolean }>('POST', '/api/armory/allow-shell', { allow });
    if (state.data) set({ data: { ...state.data, allowSkillShell: res.allowSkillShell === true } });
    announce(res.allowSkillShell ? 'Skills may run commands when they load.' : 'Skills may not run commands when they load.');
  } catch (e) {
    if (state.data) set({ data: { ...state.data, allowSkillShell: before } });
    set({ shellError: msg(e) });
  } finally {
    set({ shellBusy: false });
  }
}

/* ---- read ---- */

export async function openRead(id: string, title: string): Promise<void> {
  const s = findSkill(id);
  if (s && !s.path) {
    set({ reading: { id, title, status: 'builtin', text: '', thirdParty: false, path: null, error: null } });
    return;
  }
  set({ reading: { id, title, status: 'loading', text: '', thirdParty: false, path: null, error: null } });
  try {
    const r = await request<{ id: string; text: string; path: string; thirdParty: boolean }>('GET', `/api/armory/file?id=${encodeURIComponent(id)}`);
    if (state.reading?.id === id) set({ reading: { id, title, status: 'ready', text: r.text, thirdParty: r.thirdParty, path: r.path, error: null } });
  } catch (e) {
    if (state.reading?.id === id) set({ reading: { id, title, status: 'error', text: '', thirdParty: false, path: null, error: msg(e) } });
  }
}
export function closeRead(): void { set({ reading: null }); }

/** The text of one skill, for the editor. Throws the core's message. */
export async function readSkillText(id: string): Promise<string> {
  const r = await request<{ text: string }>('GET', `/api/armory/file?id=${encodeURIComponent(id)}`);
  return r.text;
}

/* ---- write ---- */

/** Create a skill, or update one of yours with the same name. Throws the core's message for the editor to show inline. */
export async function saveSkill(f: EditorFields): Promise<{ id: string; created: boolean }> {
  const body = { name: f.name, description: f.description, ...(f.whenToUse.trim() ? { whenToUse: f.whenToUse } : {}), body: f.body };
  const res = await request<ArmorySkill & { created: boolean }>('POST', '/api/armory/skill', body);
  clearUndo();
  await loadArmory();
  markNew(res.id);
  set({ savedOff: res.created ? res.id : null });
  announce(res.created ? `Saved ${res.name}. It is off. Turn it on from its row.` : `Saved ${res.name}.`);
  return { id: res.id, created: res.created };
}

/**
 * What an import would do, asked of the core with dryRun: nothing is written. The core owns every rule (what is dropped, what is
 * stripped, what is refused); the screen only shows the answer. A refusal comes back as `ok: false` with the reason; a request
 * that fails throws the core's message.
 */
export async function reviewImportFiles(files: SentFile[]): Promise<ImportReview> {
  return request<ImportReview>('POST', '/api/armory/import', { files, dryRun: true });
}

/** Add an imported skill (off). Throws the core's message. */
export async function importSkill(files: SentFile[]): Promise<ImportDone> {
  const res = await request<ImportDone & { state: string }>('POST', '/api/armory/import', { files });
  clearUndo();
  await loadArmory();
  markNew(res.id);
  announce(`Added ${res.name}. It is off.`);
  return { id: res.id, name: res.name, kept: res.kept, dropped: res.dropped, stripped: res.stripped };
}

/**
 * Remove a skill of yours or an imported one, at once, and offer Undo. The core hands back the old text; Undo posts it again and
 * puts the state and the agent list back. An imported skill comes back with SKILL.md only, and off.
 */
export async function removeSkill(id: string): Promise<boolean> {
  const s = findSkill(id);
  if (!s || (s.source !== 'yours' && s.source !== 'imported') || state.busyIds.includes(id)) return false;
  clearUndo();
  clearRemoved();
  set({ busyIds: [...state.busyIds, id], busyOps: { ...state.busyOps, [id]: 'remove' }, rowErrors: dropKey(state.rowErrors, id) });
  try {
    const res = await request<{ removed: string; source: 'yours' | 'imported'; text: string }>('DELETE', `/api/armory/skill?id=${encodeURIComponent(id)}`);
    await loadArmory();
    const message = `Removed ${uniqueLabel(s)}.`;
    set({ removed: { id, name: s.name, source: res.source, state: s.state, agents: s.agents, text: res.text, message } });
    removedClock.start(true);
    announce(message);
    return true;
  } catch (e) {
    set({ rowErrors: { ...state.rowErrors, [id]: { op: 'remove', message: msg(e) } } });
    return false;
  } finally {
    set({ busyIds: state.busyIds.filter((x) => x !== id), busyOps: dropKey(state.busyOps, id) });
  }
}

export async function undoRemove(): Promise<void> {
  const r = state.removed;
  if (!r || state.busyIds.includes(r.id)) return;
  removedClock.stop();
  set({ busyIds: [...state.busyIds, r.id], removed: { ...r, error: undefined } });
  try {
    if (r.source === 'yours') {
      const p = restorePayload(r.text);
      await request('POST', '/api/armory/skill', { name: p.name || r.name, description: p.description, body: p.body });
    } else {
      await request('POST', '/api/armory/import', { files: [{ path: `${r.name}/SKILL.md`, text: r.text }] });
    }
    // The core starts a restored skill at its default; the owner's own choices go back too.
    const fresh = (await request<ArmoryData>('GET', '/api/armory')).skills.find((x) => x.id === r.id);
    if (fresh && fresh.state !== r.state) await request('POST', '/api/armory/state', { id: r.id, state: r.state });
    if (r.agents !== 'all') await request('POST', '/api/armory/agents', { id: r.id, agents: r.agents });
    clearRemoved();
    await loadArmory();
    markNew(r.id);
    // The bar that held focus is gone: focus goes to the restored row, not to the top of the page.
    set({ focusRow: r.id });
    announce(`Put ${r.name} back.`);
  } catch (e) {
    const error = `${endSentence(`Undo failed: ${msg(e)}`)} Try again.`;
    set({ removed: { ...r, error } });
    announce(error);
  } finally {
    set({ busyIds: state.busyIds.filter((x) => x !== r.id) });
  }
}

/** Promote copies the skill into Doctrine as a drill that is not approved and off. The owner approves it there. */
export async function promoteSkill(id: string): Promise<boolean> {
  const s = findSkill(id);
  if (!s || state.busyIds.includes(id)) return false;
  set({ busyIds: [...state.busyIds, id], busyOps: { ...state.busyOps, [id]: 'promote' }, rowErrors: dropKey(state.rowErrors, id), promoted: null });
  try {
    const res = await request<{ path: string; name: string }>('POST', '/api/house/drill/promote', { armoryId: id });
    set({ promoted: { id, name: res.name, path: res.path, from: s.name } });
    announce(`Copied ${s.name} to Doctrine as the drill ${res.name}. It is not approved and it is off.`);
    void loadHouse();
    return true;
  } catch (e) {
    set({ rowErrors: { ...state.rowErrors, [id]: { op: 'promote', message: msg(e) } } });
    return false;
  } finally {
    set({ busyIds: state.busyIds.filter((x) => x !== id), busyOps: dropKey(state.busyOps, id) });
  }
}
export const clearFocusRow = (): void => { if (state.focusRow) set({ focusRow: null }); };
export function dismissPromoted(): void { if (state.promoted) set({ promoted: null }); }
/** Open Doctrine at the new drill: the caller switches the screen; the drill's group opens, its row is marked and takes focus. */
export function showPromotedDrill(): void {
  const p = state.promoted;
  if (!p) return;
  revealDrill(p.path);
  set({ promoted: null });
}

/* ---- what an agent sees ---- */

/** GET /api/armory/effective for one agent. A late answer for an older call is kept only if it is the latest. */
const effSeq: Record<string, number> = {};
export async function loadEffective(agentId: string): Promise<void> {
  const seq = (effSeq[agentId] = (effSeq[agentId] ?? 0) + 1);
  set({ effective: { ...state.effective, [agentId]: { status: 'loading', data: state.effective[agentId]?.data ?? null, error: null } } });
  try {
    const data = await request<EffectiveView>('GET', `/api/armory/effective?agent=${encodeURIComponent(agentId)}`);
    if (effSeq[agentId] === seq) set({ effective: { ...state.effective, [agentId]: { status: 'ready', data, error: null } } });
  } catch (e) {
    if (effSeq[agentId] === seq) set({ effective: { ...state.effective, [agentId]: { status: 'error', data: null, error: msg(e) } } });
  }
}

/**
 * GET /api/armory/effective-all: the counts for every agent in one request (the panel that lists them all used to ask once per agent).
 * Every agent shows "Reading" until the answer is in; a failure is shown on each agent, each with its own Try again.
 */
let allSeq = 0;
export async function loadEffectiveAll(agentIds: readonly string[]): Promise<void> {
  const seq = ++allSeq;
  const loading: Record<string, EffectiveSlot> = {};
  for (const id of agentIds) loading[id] = { status: 'loading', data: state.effective[id]?.data ?? null, error: null };
  set({ effective: { ...state.effective, ...loading } });
  try {
    const res = await request<{ agents: EffectiveCounts[] }>('GET', '/api/armory/effective-all');
    if (seq !== allSeq) return;
    const by = new Map(res.agents.map((a) => [a.agent, a] as const));
    const next: Record<string, EffectiveSlot> = {};
    for (const id of agentIds) {
      const d = by.get(id);
      next[id] = d ? { status: 'ready', data: d, error: null } : { status: 'error', data: null, error: 'Legion did not list this agent' };
    }
    set({ effective: { ...state.effective, ...next } });
  } catch (e) {
    if (seq !== allSeq) return;
    const next: Record<string, EffectiveSlot> = {};
    for (const id of agentIds) next[id] = { status: 'error', data: null, error: msg(e) };
    set({ effective: { ...state.effective, ...next } });
  }
}

let started = false;
export function initArmory(): void {
  if (started) return;
  started = true;
  void loadArmory();
}
