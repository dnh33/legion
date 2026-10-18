/**
 * The agent editor's Skill finder control. The form holds a mode and a count; this turns saved fields into the form and the form
 * into the body of the save. Pure, so the editor and the tests share one rule.
 */
export type FinderMode = 'inherit' | 'on' | 'off';
export interface FinderForm { mode: FinderMode; /** Skills per suggestion (1 to 5), or null to follow the Armory. */ k: number | null }

export const FINDER_MODES: ReadonlyArray<{ value: FinderMode; label: string }> = [
  { value: 'inherit', label: 'Same as the Armory' },
  { value: 'on', label: 'Suggest each turn' },
  { value: 'off', label: 'Off: no search, no suggestions' },
];

export function finderFormOf(a: { skillFinder?: FinderMode | undefined; skillFinderK?: number | undefined }): FinderForm {
  return { mode: a.skillFinder ?? 'inherit', k: typeof a.skillFinderK === 'number' ? a.skillFinderK : null };
}

/** Choosing "Same as the Armory" also clears the count, so the agent follows the Armory in full. */
export function pickFinderMode(form: FinderForm, mode: FinderMode): FinderForm {
  return { mode, k: mode === 'inherit' ? null : form.k };
}

/** The fields of the save. Off sends no count: the count only matters when the finder is on, and a saved one is kept. */
export function finderBody(form: FinderForm): { skillFinder: FinderMode; skillFinderK?: number | null } {
  return form.mode === 'off' ? { skillFinder: 'off' } : { skillFinder: form.mode, skillFinderK: form.k };
}

/**
 * The fields of the save that the owner really changed. A key goes in only when its value differs from the form's first value, so saving
 * an agent for another reason does not store `skillFinder: 'inherit'` on an agent that never had a choice.
 */
export function finderChanges(start: FinderForm, now: FinderForm): { skillFinder?: FinderMode; skillFinderK?: number | null } {
  const body = finderBody(now);
  const out: { skillFinder?: FinderMode; skillFinderK?: number | null } = {};
  if (now.mode !== start.mode) out.skillFinder = body.skillFinder;
  if (now.k !== start.k && body.skillFinderK !== undefined) out.skillFinderK = body.skillFinderK;
  return out;
}
