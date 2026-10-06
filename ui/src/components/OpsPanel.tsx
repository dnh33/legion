import { useEffect, useState } from 'react';
import { RelicStage } from '../mascot/Relic';
import { BustStage } from '../mascot/BustStage';
import { hasBust } from '../mascot/busts';
import { forceMascot, forceMascotVm, openTaskMenu, reopenTask, selectTask, setShowClosed, useStore, type RelicState } from '../store';
import { modelLabel } from '../models';
import { inProject } from '../projects/projectsLogic';
import { RenameInput } from './TaskSwitcher';
import { cleanTitle, money, relTime, taskTitle } from '../util';
import { BlenderCard } from '../blender/BlenderCard';
import { ComputerCard } from './ComputerCard';
import { statusDot } from '../../../src/shared/continue';

const LAB_STATES: RelicState[] = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];

function Lab() {
  const force = useStore((s) => s.mascotForce);
  const vm = useStore((s) => s.mascotVm);
  return (
    <div className="lab" role="group" aria-label="Mascot Lab">
      <h5>Mascot Lab</h5>
      <div className="lab-grid">
        {LAB_STATES.map((st) => <button key={st} className={force === st ? 'on' : ''} onClick={() => forceMascot(st)}>{st}</button>)}
        <button className={`wide${force === null ? ' on' : ''}`} onClick={() => forceMascot(null)}>auto</button>
        <button className={`wide${vm ? ' on' : ''}`} onClick={() => forceMascotVm(vm ? null : true)}>VM running overlay</button>
      </div>
    </div>
  );
}

function useShort() {
  const q = '(max-height: 700px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, []);
  return m;
}

export function OpsPanel() {
  const lab = useStore((s) => s.mascotLab);
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const catalog = useStore((s) => s.catalog);
  const selAgent = useStore((s) => s.selectedAgentId);
  const sel = useStore((s) => s.selectedTaskId);
  const showClosed = useStore((s) => s.showClosed);
  const projectFilter = useStore((s) => s.projectFilter);
  const renaming = useStore((s) => (s.renaming?.src === 'recent' ? s.renaming.id : null));
  const [, tick] = useState(0);
  const short = useShort();
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const recent = tasks.filter((t) => (showClosed || !t.archived) && inProject(t, projectFilter)).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  return (
    <aside className="ops" aria-label="Ops">
      <div className="ops-inner">
        <div className="mascot-stage">
          {selAgent !== 'zealot' && hasBust(selAgent)
            ? <BustStage key={selAgent} agentId={selAgent} width={short ? 124 : 210} />
            : <RelicStage width={short ? 124 : 210} />}
          {lab && <Lab />}
        </div>
        <ComputerCard />
        <BlenderCard />
        <section className={`card recent-card${recent.length === 0 ? ' solo' : ''}`}>
          <div className="card-head"><h4>Recent tasks</h4>{recent.length > 0 && <span className="count">{recent.length}</span>}<button type="button" className="show-closed" onClick={() => void setShowClosed(!showClosed)} aria-pressed={showClosed}>{showClosed ? 'Hide closed' : 'Show closed'}</button></div>
          {recent.length === 0 && <div className="card-empty"><p>Tasks show up here as agents work.</p></div>}
          <ul className="recent">
            {recent.map((t) => {
              const a = agents.find((x) => x.id === t.agentId);
              const from = t.source === 'agent' && t.fromAgentId ? agents.find((x) => x.id === t.fromAgentId)?.name ?? t.fromAgentId : null;
              return (
                <li key={t.id}>
                  <button className={`${t.id === sel ? 'sel' : ''}${t.archived ? ' closed' : ''}`}
                    onClick={() => { if (t.archived) void reopenTask(t.id); selectTask(t.id); }}
                    onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
                    onContextMenu={(e) => { e.preventDefault(); openTaskMenu(e.clientX, e.clientY, t.id, 'recent'); }}>
                    <i className={`st st-${statusDot(t)}`} />
                    {renaming === t.id ? <RenameInput id={t.id} title={t.title} /> : <span className="r-title">{taskTitle(t.title, from)}</span>}
                    <span className="r-meta">{a?.name ?? 'Agent'} {'\u00b7'} {t.costUsd != null ? (t.costLegacy ? 'up to ' : '') + money(t.costUsd) + ' · ' : ''}{relTime(t.updatedAt)}{from && <em className="from-chip">from {from}</em>}{t.modelOverride && <em className="from-chip model-chip" title={`${agents.find((x) => x.id === t.modelOverride!.by)?.name ?? t.modelOverride.by} chose ${modelLabel(catalog, t.modelOverride.model)} for this task`}>{modelLabel(catalog, t.modelOverride.model)}</em>}{t.archived && <em className="from-chip closed-chip">closed</em>}</span>
                  </button>
                </li>
              );
            })}
          </ul>

        </section>
      </div>
    </aside>
  );
}
