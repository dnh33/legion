/**
 * The activity log (gates PR 2): one plain line for each thing that happened around a run, so the owner can see what ran without asking
 * (runs, cards asked and answered, gate and preset changes, what a gate that is off let through, goal states and check verdicts).
 * Append-only JSON lines, one file per day (`<dataDir>/activity/<yyyy-mm-dd>.jsonl`), kept 30 days.
 *
 * It is a record the agents must not rewrite, so the module lists the folder as a protected path (file tools and the shell guard).
 * Lines never carry a secret: every text first loses address userinfo, query strings and fragments and curl body flags (`scrubLine`), then passes the log redactor (`redact`: `scrubSecrets` plus the exact values the core holds, plus URL
 * query strings) and is cut at 400 characters. Writing never throws: a full or read-only disk loses the line, never the run.
 *
 * The "last used" record of an approved site is NOT kept here (this log forgets after 30 days): the web module keeps its own file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreModule, ModuleDeps } from '../modules.js';
import type { LegionEvent } from '../../shared/types.js';
import { redact } from '../log/redact.js';

export type ActivityKind = 'run-start' | 'run-end' | 'card-asked' | 'card-answered' | 'would-have-asked' | 'gate-changed' | 'goal-state' | 'check-verdict' | 'note';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['run-start', 'run-end', 'card-asked', 'card-answered', 'would-have-asked', 'gate-changed', 'goal-state', 'check-verdict', 'note'];
export interface ActivityLine { at: string; kind: ActivityKind; text: string; taskId?: string; projectId?: string; agentId?: string; data?: Record<string, string | number | boolean> }
export interface ActivityLog {
  folder: string;
  /** Never throws. The text is scrubbed and cut at 400 characters. */
  append(line: Omit<ActivityLine, 'at'> & { at?: string }): void;
  wouldHaveAsked(a: { gateId: string; label: string; action: string; taskId: string; projectId?: string; agentId?: string }): void;
  /** Newest first. Default limit 200, at most 1000. */
  read(q?: { projectId?: string; taskId?: string; day?: string; kinds?: ActivityKind[]; limit?: number }): ActivityLine[];
  /** Deletes the day files that are wholly older than 30 days. */
  prune(now?: number): void;
}

/** Lines kept for one task id (a run, or `goal:<id>` for a goal), then one summary line and nothing more. */
export const RUN_LINE_CAP = 2000;
export const CUT_LINE = 'Activity for this run was cut at 2,000 lines.';
const TEXT_MAX = 400;
const KEEP_MS = 30 * 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const READ_DEFAULT = 200;
const READ_MAX = 1000;
const COUNTS_MAX = 20_000;
const STATUS_MAX = 20_000;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Redacts first on a bounded head, then cuts: a token must never be cut in half and slip past the rules. */
/** Curl-style flags whose argument is a request body or an uploaded file (separate or `=` attached, quoted or bare). Case matters: `-D` dumps headers, `-f` fails. */
const BODY_FLAG = /(^|\s)(-[a-zA-Z]*[dFT]|--data(?:-raw|-binary|-urlencode|-ascii)?|--form(?:-string)?|--upload-file|--json)(?:=|\s+)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/g;
export const scrubShell = (s: string): string => s.replace(BODY_FLAG, (_m, pre: string, flag: string) => `${pre}${flag} <omitted>`);
/** An address without its userinfo, query string and fragment. Text that is not an address comes back as it was. */
export function scrubUrl(u: string): string {
  try { const x = new URL(u); x.username = ''; x.password = ''; x.search = ''; x.hash = ''; return x.toString().replace(/\/$/, u.endsWith('/') ? '/' : ''); } catch { return u; }
}
const URL_IN_TEXT = /https?:\/\/\S+/gi;
const TRAILING = /[.,;:!?)\]}>'"]+$/;
/** Every address in a line is cut down to scheme, host and path, and curl body flags are dropped, before the log redactor runs. */
export const scrubLine = (s: string): string => scrubShell(s).replace(URL_IN_TEXT, (m) => { const tail = TRAILING.exec(m)?.[0] ?? ''; return scrubUrl(m.slice(0, m.length - tail.length)) + tail; });
const clean = (s: unknown, n: number): string => clip(redact(scrubLine(String(s).slice(0, n * 5))), n);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isKind = (k: unknown): k is ActivityKind => typeof k === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(k);

export function createActivityLog(o: { dataDir: string; now?: () => number }): ActivityLog {
  const folder = join(o.dataDir, 'activity');
  const now = (): number => (o.now ?? Date.now)();
  const counts = new Map<string, number>();
  let seededDay = '';
  let prunedDay = '';

  const fileOf = (day: string): string => join(folder, `${day}.jsonl`);
  const parse = (raw: string): ActivityLine[] => {
    const out: ActivityLine[] = [];
    for (const l of raw.split('\n')) {
      if (!l) continue;
      try { const v = JSON.parse(l) as ActivityLine; if (v && typeof v.text === 'string' && isKind(v.kind)) out.push(v); } catch { /* a torn line */ }
    }
    return out;
  };
  /** Task ids not seen in this process are counted from today's file once per day, so a core restart does not give a run a fresh cap. */
  const seed = (day: string): void => {
    if (seededDay === day) return;
    seededDay = day;
    let raw = ''; try { raw = readFileSync(fileOf(day), 'utf8'); } catch { return; }
    const fromFile = new Map<string, number>();
    for (const l of parse(raw)) if (l.taskId) fromFile.set(l.taskId, (fromFile.get(l.taskId) ?? 0) + 1);
    for (const [id, n] of fromFile) if (!counts.has(id)) counts.set(id, n);
  };
  const prune = (at: number = now()): void => {
    try {
      for (const name of readdirSync(folder)) {
        const m = FILE_RE.exec(name); if (!m) continue;
        const dayEnd = Date.parse(`${m[1]}T00:00:00Z`) + 86_400_000;
        if (Number.isFinite(dayEnd) && dayEnd < at - KEEP_MS) { try { unlinkSync(join(folder, name)); } catch { /* in use: the next prune */ } }
      }
    } catch { /* no folder yet */ }
  };

  const write = (line: ActivityLine, day: string): void => {
    mkdirSync(folder, { recursive: true });
    appendFileSync(fileOf(day), JSON.stringify(line) + '\n', 'utf8');
  };

  const append: ActivityLog['append'] = (l) => {
    try {
      const t = now();
      const day = dayOf(t);
      if (prunedDay !== day) { prunedDay = day; prune(t); }
      const line: ActivityLine = { at: typeof l.at === 'string' ? clean(l.at, 40) : new Date(t).toISOString(), kind: isKind(l.kind) ? l.kind : 'note', text: clean(l.text ?? '', TEXT_MAX) };
      if (l.taskId) line.taskId = clean(l.taskId, 120);
      if (l.projectId) line.projectId = clean(l.projectId, 120);
      if (l.agentId) line.agentId = clean(l.agentId, 120);
      if (l.data && typeof l.data === 'object') {
        const data: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(l.data).slice(0, 20)) {
          if (typeof v === 'string') data[clean(k, 60)] = clean(v, TEXT_MAX);
          else if (typeof v === 'number' || typeof v === 'boolean') data[clean(k, 60)] = v;
        }
        if (Object.keys(data).length) line.data = data;
      }
      if (line.taskId) {
        seed(day);
        const n = counts.get(line.taskId) ?? 0;
        if (n > RUN_LINE_CAP) return; // the summary is out: nothing more for this task
        counts.set(line.taskId, n + 1);
        if (counts.size > COUNTS_MAX) { let drop = COUNTS_MAX / 4; for (const k of counts.keys()) { if (drop-- <= 0) break; counts.delete(k); } }
        if (n === RUN_LINE_CAP) {
          write({ at: line.at, kind: 'note', text: CUT_LINE, taskId: line.taskId, ...(line.projectId ? { projectId: line.projectId } : {}) }, day);
          return;
        }
      }
      write(line, day);
    } catch { /* a line the disk would not take: the run goes on */ }
  };

  return {
    folder,
    append,
    wouldHaveAsked(a) {
      append({
        kind: 'would-have-asked', text: `Would have asked: ${clean(a.action, 300)}, because ${a.label} is off`, taskId: a.taskId,
        ...(a.projectId ? { projectId: a.projectId } : {}), ...(a.agentId ? { agentId: a.agentId } : {}), data: { gateId: a.gateId },
      });
    },
    read(q = {}) {
      const limit = Math.max(1, Math.min(READ_MAX, Math.floor(Number.isFinite(q.limit) ? (q.limit as number) : READ_DEFAULT)));
      const kinds = q.kinds?.filter(isKind);
      const out: ActivityLine[] = [];
      try {
        let days: string[];
        if (q.day !== undefined) days = DAY_RE.test(q.day) && existsSync(fileOf(q.day)) ? [q.day] : [];
        else days = readdirSync(folder).map((n) => FILE_RE.exec(n)?.[1]).filter((d): d is string => !!d).sort().reverse();
        for (const day of days) {
          let raw = ''; try { raw = readFileSync(fileOf(day), 'utf8'); } catch { continue; }
          const lines = parse(raw);
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i]!;
            if (q.projectId !== undefined && l.projectId !== q.projectId) continue;
            if (q.taskId !== undefined && l.taskId !== q.taskId) continue;
            if (kinds && kinds.length && !kinds.includes(l.kind)) continue;
            out.push(l);
            if (out.length >= limit) return out;
          }
        }
      } catch { /* no folder: nothing happened yet */ }
      return out;
    },
    prune,
  };
}

/** What a bus event adds to the log: run start and end, a card asked, a card answered. Pure bookkeeping, never throws. */
function watchBus(deps: Pick<ModuleDeps, 'bus'>, log: ActivityLog): () => void {
  const status = new Map<string, string>();
  const cards = new Map<string, { taskId: string; agentId: string; projectId?: string }>();
  return deps.bus.on((ev: LegionEvent) => {
    try {
      if (ev.type === 'task.updated') {
        const t = ev.task;
        const was = status.get(t.id);
        if (was === t.status) return;
        status.set(t.id, t.status);
        if (status.size > STATUS_MAX) { let drop = STATUS_MAX / 4; for (const k of status.keys()) { if (drop-- <= 0) break; status.delete(k); } }
        if (t.status === 'running') log.append({ kind: 'run-start', text: 'Run started', taskId: t.id, agentId: t.agentId, ...(t.projectId ? { projectId: t.projectId } : {}) });
        // a run ends once: only a task this process saw queued or running gets a run-end (a rename or archive of a finished task is not one)
        else if ((t.status === 'done' || t.status === 'error' || t.status === 'cancelled') && (was === 'running' || was === 'queued')) {
          log.append({ kind: 'run-end', text: `Run ended: ${t.status}`, taskId: t.id, agentId: t.agentId, ...(t.projectId ? { projectId: t.projectId } : {}), data: { status: t.status } });
        }
      } else if (ev.type === 'approval.requested') {
        const a = ev.approval;
        cards.set(a.id, { taskId: a.taskId, agentId: a.agentId, ...(a.projectId ? { projectId: a.projectId } : {}) });
        log.append({ kind: 'card-asked', text: `Asked: ${a.summary}`, taskId: a.taskId, agentId: a.agentId, ...(a.projectId ? { projectId: a.projectId } : {}), data: { tool: a.toolName } });
      } else if (ev.type === 'approval.resolved') {
        const c = cards.get(ev.approvalId);
        cards.delete(ev.approvalId);
        log.append({ kind: 'card-answered', text: ev.allowed ? 'Answered: allowed' : 'Answered: not allowed', ...(c ? { taskId: c.taskId, agentId: c.agentId, ...(c.projectId ? { projectId: c.projectId } : {}) } : {}), data: { allowed: ev.allowed } });
      }
    } catch { /* advisory */ }
  });
}

/** `GET /api/activity?projectId&taskId&day&kinds&limit` (admin only by the gate's default deny) and the bus lines. The log folder is protected. */
export function createActivityModule(deps: ModuleDeps, log: ActivityLog): CoreModule {
  const stop = watchBus(deps, log);
  return {
    id: 'activity',
    protectedPaths: () => [log.folder],
    routes: (add) => {
      add('GET', '/api/activity', ({ url }) => {
        const p = url.searchParams;
        const limit = p.get('limit');
        const asked = p.get('kinds');
        const kinds = (asked ?? '').split(',').filter(isKind);
        if (asked && !kinds.length) return []; // kinds were named and none is a kind: nothing matches
        return log.read({
          ...(p.get('projectId') ? { projectId: p.get('projectId')! } : {}), ...(p.get('taskId') ? { taskId: p.get('taskId')! } : {}),
          ...(p.get('day') ? { day: p.get('day')! } : {}), ...(kinds.length ? { kinds } : {}),
          ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
        });
      });
    },
    dispose: () => { stop(); },
  };
}
