import { useEffect, useState } from 'react';
import { elapsedLabel } from '../chat/elapsed';
import { contextLabel } from '../../../src/shared/context-meter';
import { workingLabel } from '../chat/working';
import { backgroundLabel } from '../chat/background';
import { useStore } from '../store';
import { bridgeVerb, pendingAskAgents, workingToolLabel } from '../chat/bridgeView';

/**
 * The row under a running task: what it is doing right now. It subscribes to its own task's progress and ticks its own
 * clock, so the thread around it does not re-render every second. The live region carries only the parts that change on
 * a real event (turn, tool, waiting); the clock is outside it, or a screen reader would announce it every second.
 */
export function WorkingRow({ taskId, queued, waiting }: { taskId: string; queued: boolean; waiting: boolean }) {
  const progress = useStore((s) => s.progress[taskId]);
  // pending asks of this run: the row names the agents it waits on. Both selectors return one string (names joined by a
  // newline), so they stay stable between messages; the list is split again for the label. Also read while no tool is
  // set: the core clears progress.tool on the first tool result (engine.ts), so after one of two asks comes back the
  // other is still open with tool null.
  const askRefs = useStore((s) => {
    const p = s.progress[taskId];
    return p && (!p.tool || bridgeVerb(p.tool) === 'ask') ? pendingAskAgents(s.messages[taskId], p.startedAt).join('\n') : '';
  });
  const askNames = useStore((s) => askRefs.split('\n').filter(Boolean)
    .map((ref) => s.agents.find((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase())?.name ?? ref)
    .filter((n, i, all) => all.indexOf(n) === i).join('\n'));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!progress || queued) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [progress, queued]);

  const label = workingLabel({ queued, waiting, thinking: progress?.thinking });
  const parts: string[] = [];
  if (progress && !queued) {
    parts.push(`turn ${progress.turn} of ${progress.maxTurns}`);
    const tool = progress.tool ?? (askNames ? 'mcp__legion__ask' : null);
    if (tool && !waiting) parts.push(workingToolLabel(tool, askNames ? askNames.split('\n') : []));
    if (progress.background) parts.push(backgroundLabel(progress.background, progress.backgroundStopsAt));
    if (progress.contextTokens !== undefined) parts.push(contextLabel(progress.contextTokens));
  }
  const started = progress && !queued ? Date.parse(progress.startedAt) : NaN;
  return (
    <div className={`working${waiting ? ' waiting' : ''}`}>
      <i /><i /><i />
      <span aria-live="polite">{[label, ...parts].join(' · ')}</span>
      {Number.isFinite(started) && <span className="working-clock" aria-hidden="true"> · {elapsedLabel(now - started)}</span>}
    </div>
  );
}
