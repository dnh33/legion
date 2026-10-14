/**
 * Is the agent waiting on its owner? An approval card or a question from the agent: both mean "your turn", so the bust asks
 * for either. Counts every project (the bust is the agent, not the project in view).
 */
export const agentAwaitsOwner = (agentId: string, approvals: ReadonlyArray<{ agentId: string }>, questions: ReadonlyArray<{ agentId: string }>): boolean =>
  approvals.some((a) => a.agentId === agentId) || questions.some((q) => q.agentId === agentId);
