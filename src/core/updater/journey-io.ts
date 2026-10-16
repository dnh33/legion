/**
 * Writes and reads the step log of an update (journey.ts says what a step is). One call writes one step to three places with the same
 * id: <install>/.update/journey.jsonl (what the window and Settings read), <install>/.update/apply.log (the swap's own log) and
 * <data>/logs/app.log (the app's log, which was empty after the last update). Never throws: a log line must not stop an update.
 *
 * The swap helper (apply.ts) is copied alone and cannot import this file; it writes the same three lines with its own code.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldJourney, journeyLine, parseJourneyJsonl, type JourneyEvent, type JourneyProc, type JourneyState, type JourneyStepId, type JourneyView } from './journey.js';
import { writeAppLog } from './outcome-notice.js';

export const JOURNEY_FILE = 'journey.jsonl';
const upDir = (installDir: string): string => join(installDir, '.update');
export const journeyPath = (installDir: string): string => join(upDir(installDir), JOURNEY_FILE);

export interface JourneyCtx { installDir: string; /** The data folder: without it the step is not written to app.log. */ dataDir?: string; id: string; from: string; to: string; proc: JourneyProc; kind?: 'code' | 'full'; now?: () => number }
export interface StepExtra { pct?: number; bytes?: number; total?: number; during?: JourneyStepId; note?: string }

export function readJourneyEvents(installDir: string): JourneyEvent[] {
  try { return parseJourneyJsonl(readFileSync(journeyPath(installDir), 'utf8')); } catch { return []; }
}
/** The newest journey on disk, folded for display, or null. */
export function readLastJourney(installDir: string): JourneyView | null {
  try { return foldJourney(readJourneyEvents(installDir)); } catch { return null; }
}

/** Writes one step. Returns the event (also when a destination could not be written). */
export function recordStep(c: JourneyCtx, step: JourneyStepId, state: JourneyState, extra: StepExtra = {}): JourneyEvent {
  const at = new Date((c.now ?? Date.now)()).toISOString();
  const e: JourneyEvent = { at, id: c.id, step, state, proc: c.proc, from: c.from, to: c.to };
  if (c.kind) e.kind = c.kind;
  for (const k of ['pct', 'bytes', 'total', 'during', 'note'] as const) if (extra[k] !== undefined) (e as unknown as Record<string, unknown>)[k] = extra[k];
  try {
    mkdirSync(upDir(c.installDir), { recursive: true });
    // a new update id starts a new journey: the file only ever holds the newest one
    const prior = readJourneyEvents(c.installDir);
    const fresh = prior.length > 0 && prior[prior.length - 1]!.id !== c.id;
    if (fresh) writeFileSync(journeyPath(c.installDir), '');
    appendFileSync(journeyPath(c.installDir), JSON.stringify(e) + '\n');
  } catch { /* the other two logs still get the line */ }
  try { appendFileSync(join(upDir(c.installDir), 'apply.log'), `[${at}] ${journeyLine(e)}\n`); } catch { /* ignore */ }
  if (c.dataDir) {
    const bad = step === 'failed' || step === 'rolled-back' || state === 'failed';
    writeAppLog(c.dataDir, bad ? 'warn' : 'info', 'journey-step', {
      step, state, id: c.id, from: c.from, to: c.to, proc: c.proc,
      ...(c.kind ? { kind: c.kind } : {}), ...(e.pct !== undefined ? { pct: e.pct } : {}), ...(e.during ? { during: e.during } : {}), ...(e.note ? { note: e.note } : {}),
    }, (c.now ?? Date.now)());
  }
  return e;
}

/**
 * The new build calls this once it is up and healthy: when the newest journey was for the version that runs now, the swap is finished and the
 * journey is still open, it writes step 10 (Done) from the new app. Returns whether it wrote anything.
 */
export function noteDoneAtStart(installDir: string, dataDir: string | undefined, runningVersion: string): boolean {
  try {
    const v = readLastJourney(installDir);
    if (!v || v.to !== runningVersion || v.result !== 'running') return false;
    if (v.steps.find((s) => s.id === 'installing')?.state !== 'done') return false;
    recordStep({ installDir, ...(dataDir ? { dataDir } : {}), id: v.id, from: v.from, to: v.to, proc: 'new-app', ...(v.kind ? { kind: v.kind } : {}) }, 'done', 'done', { note: `Legion ${v.to} is running` });
    return true;
  } catch { return false; }
}

export const journeyFileExists = (installDir: string): boolean => existsSync(journeyPath(installDir));
