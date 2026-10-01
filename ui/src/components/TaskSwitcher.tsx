import { useMemo } from 'react';
import { newTask, selectTask, useStore } from '../store';
import { Icon } from './icons';
import { cleanTitle } from '../util';

export function TaskSwitcher() {
  const tasks = useStore((s) => s.tasks);
  const agentId = useStore((s) => s.selectedAgentId);
  const sel = useStore((s) => s.selectedTaskId);
  const mine = useMemo(() => tasks.filter((t) => t.agentId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12), [tasks, agentId]);
  return (
    <div className="tasks-bar" role="tablist" aria-label="Tasks">
      <button className={`tab new${sel === null ? ' sel' : ''}`} onClick={newTask} title="New task (Ctrl N)"><Icon name="plus" size={13} /> New task</button>
      <div className="tab-sep" />
      <div className="tabs-scroll">
        {mine.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === sel} className={`tab${t.id === sel ? ' sel' : ''}`} onClick={() => selectTask(t.id)} title={cleanTitle(t.title)}>
            <i className={`st st-${t.status}`} />
            <span>{cleanTitle(t.title)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
