/**
 * The side sheet (spec 3.3, 3.4): one task with its asks, or the New task form. A side sheet, not a modal: it never traps focus, Esc closes
 * it and returns focus to the control that opened it, and with an unsaved draft the first Esc only says so. Every rule it applies lives in
 * sheetLogic.ts; this file renders and wires.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../../src/shared/projects';
import { isImeKey } from '../../chat/ime';
import { moveItem } from '../board/boardStore';
import { sendPromptTo, toast, useStore } from '../../store';
import { projectAway, useAway } from '../awayStore';
import { AgentBust } from './AgentBust';
import { announce } from './announce';
import { buildAskRows } from './askLogic';
import { setVisibleRows, startAnswer, useAnswers } from './answerStore';
import { AnsweredRow, OpenRow } from './Digest';
import { Menu } from './Menu';
import { RunsButton } from './Overview';
import './sheet.css';
import { ageText, liveRuns, money, pageStatus, waitingTaskIds, asksOf } from './pageLogic';
import type { PageFacts } from './pageLogic';
import { PIcon } from './PIcon';
import { ESC_NOTE, bestFit, canStart, costLine, escStep, newTaskBody, secondRun, taskCard, typicalCost } from './sheetLogic';
import type { CardAction, RunChoice } from './sheetLogic';
import { closeSheet, getDraft, openSheet, setDraft, sheetKey, useSheet } from './sheetState';
import type { SheetContent } from './sheetState';
import { continueTask, openThread, retryTask, stopTask } from './taskActions';

const STATUS_CHIP: Record<string, [string, string]> = {
  working: ['working', 'Working'], waiting: ['waiting', 'Waiting on you'], queued: ['queued', 'Queued'], stopped: ['paused', 'Stopped'],
  failed: ['failed', 'Failed'], done: ['done', 'Done'], review: ['done', 'In review'], cancelled: ['done', 'Cancelled'],
};

/** Esc handling shared by both sheets: an unsaved draft keeps the sheet (and the caret) until a second Esc. Listens on the document, so Esc works wherever focus is. */
function useEsc(dirty: boolean): { note: boolean; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!dirty) setArmed(false); }, [dirty]);
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.pg-menu')) return;
      e.preventDefault();
      if (escStep({ dirty, armed }) === 'arm') { setArmed(true); announce(ESC_NOTE); return; }
      closeSheet();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [dirty, armed]);
  return { note: armed, disarm: () => setArmed(false) };
}

export function Sheet({ f, project, openBoard }: { f: PageFacts; project: Project; openBoard: () => void }) {
  const { content } = useSheet();
  if (!content) return null;
  return <SheetFrame key={sheetKey(content)} content={content} f={f} project={project} openBoard={openBoard} />;
}

function SheetFrame({ content, f, project, openBoard }: { content: SheetContent; f: PageFacts; project: Project; openBoard: () => void }) {
  return (
    <aside className="pg-sheet on" data-region="sheet" data-testid="sheet" role="dialog" aria-modal="false" aria-label={content.kind === 'new' ? 'New task' : 'Task'}>
      {content.kind === 'new' ? <NewTaskSheet f={f} project={project} /> : <TaskSheet f={f} project={project} id={content.id} openBoard={openBoard} />}
    </aside>
  );
}

/* ---------- one task ---------- */
function TaskSheet({ f, project, id, openBoard }: { f: PageFacts; project: Project; id: string; openBoard: () => void }) {
  const card = taskCard(f, id);
  const gone = !card;
  const closeBtn = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEsc(false);
  useEffect(() => { if (gone) closeSheet(); }, [gone]);
  useEffect(() => { closeBtn.current?.focus(); }, []);

  const pid = f.project.id;
  const away = useAway((s) => projectAway(s, pid));
  const quiet = useAway((s) => s.view?.app.quiet);
  const answers = useAnswers();
  const rows = useMemo(() => buildAskRows(f, { mode: away.onSilence.mode, parkMinutes: away.onSilence.parkMinutes, ...(quiet ? { quiet } : {}) }).filter((r) => r.taskId === id), [f, away, quiet, id]);
  const mine = [...answers.values()].filter((a) => a.row.taskId === id);
  const keys = [...new Set([...rows.map((r) => r.key), ...mine.map((a) => a.key)])];
  const keyStr = keys.join('|');
  useEffect(() => { setVisibleRows(keyStr ? keyStr.split('|') : [], 'sheet'); }, [keyStr]);
  useEffect(() => () => setVisibleRows([], 'sheet'), []);

  if (!card) return null;
  const task = f.tasks.find((t) => t.id === id)!;
  const st = pageStatus(task, waitingTaskIds(asksOf(f)));
  const [cls, label] = STATUS_CHIP[card.kind] ?? STATUS_CHIP[st] ?? ['done', st];
  const runs = liveRuns(task.agentId, f.tasks);
  const act = (a: CardAction): void => {
    if (a.act === 'stop' || a.act === 'stop-waiting') void stopTask(id);
    else if (a.act === 'continue') void continueTask(task);
    else if (a.act === 'retry') retryTask(task);
    else if (a.act === 'mark-done' && a.itemId) void moveItem(pid, a.itemId, 'done', 0, 'Marked done.');
  };
  const onRow = (row: (typeof rows)[number], actName: string, b: (typeof rows)[number]['buttons'][number], li: HTMLElement | null): void => {
    if (actName === 'open' || actName === 'review') return; // it is already open here
    if (actName === 'read') { closeSheet(); openBoard(); return; }
    startAnswer({ row, b, projectId: pid, height: li?.offsetHeight ?? 0 });
  };
  const open = new Set(rows.map((r) => r.key));
  return (
    <div className="pg-sh" ref={root}>
      <header className="pg-sh-h">
        <div className="pg-sh-top">
          <AgentBust agentId={card.agentId} size={28} />
          <h3 title={card.title}>{card.title}</h3>
          <button ref={closeBtn} type="button" className="pg-btn icon ghost" aria-label="Close the task" title="Close (Esc)" onClick={closeSheet}><PIcon name="close" size={14} /></button>
        </div>
        <div className="pg-sh-meta num">
          <span>{card.agentName}</span><span className="pg-sep" aria-hidden="true">/</span>
          <span className={`pg-chip ${cls}`}><i />{label}</span><span className="pg-sep" aria-hidden="true">/</span>
          <span>{money(card.costUsd)}</span><span className="pg-sep" aria-hidden="true">/</span>
          <span>{ageText(f.nowMs, card.updatedAt)}</span>
          {runs >= 2 && <RunsButton f={f} agentId={card.agentId} runs={runs} />}
        </div>
      </header>
      <div className="pg-sh-b">
        {keys.length > 0 && (
          <ul className="pg-ul pg-sh-asks" data-testid="sheet-asks">
            {keys.map((k) => {
              const a = answers.get(k);
              if (a) return <AnsweredRow key={k} a={a} />;
              const row = rows.find((r) => r.key === k);
              return row && open.has(k) ? <OpenRow key={k} row={row} armed={false} onAct={onRow} /> : null;
            })}
          </ul>
        )}
        {card.kind !== 'waiting' || keys.length === 0 ? (
          <div className="pg-card" data-kind={card.kind} data-testid="sheet-card">
            <b>{card.headline}</b>
            {card.detail && <p>{card.detail}</p>}
            {card.actions.length > 0 && (
              <div className="pg-sh-acts">
                {card.actions.map((a) => <button key={a.act} type="button" className="pg-btn" data-fk={`sh:${a.act}`} aria-label={`${a.label}: ${card.agentName} ${card.title}`} onClick={() => act(a)}>{a.label}</button>)}
              </div>
            )}
          </div>
        ) : null}
        {card.lastMessage && (
          <div className="pg-msg">
            <div className="w">{card.agentName}, {ageText(f.nowMs, card.updatedAt)}</div>
            <div className="bub" data-testid="sheet-last">{card.lastMessage}</div>
          </div>
        )}
      </div>
      <footer className="pg-sh-f">
        <button type="button" className="pg-btn" data-fk="sh:thread" onClick={() => openThread(id)}>Open full thread</button>
        <span className="pg-gap" />
        <button type="button" className="pg-btn ghost" onClick={closeSheet}>Close</button>
      </footer>
    </div>
  );
}

/* ---------- New task ---------- */
function NewTaskSheet({ f, project }: { f: PageFacts; project: Project }) {
  const key = 'new';
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const [text, setTextRaw] = useState(() => getDraft(key));
  const [to, setTo] = useState<string | null>(null); // null = Best fit
  const [projId, setProjId] = useState(project.id);
  const [choice, setChoice] = useState<RunChoice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [toMenu, setToMenu] = useState(false);
  const [inMenu, setInMenu] = useState(false);
  const [at, setAt] = useState<{ q: string; sel: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const toBtn = useRef<HTMLButtonElement>(null);
  const inBtn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const setText = (t: string): void => { setTextRaw(t); setDraft(key, t); };
  const esc = useEsc(text.trim() !== '');
  useEffect(() => { ta.current?.focus(); }, []);

  const chosen = projects.find((p) => p.id === projId && p.status === 'active') ?? project;
  const fx: PageFacts = useMemo(() => ({ ...f, project: chosen }), [f, chosen]);
  const members = chosen.members;
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  const fit = bestFit(fx);
  const agentId = to && members.includes(to) ? to : fit;
  const warning = agentId ? secondRun(fx, agentId) : null;
  useEffect(() => { setChoice(undefined); }, [agentId, projId, !!warning]); // eslint-disable-line react-hooks/exhaustive-deps
  const cost = agentId ? typicalCost(tasks, agentId) : undefined;
  const can = canStart({ text, warning, choice });

  const start = async (): Promise<void> => {
    if (!agentId || busy) return;
    if (!can.ok) {
      if (can.why === 'choose' && warning) { box.current?.focus(); announce(`${warning.agentName} is already working here. Choose Run anyway or Queue after it.`); }
      return;
    }
    const body = newTaskBody({ agentId, projectId: chosen.id, text, warning, choice });
    setBusy(true);
    const r = await sendPromptTo({ agentId, taskId: null }, body.prompt, { select: false, projectId: body.projectId, ...(body.startAfter ? { startAfter: true as const } : {}) });
    setBusy(false);
    if (!r.ok) { toast(r.message, 'error'); return; }
    setDraft(key, '');
    announce(body.startAfter ? `Queued. ${nameOf(agentId)} starts it when the current run finishes.` : `Started. ${nameOf(agentId)} is on it.`);
    openSheet({ kind: 'task', id: r.task.id });
  };

  // "@name" at the end of the text offers the members; picking one sets To and removes the token
  const atMatches = at ? members.filter((id) => nameOf(id).toLowerCase().startsWith(at.q.toLowerCase())) : [];
  const pickAt = (id: string): void => { setTo(id); setText(text.replace(/(^|\s)@\w*$/, '$1')); setAt(null); ta.current?.focus(); };
  const onText = (v: string): void => {
    setText(v); esc.disarm();
    const m = /(?:^|\s)@(\w*)$/.exec(v);
    setAt(m ? { q: m[1]!, sel: 0 } : null);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeKey(e.nativeEvent)) return;
    if (at && atMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAt({ ...at, sel: (at.sel + 1) % atMatches.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAt({ ...at, sel: (at.sel - 1 + atMatches.length) % atMatches.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(atMatches[at.sel]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAt(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void start(); }
  };

  const fitName = fit ? nameOf(fit) : '';
  const activeProjects = projects.filter((p) => p.status === 'active' && p.members.length > 0);
  return (
    <div className="pg-sh">
      <header className="pg-sh-h">
        <div className="pg-sh-top">
          <h3>New task</h3>
          <button type="button" className="pg-btn icon ghost" aria-label="Close" title="Close (Esc)" onClick={closeSheet}><PIcon name="close" size={14} /></button>
        </div>
      </header>
      <div className="pg-sh-b">
        <div className="pg-comp big">
          <textarea ref={ta} value={text} rows={6} placeholder="What should happen next?" aria-label="What should happen next?" onChange={(e) => onText(e.target.value)} onKeyDown={onKey} />
          {at && atMatches.length > 0 && (
            <div className="pg-at" role="listbox" aria-label="Members">
              {atMatches.map((id, i) => (
                <button key={id} type="button" role="option" aria-selected={i === at.sel} className={i === at.sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickAt(id); }}>
                  <AgentBust agentId={id} size={20} calm /><span>{nameOf(id)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {esc.note && <div className="pg-sh-conf" role="status">{ESC_NOTE}</div>}
        <div className="pg-pills">
          <span className="pl">To:</span>
          <button ref={toBtn} type="button" className="pg-pill" aria-haspopup="menu" aria-expanded={toMenu} onClick={() => setToMenu((v) => !v)}>
            {agentId && <AgentBust agentId={agentId} size={22} calm />}
            <span className="ell">{to && members.includes(to) ? nameOf(to) : 'Best fit'}</span><PIcon name="chev" size={12} />
          </button>
          <span className="pl">in</span>
          <button ref={inBtn} type="button" className="pg-pill" aria-haspopup="menu" aria-expanded={inMenu} onClick={() => setInMenu((v) => !v)}>
            <span className="ell">{chosen.name}</span><PIcon name="chev" size={12} />
          </button>
          {toMenu && (
            <Menu anchor={toBtn} label="Who does it" onClose={() => setToMenu(false)} minWidth={260}>
              <button type="button" role="menuitemradio" aria-checked={to === null} onClick={() => { setTo(null); setToMenu(false); }}>
                <span className="mm"><b>Best fit</b><span>{fitName ? `The member with the fewest running tasks here, now ${fitName}` : 'Add a member first'}</span></span>
                {to === null && <PIcon name="check" size={14} className="ck" />}
              </button>
              {members.map((id) => (
                <button key={id} type="button" role="menuitemradio" aria-checked={to === id} onClick={() => { setTo(id); setToMenu(false); }}>
                  <AgentBust agentId={id} size={24} calm /><span className="mm"><b>{nameOf(id)}</b></span>
                  {to === id && <PIcon name="check" size={14} className="ck" />}
                </button>
              ))}
            </Menu>
          )}
          {inMenu && (
            <Menu anchor={inBtn} label="Which project" onClose={() => setInMenu(false)} minWidth={240}>
              {activeProjects.map((p) => (
                <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === chosen.id} onClick={() => { setProjId(p.id); setInMenu(false); }}>
                  <span className="mm"><b>{p.name}</b></span>{p.id === chosen.id && <PIcon name="check" size={14} className="ck" />}
                </button>
              ))}
            </Menu>
          )}
        </div>
        {warning ? (
          <div ref={box} className="pg-busy-n" tabIndex={-1} role="group" aria-label="This agent is already working here" data-testid="second-run">
            <b>{warning.agentName} is already working here.</b>
            <p>{warning.taskTitle} is in progress. Run anyway: both runs work at once and share the project folder. Queue after it: starts when {warning.agentName} finishes.</p>
            <div className="opts2">
              <button type="button" className="pg-btn" aria-pressed={choice === 'run'} onClick={() => setChoice('run')}>Run anyway</button>
              <button type="button" className="pg-btn" aria-pressed={choice === 'after'} onClick={() => setChoice('after')}>Queue after it</button>
            </div>
          </div>
        ) : (
          <p className="pg-sh-note">{fit && to === null ? `Legion picks the member with the fewest running tasks (${fitName} right now). ` : ''}Type @ in the text to pick someone else.</p>
        )}
      </div>
      <footer className="pg-sh-f">
        <span className="pg-sh-hint">Enter starts it, Shift Enter adds a line.{cost !== undefined ? ` ${costLine(cost)}` : ''}</span>
        <span className="pg-gap" />
        <button type="button" className="pg-btn strong" data-fk="sh:start" disabled={busy || !agentId || (!can.ok && can.why === 'empty')} onClick={() => void start()}>Start task</button>
      </footer>
    </div>
  );
}
