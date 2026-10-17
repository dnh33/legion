// The first-run screen "How should your agents ask?": when it shows and what Continue sends. Pure; the words live here so a test can read them.
import type { Preset } from '../../../src/shared/gates-registry.js';
import type { GatesView } from '../gates/presetsLogic.js';

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

/** What Continue sends for the chosen preset. Only a looser one raises the native confirm (the core decides; this says so the screen can word the wait). */
export function presetSubmit(id: Preset): { patch: { preset: Preset; firstRunChoice: true }; needsConfirm: boolean } {
  return { patch: { preset: id, firstRunChoice: true }, needsConfirm: id !== 'ask' };
}
