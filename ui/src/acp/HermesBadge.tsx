import type { Task } from '../../../src/shared/types';
import { HERMES_BADGE, HERMES_NOTE, hermesUsageLine } from '../../../src/shared/acp-copy';
import { parseAcpModel } from '../../../src/shared/runtime';

/** A task that ran (or is set to run) on Hermes. The label the core wrote after a run, or the agent host model value of the latest run. */
export const isHermesTask = (t: Pick<Task, 'runtime' | 'model'> | undefined): boolean =>
  !!t && (t.runtime === 'Hermes' || parseAcpModel(t.model ?? '')?.entryId === 'hermes');

/** On every Hermes task: Hermes acts on your computer with its own tools. The tooltip is the full sentence. */
export function HermesBadge({ task }: { task: Pick<Task, 'runtime' | 'model'> | undefined }) {
  if (!isHermesTask(task)) return null;
  return <span className="chip-pill hermes-badge" title={HERMES_NOTE}>{HERMES_BADGE}</span>;
}

/** Tokens, and that Hermes does not report cost (a cost shows only when the owner entered prices). */
export function HermesUsage({ task }: { task: Pick<Task, 'runtime' | 'model' | 'tokenUsage' | 'costUsd' | 'status'> | undefined }) {
  if (!task || !isHermesTask(task)) return null;
  return <span className="th-cost hermes-usage" title={`What this Hermes run used, as Hermes reports it. ${hermesUsageLine(task)}`}>{hermesUsageLine(task)}</span>;
}
