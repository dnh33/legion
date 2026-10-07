/** Wording for a run that is held open by Claude Code background agents. Pure, so the core suite can check it. */
export const backgroundLabel = (n: number): string => `waiting on ${n} background agent${n === 1 ? '' : 's'}`;

/** Asked before anything that cancels the run (Stop, Ctrl+Enter, "send now"): cancelling ends the background agents with it. */
export const stopWarning = (n: number): string =>
  `${n} background agent${n === 1 ? ' is' : 's are'} still working in this run. Stopping the run ends ${n === 1 ? 'it' : 'them'} too, and any unfinished work is lost. Stop anyway?`;
