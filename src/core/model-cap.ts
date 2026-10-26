import { runtimeOf } from '../shared/runtime.js';

/**
 * The most expensive model a bot may ask for on another agent's behalf (per-task `model` on ask, tell, bot_send, room_post).
 * Rank: haiku 1, sonnet 2, opus 3, fable 4. An agent's own setting is its ceiling, and `auto` (or an id we cannot place) counts as sonnet, so
 * a bot never upgrades a peer past what its owner chose for it. `auto` as a request is always allowed (the router decides, and the
 * engine clamps the result to the same ceiling).
 *
 * Fable sits ABOVE Opus. Without its own rank it would count as Sonnet, and a Sonnet agent could be moved onto the dearest model.
 */
export function modelRank(model: string | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (m.includes('fable')) return 4;
  if (m.includes('opus')) return 3;
  if (m.includes('haiku')) return 1;
  return 2;
}

/** The alias to run on when a request is clamped. */
export function rankModel(rank: number): 'haiku' | 'sonnet' | 'opus' | 'fable' {
  return rank >= 4 ? 'fable' : rank >= 3 ? 'opus' : rank <= 1 ? 'haiku' : 'sonnet';
}

/** True for a provider or agent host model value (`openrouter:vendor/model`, `acp:hermes`); a Bedrock ARN and a Claude alias are not. */
const offClaude = (model: string | undefined): boolean => runtimeOf(model) !== 'claude';

/**
 * True when the agent's own model allows a per-task override to `requested`. An agent that runs on a provider keeps it (a bot cannot
 * move it to Claude or to another model: no price order is known, and it would send the owner's data elsewhere), and a Claude agent
 * cannot be moved onto a provider by a bot.
 */
export function overrideAllowed(agentModel: string | undefined, requested: string | undefined): boolean {
  if (!requested) return true;
  if (offClaude(agentModel) || offClaude(requested)) return requested === agentModel;
  if (requested.toLowerCase() === 'auto') return true;
  return modelRank(requested) <= modelRank(agentModel);
}

export function overrideRefusal(agentName: string, agentModel: string | undefined, requested: string): string {
  if (offClaude(agentModel) || offClaude(requested)) return `${agentName} runs on ${agentModel ?? 'its own setting'}; a per-task model cannot change where it runs or which model it uses. Leave model out.`;
  const ceil = rankModel(modelRank(agentModel));
  return `Model "${requested}" is above ${agentName}'s own model setting (${agentModel ?? 'auto'}, so at most ${ceil}). Ask for ${ceil} or lower, or leave model out.`;
}
