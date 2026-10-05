/** The word at the start of the working row: what the run is doing at the highest level. Pure, so the core suite can check it. */
export function workingLabel(o: { queued: boolean; waiting: boolean; thinking?: boolean }): string {
  return o.queued ? 'Queued' : o.waiting ? 'Waiting for your OK' : o.thinking ? 'Thinking' : 'Working';
}
