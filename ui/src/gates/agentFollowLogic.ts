// How an agent's approval is chosen and shown (spec 4.2: visible, always). Pure: the agent editor, the project settings and the run header read it.
import { effectiveMode, presetMode } from '../../../src/core/permission-mode.js';
import { NOT_APPLIED_TO_HERMES, isAgentHostModel } from '../../../src/shared/acp-copy.js';
import type { AgentProfile, ApprovalMode, RunMode, Task } from '../../../src/shared/types.js';
import type { Project } from '../../../src/shared/projects.js';
import type { Preset } from '../../../src/shared/gates-registry.js';
import { checkerChipText, checkerFallbackLine } from '../../../src/shared/claude-checks-copy.js';
import { AGENT_MODE_HELP, AGENT_MODE_LABEL, MODE_LABEL, PRESET_LABEL, runsAsChip, webChip, type GatesView } from './presetsLogic.js';

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
  ask: AGENT_MODE_HELP.ask,
  'auto-edits': AGENT_MODE_HELP['auto-edits'],
  full: AGENT_MODE_HELP.full,
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

/**
 * Whether saving this choice may ask the owner in a native window (the core decides for real; this only words the wait). Own modes are ordered
 * Ask < Accept edits < Full; Follow project may raise the mode when the app or a project the agent is in has a preset that is not Ask.
 */
export function mayRaiseMode(existing: Pick<AgentProfile, 'approval' | 'approvalSource' | 'id'> | undefined, choice: ApprovalChoice, projects: readonly Project[], view: GatesView | null): boolean {
  if (existing !== undefined && choiceOf(existing) === choice) return false;
  if (choice === 'ask') return false;
  if (choice !== 'project') return true;
  if (!view) return false;
  const mine = existing ? projects.filter((p) => p.status !== 'archived' && p.members.includes(existing.id)) : [];
  return (view.app.preset !== undefined && view.app.preset !== 'ask') || mine.some((p) => { const x = view.projects[p.id]?.preset; return x !== undefined && x !== 'ask'; });
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
  text: 'Projects can now set how agents ask. Nothing changed: each of your agents keeps the setting it had. You can look at it in Settings, Gates.',
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

const RESULT_WORDS: Record<RunMode, string> = {
  ask: 'asks before every command and file change',
  'auto-edits': 'changes files without asking and asks before commands',
  smart: 'asks only before risky actions',
  'smart-edits': 'asks before risky actions, and file edits inside the project run',
  full: 'never asks',
};

/**
 * The hover of the run chip: the agent's own setting, the project preset (or the app default it follows) and the result, in that order.
 * Built from the same inputs as the chip, so the words and the chip can never disagree.
 */
function explainRun(a: { name?: string; agentMode: ApprovalMode; source: 'own' | 'project'; effective: RunMode; projectName?: string; projectPreset?: Preset; appPreset: Preset; limit: boolean; ceiling?: RunMode }): string {
  const who = a.name ?? 'This agent';
  const parts: string[] = [];
  if (a.source === 'own') {
    parts.push(`${a.name ? `${who}'s` : 'Its'} own setting is ${AGENT_MODE_LABEL[a.agentMode]}.`);
    if (a.projectPreset) parts.push(`Project ${a.projectName ?? 'this project'} is set to ${PRESET_LABEL[a.projectPreset]} and ${a.limit ? 'limits agents to it' : 'does not limit agents'}.`);
  } else {
    const where = a.projectPreset ? `project ${a.projectName ?? 'this project'}, which is set to ${PRESET_LABEL[a.projectPreset]}` : `the app default, which is ${PRESET_LABEL[a.appPreset]}`;
    parts.push(`${who} follows ${where}.`, `Its own setting (${AGENT_MODE_LABEL[a.agentMode]}) is kept for when it stops following.`);
  }
  if (a.ceiling !== undefined && a.ceiling !== a.agentMode) parts.push('An outside app started this run, so it asks.');
  parts.push(`Result: this run ${RESULT_WORDS[a.effective]}.`);
  return parts.join(' ');
}

/** What a run from before the chip existed shows next to the agent: its own setting, in the same words as everywhere else. */
export function legacyModeChip(agent: Pick<AgentProfile, 'approval' | 'approvalSource'>): string {
  return agent.approvalSource === 'project' ? 'Follow project' : AGENT_MODE_LABEL[agent.approval];
}

/** What the agent editor says under the Approvals field about a seeded agent nobody has changed. Nothing for any other agent. */
export const SEED_TAG = 'Comes with Legion';
export function seedWords(agent: Pick<AgentProfile, 'seedApproval'> | undefined): string {
  return agent?.seedApproval === true ? `${SEED_TAG}. You have not changed this agent's setting.` : '';
}

type RunsAs = { text: string; reason?: string; full?: true; title?: string };
/** What the run header shows next to the agent: how the run asks, and how much of the web it read. Both hidden when the run has nothing to say. */
export function runChips(task: Pick<Task, 'runsAs' | 'web' | 'origin' | 'claudeChecker'> & Partial<Pick<Task, 'claudeCheckerModel'>> | undefined, agent: (Pick<AgentProfile, 'approval' | 'approvalSource'> & { name?: string }) | undefined, projects: readonly Project[], view: GatesView | null): { runsAs?: RunsAs; web?: string; checker?: { text: string; title: string } } {
  if (!task) return {};
  const out: { runsAs?: RunsAs; web?: string; checker?: { text: string; title: string } } = {};
  const ra = task.runsAs;
  if (ra && agent) {
    // the project the run STARTED in, never the one the task sits in now
    const set = ra.projectId ? view?.projects[ra.projectId] : undefined;
    const name = ra.projectId ? projects.find((p) => p.id === ra.projectId)?.name : undefined;
    const source = agent.approvalSource === 'project' ? 'project' : 'own';
    const limit = set?.preset !== undefined && set.limit !== false;
    const ceiling = task.origin?.approvalCeiling;
    out.runsAs = runsAsChip({
      effective: ra.mode, agentMode: agent.approval, source,
      ...(name ? { projectName: name } : {}), ...(set?.preset ? { projectPreset: set.preset } : {}),
      limit,
      ...(ceiling ? { ceiling } : {}),
    });
    out.runsAs.title = explainRun({
      ...(agent.name ? { name: agent.name } : {}), agentMode: agent.approval, source, effective: ra.mode,
      ...(name ? { projectName: name } : {}), ...(set?.preset ? { projectPreset: set.preset } : {}),
      appPreset: view?.app.preset ?? 'ask', limit,
      ...(ceiling ? { ceiling } : {}),
    });
    // A run that asks for nothing keeps the amber warning the old approval pill had.
    if (ra.mode === 'full') out.runsAs.full = true;
  }
  // A Smart run that could not use Claude's checker: Claude asks as in Ask. One chip says both ("Smart: Claude asks as in Ask (no checker for <model>)"), with the whole
  // line on hover and for screen readers. A run with no "Runs as" chip keeps a chip of its own.
  if (task.claudeChecker === 'fallback') {
    const line = checkerFallbackLine([{ ...(agent?.name ? { agent: agent.name } : {}), ...(task.claudeCheckerModel ? { model: task.claudeCheckerModel } : {}) }]);
    const text = checkerChipText(task.claudeCheckerModel);
    if (out.runsAs) { out.runsAs.text = text; out.runsAs.title = `${out.runsAs.title ?? ''} ${line}`.trim(); out.runsAs.reason ??= line; }
    else out.checker = { text, title: line };
  }
  const web = task.web ? webChip(task.web) : undefined;
  if (web) out.web = web;
  return out;
}

// ---------------------------------------------------------------- who a project limits

const looseness = (m: ApprovalMode): number => (m === 'full' ? 0 : m === 'auto-edits' ? 1 : 2);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
function nameList(items: readonly string[], shown = 4): string {
  if (items.length <= 1) return items.join('');
  if (items.length <= shown) return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${items.slice(0, shown).join(', ')} and ${items.length - shown} more`;
}

/**
 * The live lines under a project's "Limit agents to this" switch, built from the real roster and the real engine rule: who the limit holds back
 * (`on`), and what the project would let run looser if it were off (`off`). Nothing for a project with no preset. The page shows `on` while the
 * limit is on and `off` while it is off.
 */
export function limitWords(agents: readonly AgentProfile[], project: Pick<Project, 'id' | 'name' | 'members'>, view: GatesView, hermes: { modeMap: boolean } = { modeMap: true }): { on?: string; off?: string } {
  const set = view.projects[project.id];
  if (!set?.preset) return {};
  const members = agents.filter((a) => project.members.includes(a.id));
  // Hermes sets its own mode unless the owner turned on Match Legion's mode: a project limit does not reach it, and the row says so
  const apart = hermes.modeMap ? [] : members.filter((a) => isAgentHostModel(a.model));
  const inProject = members.filter((a) => !apart.includes(a));
  if (inProject.length === 0 && apart.length > 0) return { on: apart.map((a) => `${a.name}: ${NOT_APPLIED_TO_HERMES}.`).join(' ') };
  if (inProject.length === 0) return { on: 'This project has no agents yet.' };
  const followers = inProject.filter((a) => a.approvalSource === 'project');
  const own = inProject.filter((a) => a.approvalSource !== 'project');
  const result = (a: AgentProfile): RunMode => effectiveMode({ agentMode: a.approval, source: 'own', appPreset: view.app.preset ?? 'ask', project: { preset: set.preset!, limit: true } });
  const limited = own.filter((a) => result(a) !== a.approval).sort((a, b) => looseness(a.approval) - looseness(b.approval));
  const rest = own.length - limited.length;
  const tail: string[] = [];
  if (rest > 0) tail.push(set.preset === 'ask' ? `${plural(rest, 'agent already asks', 'agents already ask')}.` : `${plural(rest, 'agent is', 'agents are')} not limited by it.`);
  if (followers.length > 0) tail.push(`${plural(followers.length, 'agent follows', 'agents follow')} the preset.`);
  const tag = (a: AgentProfile): string => `${a.name} (${AGENT_MODE_LABEL[a.approval]})`;
  let head: string;
  if (limited.length === 0) head = 'This limits no agent here.';
  else {
    const groups = new Map<RunMode, AgentProfile[]>();
    for (const a of limited) groups.set(result(a), [...(groups.get(result(a)) ?? []), a]);
    const clause = (m: RunMode, l: AgentProfile[]): string => `${nameList(l.map(tag))} ${l.length === 1 ? 'runs' : 'run'} as ${MODE_LABEL[m]}`;
    const n = limited.length;
    head = groups.size === 1
      ? `This limits ${plural(n, 'agent', 'agents')} here: ${[...groups].map(([m, l]) => clause(m, l)).join('')} in ${project.name}.`
      : `This limits ${plural(n, 'agent', 'agents')} here: in ${project.name}, ${[...groups].map(([m, l]) => clause(m, l)).join('; ')}.`;
  }
  for (const a of apart) tail.push(`${a.name}: ${NOT_APPLIED_TO_HERMES}.`);
  const out: { on?: string; off?: string } = { on: [head, ...tail].join(' ') };
  if (limited.length > 0) {
    const runs = limited.map((a) => `${a.name} runs as ${AGENT_MODE_LABEL[a.approval]}`);
    const fulls = limited.filter((a) => a.approval === 'full').map((a) => a.name);
    const solo = limited.length === 1 && fulls.length === 1;
    const list = runs.length <= 1 ? runs.join('') : `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
    out.off = `With the limit off, ${list} in ${project.name}${solo ? ' and never asks' : ''}.${fulls.length > 0 && !solo ? ` ${nameList(fulls)} ${fulls.length === 1 ? 'never asks' : 'never ask'}.` : ''}`;
  }
  return out;
}
