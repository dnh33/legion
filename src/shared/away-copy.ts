/**
 * Every plain-language string the away features show, keyed (so a pack can replace them later) and in one place.
 * Rules: no em or en dashes, say "your computer", never name outside products. A test (test/away-copy.test.ts) holds the rules.
 */

export const AWAY_COPY = {
  chip: {
    leaves: 'Leaves your computer, cannot be undone',
    deletes: 'Deletes files, cannot be undone',
    readOnly: 'Read only, inside this project',
    readOnlyNoProject: 'Read only',
    readsOutside: 'Reads outside this project',
    readsUnchecked: 'Reads files, location not checked',
    edits: 'Changes files in this project',
    editsNoProject: 'Changes a file',
    editsOutside: 'Changes a file outside this project, check it',
    writesFile: 'Writes a file',
    fetches: 'Fetches from the web',
    localRun: 'Runs a check on your computer',
    decides: 'A choice, nothing happens until you answer',
    proposal: 'Written after outside content',
    unknown: 'Unknown effect, check it',
  },
  queue: {
    slot: (running: number, cap: number): string => `Waiting for a free slot (${running} of ${cap} running in all projects)`,
    budget: 'Waiting for the budget',
    paused: 'Waiting: new starts are paused',
    after: (agentName: string): string => `Queued after ${agentName}'s current run`,
    group: 'Waiting for a slot',
  },
  wait: {
    deny: (min: number): string => `Auto-denies after ${min} min`,
    park: (min: number): string => `Parks after ${min} min`,
    quiet: (until: string): string => `Waiting: quiet hours until ${until}`,
    deniedAfter: (min: number): string => `Denied after ${min} min`,
    holdRace: (min: number): string => `This approval was already denied after ${min} min.`,
  },
} as const;

export type QueueReasonKey = 'slot' | 'budget' | 'paused' | 'after';

/** The sentence for a queue reason. `agentName` is used by "after"; `running` and `cap` by "slot". */
export function queueReasonText(reason: QueueReasonKey, ctx: { running?: number; cap?: number; agentName?: string } = {}): string {
  switch (reason) {
    case 'slot': return AWAY_COPY.queue.slot(ctx.running ?? 0, ctx.cap ?? 0);
    case 'budget': return AWAY_COPY.queue.budget;
    case 'paused': return AWAY_COPY.queue.paused;
    case 'after': return AWAY_COPY.queue.after(ctx.agentName ?? 'the agent');
  }
}
