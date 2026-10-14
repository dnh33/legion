/** The tabbed project page: header, meta line (one derivation), tabs with a roving tabindex, and the tab panel. Spec 3.1. */
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../../src/shared/projects';
import { ensureRoomList, useRooms } from '../../rooms/roomsStore';
import { loadProjectTasks } from '../../store';
import { BoardPanel } from '../board/BoardPanel';
import { archiveProject, closeProjectPage, unarchiveProject } from '../projectsStore';
import { roomsOf } from '../projectsLogic';
import { projectAway, setPaused, useAway } from '../awayStore';
import { announce } from './announce';
import { Menu } from './Menu';
import { Overview } from './Overview';
import { enterProject, setLens, setTab, usePageState } from './pageState';
import { asksOf, metaParts, nextTab, projectTasks, tabDefs, workingAgents } from './pageLogic';
import type { TabKey } from './pageLogic';
import { PIcon } from './PIcon';
import { Sheet } from './Sheet';
import { layoutFor } from './sheetLogic';
import { closeSheet, openSheet, useSheet } from './sheetState';
import { SettingsTab } from './SettingsTab';
import { RoomsTab, TasksTab } from './TabsContent';
import { usePageFacts } from './usePageFacts';
import './page.css';

export function ProjectFrame({ project }: { project: Project }) {
  const f = usePageFacts(project);
  const ps = usePageState();
  const rooms = useRooms((s) => s.rooms);
  const away = useAway((s) => projectAway(s, project.id));
  const weekUsd = useAway((s) => s.spend[project.id]?.week);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const sheet = useSheet().content;
  const [areaW, setAreaW] = useState(0);
  useEffect(() => { enterProject(project.id); ensureRoomList(); void loadProjectTasks(project.id); }, [project.id]);
  // the sheet pushes the list aside only when 520 px stay free beside it; otherwise it covers the list (dimmed, inert)
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el); setAreaW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { panel.current?.toggleAttribute('inert', !!sheet && layoutFor(areaW) === 'over'); });
  // a sheet belongs to the page it was opened on: leaving the page closes it
  useEffect(() => () => { closeSheet(); }, []);

  const tab: TabKey = ps.project === project.id ? ps.tab : 'overview';
  const archived = project.status === 'archived';
  const asks = asksOf(f);
  const working = workingAgents(f, asks).length;
  const tabs = tabDefs({ asks: asks.length, board: f.board?.items.length ?? 0, tasks: projectTasks(f).length, rooms: roomsOf(rooms, project.id).length });
  const parts = metaParts(f, { asks: asks.length, working, paused: away.paused, ...(weekUsd !== undefined ? { weekUsd } : {}) });
  const canLens = tab === 'overview' && project.members.length > 1 && !archived;

  const onTabKey = (e: React.KeyboardEvent): void => {
    const next = nextTab(tabs.map((t) => t.key), tab, e.key);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    requestAnimationFrame(() => document.getElementById('pg-tab-' + next)?.focus());
  };

  return (
    <section className="pg" aria-labelledby="pg-title" data-testid="project-page">
      <header className="pg-head">
        <button type="button" className="pg-back" title="Back to chat" aria-label="Back to chat" onClick={closeProjectPage}><PIcon name="back" /></button>
        <div className="pg-title">
          <h1 id="pg-title" title={project.name}>{project.name}</h1>
          <div className="pg-meta num" data-testid="meta">
            <ul>{parts.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        </div>
        <div className="pg-acts">
          {archived ? (
            <button type="button" className="pg-btn" disabled={busy} onClick={() => { setBusy(true); void unarchiveProject(project).finally(() => setBusy(false)); }}>Unarchive</button>
          ) : (
            <>
              {project.members.length === 0 && <span className="why" id="pg-nomem">Add a member first</span>}
              <button type="button" className="pg-btn primary" data-fk="new" disabled={project.members.length === 0} aria-describedby={project.members.length === 0 ? 'pg-nomem' : undefined} onClick={(e) => openSheet({ kind: 'new' }, e.currentTarget)}>
                <PIcon name="plus" size={14} />New task
              </button>
            </>
          )}
          <button ref={moreBtn} type="button" className="pg-btn icon ghost" aria-haspopup="menu" aria-expanded={menu} aria-label="More project actions" title="More: pause new starts, rename, archive" onClick={() => setMenu((v) => !v)}><PIcon name="more" /></button>
          {menu && (
            <Menu anchor={moreBtn} label="Project actions" align="end" minWidth={240} onClose={() => setMenu(false)}>
              {!archived && (
                <button type="button" role="menuitemcheckbox" aria-checked={away.paused} onClick={() => { setMenu(false); void setPaused(project.id, !away.paused).then((ok) => { if (ok) announce(away.paused ? 'New starts resumed.' : 'New starts are paused.'); }); }}>
                  <span className="mm"><b>Pause new starts</b><span>Tasks you start yourself still run</span></span>
                  {away.paused && <PIcon name="check" size={14} className="ck" />}
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setTab('settings'); requestAnimationFrame(() => document.getElementById('pg-name')?.focus()); }}><span className="mm"><b>Rename project</b></span></button>
              {!archived && <button type="button" role="menuitem" onClick={() => { setMenu(false); void archiveProject(project); }}><span className="mm"><b>Archive project</b></span></button>}
            </Menu>
          )}
        </div>
      </header>
      <div className="pg-tabbar">
        <div className="pg-tabs" role="tablist" aria-label="Project sections" data-tip="project-tabs" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" id={'pg-tab-' + t.key} aria-controls="pg-panel" aria-selected={tab === t.key} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>
              {t.label}
              {t.pip && <><i className="pip" aria-hidden="true" /><span className="sr">, {t.pipText}</span></>}
              {t.count !== undefined && <span className="c">{t.count}</span>}
            </button>
          ))}
        </div>
        {canLens && (
          <span className="pg-lens" role="radiogroup" aria-label="Group the overview">
            <button type="button" role="radio" aria-checked={ps.lens === 'state'} onClick={() => setLens('state')}>By status</button>
            <button type="button" role="radio" aria-checked={ps.lens === 'agent'} onClick={() => setLens('agent')}>By agent</button>
          </span>
        )}
      </div>
      <div ref={area} className={`pg-area${sheet ? (layoutFor(areaW) === 'push' ? ' pushed' : ' over') : ''}`}>
        <div ref={panel} key={tab} id="pg-panel" className="pg-scroll fade" role="tabpanel" tabIndex={-1} aria-labelledby={'pg-tab-' + tab} {...(sheet && layoutFor(areaW) === 'over' ? { 'aria-hidden': true } : {})}>
          {tab === 'overview' && <Overview f={f} project={project} lens={ps.lens} openBoard={() => setTab('board')} />}
          {tab === 'board' && <div className="pg-inner"><BoardPanel project={project} /></div>}
          {tab === 'tasks' && <TasksTab f={f} project={project} />}
          {tab === 'rooms' && <RoomsTab f={f} project={project} />}
          {tab === 'settings' && <SettingsTab f={f} project={project} />}
        </div>
        <Sheet f={f} project={project} openBoard={() => setTab('board')} />
      </div>
    </section>
  );
}
