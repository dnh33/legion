/**
 * Per-task write quotas for the Lattice. One TaskQuota lives for one task run; the Graph charges it on every
 * agent write and the tool layer charges it on every call, so a looping or poisoned bot hits a wall quickly.
 * Refusals say "quota reached, finish up" so the bot stops instead of retrying.
 */
import { KgError } from './types.js';

export const TASK_QUOTA = { nodeWrites: 40, edgeOps: 100, bytes: 200 * 1024, calls: 60 } as const;
export type QuotaLimits = { nodeWrites: number; edgeOps: number; bytes: number; calls: number };

export class TaskQuota {
  nodeWrites = 0;
  edgeOps = 0;
  bytes = 0;
  calls = 0;
  constructor(readonly limits: QuotaLimits = { ...TASK_QUOTA }) {}

  private refuse(what: string): never {
    throw new KgError('limit', `Quota reached for this task (${what}): finish up. Summarise what you have and stop writing to the knowledge graph.`);
  }

  /** One kg tool call (reads included). */
  call(): void {
    if (this.calls >= this.limits.calls) this.refuse(`${this.limits.calls} knowledge graph calls`);
    this.calls++;
  }

  /** One node write (create, update, no-change upsert, tombstone) of roughly `bytes` bytes. */
  node(bytes: number): void {
    if (this.nodeWrites >= this.limits.nodeWrites) this.refuse(`${this.limits.nodeWrites} node writes`);
    if (this.bytes + bytes > this.limits.bytes) this.refuse(`${Math.round(this.limits.bytes / 1024)} KB written`);
    this.nodeWrites++;
    this.bytes += bytes;
  }

  /** One edge write (link or unlink). */
  edge(bytes = 0): void {
    if (this.edgeOps >= this.limits.edgeOps) this.refuse(`${this.limits.edgeOps} link operations`);
    if (this.bytes + bytes > this.limits.bytes) this.refuse(`${Math.round(this.limits.bytes / 1024)} KB written`);
    this.edgeOps++;
    this.bytes += bytes;
  }
}
