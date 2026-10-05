/** Pure helpers for the task checklist (Claude's TodoWrite), so the core test suite can check them. */
export interface TodoLine { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

/** More items than this fold behind "Show all N". */
export const TODO_FOLD = 6;

/** "3 of 7 done". */
export function todoSummary(todos: readonly TodoLine[]): string {
  return `${todos.filter((t) => t.status === 'completed').length} of ${todos.length} done`;
}

/** What a line says: the present-tense form while it is in progress, the plain task otherwise. */
export function todoText(t: TodoLine): string {
  return t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
}

/** Reads the stored input of a TodoWrite call; null when it is clipped or not a list (the chip then shows its raw text). */
export function parseTodoInput(text: string): TodoLine[] | null {
  try {
    const list = (JSON.parse(text) as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(list)) return null;
    return list.filter((t) => t && typeof t.content === 'string').map((t) => ({
      content: t.content as string,
      status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
    }));
  } catch { return null; }
}

/** The label of a TodoWrite chip, or null when its input cannot be read. */
export function todoChipLabel(text: string): string | null {
  const todos = parseTodoInput(text);
  return todos ? `Updated the task list (${todoSummary(todos)})` : null;
}

/**
 * The lines to show. Up to TODO_FOLD lines all show. Longer lists fold to a window of TODO_FOLD lines that holds the
 * first unfinished line, so the current work is always in view; `hidden` is how many lines are folded away.
 */
export function visibleTodos<T extends TodoLine>(todos: readonly T[], expanded: boolean): { items: T[]; hidden: number } {
  if (expanded || todos.length <= TODO_FOLD) return { items: [...todos], hidden: 0 };
  const open = todos.findIndex((t) => t.status !== 'completed');
  const start = Math.max(0, Math.min(open < 0 ? todos.length - TODO_FOLD : open, todos.length - TODO_FOLD));
  const items = todos.slice(start, start + TODO_FOLD);
  return { items, hidden: todos.length - items.length };
}
