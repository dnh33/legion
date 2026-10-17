// How an agent's approval is chosen and shown (spec 4.2: visible, always). Pure: the agent editor, the project settings and the run header read it.
import { effectiveMode, presetMode } from '../../../src/core/permission-mode.js';
import type { AgentProfile, ApprovalMode, RunMode, Task } from '../../../src/shared/types.js';
import type { Project } from '../../../src/shared/projects.js';
import { AGENT_MODE_LABEL, MODE_LABEL, runsAsChip, webChip, type GatesView } from './presetsLogic.js';

/** What the agent editor's Approvals field offers. `project` is "Follow project"; the rest are the agent's own mode. */
export type ApprovalChoice = 'project' | ApprovalMode;
export const APPROVAL_CHOICES: ReadonlyArray<{ id: ApprovalChoice; label: string }> = [
  { id: 'project', label: 'Follow project' },
  { id: 'ask', label: 'Ask' },
  { id: 'auto-edits', label: 'Accept edits' },
  { id: 'full', label: 'Full' },
];
export const CHOICE_HELP: Record<ApprovalChoice, string> = {
  project: 'Uses the way agents ask in the project it works in, or the app default outside a project.',
  ask: 'Asks before Bash, edits and MCP tools.',
  'auto-edits': 'Allows file edits, asks for Bash and MCP tools.',
  full: 'Never asks. A project can still limit it.',
};

/** What the field shows for a saved agent. A new agent (nothing saved yet) starts on Follow project. */
export const choiceOf = (a: Pick<AgentProfile, 'approval' | 'approvalSource'> | undefined): ApprovalChoice => (a === undefined ? 'project' : a.approvalSource === 'project' ? 'project' : a.approval);

/**
 * The approval fields a save sends. A saved agent that was not touched sends nothing, so loading an agent never rewrites its source
 * (an agent made before projects could set this stays on its own mode). A new agent always sends both: Follow project keeps Ask as its own mode.
 */
export function approvalPatch(existing: Pick<AgentProfile, 'approval' | 'approvalSource'> | undefined, choice: ApprovalChoice): { approval?: ApprovalMode; approvalSource?: 'own' | 'project' } {
  if (existing === undefined) return choice === 'project' ? { approval: 'ask', approvalSource: 'project' } : { approval: choice, approvalSource: 'own' };
  if (choiceOf(existing) === choice) return {};
  // Following a project keeps the agent's own mode as it was (it is the mode the agent goes back to).
  return choice === 'project' ? { approvalSource: 'project' } : { approval: choice, approvalSource: 'own' };
}

/** The mode a run of this agent gets in a project (or outside one: `project` undefined), the same way the engine works it out. */
function modeIn(a: { approval: ApprovalMode; source: 'own' | 'project' }, view: GatesView, projectId?: string): RunMode {
  const p = projectId === undefined ? undefined : view.projects[projectId];
  return effectiveMode({
    agentMode: a.approval, source: a.source, appPreset: view.app.preset ?? 'ask',
    ...(p ? { project: { ...(p.preset ? { preset: p.preset } : {}), limit: p.limit ?? true } } : {}),
  });
}

const modeName = (mode: RunMode, source: 'own' | 'project'): string => (source === 'own' && mode === 'full' ? AGENT_MODE_LABEL.full : MODE_LABEL[mode]);

/**
 * The lines under the Approvals field: one clause per project the agent belongs to, `In Shop: runs as Ask (project limit). In Blog: Full.`
 * `a` is what the editor shows right now (the choice not yet saved), so the lines answer for the choice on screen.
 */
export function agentProjectLines(a: { id: string | null; approval: ApprovalMode; source: 'own' | 'project' }, projects: readonly Project[], view: GatesView | null): string {
  if (!view) return '';
  const mine = a.id === null ? [] : projects.filter((p) => p.status !== 'archived' && p.members.includes(a.id!));
  if (mine.length === 0) {
    if (a.source !== 'project') return '';
    return `Not in a project, so it follows the app default: ${MODE_LABEL[presetMode(view.app.preset ?? 'ask')]}.`;
  }
  return mine.map((p) => {
    const mode = modeIn(a, view, p.id);
    const set = view.projects[p.id];
    const name = modeName(mode, a.source);
    if (a.source === 'project') return `In ${p.name}: runs as ${name} (${set?.preset ? 'project preset' : 'app default'}).`;
    if (set?.preset && set.limit !== false && mode !== a.approval) return `In ${p.name}: runs as ${name} (project limit).`;
    return `In ${p.name}: ${name}.`;
  }).join(' ');
}

// ---------------------------------------------------------------- the one-time notice in project settings

export const PROJECT_NOTICE = {
  text: 'Projects can now set how agents ask. Yours are set to Per agent, so nothing changed.',
  dismiss: 'Got it',
} as const;

/**
 * Shown once, on the first launch after the upgrade, for an install that already had projects. Never for a fresh install (it answered the first-run
 * screen, or has no project yet), never once dismissed, and not when anything is already set (the owner has seen the page).
 */
export function shouldShowProjectNotice(view: GatesView, projectCount: number): boolean {
  if (projectCount === 0) return false;
  if (view.app.noticeSeen === true || view.app.firstRunChoice === true || view.app.preset !== undefined) return false;
  return !Object.values(view.projects).some((p) => p.preset !== undefined);
}

// ---------------------------------------------------------------- the chips on a run

/** What the run header shows next to the agent: how the run asks, and how much of the web it read. Both hidden when the run has nothing to say. */
export function runChips(task: Pick<Task, 'runsAs' | 'web' | 'origin'> | undefined, agent: Pick<AgentProfile, 'approval' | 'approvalSource'> | undefined, projects: readonly Project[], view: GatesView | null): { runsAs?: { text: string; reason?: string }; web?: string } {
  if (!task) return {};
  const out: { runsAs?: { text: string; reason?: string }; web?: string } = {};
  const ra = task.runsAs;
  if (ra && agent) {
    // the project the run STARTED in, never the one the task sits in now
    const set = ra.projectId ? view?.projects[ra.projectId] : undefined;
    const name = ra.projectId ? projects.find((p) => p.id === ra.projectId)?.name : undefined;
    out.runsAs = runsAsChip({
      effective: ra.mode, agentMode: agent.approval, source: agent.approvalSource === 'project' ? 'project' : 'own',
      ...(name ? { projectName: name } : {}), ...(set?.preset ? { projectPreset: set.preset } : {}),
      limit: set?.preset !== undefined && set.limit !== false,
      ...(task.origin?.approvalCeiling ? { ceiling: task.origin.approvalCeiling } : {}),
    });
  }
  const web = task.web ? webChip(task.web) : undefined;
  if (web) out.web = web;
  return out;
}
