/** The slice of GET /api/update/status the journey list reads. Mirrors src/core/updater/journey.ts JourneyView; the list is pure so test/update-journey-ui.test.ts runs it as it is. */
export interface JourneyStepRow { id: string; n: string; label: string; state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; at?: string; startedAt?: string }
export interface JourneyViewLike { id: string; from: string; to: string; kind?: 'code' | 'full'; steps: JourneyStepRow[]; result: 'running' | 'ok' | 'failed' | 'rolled-back'; reason?: string; startedAt: string; endedAt?: string }

const two = (n: number): string => String(n).padStart(2, '0');
/** HH:MM:SS in the person's own time, or '' for a time that is not a time. */
export function clock(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** One row per step the update really has (a code update has no Preparing), each with its state and the time it finished or failed. */
export function journeyRows(v: JourneyViewLike): Array<{ id: string; label: string; state: JourneyStepRow['state']; when: string }> {
  return v.steps.filter((s) => s.state !== 'skipped').map((s) => ({ id: s.id, label: s.label, state: s.state, when: s.state === 'pending' ? '' : clock(s.at ?? s.startedAt) }));
}

/** The one line above the list: what the journey ended in. */
export function journeySummary(v: JourneyViewLike): string {
  const route = v.kind === 'full' ? 'full update' : 'update';
  if (v.result === 'ok') return `Updated from ${v.from} to ${v.to} (${route}).`;
  if (v.result === 'failed') return `The update from ${v.from} to ${v.to} did not finish.`;
  if (v.result === 'rolled-back') return `The update to ${v.to} did not start correctly, so Legion went back to ${v.from}.`;
  return `Updating from ${v.from} to ${v.to}.`;
}
