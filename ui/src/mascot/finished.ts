import { isTurnLimitPause } from '../../../src/shared/continue.js';

/**
 * "status|updatedAt" of an agent's latest finished task: the bust plays Victory for a fresh `done` and Fault detected for a
 * fresh `error`. A task paused at the turn limit is stored as `error` but is not a failure (the work is kept and Continue
 * picks it up), so it is not a finish at all here: the bust stays calm instead of contradicting the Paused card.
 */
export function latestFinished(tasks: ReadonlyArray<{ agentId: string; status: string; error?: string; updatedAt: string }>, agentId: string): string {
  let best = '';
  let bt = '';
  for (const t of tasks) {
    if (t.agentId !== agentId || (t.status !== 'done' && t.status !== 'error') || isTurnLimitPause(t)) continue;
    if (t.updatedAt > bt) { bt = t.updatedAt; best = `${t.status}|${t.updatedAt}`; }
  }
  return best;
}
