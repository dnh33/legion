import type { Task } from '../../../src/shared/types';
import { agentHostNote, hermesUsageLine, hostBadge, hostNameOf, isAgentHostModel } from '../../../src/shared/acp-copy';

/** A task that ran (or is set to run) on an agent host: the label the core wrote after a run, or the agent host model value of the latest run. */
export const isHostTask = (t: Pick<Task, 'runtime' | 'model'> | undefined): boolean => !!t && (!!t.runtime || isAgentHostModel(t.model));
/** The name the words about this task use: the host's own label from the run, else the name the model value points at. */
export const hostNameOfTask = (t: Pick<Task, 'runtime' | 'model'>): string => t.runtime ?? hostNameOf(t.model);

/** On every agent host task: the host acts on your computer with its own tools. The tooltip is the full sentence. */
export function HermesBadge({ task }: { task: Pick<Task, 'runtime' | 'model'> | undefined }) {
  if (!task || !isHostTask(task)) return null;
  const name = hostNameOfTask(task);
  return <span className="chip-pill hermes-badge" title={agentHostNote(name)}>{hostBadge(name)}</span>;
}

/** Tokens, and that the host does not report cost (a cost shows only when the owner entered prices). */
export function HermesUsage({ task }: { task: Pick<Task, 'runtime' | 'model' | 'tokenUsage' | 'costUsd' | 'status'> | undefined }) {
  if (!task || !isHostTask(task)) return null;
  const name = hostNameOfTask(task);
  const line = hermesUsageLine({ ...task, name });
  return <span className="th-cost hermes-usage" title={`What this ${name} run used, as ${name} reports it. ${line}`}>{line}</span>;
}
