import type { DoctorCheck } from '../../src/shared/types.js';

export type CheckKind = 'ok' | 'bad' | 'warn' | 'neutral' | 'opt';

/**
 * How the Doctor draws a row. `level` is the core's word for a row that passed but wants a look (warn, amber, shows its fix) or has nothing to say
 * (neutral, quiet, not counted as needing attention). A row with no level is plain pass or fail. `optional` is the boat.dev row nobody has set up.
 */
export function checkKind(c: Pick<DoctorCheck, 'ok' | 'level'>, optional: boolean): CheckKind {
  if (optional) return 'opt';
  if (!c.ok) return 'bad';
  return c.level === 'warn' ? 'warn' : c.level === 'neutral' ? 'neutral' : 'ok';
}

const isAgentRow = (c: Pick<DoctorCheck, 'id'>): boolean => c.id.startsWith('acp-');

/**
 * A refresh that did not start Hermes (after a save, at boot) must not turn the rows an earlier probe filled into "not checked yet" while the
 * window shows them: the agent rows of `prev` stay, the rest are fresh. Only used while the Doctor window is open.
 */
export function keepProbedAgentRows(next: DoctorCheck[], prev: DoctorCheck[] | null): DoctorCheck[] {
  const keep = (prev ?? []).filter(isAgentRow);
  // a fresh pass with no agent rows at all means Hermes was switched off (R75): the old rows go too
  if (keep.length === 0 || !next.some(isAgentRow)) return next;
  const out: DoctorCheck[] = [];
  let placed = false;
  for (const c of next) {
    if (!isAgentRow(c)) { out.push(c); continue; }
    if (!placed) { out.push(...keep); placed = true; }
  }
  return out;
}
