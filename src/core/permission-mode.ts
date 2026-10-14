/**
 * The mode a run's tool calls are judged by (spec 2026-10-14 goals and gates, section 4.2, revision 4). Pure.
 * base = the goal's autonomy (Full gives full), else the agent's own mode, else (an agent that follows its project) the
 * project preset, or the app preset without a project. cap = the project preset when "Limit agents to this" is on; a goal
 * lease replaces the cap for that goal's runs. effective = the stricter of base, cap and the origin ceiling.
 * A project with no preset ("Per agent") and an agent with its own mode give exactly 0.3.0.
 */
import type { Preset } from '../shared/gates-registry.js';
import type { ApprovalMode } from '../shared/types.js';

export type RunMode = 'ask' | 'auto-edits' | 'smart' | 'full';
export type GoalAutonomy = 'track' | 'suggest' | 'check-once' | 'own' | 'full';
export interface ModeInputs {
  agentMode: ApprovalMode;
  source: 'own' | 'project';
  project?: { preset?: Preset; limit: boolean };
  appPreset: Preset;
  goal?: { autonomy: GoalAutonomy; lease?: Preset };
  ceiling?: ApprovalMode;
}

const RANK: Record<RunMode, number> = { ask: 0, 'auto-edits': 1, smart: 2, full: 3 };
const stricter = (a: RunMode, b: RunMode): RunMode => (RANK[a] <= RANK[b] ? a : b);

export function presetMode(p: Preset): RunMode {
  switch (p) {
    case 'ask': return 'ask';
    case 'accept-edits': return 'auto-edits';
    case 'smart': return 'smart';
    case 'bypass': return 'full';
  }
}

export function effectiveMode(a: ModeInputs): RunMode {
  let base: RunMode;
  if (a.goal?.autonomy === 'full') base = 'full';
  else if (a.source === 'own') base = a.agentMode;
  else base = presetMode(a.project?.preset ?? a.appPreset);

  let out = base;
  const preset = a.project?.preset;
  if (a.goal?.lease) out = stricter(out, presetMode(a.goal.lease));
  else if (preset && a.project?.limit) out = stricter(out, presetMode(preset));
  if (a.ceiling) out = stricter(out, a.ceiling);
  return out;
}
