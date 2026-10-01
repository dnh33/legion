import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { archiveTask, closeOthers, closeTaskMenu, deleteTask, reopenTask, startRename, stopTask, toast, useStore } from '../store';
import { copyText } from '../util';
import { Icon } from './icons';

/** Right-click menu shared by the task tabs and the Recent tasks rows. */
export function TaskMenu() {
  const menu = useStore((s) => s.taskMenu);
  const task = useStore((s) => s.tasks.find((t) => t.id === s.taskMenu?.taskId));
  const siblings = useStore((s) => s.tasks.filter((t) => t.agentId === task?.agentId && !t.archived && t.id !== task?.id).length);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [confirm, setConfirm] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => { setConfirm(false); setI(0); }, [menu?.taskId, menu?.x, menu?.y]);
  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) });
    box.current.focus();
  }, [menu, confirm]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.('.task-menu')) closeTaskMenu(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeTaskMenu(); } };
    document.addEventListener('mousedown', close, true); document.addEventListener('contextmenu', close, true);
    window.addEventListener('blur', closeTaskMenu); window.addEventListener('resize', closeTaskMenu); document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('contextmenu', close, true); window.removeEventListener('blur', closeTaskMenu); window.removeEventListener('resize', closeTaskMenu); document.removeEventListener('keydown', esc, true); };
  }, [menu]);
  if (!menu || !task) return null;

  const running = task.status === 'running' || task.status === 'queued';
  const act = (fn: () => void) => () => { closeTaskMenu(); fn(); };
  const items: { key: string; label: string; icon?: string; run: () => void; disabled?: boolean; danger?: boolean; keep?: boolean; hint?: string }[] = [
    task.archived
      ? { key: 'reopen', label: 'Reopen', icon: 'play', run: act(() => void reopenTask(task.id)) }
      : { key: 'close', label: 'Close', icon: 'x', run: act(() => void archiveTask(task.id)), hint: 'Middle-click' },
    { key: 'others', label: 'Close others', run: act(() => void closeOthers(task.id)), disabled: siblings === 0 },
    { key: 'rename', label: 'Rename', icon: 'edit', run: () => startRename(task.id, menu.src) },
    ...(running ? [{ key: 'stop', label: 'Stop', icon: 'stop', run: act(() => void stopTask(task.id)) }] : []),
    { key: 'copy', label: 'Copy task id', icon: 'copy', run: act(() => void copyText(task.id).then((ok) => ok && toast('Task id copied'))) },
    { key: 'delete', label: confirm ? 'Delete for good?' : 'Delete…', icon: 'trash', danger: true, disabled: running, keep: !confirm, run: () => { if (confirm) { closeTaskMenu(); void deleteTask(task.id); } else setConfirm(true); } },
  ];
  const enabled = items.map((x, n) => (x.disabled ? -1 : n)).filter((n) => n >= 0);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => enabled[(enabled.indexOf(n) + 1) % enabled.length] ?? 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => enabled[(enabled.indexOf(n) - 1 + enabled.length) % enabled.length] ?? 0); }
    else if (e.key === 'Enter') { e.preventDefault(); items[i]?.run(); }
  };
  return (
    <div className="task-menu popover-plain" ref={box} role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <div className="tm-title" title={task.title}>{task.title.replace(/^\/(opus|sonnet)\s+/i, '')}</div>
      {items.map((m, n) => (
        <button key={m.key} role="menuitem" type="button" className={`tm-item${m.danger ? ' danger' : ''}${n === i ? ' hl' : ''}`} disabled={m.disabled}
          onMouseMove={() => !m.disabled && setI(n)} onClick={m.run} title={m.key === 'delete' && running ? 'Stop the task before deleting it' : undefined}>
          <span className="tm-ic">{m.icon && <Icon name={m.icon} size={13} />}</span><span>{m.label}</span>{m.hint && <kbd>{m.hint}</kbd>}
        </button>
      ))}
      {confirm && <div className="tm-note">This removes the task and its messages. It cannot be undone. <button type="button" className="link-btn" onClick={() => setConfirm(false)}>Cancel</button></div>}
    </div>
  );
}
