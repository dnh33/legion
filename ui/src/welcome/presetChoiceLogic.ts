// The first-run screen "How should your agents ask?": when it shows and what Continue sends. Pure; the words live here so a test can read them.
import type { Preset } from '../../../src/shared/gates-registry.js';
import type { AgentProfile } from '../../../src/shared/types.js';
import { presetMode, stricterMode } from '../../../src/core/permission-mode.js';
import { presetChoices, type GatesView } from '../gates/presetsLogic.js';
import type { GatesChangeRequest } from '../gates/gatesAction.js';

export const PRESET_STRINGS = {
  title: 'How should agents ask by default?',
  lead: 'This is the app default. It is only for agents that follow it. Your agents keep their own settings unless you tick the box below.',
  continue: 'Continue',
  later: 'Decide later',
  laterNote: 'Decide later changes nothing.',
  note: 'You can change this any time in Settings, Gates.',
  followLabel: 'Also make my agents follow this',
  followNote: 'Each agent can still be set back to its own setting in the agent editor.',
  keepHead: 'Your agents keep their own settings:',
  confirmNote: 'This default is looser than Ask, so Continue asks you to confirm in a separate window.',
} as const;

type RosterAgent = Pick<AgentProfile, 'id' | 'name' | 'approval' | 'approvalSource'> & { seedApproval?: true };
const follows = (a: RosterAgent): boolean => a.approvalSource === 'project';
const labelOf = (p: Preset): string => presetChoices().find((c) => c.id === p)?.label ?? p;

/**
 * A fresh install: the agents are the ones Legion seeded and nobody has changed. The core marks those (`seedApproval`); an install from before the
 * mark has no marks, a custom agent has none, and a list that has not arrived yet is empty, so all three read as NOT fresh and the screen stays away.
 */
export function isFreshInstall(agents: readonly RosterAgent[]): boolean { return agents.length > 0 && agents.every((a) => a.seedApproval === true); }

/**
 * True for an install that has never answered and has nothing set: no first-run answer, no app preset, no project preset, and only seeded agents
 * nobody changed. An existing install never sees it (its agents and projects already behave as they do, and a forced screen would imply a change).
 * It waits for the sign-in step of the welcome, so a new user is never blocked from signing in to Claude.
 */
export function shouldShowPresetChoice(view: GatesView, welcomeDone: boolean, agents: readonly RosterAgent[]): boolean {
  if (!welcomeDone) return false;
  if (view.app.firstRunChoice === true || view.app.preset !== undefined) return false;
  if (Object.values(view.projects).some((p) => p.preset !== undefined)) return false;
  return isFreshInstall(agents);
}

/** "Builder", "Builder and Scribe", "A, B and C", then (four or more) the first `shown` names and a count. */
function names(list: readonly string[], shown = 1): string {
  if (list.length <= 2) return list.join(' and ');
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
  return `${list.slice(0, shown).join(', ')} and ${list.length - shown} others`;
}

/** The live list: each agent's own setting, grouped in plain words, built from the roster that is really there. */
export function ownSettingLines(agents: readonly RosterAgent[]): string[] {
  const group = (f: (a: RosterAgent) => boolean): string[] => agents.filter((a) => !follows(a) && f(a)).map((a) => a.name);
  const full = group((a) => a.approval === 'full');
  const edits = group((a) => a.approval === 'auto-edits');
  const ask = group((a) => a.approval === 'ask');
  const follow = agents.filter(follows).map((a) => a.name);
  const out: string[] = [];
  if (full.length) out.push(`${names(full)} ${full.length === 1 ? 'never asks' : 'never ask'} (Full)`);
  if (edits.length) out.push(`${names(edits)} ${edits.length === 1 ? 'accepts edits by itself' : 'accept edits by themselves'}`);
  if (ask.length) out.push(`${names(ask)} ${ask.length === 1 ? 'asks' : 'ask'} first`);
  if (follow.length) out.push(`${names(follow)} ${follow.length === 1 ? 'follows' : 'follow'} the app default`);
  return out;
}

/** What ticking the box would do for this preset: the changes to send, and who would ask less or more than now. */
export function followPlan(agents: readonly RosterAgent[], preset: Preset): { changes: Array<{ agentId: string; approvalSource: 'project' }>; looser: string[]; tighter: string[] } {
  const to = presetMode(preset);
  const changes: Array<{ agentId: string; approvalSource: 'project' }> = [];
  const looser: string[] = []; const tighter: string[] = [];
  for (const a of agents) {
    if (follows(a)) continue;
    changes.push({ agentId: a.id, approvalSource: 'project' });
    if (to === a.approval) continue;
    // the same rule the core uses: a change is looser unless the new mode is at least as strict as the old one
    (stricterMode(to, a.approval) === to ? tighter : looser).push(a.name);
  }
  return { changes, looser, tighter };
}

/** The words under the presets. Unticked: the agents keep their own settings. Ticked: they all follow, and who asks less or more is named. */
export function listWords(agents: readonly RosterAgent[], preset: Preset, follow: boolean): { head: string; lines: string[]; warn?: string; info?: string } {
  if (!follow) {
    const note = preset === 'ask' ? undefined : PRESET_STRINGS.confirmNote;
    return { head: PRESET_STRINGS.keepHead, lines: ownSettingLines(agents), ...(note ? { warn: note } : {}) };
  }
  const plan = followPlan(agents, preset);
  const head = `All ${agents.length} agents will follow ${labelOf(preset)}.`;
  const warn = plan.looser.length ? `This makes ${names(plan.looser, 3)} ask less than now. Continue asks you to confirm in a separate window.` : undefined;
  const info = plan.tighter.length ? `${names(plan.tighter, 3)} will ask more often than now.` : undefined;
  return { head, lines: [], ...(warn ? { warn } : {}), ...(info ? { info } : {}) };
}

/** What Decide later sends: only the flag that the question was seen. No preset, so nothing gets looser and no dialog opens. */
export function skipSubmit(): { patch: { firstRunChoice: true } } { return { patch: { firstRunChoice: true } }; }

/** What Continue sends for the chosen preset. Only a looser one raises the native confirm (the core decides; this says so the screen can word the wait). */
export function presetSubmit(id: Preset): { patch: { preset: Preset; firstRunChoice: true }; needsConfirm: boolean } {
  return { patch: { preset: id, firstRunChoice: true }, needsConfirm: id !== 'ask' };
}

type Run = (change: GatesChangeRequest, done: string) => Promise<boolean>;
export interface BatchResult { ok: boolean; error?: string; cancelled?: boolean; applied: string[]; failed?: Array<{ agentId: string; error: string }> }
/** The window's bridge for many agent changes in one confirm. undefined = no bridge (a plain browser). */
export type Batch = ((b: { changes: Array<{ agentId: string; approvalSource: 'project' }> }) => Promise<BatchResult>) | undefined;
export interface Outcome { done: boolean; selected: Preset; /** What the owner reads after the screen is gone: only what changed. */ saved?: { tone: 'ok' | 'info' | 'error'; text: string } }

/** The line the owner reads once the screen has closed. It says only what changed, and what did not. */
export function savedWords(preset: Preset, follow: boolean, total: number, r: BatchResult | 'none' | 'unchanged'): { tone: 'ok' | 'info' | 'error'; text: string } {
  const head = `Saved. The app default is ${labelOf(preset)}.`;
  if (!follow) return { tone: 'ok', text: `${head} Your agents keep their own settings.` };
  if (r === 'unchanged') return { tone: 'ok', text: `${head} All ${total} agents already follow it.` };
  if (r === 'none') return { tone: 'error', text: `${head} The agents were not changed: changing agents needs the Legion app window.` };
  if (r.ok) return { tone: 'ok', text: `${head} All ${total} agents follow it.` };
  if (r.cancelled) return { tone: 'info', text: `${head} No agent was changed, because you cancelled that question. Each agent can be set in its editor.` };
  if (r.applied.length === 0) return { tone: 'error', text: `${head} No agent was changed: ${r.error ?? 'the change was not made.'}` };
  const first = r.failed?.[0];
  return { tone: 'error', text: `${head} ${r.applied.length} of ${total} agents follow it now. ${r.failed?.length ?? 0} did not change${first ? `: ${first.error}` : '.'}` };
}

/**
 * Continue. First the app default is saved through the Gates path (its own native confirm for a looser one). Only then, when the box is ticked,
 * each agent's change goes through the agent-mode bridge, with ONE native confirm naming every agent made looser; they are checked against the
 * default that now stands. A cancelled or refused default stops here and the screen stays with Ask selected. A cancelled agent question leaves the
 * saved default as it is, and the words say so.
 */
export async function continueFrom(selected: Preset, follow: boolean, agents: readonly RosterAgent[], run: Run, batch: Batch): Promise<Outcome> {
  const ok = await run({ kind: 'app', patch: presetSubmit(selected).patch }, `Saved. The app default is ${labelOf(selected)}.`);
  if (!ok) return { done: false, selected: 'ask' };
  if (!follow) return { done: true, selected, saved: savedWords(selected, false, agents.length, 'unchanged') };
  const plan = followPlan(agents, selected);
  if (plan.changes.length === 0) return { done: true, selected, saved: savedWords(selected, true, agents.length, 'unchanged') };
  if (!batch) return { done: true, selected, saved: savedWords(selected, true, agents.length, 'none') };
  let r: BatchResult;
  try { r = await batch({ changes: plan.changes }); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), applied: [] }; }
  return { done: true, selected, saved: savedWords(selected, true, agents.length, r) };
}
/** Decide later: the question is remembered as seen, then the screen goes. A write that fails still lets this launch go on. */
export async function laterFrom(run: Run): Promise<void> { await run({ kind: 'app', patch: skipSubmit().patch }, ''); }
