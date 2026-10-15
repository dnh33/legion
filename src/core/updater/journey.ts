/**
 * The update journey: the named steps from "Checking" to "Done", the one event shape every process writes, and the fold that turns events
 * into what a person sees (the "Updating Legion" window, the panel, Settings > About).
 *
 * PURE and import-free on purpose. It is copied next to the update window's files and runs there, outside every folder an update swaps,
 * so it can import nothing. The swap helper (apply.ts) cannot import it either (that file is copied alone), so the helper writes the same
 * event shape with its own few lines and a test pins that the two agree.
 *
 * One update id runs through the whole journey: the core makes it when an update is found, the app and the helper carry it in the job,
 * and the new build reads it back. Every step writes ONE line with the step, the id, both versions and the process that wrote it.
 */

export type JourneyStepId = 'checking' | 'downloading' | 'verifying' | 'ready' | 'closing' | 'preparing' | 'installing' | 'starting' | 'health' | 'done' | 'failed' | 'rolled-back';
/** Which process runs the step. `any` is for a failure, which can happen anywhere. */
export type JourneyWhere = 'app' | 'helper' | 'new-app' | 'any';
export interface JourneyStep { id: JourneyStepId; n: string; label: string; where: JourneyWhere; /** Only a full-package update has this step. */ fullOnly?: boolean }

/** The steps, once. The numbers match the update plan (D:/bots/helper-h2-brief.md); the words are what the owner reads. */
export const JOURNEY_STEPS: readonly JourneyStep[] = Object.freeze([
  { id: 'checking', n: '1', label: 'Checking for the update', where: 'app' },
  { id: 'downloading', n: '2', label: 'Downloading', where: 'app' },
  { id: 'verifying', n: '3', label: 'Verifying the signature', where: 'app' },
  { id: 'ready', n: '4', label: 'Ready to install', where: 'app' },
  { id: 'closing', n: '5', label: 'Closing Legion', where: 'app' },
  { id: 'preparing', n: '6', label: 'Preparing', where: 'helper', fullOnly: true },
  { id: 'installing', n: '7', label: 'Installing', where: 'helper' },
  { id: 'starting', n: '8', label: 'Starting the new version', where: 'helper' },
  { id: 'health', n: '9', label: 'Checking that it runs', where: 'helper' },
  { id: 'done', n: '10', label: 'Done', where: 'new-app' },
  { id: 'failed', n: 'x', label: 'The update did not finish', where: 'any' },
  { id: 'rolled-back', n: 'y', label: 'Went back to the previous version', where: 'helper' },
] as JourneyStep[]);
const MAIN = JOURNEY_STEPS.slice(0, 10);
const isStepId = (v: unknown): v is JourneyStepId => typeof v === 'string' && JOURNEY_STEPS.some((s) => s.id === v);

export type JourneyProc = 'app' | 'core' | 'helper' | 'window' | 'new-app';
export type JourneyState = 'start' | 'done' | 'failed';
export interface JourneyEvent {
  at: string; id: string; step: JourneyStepId; state: JourneyState; proc: JourneyProc; from: string; to: string;
  kind?: 'code' | 'full'; pct?: number; bytes?: number; total?: number;
  /** For `failed` and `rolled-back`: the step that was under way. */
  during?: JourneyStepId; note?: string;
}

/** A short id for one update, 8 hex characters. */
export function newUpdateId(): string {
  const b = new Uint8Array(4);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The one-line form, as written in apply.log and app.log (the writer adds the time). Newlines in a note cannot break the line. */
export function journeyLine(e: JourneyEvent): string {
  let s = `journey step=${e.step} state=${e.state} id=${e.id} from=${e.from} to=${e.to} proc=${e.proc}`;
  if (e.kind) s += ` kind=${e.kind}`;
  if (e.pct !== undefined) s += ` pct=${Math.round(e.pct)}`;
  if (e.bytes !== undefined) s += ` bytes=${Math.round(e.bytes)}`;
  if (e.total !== undefined) s += ` total=${Math.round(e.total)}`;
  if (e.during) s += ` during=${e.during}`;
  if (e.note) s += ` note=${JSON.stringify(e.note)}`;
  return s;
}

/** Reads one journey line back (with or without the `[time] ` prefix the log writers add). Anything else is not a journey line. */
export function parseJourneyLine(line: string): JourneyEvent | null {
  const m = /^(?:\[([^\]]+)\]\s+)?journey\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const kv: Record<string, string> = {};
  for (const p of m[2]!.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) kv[p[1]!] = p[2]!;
  if (!isStepId(kv.step) || (kv.state !== 'start' && kv.state !== 'done' && kv.state !== 'failed') || !kv.id || !kv.from || !kv.to || !kv.proc) return null;
  const num = (k: string): number | undefined => { const n = Number(kv[k]); return kv[k] !== undefined && Number.isFinite(n) ? n : undefined; };
  let note: string | undefined;
  if (kv.note !== undefined) { try { note = JSON.parse(kv.note) as string; } catch { note = kv.note; } }
  const e: JourneyEvent = { at: m[1] ?? '', id: kv.id, step: kv.step, state: kv.state, proc: kv.proc as JourneyProc, from: kv.from, to: kv.to };
  if (kv.kind === 'code' || kv.kind === 'full') e.kind = kv.kind;
  if (num('pct') !== undefined) e.pct = num('pct')!;
  if (num('bytes') !== undefined) e.bytes = num('bytes')!;
  if (num('total') !== undefined) e.total = num('total')!;
  if (isStepId(kv.during)) e.during = kv.during;
  if (note !== undefined) e.note = note;
  return e;
}

const isEvent = (v: unknown): v is JourneyEvent => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.at === 'string' && typeof o.id === 'string' && isStepId(o.step) && (o.state === 'start' || o.state === 'done' || o.state === 'failed') && typeof o.from === 'string' && typeof o.to === 'string' && typeof o.proc === 'string';
};
/** The journey file is one JSON event per line, appended by every process. A damaged line is skipped, never fatal. */
export function parseJourneyJsonl(text: string): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const v: unknown = JSON.parse(t); if (isEvent(v)) out.push(v); } catch { /* not an event */ }
  }
  return out;
}

export type JourneyStepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export interface JourneyStepView { id: JourneyStepId; n: string; label: string; where: JourneyWhere; state: JourneyStepState; startedAt?: string; at?: string }
export interface JourneyView {
  id: string; from: string; to: string; kind?: 'code' | 'full';
  /** The ten steps, in order. */
  steps: JourneyStepView[];
  /** The step under way (it has started and not finished). */
  current?: JourneyStepId; pct?: number; bytes?: number; total?: number;
  result: 'running' | 'ok' | 'failed' | 'rolled-back'; reason?: string; failedAt?: JourneyStepId;
  /** How a failed or rolled-back update ended, in plain words for Settings (outcomeText). */
  message?: string;
  startedAt: string; endedAt?: string;
}

/** What a person should see for one journey: the events of one id folded into step states. `id` defaults to the newest journey in the list. */
export function foldJourney(events: readonly JourneyEvent[], id?: string): JourneyView | null {
  const want = id ?? events[events.length - 1]?.id;
  if (!want) return null;
  const mine = events.filter((e) => e.id === want);
  if (!mine.length) return null;
  const last = <K extends keyof JourneyEvent>(k: K): JourneyEvent[K] | undefined => { for (let i = mine.length - 1; i >= 0; i--) if (mine[i]![k] !== undefined) return mine[i]![k]; return undefined; };
  const kind = last('kind');
  const terminal = [...mine].reverse().find((e) => (e.step === 'failed' || e.step === 'rolled-back') && e.state !== 'start');
  const okDone = mine.some((e) => e.step === 'done' && e.state === 'done');
  const idxOf = (s: JourneyStepId): number => MAIN.findIndex((m) => m.id === s);
  let maxIdx = -1;
  for (const e of mine) { const i = idxOf(e.step); if (i > maxIdx) maxIdx = i; }
  if (terminal?.during) maxIdx = Math.max(maxIdx, idxOf(terminal.during));
  const result: JourneyView['result'] = okDone ? 'ok' : terminal ? (terminal.step === 'rolled-back' ? 'rolled-back' : 'failed') : 'running';
  // the active step: the furthest one that started and has not finished, while nothing has ended the journey
  let activeIdx = -1;
  if (result === 'running' && maxIdx >= 0) {
    const ev = mine.filter((e) => e.step === MAIN[maxIdx]!.id);
    if (ev.some((e) => e.state === 'start') && !ev.some((e) => e.state === 'done')) activeIdx = maxIdx;
  }
  const steps: JourneyStepView[] = MAIN.map((s, i) => {
    const ev = mine.filter((e) => e.step === s.id);
    const started = ev.find((e) => e.state === 'start');
    const done = [...ev].reverse().find((e) => e.state === 'done');
    const skippable = !!s.fullOnly && kind === 'code';
    let state: JourneyStepState;
    if (terminal?.during === s.id || ev.some((e) => e.state === 'failed')) state = 'failed';
    else if (i === activeIdx) state = 'active';
    else if (done || i < maxIdx || (result === 'ok')) state = skippable && !done ? 'skipped' : 'done';
    else state = skippable ? 'skipped' : 'pending';
    const v: JourneyStepView = { id: s.id, n: s.n, label: s.label, where: s.where, state };
    if (started) v.startedAt = started.at;
    if (done) v.at = done.at;
    else if (state === 'failed') { const f = ev.find((e) => e.state === 'failed') ?? terminal; if (f) v.at = f.at; }
    return v;
  });
  const view: JourneyView = { id: want, from: last('from') ?? '', to: last('to') ?? '', steps, result, startedAt: mine[0]!.at };
  if (kind) view.kind = kind;
  if (activeIdx >= 0) {
    view.current = MAIN[activeIdx]!.id;
    const cur = mine.filter((e) => e.step === view.current);
    for (const k of ['pct', 'bytes', 'total'] as const) { for (let i = cur.length - 1; i >= 0; i--) if (cur[i]![k] !== undefined) { view[k] = cur[i]![k]!; break; } }
  }
  if (result !== 'running') view.endedAt = (terminal ?? [...mine].reverse().find((e) => e.step === 'done'))?.at ?? mine[mine.length - 1]!.at;
  if (terminal?.note) view.reason = terminal.note;
  if (terminal?.during) view.failedAt = terminal.during;
  if (terminal) view.message = outcomeText({ result: terminal.step === 'rolled-back' ? 'rolled-back' : 'failed', ...(terminal.note ? { reason: terminal.note } : {}), ...(terminal.during ? { failedAt: terminal.during } : {}), from: view.from }, 'settings');
  return view;
}

/**
 * The helper writes short technical reasons; the owner gets plain words, never a raw code, an address, a port or a path, and never a cut-off sentence.
 * The result has no full stop: the caller adds the one it needs.
 */
export function plainReason(reason?: string): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Something went wrong';
  if (/core is still running|still answers on the port/i.test(r)) return 'Legion was opened while it was updating';
  if (/did not exit in time|still running: nothing/i.test(r)) return 'Legion did not close in time';
  if (/files in use|EBUSY|EPERM|EACCES/i.test(r)) return 'Some files were in use';
  if (/did not report healthy|did not become healthy/i.test(r)) return 'The new version did not start correctly, so Legion went back to the previous one';
  if (/^preflight/i.test(r)) return 'Legion could not back up your data first';
  if (/could not prepare the update helper|helper copy/i.test(r)) return 'Legion could not prepare the update helper';
  const clean = r.replace(/[–—]/g, '-')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi, '')
    .replace(/\b[A-Za-z]:\\[^\s'"]*/g, '')
    .replace(/^failed:\s*/i, '')
    .replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/[.\s]+$/, '');
  return clean || 'Something went wrong';
}

const STEPS_BEFORE_THE_SWAP_ENDS: readonly JourneyStepId[] = ['closing', 'preparing', 'installing'];
const sentence = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
/**
 * The one sentence for how an update ended, the same words in the update window and in Settings, About. Each outcome says only what is true:
 * "Your files are unchanged." only when it failed before the new files were in place (a swap that fails puts the old ones back), and a rollback
 * says which version is running. `where` changes only the way forward: the window has a Retry button, Settings does not.
 */
export function outcomeText(o: { result: 'failed' | 'rolled-back'; reason?: string; failedAt?: JourneyStepId; from?: string }, where: 'window' | 'settings' = 'window'): string {
  const raw = o.reason ?? '';
  let why = plainReason(raw);
  if (o.result === 'rolled-back') why = why.replace(/,? so Legion went back to the previous one$/i, '');
  let t = sentence(why);
  if (/files in use|EBUSY|EPERM|EACCES/i.test(raw)) t += ` Close other Legion windows or programs using the Legion folder, then ${where === 'window' ? 'press Retry' : 'try the update again'}.`;
  if (o.result === 'rolled-back') t += ` Legion went back to ${o.from || 'the previous version'}.`;
  else if (o.failedAt && STEPS_BEFORE_THE_SWAP_ENDS.includes(o.failedAt)) t += ' Your files are unchanged.';
  return t;
}
