import { LEAD_AGENT_ID } from './lead-id.js';
import type { AgentProfile } from './types.js';

/** Claude Code's own task tools for this agent's Claude runs: an explicit setting wins; otherwise on for the lead only. */
export function nativeTaskListOn(agent: Pick<AgentProfile, 'id' | 'taskList'>): boolean {
  if (agent.taskList === 'on') return true;
  if (agent.taskList === 'off') return false;
  return agent.id === LEAD_AGENT_ID;
}
