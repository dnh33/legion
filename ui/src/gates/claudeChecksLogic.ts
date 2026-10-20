// The window's view model for "Claude agents follow Claude's own permission checks": whether the switch is on, who the setting touches, when the one-time
// notice shows, and whether the newest Smart run had to do without Claude's checker. Pure; the words live in src/shared/claude-checks-copy.ts.
import type { AgentProfile, Task } from '../../../src/shared/types.js';
import { shouldShowPresetChoice } from '../welcome/presetChoiceLogic.js';
import { isProviderModel } from '../chat/busy.js';
import type { GatesView } from './presetsLogic.js';

/** The switch: on unless the app file says false. */
export const claudeChecksOn = (view: GatesView): boolean => view.app.claudeOwnChecks !== false;

/** Claude agents are the ones whose model is not a provider's (an AWS "arn:" id is Claude). */
export function hasClaudeAgents(agents: ReadonlyArray<Pick<AgentProfile, 'model'>>): boolean { return agents.some((a) => !isProviderModel(a.model)); }

/**
 * The one-time notice: an install that was already in use (a fresh install is about to see the first-run screen, which says it in one sentence and marks it
 * seen), with a Claude agent, with the switch still on (turned off: nothing changed for them), and not dismissed.
 */
export function shouldShowClaudeNotice(view: GatesView, agents: ReadonlyArray<Pick<AgentProfile, 'id' | 'name' | 'approval' | 'approvalSource' | 'model'> & { seedApproval?: true }>): boolean {
  if (view.app.claudeNoticeSeen === true || !claudeChecksOn(view)) return false;
  if (!hasClaudeAgents(agents)) return false;
  return !shouldShowPresetChoice(view, true, agents);
}

/** True when the newest task that reports a checker had to do without it: the Gates page then says so once. */
export function checkerFallbackNow(tasks: ReadonlyArray<Pick<Task, 'updatedAt' | 'claudeChecker'>>): boolean {
  let newest: Pick<Task, 'updatedAt' | 'claudeChecker'> | undefined;
  for (const t of tasks) if (t.claudeChecker !== undefined && (!newest || Date.parse(t.updatedAt) > Date.parse(newest.updatedAt))) newest = t;
  return newest?.claudeChecker === 'fallback';
}
