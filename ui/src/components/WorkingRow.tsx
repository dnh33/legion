import { useEffect, useState } from 'react';
import { elapsedLabel } from '../chat/elapsed';
import { contextLabel } from '../../../src/shared/context-meter';
import { workingLabel } from '../chat/working';
import { useStore } from '../store';

/**
 * The row under a running task: what it is doing right now. It subscribes to its own task's progress and ticks its own
 * clock, so the thread around it does not re-render every second. The live region carries only the parts that change on
 * a real event (turn, tool, waiting); the clock is outside it, or a screen reader would announce it every second.
 */
export function WorkingRow({ taskId, queued, waiting }: { taskId: string; queued: boolean; waiting: boolean }) {
  const progress = useStore((s) => s.progress[taskId]);
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
    if (progress.tool && !waiting) parts.push(progress.tool);
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
