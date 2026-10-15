/**
 * Board proposals waiting in any project's Inbox: the one source the page, the project menu and the rail read, so a proposal counts the same
 * everywhere (spec 4.2). The boards of the active projects are loaded once and kept current from the core's board events.
 */
import { useEffect, useMemo } from 'react';
import type { WorkItem } from '../../../src/shared/board';
import { useStore } from '../store';
import { loadBoard, probeBoard, useBoard } from './board/boardStore';
import { proposalsSettled } from './projectsLogic';

const requested = new Set<string>();
let listening = false;

export function useAllProposals(): WorkItem[] {
  const projects = useStore((s) => s.projects);
  const enabled = useBoard((s) => s.enabled);
  const views = useBoard((s) => s.views);
  useEffect(() => { void probeBoard(); }, []);
  useEffect(() => {
    if (enabled !== 'yes') return;
    for (const p of projects) if (p.status === 'active' && !requested.has(p.id)) { requested.add(p.id); void loadBoard(p.id); }
    if (!listening) {
      listening = true;
      window.addEventListener('legion-board-updated', (e) => { const id = (e as CustomEvent).detail as string; if (id) void loadBoard(id); });
    }
  }, [enabled, projects]);
  return useMemo(() => Object.values(views).flatMap((v) => v?.inbox ?? []), [views]);
}

/** True once the proposals source has loaded once (see proposalsSettled): the rail stays silent on its first load. */
export function useProposalsSettled(): boolean {
  const projectsLoaded = useStore((s) => s.projectsLoaded);
  const projects = useStore((s) => s.projects);
  const enabled = useBoard((s) => s.enabled);
  const attempted = useBoard((s) => s.attempted);
  return proposalsSettled({ projectsLoaded, enabled, activeIds: projects.filter((p) => p.status === 'active').map((p) => p.id), attempted });
}
