/**
 * "Idle", exactly (plan section 5). Busy reasons come from engine/store/approval/VM state and registered probes; anything unreadable counts as busy.
 * Idle = no reason for QUIET_MS in a row, and the core has been up for BOOT_GRACE_MS.
 */
import type { Task, VmRecord } from '../../shared/types.js';
import { BOOT_GRACE_MS, QUIET_MS } from './config.js';

export type BusyProbe = () => boolean | Promise<boolean>;
export interface BusyInputs {
  tasks(): Task[];
  running(): string[];
  approvals(): unknown[];
  vms(): VmRecord[];
  probes: ReadonlyMap<string, BusyProbe>;
  /** True while the updater itself is checking/downloading/staging/applying. */
  updaterBusy(): boolean;
}

/** The plain-words reasons the core is busy right now (empty = nothing is running). */
export async function computeBusy(i: BusyInputs, nowMs: number, startedAtMs: number): Promise<string[]> {
  const why: string[] = [];
  const guard = <T>(name: string, fn: () => T): T | undefined => { try { return fn(); } catch { why.push(`${name} could not be read`); return undefined; } };
  const tasks = guard('the task list', () => i.tasks());
  if (tasks) {
    const live = tasks.filter((t) => t && (t.status === 'running' || t.status === 'queued'));
    if (live.length) why.push(`${live.length} task${live.length === 1 ? '' : 's'} running or waiting`);
  }
  const run = guard('the engine', () => i.running());
  if (run && run.length) why.push(`${run.length} agent run${run.length === 1 ? '' : 's'} in progress`);
  const apr = guard('the approvals list', () => i.approvals());
  if (apr && apr.length) why.push(`${apr.length} approval${apr.length === 1 ? '' : 's'} waiting for you`);
  const vms = guard('the VM list', () => i.vms());
  if (vms) {
    const ops = vms.filter((v) => v && (v.state === 'provisioning' || v.state === 'archiving'));
    if (ops.length) why.push('a VM operation is in progress');
  }
  for (const [name, probe] of i.probes) {
    try { if (await probe()) why.push(name); } catch { why.push(`${name} could not be read`); }
  }
  if (guard('the updater', () => i.updaterBusy())) why.push('an update is being prepared');
  if (nowMs - startedAtMs < BOOT_GRACE_MS) why.push('Legion just started');
  return why;
}

/** Remembers when the core last looked busy; idle means QUIET_MS without a busy sample. */
export class QuietClock {
  private lastBusyAt: number;
  constructor(startMs: number) { this.lastBusyAt = startMs; }
  sample(reasons: readonly string[], nowMs: number): void { if (reasons.length) this.lastBusyAt = nowMs; }
  quietMs(nowMs: number): number { return Math.max(0, nowMs - this.lastBusyAt); }
  isQuiet(nowMs: number): boolean { return this.quietMs(nowMs) >= QUIET_MS; }
}
