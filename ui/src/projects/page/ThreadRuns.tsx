/** The "N runs" button in the chat header (spec 3.7): shown only when the agent has 2 or more live runs, in any project. */
import { useMemo } from 'react';
import { selectAgent, selectTask, useStore } from '../../store';
import { setProjectFilter } from '../projectsStore';
import { liveRuns } from './pageLogic';
import type { PageFacts } from './pageLogic';
import { RunsButton } from './Overview';
import './page.css';

export function ThreadRuns({ agentId }: { agentId: string }) {
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const queue = useStore((s) => s.queue);
  const progress = useStore((s) => s.progress);
  const filter = useStore((s) => s.projectFilter);
  const runs = liveRuns(agentId, tasks);
  const f: PageFacts = useMemo(() => ({
    project: { id: filter ?? '', name: projects.find((p) => p.id === filter)?.name ?? '', members: [], status: 'active', createdAt: '' },
    projects, agents, tasks, approvals, questions, queue, progress, nowMs: Date.now(),
  }), [filter, projects, agents, tasks, approvals, questions, queue, progress]);
  if (runs < 2) return null;
  const open = (taskId: string, projectId: string | undefined): void => {
    if (projectId && projectId !== filter) setProjectFilter(projectId);
    selectAgent(agentId);
    selectTask(taskId);
  };
  return <RunsButton f={f} agentId={agentId} runs={runs} onOpen={open} />;
}
