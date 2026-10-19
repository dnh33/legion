/** The Overview tab: banners, Working now, the digest, then the state groups or the By-agent units, and the side column. Spec 3.2, 3.7, 3.8. */
import { useRef, useState } from 'react';
import { useRooms } from '../../rooms/roomsStore';
import { openRoom } from '../../rooms/roomsStore';
import { setView, useStore } from '../../store';
import { MODE_HELP, ageText, asksOf, budgetBanner, hereRuns, money, plural, projectTasks, queueText, runsMenu, spendBlock, stateGroups, unitModel, workingAgents } from './pageLogic';
import type { BudgetVerdict, Group, GroupItem, PageFacts, Unit, UnitLine } from './pageLogic';
import { patchAway, projectAway, runAnyway, setPaused, useAway } from '../awayStore';
import { setProjectFilter } from '../projectsStore';
import { projectLabel, roomsOf } from '../projectsLogic';
import type { Project } from '../../../../src/shared/projects';
import { AgentBust } from './AgentBust';
import { Digest } from './Digest';
import { Menu } from './Menu';
import { PIcon } from './PIcon';
import type { PIconName } from './PIcon';
import { useGateOff } from './holdOff';
import { setTab } from './pageState';
import type { Lens } from './pageState';
import { continueTask, openTask, retryTask, stopTask } from './taskActions';
import { announce } from './announce';

const ICON: Record<string, [PIconName, string]> = {
  working: ['run', 'live'], waiting: ['hand', 'warn'], queued: ['queue', ''], review: ['review', ''], stopped: ['pause', 'warn'], failed: ['x', 'bad'], done: ['ok', ''], cancelled: ['x', ''],
};
const UNIT_ICON: Record<UnitLine['icon'], PIconName> = { hand: 'hand', run: 'run', queue: 'queue', x: 'x', pause: 'pause', review: 'review' };

export function Overview({ f, project, lens, openBoard }: { f: PageFacts; project: Project; lens: Lens; openBoard: () => void }) {
  const asks = asksOf(f);
  const archived = project.status === 'archived';
  const spend = useAway((s) => s.spend[project.id]);
  const weekByAgent = Object.fromEntries((spend?.byAgent ?? []).map((a) => [a.agentId, a.usd]));
  if (!project.members.length && !archived) return <SetUp project={project} />;
  const agentLens = lens === 'agent' && project.members.length > 1 && !archived;
  return (
    <div className="pg-inner" data-testid="overview">
      <div className="pg-ov">
        <div style={{ minWidth: 0 }}>
          <Banners f={f} project={project} spend={spend} />
          {!archived && <WorkingStrip f={f} asks={asks} />}
          {!archived && <Digest f={f} asks={asks} agentLens={agentLens} openBoard={openBoard} />}
          <div data-region="body">{agentLens ? <AgentUnits f={f} asks={asks} weekByAgent={weekByAgent} /> : <Groups f={f} asks={asks} archived={archived} openBoard={openBoard} />}</div>
        </div>
        {!archived && <SideColumn f={f} project={project} spend={spend} showMembers={!agentLens} />}
      </div>
      <p className="pg-fnote">Viewing {projectLabel(project)}. The rail and task lists show this project&rsquo;s agents and tasks until you choose All projects.</p>
    </div>
  );
}

function SetUp({ project }: { project: Project }) {
  return (
    <div className="pg-inner"><div className="pg-empty">
      <h2>Set up {project.name}</h2>
      <p>Add the agents who work here, then start a task. Everything else is optional and off until you turn it on.</p>
      <button type="button" className="pg-btn" onClick={() => setTab('settings')}>Add members</button>
    </div></div>
  );
}

/* ---------- banners ---------- */
function Banners({ f, project, spend }: { f: PageFacts; project: Project; spend: import('../../api').ProjectSpend | undefined }) {
  const paused = useAway((s) => projectAway(s, project.id).paused);
  const stopOff = useGateOff('budget-stop', project.id);
  const [pop, setPop] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (project.status === 'archived') {
    return <div className="pg-banner neutral" role="note"><PIcon name="archive" size={18} className="bi" /><div className="bt"><b>This project is archived.</b> <span>It starts no new tasks and its board is read-only. Nothing was deleted.</span></div></div>;
  }
  const hit = budgetBanner(spend?.budget, stopOff);
  void f;
  return (
    <div data-region="banner">
      {hit && (
        <div className="pg-banner" role="status">
          <PIcon name="coin" size={18} className="bi" /><div className="bt"><b className="long">{hit.title}</b><b className="short">{hit.shortTitle}</b> <span>{hit.text}</span></div>
          <div className="ba"><button ref={btn} type="button" className="pg-btn" aria-haspopup="dialog" aria-expanded={pop} onClick={() => setPop((v) => !v)}>Change budget</button></div>
          {pop && <BudgetPop anchor={btn} project={project} budget={spend!.budget} stopOff={stopOff} onClose={() => setPop(false)} />}
        </div>
      )}
      {paused && (
        <div className="pg-banner neutral" role="status">
          <PIcon name="pause" size={18} className="bi" /><div className="bt"><b className="long">New starts are paused.</b><b className="short">New starts paused.</b> <span className="long">Tasks you start yourself still run. Board items and Marshal starts wait.</span><span className="short">Your own tasks still run.</span></div>
          <div className="ba"><button type="button" className="pg-btn" onClick={() => { void setPaused(project.id, false).then((ok) => { if (ok) announce('New starts resumed.'); }); }}>Resume</button></div>
        </div>
      )}
    </div>
  );
}

function BudgetPop({ anchor, project, budget, stopOff, onClose }: { anchor: React.RefObject<HTMLElement | null>; project: Project; budget: BudgetVerdict; stopOff: boolean; onClose: () => void }) {
  const [v, setV] = useState(String(budget.limit ?? ''));
  const n = Number(v);
  const bad = !(n > 0) || !Number.isFinite(n);
  const period = budget.period ?? 'week';
  return (
    <Menu anchor={anchor} label="Change budget" kind="dialog" onClose={onClose} align="end" minWidth={300}>
      <b style={{ color: 'var(--text)', display: 'block', marginBottom: 6 }}>Change the {period === 'day' ? 'daily' : period === 'week' ? 'weekly' : 'monthly'} budget</b>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>$
        <input className="pg-inp" inputMode="decimal" value={v} aria-label="Budget in dollars" aria-invalid={bad} onChange={(e) => setV(e.target.value)} style={{ width: 90, height: 32, background: 'var(--surface)', border: '1px solid var(--control-line)', borderRadius: 'var(--r)', padding: '0 8px', color: 'var(--text)' }} />
        <button type="button" className="pg-btn" disabled={bad} onClick={() => { void patchAway(project.id, { budget: { limit: n, period } }).then((ok) => { if (ok) { announce('Budget saved.'); onClose(); } }); }}>Save budget</button>
      </label>
      {stopOff ? (
        <p style={{ margin: '8px 0 0' }}>Runs are not waiting at the budget, because Stop at the budget is off for this project.</p>
      ) : (
        <>
          <p style={{ margin: '8px 0 0' }}>New runs start again as soon as the budget is above what you spent.</p>
          <hr />
          <p style={{ margin: '0 0 8px' }}>Or spend over the budget until {period === 'week' ? 'Monday' : 'the next period'}. Runs that start now cost real money.</p>
          <button type="button" className="pg-btn ghost sm" onClick={() => { void runAnyway(project.id).then((ok) => { if (ok) { announce('Running over the budget until the period ends.'); onClose(); } }); }}>Run anyway this week</button>
        </>
      )}
    </Menu>
  );
}

/* ---------- working now ---------- */
function WorkingStrip({ f, asks }: { f: PageFacts; asks: ReturnType<typeof asksOf> }) {
  const agents = workingAgents(f, asks);
  const queued = projectTasks(f).filter((t) => t.status === 'queued');
  const q = queued[0];
  return (
    <section className="pg-ws" data-region="working" data-testid="working-strip" aria-label="Working now">
      <h2>Working now<span className="n num">{agents.length}</span></h2>
      {agents.length ? <div className="pg-chips">{agents.map((id) => <WorkChip key={id} f={f} agentId={id} />)}</div> : <span className="none">No run is working right now.</span>}
      {q && (
        <span className="qn"><PIcon name="queue" className="pg-st" />
          <span><b style={{ fontWeight: 500, color: 'var(--text-2)' }}>{f.agents.find((a) => a.id === q.agentId)?.name ?? q.agentId}</b>{queued.length > 1 ? ` and ${queued.length - 1} more` : ''}: {queueText(f, q).replace(/^Waiting/, 'waiting')}</span>
        </span>
      )}
    </section>
  );
}

function WorkChip({ f, agentId }: { f: PageFacts; agentId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const name = f.agents.find((a) => a.id === agentId)?.name ?? agentId;
  const runs = hereRuns(f, agentId);
  return (
    <>
      <button ref={ref} type="button" className="pg-chipbtn" data-fk={`w:${agentId}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={`${name}, ${plural(runs, 'run')} here. Show runs`} onClick={() => setOpen((v) => !v)}>
        <AgentBust agentId={agentId} size={24} /><span>{name}</span>{runs > 1 && <span className="mult" aria-hidden="true">×{runs}</span>}
      </button>
      {open && <RunsMenuView anchor={ref} f={f} agentId={agentId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The "N runs" menu: grouped by project, the current one first; Stop only on a run that is not waiting on you (spec 3.7). */
export function RunsMenuView({ anchor, f, agentId, onClose, onOpen }: { anchor: React.RefObject<HTMLElement | null>; f: PageFacts; agentId: string; onClose: () => void; onOpen?: (taskId: string, projectId: string | undefined) => void }) {
  const m = runsMenu(f, agentId);
  const go = (taskId: string, projectId: string | undefined): void => { onClose(); if (onOpen) { onOpen(taskId, projectId); return; } if (projectId && projectId !== f.project.id) setProjectFilter(projectId); openTask(taskId, anchor.current); };
  return (
    <Menu anchor={anchor} label={`${f.agents.find((a) => a.id === agentId)?.name ?? agentId} runs`} onClose={onClose} minWidth={320}>
      <div className="head">{m.header}</div>
      {m.groups.map((g) => (
        <div key={g.projectName}>
          <div className="grp-l">{g.projectName}</div>
          {g.rows.map((r) => (
            <div key={r.taskId} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button type="button" role="menuitem" onClick={() => go(r.taskId, r.projectId)} style={{ flex: 1, width: 'auto', minWidth: 0 }}>
                <PIcon name={r.needsYou ? 'hand' : 'run'} className={`pg-st ${r.needsYou ? 'warn' : 'live'}`} />
                <span className="mm"><b>{r.title}</b><span>{r.detail} / {money(r.costUsd)}</span></span>
              </button>
              {r.canStop && <button type="button" role="menuitem" aria-label={`Stop: ${r.title}`} style={{ flex: 'none', width: 'auto' }} onClick={() => { onClose(); void stopTask(r.taskId); }}>Stop</button>}
            </div>
          ))}
        </div>
      ))}
    </Menu>
  );
}

export function RunsButton({ f, agentId, runs, onOpen }: { f: PageFacts; agentId: string; runs: number; onOpen?: (taskId: string, projectId: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const name = f.agents.find((a) => a.id === agentId)?.name ?? agentId;
  return (
    <>
      <button ref={ref} type="button" className="pg-runsbtn" data-fk={`rb:${agentId}`} aria-haspopup="menu" aria-expanded={open} aria-label={`${name}: ${runs} runs. Show runs`} onClick={() => setOpen((v) => !v)}>
        {runs} runs <PIcon name="chev" size={10} />
      </button>
      {open && <RunsMenuView anchor={ref} f={f} agentId={agentId} onClose={() => setOpen(false)} {...(onOpen ? { onOpen } : {})} />}
    </>
  );
}

/* ---------- by status ---------- */
function Groups({ f, asks, archived, openBoard }: { f: PageFacts; asks: ReturnType<typeof asksOf>; archived: boolean; openBoard: () => void }) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  const groups: Group[] = archived
    ? [{ key: 'done' as const, heading: 'Last activity', total: 0, cap: 5, items: projectTasks(f).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((t): GroupItem => ({ key: `t:${t.id}`, taskId: t.id, title: t.title, agentId: t.agentId, agentName: f.agents.find((a) => a.id === t.agentId)?.name ?? t.agentId, status: 'done', detail: '', costUsd: t.costUsd ?? 0, age: ageText(f.nowMs, t.updatedAt) })) }].map((g) => ({ ...g, total: g.items.length }))
    : stateGroups(f, asks);
  if (!groups.length || (archived && groups.every((g) => g.total === 0))) {
    // runs that all wait on you are in the digest above: only a project with nothing at all says so
    if (projectTasks(f).length > 0 || asks.length > 0 || archived) return null;
    return <div className="pg-empty" style={{ marginTop: 0 }}><h2>Nothing has run here yet</h2><p>Tasks you start here, and tasks agents start for you, show up on this page.</p></div>;
  }
  return (
    <>
      {groups.map((g) => {
        const open = more[g.key];
        const vis = open ? g.items : g.items.slice(0, g.cap);
        const rest = g.total - vis.length;
        return (
          <section key={g.key} className={`pg-grp ${g.key === 'working' ? 'live' : ''}`} aria-label={g.heading}>
            <h2>{g.heading}<span className="n num">{g.total}</span></h2>
            <div className="pg-list">{vis.map((it) => <ItemRow key={it.key} it={it} f={f} openBoard={openBoard} />)}</div>
            {rest > 0 && <button type="button" className="pg-more" onClick={() => setMore({ ...more, [g.key]: true })}>{rest} more</button>}
            {open && g.total > g.cap && <button type="button" className="pg-more" onClick={() => setMore({ ...more, [g.key]: false })}>Show fewer</button>}
          </section>
        );
      })}
    </>
  );
}

function ItemRow({ it, f, openBoard }: { it: GroupItem; f: PageFacts; openBoard: () => void }) {
  const [icon, tone] = ICON[it.status] ?? ['ok', ''];
  const task = it.taskId ? f.tasks.find((t) => t.id === it.taskId) : undefined;
  const open = (): void => { if (it.taskId) openTask(it.taskId); else openBoard(); };
  return (
    <div className="pg-item" data-testid="state-item">
      <PIcon name={icon} className={`pg-st ${tone}`} />
      <div className="ti">
        <button type="button" className="lk" data-fk={it.key} title={it.title} onClick={open}>{it.title}</button>
        <div className="sub">{it.agentName}{it.detail ? <><span className="pg-sep" aria-hidden="true">/</span>{it.detail}</> : null}</div>
      </div>
      <div className="r num">
        {it.action && task && <button type="button" className="pg-btn sm" aria-label={`${it.action === 'continue' ? 'Continue' : 'Retry'}: ${it.agentName} ${it.title}`} onClick={() => (it.action === 'continue' ? void continueTask(task) : retryTask(task))}>{it.action === 'continue' ? 'Continue' : 'Retry'}</button>}
        {it.status !== 'queued' && it.costUsd !== undefined && <span className="cost">{money(it.costUsd)}</span>}
        {it.age && <span className="ago">{it.age}</span>}
      </div>
    </div>
  );
}

/* ---------- by agent ---------- */
function AgentUnits({ f, asks, weekByAgent }: { f: PageFacts; asks: ReturnType<typeof asksOf>; weekByAgent: Record<string, number> }) {
  const { units, idle, noTasks } = unitModel(f, { weekByAgent }, asks);
  return (
    <>
      {units.length > 0 && <section className="pg-grp" aria-label="Active"><h2>Active<span className="n num">{units.length}</span></h2><div className="pg-units">{units.map((u) => <UnitRow key={u.agentId} u={u} f={f} />)}</div></section>}
      {idle.length > 0 && <section className="pg-grp" aria-label="Idle"><h2>Idle<span className="n num">{idle.length}</span></h2><div className="pg-idle">{idle.map((i) => (
        <div key={i.agentId} className="pg-irow"><AgentBust agentId={i.agentId} size={20} calm /><div className="nm"><b>{i.name}</b><span>{i.text}</span></div><span className="c num">{money(i.weekUsd)}</span></div>
      ))}</div></section>}
      {noTasks.length > 0 && <div className="pg-nontask">{plural(noTasks.length, 'member has', 'members have')} no tasks here yet: {noTasks.join(', ')}.</div>}
      <p className="pg-legend">{MODE_HELP}</p>
    </>
  );
}

function UnitRow({ u, f }: { u: Unit; f: PageFacts }) {
  const open = (l: UnitLine): void => { if (l.taskId) openTask(l.taskId); };
  const leadTask = u.lead.taskId ? f.tasks.find((t) => t.id === u.lead.taskId) : undefined;
  const lab = `${u.name} ${u.lead.text.slice(0, 40)}`;
  const tone = u.lead.tone;
  return (
    <div className="pg-unit" data-testid="agent-unit">
      <AgentBust agentId={u.agentId} size={40} runs={u.runs} />
      <div style={{ minWidth: 0 }}>
        <div className="pg-u-head"><b>{u.name}</b><span className="role" title={u.role}>{u.role}</span>{u.mode && <span className="mode">{u.mode}</span>}{u.cloud && <span className="mode">Cloud computer</span>}</div>
        <div className="pg-u-now"><PIcon name={UNIT_ICON[u.lead.icon]} className={`pg-st ${tone}`} /><span title={u.lead.text}>{u.lead.text}</span></div>
        {u.rest.length > 0 && <div className="pg-u-more"><span style={{ whiteSpace: 'nowrap', flex: 'none' }}>+{u.rest.length} more</span><span className="ell">{u.rest[0]!.text}{u.rest.length > 1 ? ` and ${u.rest.length - 1} other${u.rest.length > 2 ? 's' : ''}` : ''}</span></div>}
        {u.also && <div className="pg-u-also">{u.also}</div>}
        {u.tail && <div className="pg-u-tail">{u.tail}</div>}
      </div>
      <div className="pg-u-r num">
        <span className="cost">{money(u.weekUsd)} this week</span><span>{u.model}</span>
        {u.runs >= 2 && <RunsButton f={f} agentId={u.agentId} runs={u.runs} />}
        {leadTask && leadTask.status === 'running' && u.lead.tone === 'live' && <button type="button" className="pg-btn sm" aria-label={`Stop: ${lab}`} onClick={() => void stopTask(leadTask.id)}>Stop</button>}
        {leadTask && leadTask.status === 'error' && <button type="button" className="pg-btn sm" aria-label={`${leadTask.resumable ? 'Continue' : 'Retry'}: ${lab}`} onClick={() => retryTask(leadTask)}>{leadTask.resumable ? 'Continue' : 'Retry'}</button>}
        {u.lead.icon === 'hand' && <button type="button" className="pg-btn sm" aria-label={`Open: ${lab}`} onClick={() => open(u.lead)}>Open</button>}
      </div>
    </div>
  );
}

/* ---------- side ---------- */
function SideColumn({ f, project, spend, showMembers }: { f: PageFacts; project: Project; spend: import('../../api').ProjectSpend | undefined; showMembers: boolean }) {
  const rooms = useRooms((s) => s.rooms);
  const rs = roomsOf(rooms, project.id);
  const b = spend?.budget;
  const stopOff = useGateOff('budget-stop', project.id);
  const block = spendBlock(spend?.week ?? 0, b?.limited ? b : undefined, stopOff);
  const working = new Set(workingAgents(f));
  return (
    <aside className="pg-side" data-region="side" aria-label="Project summary">
      <div className="pg-blk pg-spend">
        <h3>This week<button type="button" className="pg-lnk" onClick={() => setTab('settings')}>{b?.limited ? 'Budget' : 'Set a budget'}</button></h3>
        <div><span className="big num">{block.big}</span>{block.of && <> <span className="of num">{block.of}</span></>}</div>
        {b?.limited && <div className={`pg-bar${block.hi ? ' hi' : ''}`} aria-hidden="true"><i style={{ width: `${block.pct}%` }} /></div>}
        <div className="foot num">{block.foot}</div>
      </div>
      {rs.length > 0 && (
        <div className="pg-blk">
          <h3>Rooms<button type="button" className="pg-lnk" onClick={() => setTab('rooms')}>All rooms</button></h3>
          {rs.map((r) => (
            <div key={r.id} className="pg-rm">
              <span className="pg-stackb" aria-hidden="true">{r.members.slice(0, 3).map((m) => <AgentBust key={m} agentId={m} size={26} calm />)}</span>
              <div className="nm"><button type="button" className="rt" data-fk={`rm:${r.id}`} title={r.name} onClick={() => { setView('rooms'); openRoom(r.id); }}>{r.name}</button>
                <span className="s">{plural(r.members.length, 'agent')}<span className="pg-sep" aria-hidden="true">/</span>updated {ageText(f.nowMs, r.updatedAt)} ago</span></div>
            </div>
          ))}
        </div>
      )}
      {showMembers && project.members.length > 0 && (
        <div className="pg-blk">
          <h3>Members<button type="button" className="pg-lnk" onClick={() => setTab('settings')}>Manage</button></h3>
          <div className="pg-team">{project.members.map((id) => {
            const name = f.agents.find((a) => a.id === id)?.name ?? id;
            const w = working.has(id);
            return <span key={id} className="pg-mini" role="img" aria-label={`${name}${w ? ', working' : ''}`} title={`${name}${w ? ', working' : ''}`}><AgentBust agentId={id} size={20} dot={w} calm /></span>;
          })}</div>
        </div>
      )}
    </aside>
  );
}

