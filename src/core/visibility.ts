/**
 * Which agents (and so which of their tasks, approvals, VMs, rooms and events) the outside world may see.
 * An agent gated behind an optional feature (the Assayer needs BSV mode, `requires: 'bsv'`) is hidden while the feature is off:
 * no surface (HTTP, SSE, MCP, comms) may list it, mention it or answer differently for it than for an id that never existed.
 * Reading the agent record by id (to edit or delete it in Settings) stays possible; running or messaging it does not.
 */
import type { AgentProfile, Task } from '../shared/types.js';

export interface VisibilityCtx {
  bsvEnabled?: () => boolean;
  store: { getAgent(id: string): AgentProfile | undefined };
}

export const agentVisible = (ctx: Pick<VisibilityCtx, 'bsvEnabled'>, a: AgentProfile): boolean => a.requires !== 'bsv' || ctx.bsvEnabled?.() === true;

/** An id the store does not know is "visible" (there is nothing to hide). */
export function agentIdVisible(ctx: VisibilityCtx, agentId: string): boolean {
  const a = ctx.store.getAgent(agentId);
  return !a || agentVisible(ctx, a);
}

export const taskVisible = (ctx: VisibilityCtx, t: Pick<Task, 'agentId'>): boolean => agentIdVisible(ctx, t.agentId);
