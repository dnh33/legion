/**
 * Raising an agent's mode (spec 2026-10-14 goals and gates, "Only the owner, in the app, with a confirm"). Pure.
 * An agent's mode comes from its own setting, or from the preset of the project it works in (the app preset outside a project). A change
 * RAISES it when, in any of those places, the agent would run as something that is not at least as strict as before. The core decides this
 * here and nowhere else: the app's dialog lists the lines this returns, and the routes ask for the native secret and the digest of this result.
 * Tightening and no change need nothing. The project's "limit agents" switch is ignored on purpose: it can only tighten, and the
 * owner's word on "Full" is wanted whether or not a limit sits on top today.
 */
import { createHash } from 'node:crypto';
import { DENY_LINE, NO_SANDBOX_LINE } from '../../shared/gates-registry.js';
import type { Preset } from '../../shared/gates-registry.js';
import type { AgentProfile, ApprovalMode, RunMode } from '../../shared/types.js';
import { presetMode, stricterMode } from '../permission-mode.js';
import type { Ctx } from '../server.js';

export interface AgentModeFields { approval: ApprovalMode; approvalSource: 'own' | 'project' }
/** What a request may change. */
export interface AgentModeChange { approval?: ApprovalMode; approvalSource?: 'own' | 'project' }
/** The presets that decide a followed mode: the app's, and one entry per project the agent is a member of. */
export interface ModeWorld { appPreset: Preset | undefined; projects: Array<{ id: string; name: string; preset: Preset | undefined }> }
export interface AgentModePreview {
  raises: boolean;
  /** The plain sentences of what gets looser, then the closing safety lines. Empty when nothing is raised. */
  loosening: string[];
  /** sha256 of the agent, the mode before and after, and the presets that decide a followed mode. */
  digest: string;
  /** What the agent will run as: one entry for an agent with its own mode, one per place for an agent that follows its project. */
  runsAs: Array<{ where: string; mode: RunMode }>;
}

/** The mode a new agent starts with (the create route stores these when the request says nothing). */
export const NEW_AGENT_MODE: AgentModeFields = { approval: 'ask', approvalSource: 'own' };

/** The fields as they would be stored after the change (the same rules as the routes: absent fields keep what the agent has). */
export function modeAfter(before: AgentModeFields, change: AgentModeChange): AgentModeFields {
  return { approval: change.approval ?? before.approval, approvalSource: change.approvalSource ?? before.approvalSource };
}
export function modeOf(a: Pick<AgentProfile, 'approval' | 'approvalSource'> | undefined): AgentModeFields {
  return a ? { approval: a.approval, approvalSource: a.approvalSource === 'project' ? 'project' : 'own' } : NEW_AGENT_MODE;
}

const place = (f: AgentModeFields, appPreset: Preset | undefined, projectPreset: Preset | undefined): RunMode =>
  f.approvalSource === 'project' ? presetMode(projectPreset ?? appPreset ?? 'ask') : f.approval;
const atLeastAsStrict = (a: RunMode, b: RunMode): boolean => stricterMode(a, b) === a;

const DOES: Record<RunMode, string> = {
  ask: 'ask before it runs commands or changes files',
  'smart-edits': 'ask before it runs commands or changes files outside the project',
  'auto-edits': 'change files without asking, and still ask before it runs commands',
  smart: 'ask before anything that reaches the web, deletes, cannot be undone, or that Legion cannot classify; tests and builds run without asking, and the code they run can reach the web',
  full: 'never ask before it runs commands or changes files',
};

/** What the change would do. `name` is the agent's name (the new name, for a rename in the same request). */
export function previewAgentMode(o: { agentId: string | undefined; name: string; before: AgentModeFields; change: AgentModeChange; world: ModeWorld }): AgentModePreview {
  const after = modeAfter(o.before, o.change);
  const { world } = o;
  const places: Array<{ where: string; app: boolean; preset: Preset | undefined }> = [{ where: 'outside a project', app: true, preset: undefined }, ...world.projects.map((p) => ({ where: `in the project "${p.name}"`, app: false, preset: p.preset }))];
  const runsAs: AgentModePreview['runsAs'] = [];
  const lines: string[] = [];
  let raises = false;
  for (const p of places) {
    const was = place(o.before, world.appPreset, p.preset);
    const now = place(after, world.appPreset, p.preset);
    runsAs.push({ where: p.where, mode: now });
    if (atLeastAsStrict(now, was)) continue;
    raises = true;
    // an agent with its own mode runs the same everywhere: one sentence, not one per project
    if (after.approvalSource === 'own') { if (lines.length === 0) lines.push(`${o.name} will ${DOES[now]}.`); continue; }
    lines.push(`${o.name} will follow the way agents ask ${p.where}. There it will ${DOES[now]}.`);
  }
  const loosening = raises ? [...lines, DENY_LINE, NO_SANDBOX_LINE] : [];
  const digest = createHash('sha256').update(JSON.stringify([o.agentId ?? 'new', o.before, after, world.appPreset ?? null, world.projects.map((p) => [p.id, p.preset ?? null])])).digest('hex');
  return { raises, loosening, digest, runsAs: after.approvalSource === 'own' ? runsAs.slice(0, 1) : runsAs };
}

/** The checks a route runs before it stores a mode change. Throws the HTTP refusal. */
export interface AgentModeGuard {
  /** `cur` is undefined for a new agent. Returns normally for a change that tightens or keeps the mode. */
  check(c: Ctx, o: { cur: AgentProfile | undefined; name: string; change: AgentModeChange }): void;
}
