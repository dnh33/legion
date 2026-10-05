/**
 * The most expensive model a bot may ask for on another agent's behalf (per-task `model` on ask, tell, bot_send, room_post).
 * Rank: haiku 1, sonnet 2, opus 3. An agent's own setting is its ceiling, and `auto` (or an id we cannot place) counts as sonnet, so
 * a bot never upgrades a peer past what its owner chose for it. `auto` as a request is always allowed (the router decides, and the
 * engine clamps the result to the same ceiling).
 */
export function modelRank(model: string | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return 3;
  if (m.includes('haiku')) return 1;
  return 2;
}

/** The alias to run on when a request is clamped. */
export function rankModel(rank: number): 'haiku' | 'sonnet' | 'opus' {
  return rank >= 3 ? 'opus' : rank <= 1 ? 'haiku' : 'sonnet';
}

/** The `<provider>:` part of a provider model value (`openrouter:vendor/model`), if it has one. A Bedrock ARN is not one. */
function providerOf(model: string | undefined): string | undefined {
  const m = typeof model === 'string' ? /^([a-z][a-z0-9-]{1,31}):./.exec(model) : null;
  return m && m[1] !== 'arn' ? m[1] : undefined;
}

/**
 * True when the agent's own model allows a per-task override to `requested`. An agent that runs on a provider keeps it (a bot cannot
 * move it to Claude or to another model: no price order is known, and it would send the owner's data elsewhere), and a Claude agent
 * cannot be moved onto a provider by a bot.
 */
export function overrideAllowed(agentModel: string | undefined, requested: string | undefined): boolean {
  if (!requested) return true;
  if (providerOf(agentModel) || providerOf(requested)) return requested === agentModel;
  if (requested.toLowerCase() === 'auto') return true;
  return modelRank(requested) <= modelRank(agentModel);
}

export function overrideRefusal(agentName: string, agentModel: string | undefined, requested: string): string {
  if (providerOf(agentModel) || providerOf(requested)) return `${agentName} runs on ${agentModel ?? 'its own setting'}; a per-task model cannot change the provider or the model. Leave model out.`;
  const ceil = rankModel(modelRank(agentModel));
  return `Model "${requested}" is above ${agentName}'s own model setting (${agentModel ?? 'auto'}, so at most ${ceil}). Ask for ${ceil} or lower, or leave model out.`;
}
