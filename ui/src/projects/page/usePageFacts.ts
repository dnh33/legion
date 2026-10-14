import { useEffect, useMemo, useState } from 'react';
import type { Project } from '../../../../src/shared/projects';
import { useStore } from '../../store';
import { loadBoard, probeBoard, useBoard } from '../board/boardStore';
import type { PageFacts } from './pageLogic';

/** A clock that ticks (default every 30 s) so "7 min" and "Since 09:40" stay true without a re-fetch. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), everyMs); return () => window.clearInterval(id); }, [everyMs]);
  return now;
}

/** Everything the page derives from, gathered once: the window's store, this project's board, and the clock. */
export function usePageFacts(project: Project): PageFacts {
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const queue = useStore((s) => s.queue);
  const progress = useStore((s) => s.progress);
  const projects = useStore((s) => s.projects);
  const enabled = useBoard((s) => s.enabled);
  const board = useBoard((s) => s.views[project.id]);
  const now = useNow();
  useEffect(() => { void probeBoard(); }, []);
  useEffect(() => { if (enabled === 'yes') void loadBoard(project.id); }, [enabled, project.id]);
  useEffect(() => {
    const on = (e: Event): void => { if ((e as CustomEvent).detail === project.id && enabled === 'yes') void loadBoard(project.id); };
    window.addEventListener('legion-board-updated', on);
    return () => window.removeEventListener('legion-board-updated', on);
  }, [enabled, project.id]);
  return useMemo(() => ({
    project, projects, agents, tasks, approvals, questions, queue, progress,
    ...(board ? { board: { items: board.items, inbox: board.inbox } } : {}),
    nowMs: now,
  }), [project, projects, agents, tasks, approvals, questions, queue, progress, board, now]);
}
