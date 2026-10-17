// The first-run screen "How should your agents ask?": when it shows and what Continue sends. Pure; the words live here so a test can read them.
import type { Preset } from '../../../src/shared/gates-registry.js';
import type { GatesView } from '../gates/presetsLogic.js';
import type { GatesChangeRequest } from '../gates/gatesAction.js';

export const PRESET_STRINGS = {
  title: 'How should your agents ask?',
  lead: 'Agents ask before they run commands or change files. Pick how much you want to be asked. Ask is the safest, and you can change it later.',
  continue: 'Continue',
  later: 'Decide later',
  laterNote: 'Deciding later keeps things as they are: agents ask as their own settings say.',
  note: 'You can change this any time in Settings, Gates.',
  saved: 'Saved. Agents will ask the way you chose.',
} as const;

/**
 * True for an install that has never answered and has nothing set: no first-run answer, no app preset, no project preset. An existing install
 * never sees it: its projects and agents already behave as Ask or Per agent, and a forced screen would imply a change. It waits for the
 * sign-in step of the welcome, so a new user is never blocked from signing in to Claude.
 */
export function shouldShowPresetChoice(view: GatesView, welcomeDone: boolean): boolean {
  if (!welcomeDone) return false;
  if (view.app.firstRunChoice === true || view.app.preset !== undefined) return false;
  return !Object.values(view.projects).some((p) => p.preset !== undefined);
}

/** What Decide later sends: only the flag that the question was seen. No preset, so nothing gets looser and no dialog opens. */
export function skipSubmit(): { patch: { firstRunChoice: true } } { return { patch: { firstRunChoice: true } }; }

/** What Continue sends for the chosen preset. Only a looser one raises the native confirm (the core decides; this says so the screen can word the wait). */
export function presetSubmit(id: Preset): { patch: { preset: Preset; firstRunChoice: true }; needsConfirm: boolean } {
  return { patch: { preset: id, firstRunChoice: true }, needsConfirm: id !== 'ask' };
}

type Run = (change: GatesChangeRequest, done: string) => Promise<boolean>;
/** Continue: the chosen preset is saved, or (cancelled, refused) the screen stays with Ask selected. */
export async function continueFrom(selected: Preset, run: Run): Promise<{ done: boolean; selected: Preset }> {
  const ok = await run({ kind: 'app', patch: presetSubmit(selected).patch }, PRESET_STRINGS.saved);
  return ok ? { done: true, selected } : { done: false, selected: 'ask' };
}
/** Decide later: the question is remembered as seen, then the screen goes. A write that fails still lets this launch go on. */
export async function laterFrom(run: Run): Promise<void> { await run({ kind: 'app', patch: skipSubmit().patch }, ''); }
