import { useState } from 'react';
import { todoSummary, todoText, visibleTodos, TODO_FOLD } from '../chat/todos';
import { useStore } from '../store';

/**
 * The run's checklist (Claude's TodoWrite), pinned in the thread just above the working row. It reads its own task's
 * progress, so only it re-renders when the list changes. Long lists fold to the lines around the current work.
 */
export function TodoList({ taskId }: { taskId: string }) {
  const todos = useStore((s) => s.progress[taskId]?.todos);
  const [expanded, setExpanded] = useState(false);
  if (!todos || todos.length === 0) return null;
  const { items, hidden } = visibleTodos(todos, expanded);
  return (
    <section className="todos" aria-label="Task list">
      <div className="todos-head"><b>Task list</b><span>{todoSummary(todos)}</span></div>
      <ul>
        {items.map((t, i) => (
          <li key={i} className={`todo ${t.status}`} aria-current={t.status === 'in_progress' ? 'step' : undefined}>
            <span className="todo-mark" aria-hidden="true">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
            <span className="todo-text">{todoText(t)}</span>
            <span className="sr-only">{t.status === 'completed' ? ' (done)' : t.status === 'in_progress' ? ' (in progress)' : ' (not started)'}</span>
          </li>
        ))}
      </ul>
      {todos.length > TODO_FOLD && (
        <button type="button" className="link-btn todos-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${todos.length}`}
        </button>
      )}
    </section>
  );
}
