import { useEffect, useState } from 'react';
import { RelicStage } from '../mascot/Relic';
import { forceMascot, forceMascotVm, selectTask, useStore, type RelicState } from '../store';
import { cleanTitle, money, relTime } from '../util';
import { ComputerCard } from './ComputerCard';

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
  const sel = useStore((s) => s.selectedTaskId);
  const [, tick] = useState(0);
  const short = useShort();
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const recent = tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  return (
    <aside className="ops" aria-label="Ops">
      <div className="ops-inner">
        <div className="mascot-stage">
          <RelicStage width={short ? 124 : 210} />
          {lab && <Lab />}
        </div>
        <ComputerCard />
        <section className={`card recent-card${recent.length === 0 ? ' solo' : ''}`}>
          <div className="card-head"><h4>Recent tasks</h4>{recent.length > 0 && <span className="count">{recent.length}</span>}</div>
          {recent.length === 0 && <div className="card-empty"><p>Tasks show up here as agents work.</p></div>}
          <ul className="recent">
            {recent.map((t) => {
              const a = agents.find((x) => x.id === t.agentId);
              return (
                <li key={t.id}>
                  <button className={t.id === sel ? 'sel' : ''} onClick={() => selectTask(t.id)}>
                    <i className={`st st-${t.status}`} />
                    <span className="r-title">{cleanTitle(t.title)}</span>
                    <span className="r-meta">{a?.name ?? 'Agent'} {'\u00b7'} {t.costUsd != null ? money(t.costUsd) + ' · ' : ''}{relTime(t.updatedAt)}</span>
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
