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
  return `${list.slice(0, shown).join(', ')} and ${list.length - shown} ${list.length - shown === 1 ? 'other' : 'others'}`;
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
export interface BatchResult { ok: boolean; error?: string; cancelled?: boolean; presetSaved?: boolean; applied: string[]; failed?: Array<{ agentId: string; error: string }> }
/** The window's bridge for the default and many agent changes in ONE confirm. undefined = no bridge (a plain browser). */
export type Batch = ((b: { preset: Preset; changes: Array<{ agentId: string; approvalSource: 'project' }> }) => Promise<BatchResult>) | undefined;
type Words = { tone: 'ok' | 'info' | 'error'; text: string };
/** `saved`: what the owner reads after the screen is gone (only what changed). `note`: what the screen shows while it stays (a cancel, a refusal). */
export interface Outcome { done: boolean; selected: Preset; saved?: Words; note?: Words }

/** The line the owner reads once the screen has closed. It says only what changed, and what did not. */
export function savedWords(preset: Preset, follow: boolean, total: number, r: BatchResult | 'unchanged'): Words {
  const head = `Saved. The app default is ${labelOf(preset)}.`;
  if (!follow) return { tone: 'ok', text: `${head} Your agents keep their own settings.` };
  if (r === 'unchanged') return { tone: 'ok', text: `${head} All ${total} agents already follow it.` };
  if (r.ok) return { tone: 'ok', text: `${head} All ${total} agents follow it.` };
  if (r.applied.length === 0) return { tone: 'error', text: `${head} No agent was changed: ${r.error ?? 'the change was not made.'}` };
  const first = r.failed?.[0];
  return { tone: 'error', text: `${head} ${r.applied.length} of ${total} agents follow it now. ${r.failed?.length ?? 0} did not change${first ? `: ${first.error}` : '.'}` };
}

/**
 * Continue. Unticked: the app default is saved through the Gates path (its own native confirm for a looser one). Ticked: the default and every agent's
 * change go to the app in ONE request and ONE native confirm; a cancel saves nothing and the screen stays with Ask selected. Once the default is saved
 * the screen closes and says exactly what was applied, even when an agent could not be changed.
 */
export async function continueFrom(selected: Preset, follow: boolean, agents: readonly RosterAgent[], run: Run, batch: Batch): Promise<Outcome> {
  const plan = followPlan(agents, selected);
  if (!follow || plan.changes.length === 0) {
    const ok = await run({ kind: 'app', patch: presetSubmit(selected).patch }, `Saved. The app default is ${labelOf(selected)}.`);
    if (!ok) return { done: false, selected: 'ask' };
    return { done: true, selected, saved: savedWords(selected, follow, agents.length, 'unchanged') };
  }
  if (!batch) return { done: false, selected: 'ask', note: { tone: 'error', text: 'Changing agents needs the Legion app window, which shows a confirmation. Open the app to do this.' } };
  let r: BatchResult;
  try { r = await batch({ preset: selected, changes: plan.changes }); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), applied: [] }; }
  if (r.cancelled) return { done: false, selected: 'ask', note: { tone: 'info', text: 'Cancelled. Nothing changed.' } };
  if (r.presetSaved !== true && !r.ok) return { done: false, selected: 'ask', note: { tone: 'error', text: r.error ?? 'The change was not made.' } };
  return { done: true, selected, saved: savedWords(selected, true, agents.length, r) };
}
/** Decide later: the question is remembered as seen, then the screen goes. A write that fails still lets this launch go on. */
export async function laterFrom(run: Run): Promise<void> { await run({ kind: 'app', patch: skipSubmit().patch }, ''); }
