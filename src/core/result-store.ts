/**
 * Full results of agent runs that were too long to send whole (the bridge sends the first part and a pointer to the rest).
 * One file per run under `<data dir>/results/<taskId>/<n>.txt`: a pair thread is reused, so a later run of the same task must not
 * overwrite what an earlier pointer refers to. Without a data dir (test doubles) the same API keeps the text in memory.
 *
 * The ids reach this module from an agent's tool arguments, so both are checked against a strict pattern before any path is built.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Longest result kept in full, per run (characters). A longer one is cut, and the text says it was. */
export const RESULT_STORE_MAX = 200_000;
/** Most bytes of kept results per task; the oldest runs are dropped first (the newest is always kept). */
export const RESULT_TASK_MAX_BYTES = 2_000_000;

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_ID_RE = /^[0-9]{1,6}$/;

const KEPT_NOTE_RE = /\n\[Legion kept the first \d+ of \d+ characters of this result\]$/;

/** The text as it is kept: whole up to RESULT_STORE_MAX, then cut with a visible note saying how much was dropped. */
export function capStored(text: string, max = RESULT_STORE_MAX): string {
  // already cut (the task row is capped when it is saved, and the bridge caps what it keeps): the note is not added twice
  if (KEPT_NOTE_RE.test(text.slice(-120)) && text.length <= max + 120) return text;
  return text.length <= max ? text : `${text.slice(0, max)}\n[Legion kept the first ${max} of ${text.length} characters of this result]`;
}

export class ResultStore {
  private readonly mem = new Map<string, string[]>();
  private readonly memIds = new Map<string, string[]>();
  private readonly memNext = new Map<string, number>();
  constructor(private readonly dir?: string) {}

  private taskDir(taskId: string): string | undefined {
    return this.dir && TASK_ID_RE.test(taskId) ? join(this.dir, 'results', taskId) : undefined;
  }

  /** Keeps the text (capped) as the next run of this task; returns the run id ("1", "2", ...). */
  put(taskId: string, text: string): string {
    if (!TASK_ID_RE.test(taskId)) throw new Error('Bad task id');
    const kept = capStored(text);
    const d = this.taskDir(taskId);
    if (!d) {
      const list = this.mem.get(taskId) ?? [];
      const id = String((this.memNext.get(taskId) ?? 0) + 1);
      this.memNext.set(taskId, Number(id));
      list.push(kept);
      this.memIds.set(taskId, [...(this.memIds.get(taskId) ?? []), id]);
      while (list.length > 1 && list.reduce((n, t) => n + Buffer.byteLength(t), 0) > RESULT_TASK_MAX_BYTES) { list.shift(); this.memIds.get(taskId)!.shift(); }
      this.mem.set(taskId, list);
      return id;
    }
    mkdirSync(d, { recursive: true });
    const ids = this.ids(taskId);
    const id = String((ids.length ? Number(ids[ids.length - 1]) : 0) + 1);
    writeFileSync(join(d, `${id}.txt`), kept, 'utf8');
    // keep the task's results under the byte cap: oldest first, never the one just written
    const all = [...ids, id];
    const size = (x: string) => { try { return statSync(join(d, `${x}.txt`)).size; } catch { return 0; } };
    let total = all.reduce((n, x) => n + size(x), 0);
    for (const old of all.slice(0, -1)) {
      if (total <= RESULT_TASK_MAX_BYTES) break;
      total -= size(old);
      try { rmSync(join(d, `${old}.txt`), { force: true }); } catch { /* ignore */ }
    }
    return id;
  }

  /** The kept text of one run, or undefined. `runId` is checked here as well as by the caller. */
  get(taskId: string, runId: string): string | undefined {
    if (!TASK_ID_RE.test(taskId) || !RUN_ID_RE.test(runId)) return undefined;
    const d = this.taskDir(taskId);
    if (!d) { const i = (this.memIds.get(taskId) ?? []).indexOf(runId); return i < 0 ? undefined : this.mem.get(taskId)?.[i]; }
    try { return readFileSync(join(d, `${runId}.txt`), 'utf8'); } catch { return undefined; }
  }

  latest(taskId: string): { id: string; text: string } | undefined {
    const ids = this.ids(taskId);
    const id = ids[ids.length - 1];
    if (id === undefined) return undefined;
    const text = this.get(taskId, id);
    return text === undefined ? undefined : { id, text };
  }

  private ids(taskId: string): string[] {
    const d = this.taskDir(taskId);
    if (!d) return [...(this.memIds.get(taskId) ?? [])];
    if (!existsSync(d)) return [];
    return readdirSync(d).map((f) => /^([0-9]{1,6})\.txt$/.exec(f)?.[1]).filter((x): x is string => !!x).sort((a, b) => Number(a) - Number(b));
  }

  /** The task was deleted: its kept results go with it. */
  remove(taskId: string): void {
    this.mem.delete(taskId); this.memIds.delete(taskId); this.memNext.delete(taskId);
    const d = this.taskDir(taskId);
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
