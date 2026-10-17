/**
 * The project Settings tab, pure. What the inputs accept, which sections differ from the default, what the "While you are away" form
 * may offer, and the one gate rule behind "Let agents read files in this project without asking". Spec 3.6, 4.8.
 */
import type { CoreCaps, GateRule } from '../../../../src/shared/types.js';
import { newGateId } from '../../gates/gatesLogic.js';

/** The part of a project's away settings the page reads (the same shape as the core's, without importing the api module). */
export interface AwayProject { onSilence: { mode: 'deny' | 'park'; parkMinutes: number }; paused: boolean; budget: { limit: number; period: 'day' | 'week' | 'month' } | null; notify: 'problems' | 'everything' | 'nothing' }
export const PARK_ERROR = 'Enter a whole number from 1 to 120.';
export const BUDGET_ERROR = 'Enter an amount above $0.00.';
export type Parsed = { ok: true; value: number } | { ok: false; error: string };

/** Minutes before a run parks: a whole number, 1 to 120. */
export function parseParkMinutes(raw: string): Parsed {
  const s = raw.trim();
  if (!/^\d{1,3}$/.test(s)) return { ok: false, error: PARK_ERROR };
  const n = Number(s);
  return n >= 1 && n <= 120 ? { ok: true, value: n } : { ok: false, error: PARK_ERROR };
}

/** A budget in dollars: positive, finite, rounded to cents, below a million. */
export function parseBudget(raw: string): Parsed {
  const s = raw.trim().replace(/^\$/, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: BUDGET_ERROR };
  const n = Math.round(Number(s) * 100) / 100;
  return n > 0 && n <= 1_000_000 ? { ok: true, value: n } : { ok: false, error: BUDGET_ERROR };
}

export type Period = 'day' | 'week' | 'month';
export const budgetPatch = (on: boolean, limit: number, period: Period): { budget: { limit: number; period: Period } | null } => ({ budget: on ? { limit, period } : null });

export type SectionKey = 'away' | 'budget' | 'notify';
/** Sections whose stored value differs from the default: they get a dot in the nav. Park minutes only count while parking. */
export function changedSections(a: AwayProject): Set<SectionKey> {
  const out = new Set<SectionKey>();
  if (a.paused || a.onSilence.mode !== 'deny') out.add('away');
  if (a.budget) out.add('budget');
  if (a.notify !== 'problems') out.add('notify');
  return out;
}

export const SETTINGS_NAV: ReadonlyArray<{ id: string; label: string; changed?: SectionKey }> = [
  { id: 'general', label: 'General' },
  { id: 'folders', label: 'Folders' },
  { id: 'members', label: 'Members' },
  { id: 'ask', label: 'How agents ask' },
  { id: 'away', label: 'While you are away', changed: 'away' },
  { id: 'safety', label: 'Safety' },
  { id: 'budget', label: 'Budget', changed: 'budget' },
  { id: 'notify', label: 'Notifications', changed: 'notify' },
  { id: 'archive', label: 'Archive' },
];

/** What the "When nobody answers" group offers. Park only when the core can park; a stored "park" on a core that cannot shows the truth (wait, then deny). */
export function awayFormModel(caps: CoreCaps, stored: 'deny' | 'park' = 'deny'): { silenceModes: Array<'deny' | 'park'>; shownMode: 'deny' | 'park'; keepAwake: boolean } {
  const canPark = caps.park === true;
  return { silenceModes: canPark ? ['deny', 'park'] : ['deny'], shownMode: canPark ? stored : 'deny', keepAwake: caps.keepAwake === true };
}

/* ---------- the reads grant (spec 4.8) ---------- */
/** `C:\Users\Dan\My Shop\` -> `C:/Users/Dan/My Shop/**`: the gate matches forward slashes. */
export const folderGlob = (folder: string): string => `${folder.replace(/\\/g, '/').replace(/\/+$/, '')}/**`;

const GRANT_LABEL = 'Agents may read files in this project without asking';

/** One allow rule for reads inside this project's folder. Writes, commands and other projects still ask. */
export function readsGrantRule(project: { id: string; folder: string }, id: string = newGateId()): GateRule {
  return { id, enabled: true, then: 'allow', source: 'card', label: GRANT_LABEL, when: { projects: [project.id], tools: ['reads'], paths: [folderGlob(project.folder)] } };
}

/** The exact shape `readsGrantRule` writes for this project, in any folder. A rule typed by hand, or one with extra conditions, is never taken for it. */
function isGrantShape(r: GateRule, projectId: string): string | undefined {
  const w = r.when;
  const ok = r.then === 'allow' && r.source === 'card' && r.label === GRANT_LABEL && w.projects?.length === 1 && w.projects[0] === projectId
    && w.tools?.length === 1 && w.tools[0] === 'reads' && w.paths?.length === 1
    && !w.agents?.length && !w.commands?.length && !w.exceptPaths?.length && !w.contexts?.length;
  return ok ? w.paths![0] : undefined;
}

/** This project's grant, if it is switched on: the same shape as `readsGrantRule`, so a rule typed by hand is never taken for it. */
export function findReadsGrant(rules: readonly GateRule[], project: { id: string; folder: string }): GateRule | undefined {
  const want = folderGlob(project.folder);
  return rules.find((r) => r.enabled && isGrantShape(r, project.id) === want);
}

/** Grants this project once gave for a folder it no longer has. Removed after a folder change (the grant never moves to the new folder). */
export function staleReadsGrants(rules: readonly GateRule[], project: { id: string; folder: string }): GateRule[] {
  const want = folderGlob(project.folder);
  return rules.filter((r) => { const p = isGrantShape(r, project.id); return p !== undefined && p !== want; });
}
