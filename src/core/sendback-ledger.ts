/**
 * The lead doctrine's send-back rule, as a record (lead.ts step 6): one goal goes to one agent at most
 * MAX_SENDS_PER_GOAL times (the first send and two send-backs), and once it moved to another agent it never comes back
 * to one that had it. Keyed on the brief's goal within one caller task; a prose-only message has no goal and is not
 * counted.
 *
 * `check` only reads, `record` only writes: the bridge records a send after the message was delivered, so a refused
 * or failed delivery does not use up a try. The record is kept in `<dir>/sendbacks.json`, so a core restart does not
 * hand an agent fresh tries; without a dir it lives in memory only.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SENDS_PER_GOAL = 3;
/** Caller tasks kept on disk; the oldest go first. A task this old has long finished its sends. */
const MAX_TASKS = 500;

interface Goal { sends: Record<string, number>; last: string; movedFrom: string[] }
type Record_ = Record<string, Record<string, Goal>>;

const goalKey = (goal: string): string => goal.trim().toLowerCase().replace(/\s+/g, ' ');

export class SendBackLedger {
  private readonly file: string | undefined;
  private data: Record_ = {};

  constructor(dir: string | undefined) {
    this.file = dir ? join(dir, 'sendbacks.json') : undefined;
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.data = raw as Record_;
    } catch { /* no file yet, or unreadable: start empty */ }
  }

  /** Why this send is refused, or undefined when it may go. Changes nothing. */
  check(callerTaskId: string, target: { id: string; name: string }, goal: string | undefined): string | undefined {
    if (!goal?.trim()) return undefined;
    const g = this.data[callerTaskId]?.[goalKey(goal)];
    if (!g) return undefined;
    if (g.movedFrom.includes(target.id)) return `This task moved from ${target.name} to another agent; it does not go back. Give it to an agent that has not had it, or report it as open.`;
    const n = g.sends[target.id] ?? 0;
    if (n >= MAX_SENDS_PER_GOAL) return `${target.name} already had this task ${n} times (the first send and two send-backs). Give it to another agent, or report it as open with the check it did not meet.`;
    return undefined;
  }

  /** Counts one delivered send. */
  record(callerTaskId: string, target: { id: string }, goal: string | undefined): void {
    if (!goal?.trim()) return;
    const goals = this.data[callerTaskId] ?? (this.data[callerTaskId] = {});
    const key = goalKey(goal);
    const g = goals[key];
    if (!g) goals[key] = { sends: { [target.id]: 1 }, last: target.id, movedFrom: [] };
    else {
      if (g.last !== target.id && !g.movedFrom.includes(g.last)) g.movedFrom.push(g.last);
      g.sends[target.id] = (g.sends[target.id] ?? 0) + 1;
      g.last = target.id;
    }
    this.save();
  }

  /** The caller task was deleted. */
  forget(callerTaskId: string): void {
    if (!(callerTaskId in this.data)) return;
    delete this.data[callerTaskId];
    this.save();
  }

  private save(): void {
    const ids = Object.keys(this.data);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TASKS))) delete this.data[id];
    if (!this.file) return;
    try {
      if (!Object.keys(this.data).length) { rmSync(this.file, { force: true }); return; }
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch { /* a lost write only resets this count to memory: the in-memory record still holds */ }
  }
}
