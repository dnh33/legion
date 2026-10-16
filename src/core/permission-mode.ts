/**
 * The mode a run's tool calls are judged by (spec 2026-10-14 goals and gates, section 4.2, revision 4). Pure.
 * base = the goal's autonomy (Full gives full), else the agent's own mode, else (an agent that follows its project) the
 * project preset, or the app preset without a project. cap = the project preset when "Limit agents to this" is on; a goal
 * lease replaces an existing cap for that goal's runs (it never adds one). effective = the stricter of base, cap and the origin ceiling.
 * A project with no preset ("Per agent") and an agent with its own mode give exactly 0.3.0.
 */
import type { Preset } from '../shared/gates-registry.js';
import type { ApprovalMode, RunMode } from '../shared/types.js';

export type { RunMode };
export type GoalAutonomy = 'track' | 'suggest' | 'check-once' | 'own' | 'full';
export interface ModeInputs {
  agentMode: ApprovalMode;
  source: 'own' | 'project';
  project?: { preset?: Preset; limit: boolean };
  appPreset: Preset;
  goal?: { autonomy: GoalAutonomy; lease?: Preset };
  ceiling?: RunMode;
}

// ask < smart-edits < { auto-edits, smart } < full. Smart and Accept edits are not ordered with each other; `smart-edits` sits under both.
const RANK: Record<RunMode, number> = { ask: 0, 'smart-edits': 1, 'auto-edits': 2, smart: 2, full: 3 };
const isRunMode = (m: unknown): m is RunMode => typeof m === 'string' && Object.hasOwn(RANK, m);
// Unknown values (they can come from disk) rank strictest and resolve to 'ask'.
/**
 * The stricter of two modes: a call needs a card if EITHER mode would card it. An unknown value on either side (it can come from disk) fails
 * closed to 'ask'. Smart and Accept edits are not ordered (Smart cards a risky Bash that Accept edits waves through; Accept edits cards a Bash
 * that Smart allows; Smart cards an edit outside the project that Accept edits allows), so a run held by both is judged by `smart-edits`, which
 * cards exactly what either would. It is never looser than either mode, and never as strict as Ask: an edit inside the project still runs.
 */
export function stricterMode<A extends RunMode, B extends RunMode>(a: A, b: B): A | B {
  if (!isRunMode(a) || !isRunMode(b)) return 'ask' as A | B;
  const x: RunMode = a; const y: RunMode = b;
  if (x === y) return a;
  if (x === 'ask' || y === 'ask') return 'ask' as A | B;
  if (x === 'full') return b;
  if (y === 'full') return a;
  // any other pair is two of smart, auto-edits, smart-edits; the meet of two different ones is smart-edits
  return 'smart-edits' as A | B;
}
const stricter = (a: RunMode, b: RunMode): RunMode => stricterMode(a, b);

/**
 * The resolver's answer for a module guard. No resolver (a core built without an engine) gives undefined, so the module uses the stored
 * mode as in 0.3.0. A resolver that THROWS reads as Ask: the stored mode may be Full while a project or ceiling caps the run, and a failed
 * lookup must never hand that Full back.
 */
export function resolverMode(engine: { runModeOf?(agentId: string, taskId?: string): RunMode | undefined } | undefined, agentId: string, taskId?: string): RunMode | undefined {
  if (!engine?.runModeOf) return undefined;
  try { return engine.runModeOf(agentId, taskId); } catch { return 'ask'; }
}

export function presetMode(p: Preset): RunMode {
  switch (p) {
    case 'ask': return 'ask';
    case 'accept-edits': return 'auto-edits';
    case 'smart': return 'smart';
    case 'bypass': return 'full';
    default: return 'ask';
  }
}

export function effectiveMode(a: ModeInputs): RunMode {
  let base: RunMode;
  if (a.goal?.autonomy === 'full') base = 'full';
  else if (a.source === 'own') base = a.agentMode;
  else base = presetMode(a.project?.preset ?? a.appPreset);

  let out = base;
  const preset = a.project?.preset;
  // A lease only replaces an existing project cap; with no cap it adds nothing.
  if (preset && a.project?.limit) out = stricter(out, presetMode(a.goal?.lease ?? preset));
  if (a.ceiling) out = stricter(out, a.ceiling);
  return isRunMode(out) ? out : 'ask';
}

/** What a run would be judged by with no presets at all: the agent's own mode, or ask for an agent that follows its project, under the ceiling. */
export function baselineMode(a: { agentMode: ApprovalMode; source?: 'own' | 'project'; ceiling?: RunMode }): RunMode {
  return effectiveMode({ agentMode: a.agentMode, source: a.source ?? 'own', appPreset: 'ask', ...(a.ceiling ? { ceiling: a.ceiling } : {}) });
}
