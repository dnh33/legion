/** Wording for a run that is held open by Claude Code background agents. Pure, so the core suite can check it. */
export const backgroundLabel = (n: number, stopsAt?: string): string => {
  const base = `waiting on ${n} background agent${n === 1 ? '' : 's'}`;
  const t = stopsAt ? new Date(stopsAt) : undefined;
  if (!t || Number.isNaN(t.getTime())) return base;
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
  return `${base} · stops at ${hh}:${mm}`;
};

/** Asked before anything that cancels the run (Stop, Ctrl+Enter, "send now"): cancelling ends the background agents with it. */
export const stopWarning = (n: number): string =>
  `${n} background agent${n === 1 ? ' is' : 's are'} still working in this run. Stopping the run ends ${n === 1 ? 'it' : 'them'} too, and any unfinished work is lost. Stop anyway?`;

/** Whether the owner agrees to stop. Fails CLOSED: if the question cannot be asked (it throws or rejects), nothing is cancelled. */
export async function askToStop(n: number, ask: (message: string) => boolean | Promise<boolean>): Promise<boolean> {
  if (n <= 0) return true;
  try { return (await ask(stopWarning(n))) === true; } catch { return false; }
}
