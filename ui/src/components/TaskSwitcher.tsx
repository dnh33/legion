import { useEffect, useMemo, useRef, useState } from 'react';
import { modelLabel } from '../models';
import { useProviders } from '../providers/providersStore';
import { taskProjectChip } from '../projects/projectsLogic';
import { otherProjectsHint, tabTasks } from '../chat/taskTabs';
import { archiveTask, newTask, openTaskMenu, renameTask, selectTask, startRename, stopRename, useStore } from '../store';
import { Icon } from './icons';
import { HistoryList } from '../history/HistoryList';
import { statusDot } from '../../../src/shared/continue';
import { cleanTitle, taskTitle } from '../util';

/** Inline title editor used by tabs and Recent rows. Enter saves, Esc cancels. */
export function RenameInput({ id, title }: { id: string; title: string }) {
  const [v, setV] = useState(cleanTitle(title));
  const r = useRef<HTMLInputElement>(null);
  useEffect(() => { r.current?.focus(); r.current?.select(); }, []);
  return <input ref={r} className="rename-input" value={v} maxLength={120} aria-label="Task name" onChange={(e) => setV(e.target.value)}
    onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void renameTask(id, v); else if (e.key === 'Escape') stopRename(); }} onBlur={() => void renameTask(id, v)} />;
}

export function TaskSwitcher() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.selectedAgentId);
  const sel = useStore((s) => s.selectedTaskId);
  const catalog = useStore((s) => s.catalog);
  useProviders((s) => s.view); // a provider model's label (OpenRouter · vendor/model) comes from the provider list
  const filter = useStore((s) => s.projectFilter);
  const projects = useStore((s) => s.projects);
  const renaming = useStore((s) => (s.renaming?.src === 'tab' ? s.renaming.id : null));
  const MAX = 12;
  // stable order: newest-created first, so tabs never jump when a task finishes
  // strictly the project in view: opening a task of another project switches the dropdown (selectTask), so the open task is always a tab
  const all = useMemo(() => tabTasks(tasks, agentId, sel, filter), [tasks, agentId, sel, filter]);
  const approvals = useStore((s) => s.approvals);
  const questions = useStore((s) => s.questions);
  const hint = useMemo(() => otherProjectsHint(tasks, agentId, filter, projects, [...approvals, ...questions]), [tasks, agentId, filter, projects, approvals, questions]);
  const [hintOpen, setHintOpen] = useState(false);
  const mine = useMemo(() => { const head = all.slice(0, MAX); if (sel && !head.some((t) => t.id === sel)) { const s = all.find((t) => t.id === sel); if (s) head[MAX - 1] = s; } return head; }, [all, sel]);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!hintOpen) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.tab-hint-wrap')) setHintOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setHintOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [hintOpen]);
  useEffect(() => { if (!hint) setHintOpen(false); }, [hint]);
  const openHinted = (id: string) => { setHintOpen(false); selectTask(id); };
  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.tab-more')) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [more]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.querySelector('.tab.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [sel]);
  return (
    <div className="tasks-bar" role="tablist" aria-label="Tasks">
      <button className={`tab new${sel === null ? ' sel' : ''}`} onClick={newTask} title="New task (Ctrl N)"><Icon name="plus" size={13} /> New task</button>
      <div className="tab-sep" />
      <div className="tabs-scroll" ref={scroller}>
        {mine.map((t) => {
          const from = t.source === 'agent' && t.fromAgentId ? agents.find((a) => a.id === t.fromAgentId)?.name ?? t.fromAgentId : null;
          const inProj = taskProjectChip(projects, t.projectId, filter);
          return (
            <div key={t.id} role="tab" tabIndex={0} aria-selected={t.id === sel} className={`tab${t.id === sel ? ' sel' : ''}${t.archived ? ' closed' : ''}`}
              onClick={() => selectTask(t.id)} title={cleanTitle(t.title)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTask(t.id); } else if (e.key === 'F2') startRename(t.id, 'tab'); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void archiveTask(t.id); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onContextMenu={(e) => { e.preventDefault(); openTaskMenu(e.clientX, e.clientY, t.id); }}>
              <i className={`st st-${statusDot(t)}`} />
              {renaming === t.id ? <RenameInput id={t.id} title={t.title} /> : <span>{taskTitle(t.title, from)}</span>}
              {from && renaming !== t.id && <em className="from-chip">from {from}</em>}
              {inProj && renaming !== t.id && <em className="from-chip project-chip" title={`In the project ${inProj}`}>{inProj}</em>}
              {t.modelOverride && renaming !== t.id && <em className="from-chip model-chip" title={`${agents.find((a) => a.id === t.modelOverride!.by)?.name ?? t.modelOverride.by} chose ${modelLabel(catalog, t.modelOverride.model)} for this task`}>{modelLabel(catalog, t.modelOverride.model)}</em>}
              {renaming !== t.id && !t.archived && <button type="button" className="tab-x" aria-label={`Close ${cleanTitle(t.title)}`} title="Close task" tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); void archiveTask(t.id); }}><Icon name="x" size={11} /></button>}
            </div>
          );
        })}
      </div>
      {hint && (
        <div className="tab-hint-wrap">
          <button type="button" className={`tab-hint${hint.tone === 'amber' ? ' needs' : ''}`} aria-label={`${hint.text}. ${hint.tasks.length === 1 ? 'Open it' : 'Show them'}`}
            aria-haspopup={hint.tasks.length > 1 ? 'menu' : undefined} aria-expanded={hint.tasks.length > 1 ? hintOpen : undefined}
            onClick={() => (hint.tasks.length === 1 ? openHinted(hint.tasks[0]!.id) : setHintOpen((v) => !v))}>{hint.text}</button>
          {hintOpen && hint.tasks.length > 1 && (
            <div className="more-pop hint-pop" role="menu" aria-label="Tasks running in other projects">
              {hint.tasks.map((t) => {
                const full = tasks.find((x) => x.id === t.id)!;
                const where = taskProjectChip(projects, t.projectId, filter) ?? 'No project';
                return <button key={t.id} type="button" role="menuitem" className="more-item" autoFocus={t === hint.tasks[0]} onClick={() => openHinted(t.id)}>
                  <i className={`st st-${statusDot(full)}`} /><span>{cleanTitle(full.title)}</span><em className="from-chip project-chip">{where}</em></button>;
              })}
            </div>
          )}
        </div>
      )}
      <div className="tab-more">
        <button type="button" className="tab more-btn" onClick={() => setMore((v) => !v)} aria-expanded={more} aria-haspopup="menu" title="Search and browse every task of this agent">History</button>
        {more && <HistoryList agentId={agentId} onClose={() => setMore(false)} />}
      </div>
    </div>
  );
}
